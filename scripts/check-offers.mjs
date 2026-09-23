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
const PAGE_FILE = path.join(ROOT_DIR, "docs", "index.html");

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

**[Voir la page de consultation (plus agréable à lire)](https://nathan-nlb.github.io/vie-watcher/)**

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

function buildOffersPageData(offers) {
  return [...offers]
    .sort((a, b) => new Date(b.startBroadcastDate ?? 0) - new Date(a.startBroadcastDate ?? 0))
    .map((offer) => ({
      titre: offer.missionTitle || "Offre VIE",
      entreprise: offer.organizationName || "Non précisée",
      ville: offer.cityName || "",
      pays: offer.countryName || "",
      indemnite: formatIndemnite(offer),
      duree: offer.missionDuration ? `${offer.missionDuration} mois` : "Non précisée",
      publieLe: offer.startBroadcastDate
        ? new Date(offer.startBroadcastDate).toLocaleDateString("fr-FR")
        : "Non précisée",
      lien: offerLink(offer),
      description: (offer.missionDescription || "").trim() || "Non communiquée.",
      profil: (offer.missionProfile || "").trim() || "Non communiqué.",
    }));
}

function buildOffersPageHtml(offers) {
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  const data = buildOffersPageData(offers);
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veille des offres VIE : Finance / Comptabilité / Gestion / Banque</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --card-bg: #ffffff;
    --text: #1c1f26;
    --muted: #5a6270;
    --accent: #2f6fed;
    --border: #e4e7ec;
    --tag-bg: #eef2ff;
    --tag-text: #2f4bb0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --card-bg: #1e2126;
      --text: #ecedef;
      --muted: #9aa2b1;
      --accent: #6ea1ff;
      --border: #2b2f36;
      --tag-bg: #23283a;
      --tag-text: #a9c0ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5;
  }
  header {
    max-width: 780px;
    margin: 0 auto;
    padding: 32px 16px 16px;
  }
  h1 {
    font-size: 1.5rem;
    margin: 0 0 4px;
  }
  .subtitle {
    color: var(--muted);
    margin: 0 0 16px;
  }
  .meta {
    color: var(--muted);
    font-size: 0.9rem;
    margin: 0 0 16px;
  }
  .meta a { color: var(--accent); }
  input[type="search"] {
    width: 100%;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--card-bg);
    color: var(--text);
    font-size: 1rem;
  }
  main {
    max-width: 780px;
    margin: 0 auto;
    padding: 0 16px 48px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .offer {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
  }
  .offer summary {
    cursor: pointer;
    list-style: none;
  }
  .offer summary::-webkit-details-marker { display: none; }
  .offer-title {
    font-weight: 600;
    font-size: 1.05rem;
    margin: 0 0 4px;
  }
  .offer-sub {
    color: var(--muted);
    font-size: 0.92rem;
    margin: 0 0 8px;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tag {
    background: var(--tag-bg);
    color: var(--tag-text);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 0.82rem;
    font-weight: 500;
  }
  .offer-body {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .offer-body h3 {
    font-size: 0.95rem;
    margin: 14px 0 6px;
  }
  .offer-body h3:first-child { margin-top: 0; }
  .offer-body p {
    white-space: pre-line;
    margin: 0;
    font-size: 0.95rem;
  }
  .offer-link {
    display: inline-block;
    margin-top: 14px;
    color: var(--accent);
    font-weight: 500;
    text-decoration: none;
  }
  .offer-link:hover { text-decoration: underline; }
  .empty {
    color: var(--muted);
    text-align: center;
    padding: 32px 0;
  }
</style>
</head>
<body>
<header>
  <h1>Veille des offres VIE</h1>
  <p class="subtitle">Finance · Comptabilité · Gestion · Banque</p>
  <p class="meta">Dernière vérification : <strong>${now}</strong>, <span id="count"></span> offre(s) en ligne.</p>
  <p class="meta"><a href="https://github.com/Nathan-NLB/vie-watcher/blob/claude/vie-finance-notifications-j770x1/README.md">Voir la liste en texte brut (README)</a></p>
  <input type="search" id="search" placeholder="Rechercher (ville, entreprise, poste...)">
</header>
<main id="list"></main>
<script>
  const OFFRES = ${dataJson};

  const listEl = document.getElementById("list");
  const searchEl = document.getElementById("search");
  const countEl = document.getElementById("count");

  function render(offres) {
    countEl.textContent = offres.length;
    listEl.innerHTML = "";

    if (offres.length === 0) {
      listEl.innerHTML = '<p class="empty">Aucune offre ne correspond à ta recherche.</p>';
      return;
    }

    for (const o of offres) {
      const lieu = [o.ville, o.pays].filter(Boolean).join(", ") || "Lieu non précisé";
      const details = document.createElement("details");
      details.className = "offer";
      details.innerHTML = \`
        <summary>
          <p class="offer-title">\${o.titre}</p>
          <p class="offer-sub">\${o.entreprise} · \${lieu}</p>
          <div class="tags">
            <span class="tag">\${o.indemnite}</span>
            <span class="tag">\${o.duree}</span>
            <span class="tag">Publiée le \${o.publieLe}</span>
          </div>
        </summary>
        <div class="offer-body">
          <h3>Description du poste</h3>
          <p>\${o.description}</p>
          <h3>Profil recherché</h3>
          <p>\${o.profil}</p>
          <a class="offer-link" href="\${o.lien}" target="_blank" rel="noopener">Voir l'offre sur mon-vie-via.businessfrance.fr →</a>
        </div>
      \`;
      listEl.appendChild(details);
    }
  }

  function applyFilter() {
    const q = searchEl.value.trim().toLowerCase();
    if (!q) {
      render(OFFRES);
      return;
    }
    render(
      OFFRES.filter((o) =>
        [o.titre, o.entreprise, o.ville, o.pays].join(" ").toLowerCase().includes(q)
      )
    );
  }

  searchEl.addEventListener("input", applyFilter);
  render(OFFRES);
</script>
</body>
</html>
`;
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
  fs.mkdirSync(path.dirname(PAGE_FILE), { recursive: true });
  fs.writeFileSync(PAGE_FILE, buildOffersPageHtml(offers));

  console.log(
    `Offres actives : ${offers.length}. Nouvelles notifiées : ${isFirstRun ? 0 : newOffers.length}` +
      (isFirstRun ? " (premier passage : initialisation sans notification)." : ".")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
