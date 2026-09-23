// Surveille les offres de VIE "Finance Comptabilité Gestion Banque" sur
// mon-vie-via.businessfrance.fr : détecte les nouvelles offres, envoie une
// notification (ntfy.sh) et régénère le README avec la liste à jour.

import fs from "node:fs";
import path from "node:path";

// Clé publique livrée par le site à tous les navigateurs (visible dans le
// code source de mon-vie-via.businessfrance.fr), pas une authentification
// personnelle.
const API_KEY = "l+KwpoLPiXlsjxNT/NQ2iOFz8+iuygxAODs9FeAEWYM=";
const SEARCH_URL = "https://civiweb-api-prd.azurewebsites.net/api/Offers/search";
const OFFER_PAGE_URL = "https://mon-vie-via.businessfrance.fr/offres";

// Identifiant de la catégorie "FINANCE COMPTABILITE GESTION BANQUE" côté API.
const SPECIALIZATION_ID = "19";

const NTFY_TOPIC = process.env.NTFY_TOPIC;

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const OFFERS_FILE = path.join(DATA_DIR, "offers.json");
const SEEN_FILE = path.join(DATA_DIR, "seen-ids.json");
const README_FILE = path.join(ROOT_DIR, "README.md");

async function fetchAllOffers() {
  const limit = 200;
  let skip = 0;
  let all = [];

  while (true) {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY },
      body: JSON.stringify({ skip, limit, specializationsIds: [SPECIALIZATION_ID] }),
    });

    if (!res.ok) {
      throw new Error(`Recherche API échouée (${res.status}) : ${await res.text()}`);
    }

    const data = await res.json();
    const batch = data.result ?? [];
    all = all.concat(batch);
    skip += limit;

    if (batch.length === 0 || skip >= (data.count ?? 0)) break;
  }

  return all;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function formatIndemnite(offer) {
  if (typeof offer.indemnite !== "number") return "Non communiquée";
  return `${offer.indemnite.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €/mois`;
}

function offerLink(offer) {
  return `${OFFER_PAGE_URL}/${offer.id}`;
}

async function notifyNewOffer(offer) {
  if (!NTFY_TOPIC) return;

  const lieu = [offer.cityName, offer.countryName].filter(Boolean).join(", ") || "Lieu non précisé";
  const message = `${offer.organizationName || "Entreprise non précisée"}, ${lieu}\nIndemnité : ${formatIndemnite(offer)}`;

  const res = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title: `Nouvelle offre VIE : ${offer.missionTitle || "Finance/Compta/Gestion/Banque"}`,
      message,
      click: offerLink(offer),
      priority: 4,
    }),
  });

  if (!res.ok) {
    console.error(`Échec de l'envoi de la notification ntfy pour l'offre ${offer.id} : ${res.status} ${await res.text()}`);
  }
}

function formatOfferMarkdown(offer) {
  const lieu = [offer.cityName, offer.countryName].filter(Boolean).join(", ") || "Non précisé";
  const publie = offer.startBroadcastDate
    ? new Date(offer.startBroadcastDate).toLocaleDateString("fr-FR")
    : "Non précisée";
  const description = (offer.missionDescription || "").trim() || "Non communiquée.";
  const profil = (offer.missionProfile || "").trim() || "Non communiqué.";

  return `<details>
<summary><strong>${offer.missionTitle || "Offre VIE"}</strong> · ${offer.organizationName || "?"} · ${lieu} · ${formatIndemnite(offer)}</summary>

- **Entreprise :** ${offer.organizationName || "Non précisée"}
- **Lieu :** ${lieu}
- **Indemnité :** ${formatIndemnite(offer)}
- **Durée de la mission :** ${offer.missionDuration ? `${offer.missionDuration} mois` : "Non précisée"}
- **Publiée le :** ${publie}
- **Lien vers l'offre :** [${offerLink(offer)}](${offerLink(offer)})

**Description du poste**

${description}

**Profil recherché**

${profil}

</details>
`;
}

function buildReadme(offers) {
  const sorted = [...offers].sort(
    (a, b) => new Date(b.startBroadcastDate ?? 0) - new Date(a.startBroadcastDate ?? 0)
  );
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  const header = `# Veille des offres VIE : Finance / Comptabilité / Gestion / Banque

Ce dépôt surveille automatiquement les offres de VIE publiées sur
[mon-vie-via.businessfrance.fr](https://mon-vie-via.businessfrance.fr) dans la
catégorie **Finance Comptabilité Gestion Banque**, toutes les 20 minutes
environ. Une notification est envoyée sur ton téléphone (via ntfy.sh) à
chaque nouvelle offre détectée.

Dernière vérification : **${now}**, ${offers.length} offre(s) actuellement en ligne.

Clique sur une offre ci-dessous pour dérouler la fiche de poste complète.

---

`;

  const body =
    sorted.length > 0
      ? sorted.map(formatOfferMarkdown).join("\n")
      : "_Aucune offre en ligne pour le moment dans cette catégorie._\n";

  return header + body;
}

async function main() {
  const offers = await fetchAllOffers();
  const currentIds = offers.map((o) => String(o.id));

  const seenIds = new Set(readJson(SEEN_FILE, []));
  const isFirstRun = seenIds.size === 0;

  const newOffers = offers.filter((o) => !seenIds.has(String(o.id)));

  if (!isFirstRun) {
    for (const offer of newOffers) {
      await notifyNewOffer(offer);
    }
  }

  const updatedSeenIds = new Set([...seenIds, ...currentIds]);
  writeJson(SEEN_FILE, [...updatedSeenIds]);
  writeJson(OFFERS_FILE, offers);
  fs.writeFileSync(README_FILE, buildReadme(offers));

  console.log(
    `Offres actives : ${offers.length}. Nouvelles notifiées : ${isFirstRun ? 0 : newOffers.length}` +
      (isFirstRun ? " (premier passage : initialisation sans notification)." : ".")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
