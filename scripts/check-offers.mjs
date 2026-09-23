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
const GEOCACHE_FILE = path.join(DATA_DIR, "geocache.json");
const COMPAT_CACHE_FILE = path.join(DATA_DIR, "compat-scores.json");

// Score de compatibilité candidat/offre, via l'API gratuite de Google
// (Gemini). Les deux secrets sont fournis par l'utilisateur via GitHub
// Actions ; en leur absence, le score est simplement omis.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CANDIDATE_PROFILE = process.env.CANDIDATE_PROFILE;
const GEMINI_MODEL = "gemini-3.6-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Service gratuit de géocodage (OpenStreetMap), sans clé. On s'identifie
// comme le demande sa politique d'usage, et on respecte la limite d'une
// requête par seconde en espaçant nos appels.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const GEOCODE_USER_AGENT = "vie-watcher (https://github.com/Nathan-NLB/vie-watcher)";
const GLOBE_GL_URL = "https://cdn.jsdelivr.net/npm/globe.gl@2.46.2/dist/globe.gl.min.js";
const EARTH_TEXTURE_URL = "https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg";

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

function formatMissionPeriod(offer) {
  const start = offer.missionStartDate ? new Date(offer.missionStartDate) : null;
  const end = offer.missionEndDate ? new Date(offer.missionEndDate) : null;
  const fmt = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });

  if (start && end) return `Du ${fmt(start)} au ${fmt(end)}`;
  if (start) return `À partir du ${fmt(start)}`;
  return "Dates non précisées";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Renvoie {lat, lon}, null si le service n'a rien trouvé (résultat qu'on
// peut mettre en cache définitivement), ou undefined en cas d'échec
// temporaire (à retenter au prochain passage, donc jamais mis en cache).
async function geocodeQuery(query) {
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": GEOCODE_USER_AGENT } });
    if (!res.ok) {
      console.error(`Géocodage échoué (${res.status}) pour "${query}"`);
      return undefined;
    }
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return null;
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
  } catch (err) {
    console.error(`Géocodage échoué pour "${query}" : ${err.message}`);
    return undefined;
  }
}

// Essaie de localiser précisément l'entreprise, sinon retombe sur la ville.
// `cache` est mis à jour en place et sauvegardé par l'appelant.
async function resolveOfferLocations(offers, cache) {
  const points = [];

  for (const offer of offers) {
    const ville = offer.cityName || "";
    const pays = offer.countryName || "";
    if (!ville && !pays) continue;

    let coords;
    let precision;

    if (offer.organizationName && ville) {
      const entrepriseKey = `entreprise|${offer.organizationName.toLowerCase()}|${ville.toLowerCase()}|${pays.toLowerCase()}`;
      coords = cache[entrepriseKey];
      if (coords === undefined) {
        coords = await geocodeQuery(`${offer.organizationName}, ${ville}, ${pays}`);
        if (coords !== undefined) cache[entrepriseKey] = coords;
        await sleep(1100);
      }
      if (coords) precision = "entreprise";
    }

    if (!coords) {
      const villeKey = `ville|${ville.toLowerCase()}|${pays.toLowerCase()}`;
      let villeCoords = cache[villeKey];
      if (villeCoords === undefined) {
        villeCoords = await geocodeQuery([ville, pays].filter(Boolean).join(", "));
        if (villeCoords !== undefined) cache[villeKey] = villeCoords;
        await sleep(1100);
      }
      coords = villeCoords;
      precision = "ville";
    }

    if (coords) {
      points.push({
        id: offer.id,
        lat: coords.lat,
        lon: coords.lon,
        precision,
      });
    }
  }

  return points;
}

