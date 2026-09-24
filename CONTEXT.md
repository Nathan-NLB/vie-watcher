# Contexte complet du projet vie-watcher

Ce fichier résume tout ce qui a été fait sur ce projet, pour reprendre le travail
dans une nouvelle conversation sans tout ré-expliquer. Il n'est pas lié au site
public (il n'est pas dans `docs/`), juste un aide-mémoire dans le dépôt.

## Prompt à coller après un /clear

```
Je reprends le projet vie-watcher (dépôt GitHub Nathan-NLB/vie-watcher,
branche claude/vie-finance-notifications-j770x1). Lis d'abord le fichier
CONTEXT.md à la racine du dépôt (déjà cloné dans /home/user/vie-watcher)
pour avoir tout le contexte : objectif du projet, architecture, secrets
utilisés, fonctionnalités déjà en place, et point ouvert en cours
(score de compatibilité cassé - modèle Gemini à corriger). Confirme-moi
que tu as bien tout lu avant qu'on continue.
```

## Objectif du projet

Nathan (contrôleur de gestion, recherche un VIE en contrôle de gestion / FP&A à
l'international) voulait être averti automatiquement des nouvelles offres de VIE
dans la catégorie "Finance Comptabilité Gestion Banque" sur
mon-vie-via.businessfrance.fr, sans avoir à coder lui-même.

## Où est tout

- Dépôt GitHub : https://github.com/Nathan-NLB/vie-watcher (**public**, nécessaire pour GitHub Pages)
- Branche de travail : `claude/vie-finance-notifications-j770x1` (c'est aussi la
  branche par défaut du dépôt - particularité : le dépôt était vide à la création,
  donc GitHub a gardé cette branche comme branche par défaut au lieu de `main`)
- Page publique consultable par Nathan : **https://nathan-nlb.github.io/vie-watcher/**
- Dans le bac à sable local : `/home/user/vie-watcher`

## Architecture

Un seul script Node fait tout : `scripts/check-offers.mjs`. Il est exécuté par
GitHub Actions (`.github/workflows/watch-vie-offers.yml`) toutes les 20 minutes
(cron `*/20 * * * *`), plus déclenchable manuellement (`workflow_dispatch`).

À chaque exécution, le script :
1. Interroge l'API publique de Civiweb/Businessfrance (voir ci-dessous) filtrée
   sur la catégorie Finance (specializationId `19`)
2. Compare avec `data/seen-ids.json` (liste de tous les ids d'offres déjà vus,
   depuis le début) pour détecter les offres réellement nouvelles
3. Envoie une notification push (ntfy.sh) pour chaque offre nouvelle
4. Géolocalise chaque offre (cache dans `data/geocache.json`)
5. Note la compatibilité de chaque **nouvelle** offre avec le profil de Nathan
   via l'API Gemini (cache dans `data/compat-scores.json`)
6. Régénère `README.md` (liste texte brut) et `docs/index.html` (la page
   publique, avec onglets Liste / Carte / Dashboard)
7. Committe et pousse les fichiers changés (`data/`, `README.md`, `docs/`), avec
   une logique de nouvelle tentative (pull --rebase + retry) en cas de conflit
   git avec un push concurrent

## APIs et services externes utilisés

### 1. API des offres (Civiweb / Businessfrance)
- Endpoint recherche : `https://civiweb-api-prd.azurewebsites.net/api/Offers/search` (POST)
- Clé : `l+KwpoLPiXlsjxNT/NQ2iOFz8+iuygxAODs9FeAEWYM=` — clé **publique**, livrée
  à tous les navigateurs par le site (trouvée dans le JS du site), pas un secret
  personnel. Codée en dur dans le script.
- Catégorie ciblée : `specializationsIds: ["19"]` (= "FINANCE COMPTABILITE GESTION BANQUE")
- Détail d'une offre : `https://mon-vie-via.businessfrance.fr/offres/{id}`

### 2. Notifications push : ntfy.sh (gratuit, aucun compte)
- Secret GitHub : `NTFY_TOPIC` = `vie-finance-5c88b533`
- Nathan a installé l'appli ntfy (iOS/Android) et s'est abonné à ce sujet
- Limite gratuite ntfy.sh : **250 messages/jour**, mais comptée par IP
  expéditrice, pas par sujet. Les runners GitHub Actions changent d'IP à
  chaque exécution donc cette limite n'est jamais un problème pour le robot
  (seulement pour des tests répétés depuis une IP fixe, ce qui a été observé
  en environnement de développement, sans impact sur le robot réel)

### 3. Géocodage : OpenStreetMap Nominatim (gratuit, aucune clé)
- Endpoint : `https://nominatim.openstreetmap.org/search`
- User-Agent obligatoire : `vie-watcher (https://github.com/Nathan-NLB/vie-watcher)`
- Essaie d'abord `entreprise + ville + pays` (adresse précise), sinon retombe sur
  `ville + pays`. Respecte 1 requête/seconde (délai de 1,1s entre appels),
  résultats mis en cache indéfiniment dans `data/geocache.json`

### 4. Score de compatibilité : Google Gemini (gratuit, sans carte bancaire)
- Secrets GitHub : `GEMINI_API_KEY` et `CANDIDATE_PROFILE` (résumé texte du CV
  de Nathan, écrit par Claude, jamais stocké comme fichier dans le dépôt)
- Clé créée par Nathan sur aistudio.google.com
- **⚠️ PROBLÈME EN COURS** : le nom de modèle utilisé change de version très
  vite chez Google et casse régulièrement :
  - `gemini-2.0-flash` → retiré (erreur 404, suggérait `gemini-3.6-flash`)
  - `gemini-3.6-flash` → quota gratuit trop faible (20 requêtes/jour seulement)
  - `gemini-3.6-flash-lite` → utilisé ensuite, mais depuis le 24/09 renvoie
    aussi une erreur 404 ("not found for API version v1beta")
  - **À corriger** : trouver un nom de modèle Gemini actuel avec un quota
    gratuit suffisant (viser une variante "flash-lite" ou équivalent léger).
    Vérifier le nom exact avant de coder, les noms de modèles Gemini changent
    vite (cf. skill "claude-api" ou recherche web pour la doc Gemini à jour)
  - Tant que ce n'est pas corrigé, le site continue de fonctionner normalement,
    juste sans badge de compatibilité sur les nouvelles offres
- La constante à modifier est `GEMINI_MODEL` dans `scripts/check-offers.mjs`
- **Le score ne s'applique qu'aux offres apparues après la mise en place de
  cette fonctionnalité** (23/09/2026), pas de rattrapage rétroactif des
  anciennes offres (décision explicite de Nathan, pour ne pas gaspiller le
  quota gratuit sur des offres déjà visibles depuis longtemps)

## Fichiers de données (committés dans le dépôt, jamais en `.gitignore`)

- `data/offers.json` — les offres actuellement actives (remplacé à chaque run)
- `data/seen-ids.json` — **tous** les ids d'offres jamais vus depuis le début
  (grandit indéfiniment, sert à détecter les nouvelles offres et ne redéclenche
  jamais de notification en double)
- `data/geocache.json` — cache de géocodage (clé = entreprise/ville/pays, jamais purgé)
- `data/compat-scores.json` — cache des scores de compatibilité par id d'offre
  (jamais recalculé une fois obtenu)

## La page publique (docs/index.html) — 3 onglets

Générée entièrement par `buildOffersPageHtml()` dans le script (HTML/CSS/JS
vanilla, aucune dépendance sauf le globe). Fonctionne en clair et sombre
(`prefers-color-scheme`).

### Onglet Liste
Recherche texte libre (titre/entreprise/ville/pays), cartes dépliables par
offre : entreprise, lieu, indemnité, **dates précises de la mission** ("Du X au Y"),
badge de compatibilité coloré (vert ≥70%, orange 40-69%, rouge <40%) avec
l'explication de l'IA, description complète, lien vers l'offre originale.

### Onglet Carte
Globe 3D interactif (librairie **globe.gl** via CDN jsdelivr, épinglée en
version `2.46.2`, texture Terre via le paquet `three-globe`). Un marqueur (pastille
rouge avec le nombre d'offres) par lieu géolocalisé. Cliquer un marqueur affiche
les offres correspondantes juste en dessous, dépliées directement (pas besoin
d'un clic supplémentaire).
**Bug corrigé** : globe.gl met `pointer-events: none` par défaut sur ses éléments
HTML (pour laisser tourner le globe à la souris) — sur mobile ça bloquait
complètement le tap. Corrigé en forçant `pointer-events: auto` sur chaque marqueur.

### Onglet Dashboard
- Chiffres clés (stat tiles) : offres actives, total vu depuis le début,
  indemnité médiane/moyenne, pays/entreprises distincts, compatibilité moyenne
- Graphiques en barres horizontales (une seule teinte bleue, suit la méthode du
  skill `dataviz` : forme selon le job des données, couleur en dernier) : top
  pays, entreprises qui recrutent le plus, répartition des indemnités par
  tranche, offres par semaine de publication, répartition des scores de
  compatibilité (coloré rouge/orange/vert par tranche)
- **Filtres combinables** : cliquer une ligne l'ajoute à une sélection multi-
  critères (façon facettes) au lieu de remplacer le résultat précédent.
  Plusieurs valeurs d'un même graphique = OU (Belgique ou France). Plusieurs
  graphiques différents = ET (une tranche d'indemnité ET un niveau de
  compatibilité). Puces retirables individuellement + bouton "Tout effacer".
- **Bug corrigé en cours de route** : les barres utilisaient des `<span>`
  (display inline par défaut, ignore width/height) → invisibles. Corrigé avec
  `display: block` sur les éléments de barre.

## Décisions de conception importantes (le "pourquoi")

- **Aucune notification au tout premier passage** : sinon Nathan aurait reçu
  d'un coup une notification pour chacune des ~80 offres déjà en ligne au
  moment de l'installation. Le premier passage se contente d'enregistrer
  silencieusement ce qui existe déjà.
- **Score de compatibilité seulement pour les offres futures**, pas de
  rattrapage du passé (cf. section Gemini ci-dessus).
- **Dépôt public** (nécessaire pour GitHub Pages gratuit) : accepté par Nathan
  car le contenu (offres VIE publiques + un résumé de CV sans coordonnées
  sensibles) n'est pas confidentiel. Le CV complet et la clé API ne sont eux
  jamais dans le dépôt, seulement en secrets GitHub chiffrés.
- **Retry sur le push git** dans le workflow (`git pull --rebase` + jusqu'à 5
  tentatives) : ajouté après un vrai incident où le push automatique du robot
  est entré en collision avec un push manuel fait pendant le développement.

## Incident notable déjà résolu (pour référence si Nathan en reparle)

Une offre (id 245944, ALPINEO CONSULTING LYON, "Gestionnaire Financier Groupe",
Vernier/Suisse) a été détectée comme nouvelle pendant une exécution **locale**
du script par Claude (pendant le développement d'une autre fonctionnalité),
donc sans la variable d'environnement `NTFY_TOPIC` configurée : elle a été
marquée comme "vue" sans qu'aucune notification soit envoyée. Nathan en a été
informé explicitement dans la conversation. C'est un cas isolé (1 offre sur 9
détectées depuis le début) ; toutes les autres notifications, envoyées par le
vrai robot GitHub Actions, ont été confirmées par les logs comme correctement
envoyées.

## Préférences de Nathan à respecter

- Ne sait pas coder du tout : tout expliquer simplement, étape par étape,
  jamais supposer qu'il peut lire du code
- Toujours demander confirmation avant une étape qui coûte de l'argent ou crée
  un nouveau compte externe (a refusé une solution payante pour le score de
  compatibilité, d'où le choix de Gemini gratuit plutôt que Claude/OpenAI)
- Explique la solution technique envisagée *avant* de l'implémenter quand c'est
  une décision structurante
- Langue : français dans les réponses
- Ne jamais utiliser de tiret cadratin (—) dans les réponses ni dans le
  contenu généré (README, page)
- Sauvegarder les infos durables (comme le profil CV) dans le projet
  (secrets GitHub), jamais seulement dans la mémoire de la conversation

## Ce qui reste à faire / pistes possibles

1. **Corriger le modèle Gemini** (voir section dédiée ci-dessus) — priorité
   immédiate, le score de compatibilité est actuellement cassé pour toute
   nouvelle offre
2. Surveiller si Google recasse encore le nom du modèle à l'avenir (ça s'est
   déjà produit deux fois en 2 jours) — envisager peut-être un mécanisme de
   repli automatique sur plusieurs noms de modèles candidats
3. Rien d'autre n'est en attente ; toutes les demandes explicites de Nathan à
   ce jour (24/09) ont été traitées : dates de mission, score de compatibilité,
   carte, dashboard, filtres combinables, vérification des notifications
