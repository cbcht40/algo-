# Let Trade Copieur

Panneau d'ordre **multi-comptes** pour Tradovate, natif Mac/Windows, sans NinjaTrader.

**Plus de compte maître ni de followers.** Tu passes ton ordre dans le Copieur ; il part sur
**tous les comptes du groupe en même temps** (les trames sont envoyées dos à dos sur des
websockets déjà ouverts → écart entre comptes de l'ordre de la milliseconde, affiché à chaque
ordre). Les stops et objectifs sont posés **au fill de chaque compte, à son propre prix**, puis
se déplacent **pour tout le groupe en un clic**.

> ⚠️ Outil de trading qui envoie de vrais ordres. Commence **toujours** en `demo` +
> `dryRun: true`. Tu es responsable du respect des règles de ta/tes prop firm(s).

**Deux façons d'entrer, même résultat :**

| | Comment | Latence entre comptes |
|---|---|---|
| **Relais Tradovate** (défaut, activé) | Tu trades **dans Tradovate** (chart, DOM, brackets…) sur n'importe quel compte du groupe. L'extension intercepte l'ordre **à l'instant où ton navigateur l'envoie** et le Copieur le tire sur les autres comptes. | quelques ms (navigateur → copieur → Tradovate, en parallèle de ton propre ordre) |
| **Panneau d'ordre** du Copieur | Tu cliques ACHETER / VENDRE dans l'app. | ≈ 0 (trames envoyées dos à dos) |

Le relais suit aussi tes **modifications** (stop déplacé sur le chart), **annulations** et
**clôtures** faites dans Tradovate : mapping exact via l'orderId (réponse relayée par
l'extension), sinon par correspondance contrat + sens + type sur chaque compte. Les
brackets natifs Tradovate (stratégie) sont relayés tels quels, quantités rescalées.
Le relais ne voit que le **navigateur** (pas l'app mobile / desktop Tradovate).

---

## 0. Démarrage (app)

1. Installe l'app (`.dmg` Mac / `.exe` Windows, releases GitHub `let-trade-copieur`).
2. Au premier lancement, l'assistant demande ta clé **Edge** (let-tradejournal.com/copieur),
   ouvre le Chrome Web Store pour installer l'**extension Let Trade Copieur** (elle capte ta
   session Tradovate — aucun mot de passe à saisir), découvre tes comptes, et te laisse
   **cocher ceux qui tradent ensemble**.
3. Le tableau de bord s'ouvre : panneau d'ordre à gauche, comptes à droite.

> Comptes prop firm (Eval/Funded) : pas d'« API Access » Tradovate, donc pas de login par mot
> de passe. On réutilise le **token de ta session web**, poussé en continu par l'extension.

## 1. Le tableau de bord

**Panneau d'ordre** (à gauche, toujours visible)
- **Instrument** : tape `MNQ`, choisis le contrat (suggestions Tradovate). Le tick et sa
  valeur en $ s'affichent ; les derniers instruments utilisés sont en raccourci.
- **Quantité de base** : stepper + presets. Chaque compte reçoit `base × son multiplicateur`
  (arrondi à l'unité inférieure — `×0,5` d'un lot n'envoie **rien**).
- **Type** : Marché / Limite / Stop, TIF Day ou GTC.
- **Stop & objectif automatiques** (en ticks) : posés au fill de chaque compte, à son prix.
  Le risque en $ pour le groupe est calculé en direct (et le R:R).
- **ACHETER / VENDRE** : un clic (confirmation optionnelle) → tous les comptes cochés et
  connectés. Le résultat indique `envoyés / total · latence · écart entre comptes`.
- **Annuler les ordres** : tous les ordres en attente, tous les comptes.

**Barre du haut**
- `n/N connectés`, **Comptes** (détecte les nouveaux comptes), **Verrouiller** (aucune entrée
  ne part, sorties toujours possibles), **Tout à plat** (annule tout + clôture au marché).

**Comptes du groupe** : interrupteur (dans le groupe ou non), état de session, positions,
protections en place, **× multiplicateur**, quantité résultante, et par compte : mettre à plat,
annuler ses ordres, actualiser, retirer. Glisser pour réordonner.

**Prix en direct** : le panneau affiche dernier / bid / ask / haut / bas de l'instrument
(flux de marché Tradovate, token de ta session) ; en Limite/Stop, un clic sur « bid »,
« dernier » ou « ask » remplit le prix. Chaque position montre son **P&L latent**, et
l'en-tête des comptes le P&L latent du groupe.

**Stops & objectifs du groupe** : une ligne par (instrument, stop/objectif), trois commandes :
- **Breakeven** (stops) : chaque stop revient au prix d'entrée de **son** compte (fill
  mémorisé, sinon prix moyen de la position), + N ticks dans le sens favorable.
- **Décaler** ±1/±4 ticks : chaque ordre bouge par rapport à **son** prix (les écarts entre
  comptes sont conservés).