// Interroge Gemini pour noter la compatibilité d'une offre avec le profil
// du candidat. Renvoie {score, raison}, ou undefined en cas d'échec
// (jamais mis en cache, pour retenter au prochain passage).
async function scoreOfferCompatibility(offer) {
  const prompt = `Tu évalues la compatibilité entre le profil d'un candidat et une offre de VIE (Volontariat International en Entreprise).

Profil du candidat :
${CANDIDATE_PROFILE}

Offre :
Titre : ${offer.missionTitle || ""}
Entreprise : ${offer.organizationName || ""}
Lieu : ${[offer.cityName, offer.countryName].filter(Boolean).join(", ")}
Description : ${offer.missionDescription || ""}
Profil recherché par l'entreprise : ${offer.missionProfile || ""}

Donne un score de compatibilité de 0 à 100 (100 = correspondance parfaite avec le profil et l'expérience du candidat, 0 = aucun rapport) et une explication très concise en français (2 à 3 phrases maximum) justifiant ce score, en mentionnant les points de correspondance et les éventuels écarts.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          score: { type: "INTEGER" },
          raison: { type: "STRING" },
        },
        required: ["score", "raison"],
      },
    },
  };

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      throw new QuotaExceededError(await res.text());
    }

    if (!res.ok) {
      console.error(`Score de compatibilité échoué (${res.status}) pour l'offre ${offer.id} : ${await res.text()}`);
      return undefined;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return undefined;

    const parsed = JSON.parse(text);
    const raison = String(parsed.raison || "").trim();
    if (!raison || typeof parsed.score !== "number") return undefined;

    return { score: Math.max(0, Math.min(100, Math.round(parsed.score))), raison };
  } catch (err) {
    if (err instanceof QuotaExceededError) throw err;
    console.error(`Score de compatibilité échoué pour l'offre ${offer.id} : ${err.message}`);
    return undefined;
  }
}

class QuotaExceededError extends Error {}

// Complète `cache` (mutée en place) avec le score des offres pas encore
// évaluées. Sans clé ou sans profil configuré, ne fait rien : le score
// est simplement absent de la page. S'arrête proprement dès que le quota
// gratuit journalier est atteint, plutôt que d'insister sur chaque offre
// restante (elles seront tentées au prochain passage).
async function resolveCompatScores(offers, cache) {
  if (!GEMINI_API_KEY || !CANDIDATE_PROFILE) return;

  for (const offer of offers) {
    const key = String(offer.id);
    if (cache[key]) continue;

    try {
      const result = await scoreOfferCompatibility(offer);
      if (result) cache[key] = result;
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        console.error("Quota Gemini gratuit atteint pour aujourd'hui, on réessaiera au prochain passage.");
        return;
      }
      throw err;
    }

    // Reste large sous la limite du palier gratuit de Gemini (par minute).
    await sleep(4500);
  }
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

function formatOfferMarkdown(offer, compatCache) {
  const lieu = [offer.cityName, offer.countryName].filter(Boolean).join(", ") || "Non précisé";
  const publie = offer.startBroadcastDate
    ? new Date(offer.startBroadcastDate).toLocaleDateString("fr-FR")
    : "Non précisée";
  const description = (offer.missionDescription || "").trim() || "Non communiquée.";
  const profil = (offer.missionProfile || "").trim() || "Non communiqué.";
  const compat = compatCache[String(offer.id)];
  const compatLine = compat ? `- **Compatibilité avec ton profil :** ${compat.score} % — ${compat.raison}\n` : "";

  return `<details>
<summary><strong>${offer.missionTitle || "Offre VIE"}</strong> · ${offer.organizationName || "?"} · ${lieu} · ${formatIndemnite(offer)}</summary>

- **Entreprise :** ${offer.organizationName || "Non précisée"}
- **Lieu :** ${lieu}
- **Indemnité :** ${formatIndemnite(offer)}
- **Durée de la mission :** ${offer.missionDuration ? `${offer.missionDuration} mois` : "Non précisée"} (${formatMissionPeriod(offer)})
- **Publiée le :** ${publie}
${compatLine}- **Lien vers l'offre :** [${offerLink(offer)}](${offerLink(offer)})

**Description du poste**

${description}

**Profil recherché**

${profil}

</details>
`;
}

function buildReadme(offers, compatCache) {
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
      ? sorted.map((offer) => formatOfferMarkdown(offer, compatCache)).join("\n")
      : "_Aucune offre en ligne pour le moment dans cette catégorie._\n";

  return header + body;
}

function buildOffersPageData(offers, compatCache) {
  return [...offers]
    .sort((a, b) => new Date(b.startBroadcastDate ?? 0) - new Date(a.startBroadcastDate ?? 0))
    .map((offer) => {
      const compat = compatCache[String(offer.id)];
      return {
        id: offer.id,
        titre: offer.missionTitle || "Offre VIE",
        entreprise: offer.organizationName || "Non précisée",
        ville: offer.cityName || "",
        pays: offer.countryName || "",
        indemnite: formatIndemnite(offer),
        duree: offer.missionDuration ? `${offer.missionDuration} mois` : "Non précisée",
        periode: formatMissionPeriod(offer),
        publieLe: offer.startBroadcastDate
          ? new Date(offer.startBroadcastDate).toLocaleDateString("fr-FR")
          : "Non précisée",
        lien: offerLink(offer),
        description: (offer.missionDescription || "").trim() || "Non communiquée.",
        profil: (offer.missionProfile || "").trim() || "Non communiqué.",
        compatScore: compat ? compat.score : null,
        compatRaison: compat ? compat.raison : null,
      };
    });
}

