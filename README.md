# Tradovate Copier (Mac)

Copieur de trades **quasi-instantané** pour Tradovate, par **réplication d'ordres**
(comme Copilink) — mais **natif Mac**, sans NinjaTrader.

Tu trades sur un compte **maître** ; chaque ordre est recopié en temps réel sur tes
comptes **followers** (prop firms Eval/Funded), via l'**API Tradovate** (WebSocket
persistant → latence minimale).

> ⚠️ Outil de trading qui envoie de vrais ordres. Commence **toujours** en `demo`
> + `dryRun: true`. Tu es responsable du respect des règles de ta/tes prop firm(s).

---

## 0. Mode autonome (recommandé) — calibre une fois, tourne tout seul

```bash
npm run setup              # 1 token par firme, choix du maître, demo/live auto
npm run service:install    # service 24/7 : démarre au boot, relance auto
```

Puis, pour ne **plus jamais coller de token**, installe l'**extension Copilink**
(dossier `extension/`, voir `extension/README.md`) : tant que tes onglets
Tradovate sont ouverts, elle capte et transmet les tokens au copieur toute seule.

- **Service macOS (launchd)** : démarre à l'allumage du Mac, se relance en cas
  de crash, logue dans `logs/copier.log` (`npm run service:logs`).
- **Renouvellement & cache** : tant que le copieur tourne il renouvelle ses
  tokens; le cache disque (`.tradovate-tokens.json`, gitignored) permet de
  reprendre après un redémarrage.
- **Extension Copilink** : pont local `127.0.0.1:7878` + lecture du token de ta
  propre session → autonomie réelle, même après une longue coupure.