- **Prix commun** + **Appliquer** : le même prix sur tous les comptes.

**Journal des ordres** : chaque action de groupe avec le détail par compte (clic sur la ligne).

## 2. Sécurités

- **Incidents** : toute action qui échoue sur un compte (ordre refusé, socket fermé, SL/TP
  non posé…) devient un incident visible en haut du tableau de bord (bandeau rouge + bip),
  avec « Réessayer » / « Ignorer ». Un échec **réseau** est **relancé automatiquement** dès
  que le compte revient (fenêtre 90 s, 2 tentatives max) ; un refus Tradovate (limite de
  risque…) reste manuel. Un incident « critique » = position sans protection ou non clôturée.
- **Pont local verrouillé** : seules les pages `*.tradovate.com` (content script) et
  l'extension peuvent parler au pont `127.0.0.1:7878`, et tout POST exige la **clé
  d'appairage** (`.copier-bridge.json`, remise à l'extension via `GET /pair`). Une page web
  quelconque reçoit 403.
- **Contrôle de synchronisation** (toutes les 3 s) : position ÷ multiplicateur doit être
  identique sur tous les comptes cochés. Un écart persistant > 6 s est signalé (bandeau + ligne
  rouge) — jamais corrigé automatiquement.
- **Garde anti-orphelins** : un compte revenu à plat sur un contrat (sortie manuelle dans
  Tradovate…) voit ses stops/objectifs posés par le Copieur annulés, pour ne pas rouvrir une
  position inverse.
- **Verrou** du panneau, **confirmation** avant envoi (activée par défaut), **simulation**
  (`dryRun`) qui journalise sans rien envoyer.
- Licence **Edge** requise pour les entrées ; annulations et mise à plat restent possibles
  même hors licence (72 h de grâce si le backend est injoignable).

## 3. Installation (développeur)

```bash
npm install
cp config.example.json config.json   # gitignored
npm start                            # moteur + dashboard http://127.0.0.1:7879
npm run app                          # la même chose dans la fenêtre Electron
npx tsx tools/test-group.ts          # tests des briques pures
```

Variables utiles : `COPIER_DRYRUN=1` (force la simulation), `COPIER_MODE=mirror` (ancien mode
maître/followers, voir §5), `DASHBOARD_PORT`, `BRIDGE_PORT`, `LOG_LEVEL=debug`,
`COPIER_LICENSE_BYPASS=1` (dev).

## 4. Configuration (`config.json`)

```jsonc
{
  "mode": "sync",             // défaut
  "environment": "demo",      // Eval = "demo" chez Tradovate
  "dryRun": true,             // true = log seulement, AUCUN ordre envoyé
  "license": "ltj_…",
  "auth": { "mode": "credentials" },
  "accounts": [
    { "label": "EVAL-1",      "accountSpec": "LFF05077107620001", "multiplier": 1, "enabled": true,  "accessToken": "…" },
    { "label": "FUNDED-150K", "accountSpec": "PAAPEX4744710000001", "multiplier": 3, "enabled": true,  "accessToken": "…", "environment": "live" }
  ]
}
```

- `accountSpec` = nom exact du compte ; `accountId` accepté à la place.
- `multiplier` : taille relative à la quantité de base ; `enabled` : dans le groupe ou non.
- Un `environment` par compte permet de mélanger demo (Eval) et live (Funded).
- Une ancienne config `master` + `followers` est **migrée automatiquement** au chargement
  (tous égaux, multiplicateur conservé).

## 5. Ancien mode « miroir » (maître → followers)

Toujours disponible : `"mode": "mirror"` (ou `COPIER_MODE=mirror`). Un compte maître tradé
dans Tradovate est recopié sur les followers dès que l'ordre apparaît côté serveur (latence =
aller-retour Tradovate, ~100–400 ms). Le tableau de bord historique est servi dans ce mode.

## 6. Structure

```
src/
  index.ts              # point d'entrée : sync (GroupEngine) ou mirror (CopierEngine)
  config.ts             # chargement + validation + migration master/followers → accounts
  copier/group.ts       # MODE SYNC : ordre de groupe, SL/TP au fill, garde, synchro
  copier/engine.ts      # mode mirror (historique)
  dashboard.ts/.html    # tableau de bord sync (API + page)
  dashboardMirror.ts / dashboard-mirror.html   # tableau de bord mirror
  setup.ts / onboarding.html                   # assistant premier lancement
  bridge.ts             # pont 127.0.0.1:7878 pour l'extension (tokens)
  tradovate/            # auth, websocket, client auto-réparant, types
electron/               # fenêtre + auto-update
extension/              # extension Chrome (capte le token de session)
tools/test-group.ts     # tests des briques pures
```

> Exécuté depuis un environnement cloud, l'accès sortant vers `tradovateapi.com` peut être
> bloqué. En local sur Mac/PC, aucun souci.