function median(sortedNumbers) {
  const n = sortedNumbers.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2 : sortedNumbers[mid];
}

function topCounts(values, limit) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return {
    total: counts.size,
    top: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([label, value]) => ({ label, value })),
  };
}

// Lundi de la semaine ISO contenant `date`, au format jj/mm.
function weekStartLabel(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

function buildDashboardData(offers, compatCache, totalSeen) {
  const indemnites = offers
    .map((o) => o.indemnite)
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);

  const avgIndemnite = indemnites.length
    ? indemnites.reduce((sum, v) => sum + v, 0) / indemnites.length
    : null;

  const indemniteBuckets = [
    { label: "< 2000 €", min: 0, max: 2000 },
    { label: "2000-2499 €", min: 2000, max: 2500 },
    { label: "2500-2999 €", min: 2500, max: 3000 },
    { label: "3000-3499 €", min: 3000, max: 3500 },
    { label: "3500-3999 €", min: 3500, max: 4000 },
    { label: "4000 € et +", min: 4000, max: Infinity },
  ].map((b) => ({
    label: b.label,
    value: indemnites.filter((v) => v >= b.min && v < b.max).length,
  }));

  const pays = topCounts(offers.map((o) => o.countryName), 10);
  const entreprises = topCounts(offers.map((o) => o.organizationName), 10);

  const weekCounts = new Map();
  for (const o of offers) {
    if (!o.startBroadcastDate) continue;
    const label = weekStartLabel(new Date(o.startBroadcastDate));
    weekCounts.set(label, (weekCounts.get(label) || 0) + 1);
  }
  const semaines = [...weekCounts.entries()]
    .sort((a, b) => {
      const [da, ma] = a[0].split("/").map(Number);
      const [db, mb] = b[0].split("/").map(Number);
      return ma - mb || da - db;
    })
    .map(([label, value]) => ({ label: `Semaine du ${label}`, value }));

  const compatScores = offers
    .map((o) => compatCache[String(o.id)]?.score)
    .filter((v) => typeof v === "number");
  const avgCompat = compatScores.length
    ? Math.round(compatScores.reduce((sum, v) => sum + v, 0) / compatScores.length)
    : null;
  const compatBuckets = [
    { label: "0-39 %", min: 0, max: 40, tier: "low" },
    { label: "40-69 %", min: 40, max: 70, tier: "mid" },
    { label: "70-100 %", min: 70, max: 101, tier: "high" },
  ].map((b) => ({
    label: b.label,
    tier: b.tier,
    value: compatScores.filter((v) => v >= b.min && v < b.max).length,
  }));

  return {
    totalActives: offers.length,
    totalVus: totalSeen,
    indemniteMoyenne: avgIndemnite,
    indemniteMediane: median(indemnites),
    indemniteBuckets,
    pays: pays.top,
    nbPays: pays.total,
    entreprises: entreprises.top,
    nbEntreprises: entreprises.total,
    semaines,
    compatBuckets,
    compatNotees: compatScores.length,
    compatMoyenne: avgCompat,
  };
}

