# Copilink — extension navigateur

Capte automatiquement le token de ta session Tradovate et l'envoie au copieur
local. **Plus jamais de copier-coller de token.**

## Comment ça marche
1. Le copieur (`npm start`) ouvre un petit pont local sur `http://127.0.0.1:7878`.
2. Sur la page Tradovate, un script lit le token **directement** (hook de
   `fetch`/`WebSocket` + scan du stockage local) — fiable même quand l'app est au
   repos. Rien ne sort de ta machine.
3. L'extension pousse le token au copieur, et renvoie chaque renouvellement.
   Si le copieur était éteint, elle réessaie toute seule chaque minute.

> Après une mise à jour de l'extension : sur `chrome://extensions`, clique
> l'icône **↻ recharger** de Copilink, **puis recharge l'onglet Tradovate**.

> C'est exactement ce que tu faisais à la main dans DevTools — automatisé. Aucun
> mot de passe, aucune clé : juste le token de ta session déjà ouverte.

## Installation (Chrome / Brave / Edge) — 30 secondes
1. Ouvre `chrome://extensions`.
2. Active **« Mode développeur »** (en haut à droite).
3. Clique **« Charger l'extension non empaquetée »** et choisis le dossier
   **`extension/`** de ce projet.
4. L'icône **C** apparaît dans la barre. Épingle-la.

## Utilisation
1. Lance le copieur : `npm start` (ou le service 24/7).
2. Laisse tes onglets **trader.tradovate.com** ouverts et connectés (un par firme).
3. Clique l'icône **C** : la popup montre
   - 🟢/🔴 si le **copieur est en ligne**,
   - la liste des **comptes détectés** avec la validité du token et l'état
     (`✓ relié`).

Le badge sur l'icône indique le nombre de logins captés (vert = au moins un
transmis au copieur).

## Notes
- Port par défaut `7878`. Si tu le changes (`BRIDGE_PORT`), édite `COPIER` dans
  `background.js` et `popup.js`.
- Les tokens ne sont **jamais** écrits sur le disque par l'extension : ils vivent
  en mémoire et sont re-captés à la prochaine requête Tradovate.