> Note : les comptes prop firm (Eval/Funded) n'ont pas l'« API Access » de
> Tradovate, donc **pas de login par mot de passe** : on réutilise le token de
> session (collé une fois, ou fourni en continu par l'extension).

## 1. Deux modes de connexion

Tradovate exige un compte **LIVE + >5000 $ + abonnement API Access** pour générer une
**clé API**. Tes comptes prop firm **Eval n'y ont donc pas droit**. Mais on n'en a pas
besoin :

| Mode | Pour qui | Comment |
|---|---|---|
| **`token`** (recommandé pour prop firm) | Comptes **Eval/Funded** | On réutilise le **token de ta session web** déjà connectée. Aucune clé API. |
| **`apikey`** | Compte **LIVE** avec API Access | Authentification classique `cid`/`sec`. |

**Pourquoi le mode token marche :** `cid`/`sec` ne servent qu'à *fabriquer* un token.
Une fois connecté sur `trader.tradovate.com`, ton navigateur **a déjà** un token
valide (c'est lui qui passe tes ordres). Le renouvellement et **tous** les appels
d'ordres n'ont besoin **que du token**. On réutilise donc celui de ta session.

## 2. Récupérer ton token de session (mode token)

1. Connecte-toi sur **https://trader.tradovate.com** (laisse l'onglet ouvert).
2. Ouvre les **outils développeur** :
   - Chrome : `Cmd+Option+I`
   - Safari : Réglages → Avancé → « Afficher les fonctionnalités… développeur », puis `Cmd+Option+I`
3. Onglet **Network / Réseau**. Filtre sur `tradovateapi`.
4. Clique sur une requête vers `*.tradovateapi.com` → **Headers** → cherche
   `Authorization: Bearer XXXXX`. **Copie la partie après `Bearer `** : c'est ton token.
5. Note aussi l'**hôte** appelé (ex. `demo.tradovateapi.com`). S'il diffère de
   demo/live, renseigne `auth.restBase` / `auth.wsUrl` (voir §4).

> Le token a une durée de vie limitée. Tant que le copieur tourne, il le **renouvelle
> tout seul** (garde ta session web connectée). S'il a totalement expiré, recolle un
> token frais et relance.

## 3. Installation

```bash
npm install
cp config.example.json config.json
```

`config.json` est **gitignored** : tes identifiants ne seront jamais committés.

## 4. Configuration (`config.json`)

**Mode token** (prop firm Eval — tous tes comptes sont en général sous **un seul
login**, donc **un seul token** couvre maître + followers) :

```jsonc
{
  "environment": "demo",      // Eval = "demo" chez Tradovate
  "appId": "MacCopier",
  "appVersion": "0.1",
  "dryRun": true,             // true = log seulement, AUCUN ordre envoyé

  "auth": {
    "mode": "token",
    "accessToken": "colle_ton_token_ici",
    "restBase": "https://demo.tradovateapi.com/v1",   // optionnel (si hôte différent)
    "wsUrl": "wss://demo.tradovateapi.com/v1/websocket" // optionnel
  },

  "master":   { "label": "MASTER", "accountSpec": "LFF05077107620002" },
  "followers": [
    { "label": "EVAL-4", "accountSpec": "LFF05077107620004", "multiplier": 1 },
    { "label": "EVAL-5", "accountSpec": "LFF05077107620005", "multiplier": 1, "symbolMap": { "MESU6": "ESU6" } }
  ]
}
```

- `accountSpec` = le nom exact du compte (ex. `LFF05077107620002`), ou `accountId` (nombre).
- `multiplier` : `2` double la taille, `0.5` la divise (arrondi).
- Si certains comptes sont sous **un autre login**, ajoute un `accessToken` propre à
  l'objet compte concerné.

**Mode apikey** (compte LIVE avec API Access) : mets `auth.mode = "apikey"` et donne à
chaque compte `name`, `password`, `cid`, `sec` (au lieu du token global).

## 5. Lancement

```bash
npm start                 # utilise ./config.json
npm start ma-config.json  # ou un chemin précis
LOG_LEVEL=debug npm start # logs détaillés
```

Workflow conseillé :

1. `dryRun: true` → passe un ordre sur le maître, vérifie les lignes `[DRY] FOLLOWER…`.
2. `dryRun: false` sur tes comptes **Eval** (sans risque réel) → vérifie la copie réelle.
3. Live réel : `multiplier` petit et **1 contrat** d'abord.

Arrêt : `Ctrl+C` (ferme les connexions ; ne touche pas à tes positions).

## 6. Comment ça marche

```
  Compte MAÎTRE ──(WebSocket, temps réel)──► CopierEngine ──(WebSocket)──► Followers
  tu passes un ordre        events                réplique           order/placeorder
```

- WebSocket **persistant pré-authentifié** par login (heartbeat 2,5 s, reconnexion
  auto avec backoff, renouvellement du token).
- `user/syncrequest` récupère l'état complet, puis les **événements** (ordres / fills /
  positions) arrivent en push.
- Quand un ordre devient `Working` sur le maître (ou un `Market` exécuté), il est
  recopié **en parallèle** sur tous les followers : `action`, `orderType`, prix,
  `orderQty × multiplier`, instrument (avec remap éventuel).
- **Annulations** et **modifications** du maître sont propagées aux followers.

## 7. Sécurité & limites (lire avant le réel)

- **Démarre à plat** : les ordres/positions déjà ouverts au lancement **ne sont pas**
  répliqués (seuls les ordres passés *après* le démarrage le sont). Avertissement si le
  maître n'est pas à plat.
- **Brackets/OCO (SL+TP)** : chaque ordre est copié individuellement ; l'annulation
  d'une jambe OCO du maître est propagée, mais il existe une petite fenêtre où les
  jambes follower ne sont pas liées en OCO. Reconstruction OCO native prévue (§8).
- **Partiels / rejets** : un rejet follower (ex. limite de risque prop firm) est
  **loggé** sans bloquer les autres followers.
- **Règles prop firm & ToS** : le mode token réutilise **ta propre** session — c'est
  *tes* comptes. Copier entre tes propres comptes est généralement permis ; l'auto
  « set & forget » est parfois encadré. Reste conforme à tes conditions.

## 8. Feuille de route

- [ ] Reconstruction **bracket/OCO native** sur les followers (SL/TP liés).
- [ ] **Garde-fous prop firm** : perte journalière max/compte (auto-flatten), position
      max, **kill-switch** global.
- [ ] Filet de sécurité par **réconciliation de position**.
- [ ] **Extension navigateur** (lit le token de session automatiquement, zéro copier-coller).
- [ ] Petite **interface** (dashboard) pour piloter et voir l'état en direct.

## Structure

```
src/
  index.ts              # point d'entrée CLI
  config.ts             # chargement + validation (modes token / apikey)
  logger.ts             # logs horodatés par compte
  tradovate/
    auth.ts             # token (REST) : acquire (apikey) + renew (token) + penalty
    ws.ts               # protocole de trames WebSocket (o/h/a/c, requêtes)
    client.ts           # connexion auto-réparante : auth, heartbeat, requêtes, events
    types.ts            # modèles d'entités (order, orderVersion, fill, position…)
  copier/
    masterBook.ts       # état local du carnet d'ordres du maître
    engine.ts           # moteur de réplication (placements, annulations, modifs)
```

> Note : exécuté depuis un environnement cloud, l'accès réseau sortant vers
> `tradovateapi.com` peut être bloqué (« host not in allowlist »). En local sur Mac,
> aucun souci.