function buildOffersPageHtml(offers, geoPoints, compatCache, totalSeen) {
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  const data = buildOffersPageData(offers, compatCache);
  const dashboard = buildDashboardData(offers, compatCache, totalSeen);
  const dashboardJson = JSON.stringify(dashboard).replace(/</g, "\\u003c");
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  const geoJson = JSON.stringify(geoPoints).replace(/</g, "\\u003c");

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
    padding: 32px 16px 0;
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
    margin: 0 0 8px;
  }
  .meta a { color: var(--accent); }
  .tabs {
    display: flex;
    gap: 20px;
    margin-top: 16px;
    border-bottom: 1px solid var(--border);
  }
  .tab-btn {
    background: none;
    border: none;
    padding: 10px 2px;
    font: inherit;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .panel { display: none; }
  .panel.active { display: block; }
  .search-wrap {
    max-width: 780px;
    margin: 16px auto 0;
    padding: 0 16px;
  }
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
    padding: 16px 16px 48px;
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
  .tag-compat-high { background: #dcfce7; color: #166534; font-weight: 700; }
  .tag-compat-mid { background: #fef3c7; color: #92400e; font-weight: 700; }
  .tag-compat-low { background: #fee2e2; color: #991b1b; font-weight: 700; }
  @media (prefers-color-scheme: dark) {
    .tag-compat-high { background: #14532d; color: #bbf7d0; }
    .tag-compat-mid { background: #78350f; color: #fde68a; }
    .tag-compat-low { background: #7f1d1d; color: #fecaca; }
  }
  .compat-box {
    border-radius: 10px;
    padding: 10px 14px;
    margin-bottom: 14px;
    border-left: 4px solid;
    font-size: 0.9rem;
  }
  .compat-box p { margin: 4px 0 0; white-space: normal; }
  .compat-high { background: #dcfce7; color: #166534; border-color: #16a34a; }
  .compat-mid { background: #fef3c7; color: #92400e; border-color: #d97706; }
  .compat-low { background: #fee2e2; color: #991b1b; border-color: #dc2626; }
  @media (prefers-color-scheme: dark) {
    .compat-high { background: #14532d; color: #bbf7d0; border-color: #22c55e; }
    .compat-mid { background: #78350f; color: #fde68a; border-color: #f59e0b; }
    .compat-low { background: #7f1d1d; color: #fecaca; border-color: #ef4444; }
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
  #globeViz {
    width: 100%;
    height: 60vh;
    min-height: 380px;
    max-height: 620px;
    cursor: grab;
  }
  #globeViz:active { cursor: grabbing; }
  .globe-marker {
    position: relative;
    width: 22px;
    height: 22px;
    cursor: pointer;
    transform: translate(-50%, -50%);
  }
  .globe-marker-dot {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: #ff5470;
    border: 2px solid #ffffff;
    box-shadow: 0 0 0 3px rgba(255, 84, 112, 0.35), 0 2px 6px rgba(0, 0, 0, 0.35);
    transition: transform 0.15s ease, background 0.15s ease;
  }
  .globe-marker-badge {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ffffff;
    font-size: 11px;
    font-weight: 700;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    pointer-events: none;
  }
  .globe-marker:hover .globe-marker-dot,
  .globe-marker.active .globe-marker-dot {
    background: #2f6fed;
    transform: scale(1.25);
    box-shadow: 0 0 0 5px rgba(47, 111, 237, 0.4), 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  .map-hint {
    max-width: 780px;
    margin: 12px auto 0;
    padding: 0 16px;
    color: var(--muted);
    font-size: 0.85rem;
  }
  #carte-offres {
    max-width: 780px;
    margin: 0 auto;
    padding: 16px 16px 48px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .dash-wrap {
    max-width: 780px;
    margin: 0 auto;
    padding: 16px 16px 48px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
  }
  .stat-tile {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
  }
  .stat-value {
    display: block;
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.2;
  }
  .stat-label {
    display: block;
    color: var(--muted);
    font-size: 0.8rem;
    margin-top: 2px;
  }
  .chart-title {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 4px;
  }
  .chart-sub {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0 0 10px;
  }
  .hbar-chart {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }
  .hbar-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .hbar-row-label {
    width: 128px;
    flex: 0 0 128px;
    font-size: 0.82rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hbar-row-track {
    display: block;
    flex: 1;
    background: var(--tag-bg);
    border-radius: 4px;
    height: 18px;
    overflow: hidden;
  }
  .hbar-row-fill {
    display: block;
    height: 100%;
    min-width: 3px;
    background: var(--accent);
    border-radius: 0 4px 4px 0;
  }
  .hbar-fill-high { background: #16a34a; }
  .hbar-fill-mid { background: #d97706; }
  .hbar-fill-low { background: #dc2626; }
  @media (prefers-color-scheme: dark) {
    .hbar-fill-high { background: #22c55e; }
    .hbar-fill-mid { background: #f59e0b; }
    .hbar-fill-low { background: #ef4444; }
  }
  .hbar-row-value {
    flex: 0 0 30px;
    text-align: right;
    font-size: 0.82rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .dash-empty {
    color: var(--muted);
    font-size: 0.9rem;
  }
</style>
</head>
<body>
<header>
  <h1>Veille des offres VIE</h1>
  <p class="subtitle">Finance · Comptabilité · Gestion · Banque</p>
  <p class="meta">Dernière vérification : <strong>${now}</strong>, <span id="count"></span> offre(s) en ligne.</p>
  <p class="meta"><a href="https://github.com/Nathan-NLB/vie-watcher/blob/claude/vie-finance-notifications-j770x1/README.md">Voir la liste en texte brut (README)</a></p>
  <div class="tabs">
    <button class="tab-btn active" data-tab="liste" type="button">Liste</button>
    <button class="tab-btn" data-tab="carte" type="button">Carte</button>
    <button class="tab-btn" data-tab="dashboard" type="button">Dashboard</button>
  </div>
</header>

<section id="panel-liste" class="panel active">
  <div class="search-wrap">
    <input type="search" id="search" placeholder="Rechercher (ville, entreprise, poste...)">
  </div>
  <main id="list"></main>
</section>

<section id="panel-carte" class="panel">
  <div id="globeViz"></div>
  <p class="map-hint">Touche ou clique un point pour voir les offres à cet endroit. Le point se place sur l'adresse de l'entreprise quand elle a pu être trouvée, sinon sur le centre de la ville.</p>
  <div id="carte-offres"></div>
</section>

<section id="panel-dashboard" class="panel">
  <div class="dash-wrap">
    <div class="stat-grid" id="stat-grid"></div>

    <div class="chart-block">
      <h2 class="chart-title">Top pays</h2>
      <div class="hbar-chart" id="chart-pays"></div>
    </div>

    <div class="chart-block">
      <h2 class="chart-title">Entreprises qui recrutent le plus</h2>
      <div class="hbar-chart" id="chart-entreprises"></div>
    </div>

    <div class="chart-block">
      <h2 class="chart-title">Répartition des indemnités</h2>
      <div class="hbar-chart" id="chart-indemnites"></div>
    </div>

    <div class="chart-block">
      <h2 class="chart-title">Offres en ligne par semaine de publication</h2>
      <div class="hbar-chart" id="chart-semaines"></div>
    </div>

    <div class="chart-block" id="chart-compat-block">
      <h2 class="chart-title">Répartition des scores de compatibilité</h2>
      <p class="chart-sub" id="chart-compat-sub"></p>
      <div class="hbar-chart" id="chart-compat"></div>
    </div>
  </div>
</section>

<script>
  const OFFRES = ${dataJson};
  const GEO_POINTS = ${geoJson};
  const DASHBOARD = ${dashboardJson};

  const listEl = document.getElementById("list");
  const searchEl = document.getElementById("search");
  const countEl = document.getElementById("count");
  const carteOffresEl = document.getElementById("carte-offres");

  function compatTier(score) {
    if (score >= 70) return "high";
    if (score >= 40) return "mid";
    return "low";
  }

  function renderOfferCard(o) {
    const lieu = [o.ville, o.pays].filter(Boolean).join(", ") || "Lieu non précisé";
    const hasCompat = typeof o.compatScore === "number";
    const compatTag = hasCompat
      ? \`<span class="tag tag-compat-\${compatTier(o.compatScore)}">\${o.compatScore} % compatible</span>\`
      : "";
    const compatBox = hasCompat
      ? \`<div class="compat-box compat-\${compatTier(o.compatScore)}">
          <strong>\${o.compatScore} % compatible avec ton profil</strong>
          <p>\${o.compatRaison}</p>
        </div>\`
      : "";

    const details = document.createElement("details");
    details.className = "offer";
    details.innerHTML = \`
      <summary>
        <p class="offer-title">\${o.titre}</p>
        <p class="offer-sub">\${o.entreprise} · \${lieu}</p>
        <div class="tags">
          \${compatTag}
          <span class="tag">\${o.indemnite}</span>
          <span class="tag">\${o.periode} (\${o.duree})</span>
          <span class="tag">Publiée le \${o.publieLe}</span>
        </div>
      </summary>
      <div class="offer-body">
        \${compatBox}
        <h3>Description du poste</h3>
        <p>\${o.description}</p>
        <h3>Profil recherché</h3>
        <p>\${o.profil}</p>
        <a class="offer-link" href="\${o.lien}" target="_blank" rel="noopener">Voir l'offre sur mon-vie-via.businessfrance.fr →</a>
      </div>
    \`;
    return details;
  }

  function render(offres) {
    countEl.textContent = offres.length;
    listEl.innerHTML = "";

    if (offres.length === 0) {
      listEl.innerHTML = '<p class="empty">Aucune offre ne correspond à ta recherche.</p>';
      return;
    }

    for (const o of offres) {
      listEl.appendChild(renderOfferCard(o));
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

  // Onglets
  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = {
    liste: document.getElementById("panel-liste"),
    carte: document.getElementById("panel-carte"),
    dashboard: document.getElementById("panel-dashboard"),
  };
  let globeInitialized = false;

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      Object.values(panels).forEach((p) => p.classList.remove("active"));
      panels[btn.dataset.tab].classList.add("active");
      if (btn.dataset.tab === "carte" && !globeInitialized) {
        globeInitialized = true;
        initGlobe();
      }
    });
  });

  // Tableau de bord
  function formatNombre(n) {
    return n.toLocaleString("fr-FR");
  }

  function renderStatTiles() {
    const tiles = [
      { value: formatNombre(DASHBOARD.totalActives), label: "Offres actuellement en ligne" },
      { value: formatNombre(DASHBOARD.totalVus), label: "Offres vues depuis le début" },
      {
        value: DASHBOARD.indemniteMediane != null
          ? \`\${Math.round(DASHBOARD.indemniteMediane).toLocaleString("fr-FR")} €\`
          : "N/C",
        label: "Indemnité médiane",
      },
      {
        value: DASHBOARD.indemniteMoyenne != null
          ? \`\${Math.round(DASHBOARD.indemniteMoyenne).toLocaleString("fr-FR")} €\`
          : "N/C",
        label: "Indemnité moyenne",
      },
      { value: formatNombre(DASHBOARD.nbPays), label: "Pays représentés" },
      { value: formatNombre(DASHBOARD.nbEntreprises), label: "Entreprises différentes" },
    ];

    if (DASHBOARD.compatNotees > 0) {
      tiles.push({
        value: \`\${DASHBOARD.compatMoyenne} %\`,
        label: \`Compatibilité moyenne (\${DASHBOARD.compatNotees} offre(s) notée(s))\`,
      });
    }

    const grid = document.getElementById("stat-grid");
    grid.innerHTML = tiles
      .map((t) => \`<div class="stat-tile"><span class="stat-value">\${t.value}</span><span class="stat-label">\${t.label}</span></div>\`)
      .join("");
  }

  function renderHBarChart(containerId, rows, fillClassFn) {
    const container = document.getElementById(containerId);
    if (!rows || rows.length === 0 || rows.every((r) => r.value === 0)) {
      container.innerHTML = '<p class="dash-empty">Pas encore assez de données.</p>';
      return;
    }
    const max = Math.max(...rows.map((r) => r.value), 1);
    container.innerHTML = rows
      .map((r) => {
        const pct = Math.max((r.value / max) * 100, 2);
        const fillClass = fillClassFn ? fillClassFn(r) : "";
        return \`
          <div class="hbar-row">
            <span class="hbar-row-label" title="\${r.label}">\${r.label}</span>
            <span class="hbar-row-track"><span class="hbar-row-fill \${fillClass}" style="width:\${pct}%"></span></span>
            <span class="hbar-row-value">\${r.value}</span>
          </div>
        \`;
      })
      .join("");
  }

  function renderDashboard() {
    renderStatTiles();
    renderHBarChart("chart-pays", DASHBOARD.pays);
    renderHBarChart("chart-entreprises", DASHBOARD.entreprises);
    renderHBarChart("chart-indemnites", DASHBOARD.indemniteBuckets);
    renderHBarChart("chart-semaines", DASHBOARD.semaines);

    const compatBlock = document.getElementById("chart-compat-block");
    if (DASHBOARD.compatNotees > 0) {
      document.getElementById("chart-compat-sub").textContent =
        \`Sur les \${DASHBOARD.compatNotees} offre(s) notée(s) depuis la mise en place du score.\`;
      renderHBarChart("chart-compat", DASHBOARD.compatBuckets, (r) => \`hbar-fill-\${r.tier}\`);
    } else {
      compatBlock.style.display = "none";
    }
  }

  renderDashboard();

  // Regroupe les offres géolocalisées par point (arrondi ~1 km) pour ne pas
  // empiler des dizaines de marqueurs au même endroit.
  function buildClusters() {
    const byOffer = new Map(OFFRES.map((o) => [o.id, o]));
    const clusters = new Map();

    for (const p of GEO_POINTS) {
      const offer = byOffer.get(p.id);
      if (!offer) continue;
      const key = p.lat.toFixed(2) + "," + p.lon.toFixed(2);
      if (!clusters.has(key)) {
        clusters.set(key, { lat: p.lat, lon: p.lon, ids: [] });
      }
      clusters.get(key).ids.push(p.id);
    }

    return [...clusters.values()];
  }

  function showOffersForCluster(ids) {
    const byOffer = new Map(OFFRES.map((o) => [o.id, o]));
    carteOffresEl.innerHTML = "";
    for (const id of ids) {
      const offer = byOffer.get(id);
      if (!offer) continue;
      const card = renderOfferCard(offer);
      card.open = true;
      carteOffresEl.appendChild(card);
    }
    carteOffresEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initGlobe() {
    const container = document.getElementById("globeViz");

    if (GEO_POINTS.length === 0) {
      container.innerHTML = '<p class="empty">Aucun lieu n\\'a pu être localisé pour l\\'instant.</p>';
      return;
    }

    const script = document.createElement("script");
    script.src = "${GLOBE_GL_URL}";
    script.onload = () => {
      const clusters = buildClusters();

      function makeMarker(d) {
        const el = document.createElement("div");
        el.className = "globe-marker";
        // globe.gl désactive les clics sur ses éléments HTML par défaut
        // (pointer-events: none) pour laisser passer la rotation du globe :
        // on le réactive explicitement pour que la bulle soit cliquable.
        el.style.pointerEvents = "auto";
        el.title = \`\${d.ids.length} offre(s) à cet endroit\`;
        el.innerHTML = \`<span class="globe-marker-dot"></span><span class="globe-marker-badge">\${d.ids.length}</span>\`;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          document.querySelectorAll(".globe-marker.active").forEach((m) => m.classList.remove("active"));
          el.classList.add("active");
          showOffersForCluster(d.ids);
        });
        return el;
      }

      const globe = Globe()(container)
        .width(container.clientWidth)
        .height(container.clientHeight)
        .backgroundColor("rgba(0,0,0,0)")
        .globeImageUrl("${EARTH_TEXTURE_URL}")
        .htmlElementsData(clusters)
        .htmlLat("lat")
        .htmlLng("lon")
        .htmlElement(makeMarker)
        .htmlAltitude(0.015);

      globe.controls().autoRotate = true;
      globe.controls().autoRotateSpeed = 0.6;
      globe.controls().addEventListener("start", () => (globe.controls().autoRotate = false));

      window.addEventListener("resize", () => {
        globe.width(container.clientWidth);
        globe.height(container.clientHeight);
      });
    };
    script.onerror = () => {
      container.innerHTML = '<p class="empty">Le globe n\\'a pas pu se charger (connexion internet nécessaire).</p>';
    };
    document.head.appendChild(script);
  }
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

  const geocache = readJson(GEOCACHE_FILE, {});
  const geoPoints = await resolveOfferLocations(offers, geocache);
  writeJson(GEOCACHE_FILE, geocache);

  // La note de compatibilité ne s'applique qu'aux offres qui apparaissent
  // à partir de maintenant, pas à celles déjà actives avant l'introduction
  // de cette fonctionnalité (pas de rattrapage rétroactif du passé).
  const compatCache = readJson(COMPAT_CACHE_FILE, {});
  if (!isFirstRun) {
    await resolveCompatScores(newOffers, compatCache);
    writeJson(COMPAT_CACHE_FILE, compatCache);
  }

  fs.writeFileSync(README_FILE, buildReadme(offers, compatCache));
  fs.mkdirSync(path.dirname(PAGE_FILE), { recursive: true });
  fs.writeFileSync(PAGE_FILE, buildOffersPageHtml(offers, geoPoints, compatCache, updatedSeenIds.size));

  const scoredCount = offers.filter((o) => compatCache[String(o.id)]).length;
  console.log(
    `Offres actives : ${offers.length}. Nouvelles notifiées : ${isFirstRun ? 0 : newOffers.length}. ` +
      `Localisées : ${geoPoints.length}/${offers.length}. Score de compatibilité : ${scoredCount}/${offers.length}` +
      (isFirstRun ? " (premier passage : initialisation sans notification)." : ".")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
