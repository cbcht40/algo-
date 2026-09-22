# Backtesting local — protocole v1

Le moteur est indépendant du Copieur et ne possède aucune interface d’ordre réel. En développement, il démarre avec `npm run app:backtest`. Le paquet Mac dédié `Let-Trade Backtesting.app` possède son propre nom, son icône, son identifiant et le protocole `lettrade://backtest`. Il démarre directement sur la fenêtre d’appairage, sans ouvrir Tradovate ni le Copieur. La version Copieur conserve son application et ses mises à jour séparées.

Construire le paquet dédié avec `npm run dist:backtest:mac`. La version empaquetée réutilise le dossier `Let Trade Copieur/backtesting` de l’utilisateur afin de retrouver les séances et caches déjà créés, sans ouvrir les données ou identifiants du Copieur. Son canal de mise à jour automatique est désactivé jusqu’à la publication d’un canal propre au Backtesting.

## Organisation

- `src/backtest/service.mjs` : HTTP local, appairage, droits, catalogue, imports, sessions et SSE.
- `archive.mjs`, `import-worker.mjs` : métadonnées DBN, décodage progressif dans un worker, cache gzip et vérification SHA-256.
- `market.mjs` : carnet MBO et bougies révélées ; `engine.mjs` : ordres et comptabilité simulés.
- `runner.mjs` : horloge commune, lecture, reconstruction et sauvegarde atomique.
- `capture.mjs` : format de collecte normalisé et relecture ; aucun transport Rithmic de production n’est activé.
- `storage.mjs` : limite de cache, rétention et protection des fichiers référencés.
- `protocol.d.ts` : interfaces des contrats, événements, commandes et résultats v1.
- `electron/backtest.*` : fenêtre locale, sélection native de fichiers, code d’appairage.

Le décodeur embarqué est le CLI Rust officiel `dbn` 0.70.0, construit et distribué par Databento. `scripts/prepare-backtest-decoder.mjs` télécharge les binaires officiels pour macOS ARM/Intel et Windows x64, contrôle leurs SHA-256 et inclut leur licence Apache 2.0. Les originaux DBN sont toujours ouverts en lecture seule.

## Liaison navigateur / compagnon

Le serveur écoute exclusivement `127.0.0.1:7880`. Il refuse les autres en-têtes Host et les origines non autorisées. En production, seules les deux origines HTTPS Let-Trade et l’origine locale de la fenêtre de liaison sont autorisées. `BACKTEST_DEV_ORIGIN` est ignoré dans l’application empaquetée.

`POST /v1/pair` reçoit un code local à six chiffres et le JWT de l’utilisateur. Le compagnon vérifie le JWT et Edge auprès de `/api/backtest?op=entitlement`, puis délivre une capacité aléatoire limitée à cet utilisateur et à cette origine pour une heure. Le code est renouvelé après utilisation. Les tentatives sont limitées. Les capacités sont transmises dans `Authorization`, jamais dans une URL. Le renouvellement vérifie de nouveau l’abonnement.

Brave et Chrome utilisent directement HTTP local après autorisation réseau local. Safari dispose du bouton « Connexion compatible Safari » : une fenêtre locale de premier niveau relaie les requêtes et le flux. Le relais contrôle la fenêtre émettrice, l’origine exacte, un canal aléatoire et une liste fermée de chemins Backtesting. Sa CSP limite les scripts à ses fichiers locaux et les connexions au service local. Il ne lit aucun fichier ni aucun identifiant en dehors des appels explicitement appairés. Fermer cette fenêtre coupe la liaison.

Principaux chemins authentifiés, tous sous `/v1` :

| Chemin | Fonction |
|---|---|
| `/catalog` | Contrats et fichiers, sans chemins absolus |
| `/import` | Ouvre le sélecteur natif de fichiers ou dossier |
| `/jobs/:id` | Progression et annulation d’un travail appartenant au compte |
| `/sessions` | Liste ou préparation d’une séance |
| `/sessions/:id` | État de la séance |
| `/sessions/:id/commands` | Commandes simulées et commandes de lecture |
| `/sessions/:id/events` | Flux SSE authentifié, intervalle et seconde vue |
| `/sessions/:id/export` | Résumé autorisé pour la synchronisation |
| `/storage` | Consommation et limite de stockage |
| `/renew`, `/disconnect` | Renouvellement ou révocation de la capacité |

## Données et simulation

La première normalisation opérationnelle accepte les fichiers CME `GLBX.MDP3` de schéma MBO. Les échéances et leurs identifiants proviennent des correspondances datées DBN ; les spreads sont séparés. Les contrats sans tick, valeur du point et devise vérifiés sont bloqués. Les racines CME connues ont des spécifications intégrées ; des fichiers DBN `definition` peuvent compléter les spécifications monétaires. Les autres schémas et places ne sont pas présentés comme pris en charge.

Les enregistrements sont lus dans l’ordre du fournisseur avec leurs entiers 64 bits préservés. Le carnet traite les réinitialisations, snapshots, ajouts, modifications et annulations. Seuls les messages `T` produisent du volume, pas les messages `F`. La frontière `F_LAST` est obligatoire avant exposition d’un état. Les indicateurs de carnet potentiellement corrompu et d’horodatage incertain suspendent les opérations dépendantes. Un sens agressif inconnu reste inconnu.

Les commandes sont sérialisées avec la lecture. Les ordres ne peuvent s’exécuter que sur un événement atomique ultérieur. Un ordre marché consomme la meilleure cotation disponible avec la limite de volume observée et le glissement configuré. Une limite déjà passive exige une transaction au-delà de sa limite ; toucher son prix ou déplacer une cotation ne suffit pas. Les volumes utilisés par plusieurs ordres sont partagés. Ce modèle prudent ne simule pas une position exacte dans la file d’attente.

Le stop déclenché devient un ordre marché et supporte les gaps. Les protections SL/TP sont liées à la position et redimensionnées lors d’une réduction ; elles sont annulées après clôture. Les frais sont comptabilisés par contrat et côté. Les prix et montants sont calculés en entiers ; le P&L réalisé, les frais et le latent restent séparés. Le win rate et le profit factor portent sur les positions entièrement closes. Le drawdown prend en compte l’équité au fil des événements. Un R initial inconnu reste nul.

La sauvegarde contient les commandes, exécutions, positions, curseur de fichier, notes et dessins. La reprise reconstruit le carnet jusqu’au curseur sauvegardé avant de réactiver les commandes. « Nouvel essai » crée un nouvel identifiant avec `attemptOf` ; l’essai précédent est conservé. Le navigateur déconnecté met la lecture en pause après dix secondes sans activité.

## Limites explicites de cette livraison

- Une séance utilise un fichier et un contrat exact. Le catalogue peut contenir un dossier entier ; le raccordement automatique de plusieurs fichiers en une séance est une évolution distincte.
- Le cache économise le redécodage DBN ; une reprise au milieu d’un fichier reconstruit encore le préfixe du carnet. Aucun événement comptable n’est sauté.
- Graphique : 1 600 bougies agrégées affichées ; carnet : 10 niveaux visibles par côté ; footprint : dernière heure et 250 niveaux au maximum, avec avertissement de vue partielle.
- L’historique local conserve toutes les exécutions ; l’interface présente les 500 dernières et la synchronisation les 2 000 dernières positions et points d’équité. Les statistiques utilisent le registre complet.
- La collecte Rithmic reste fermée. Il manque l’accès développeur, le transport officiel, le stockage sécurisé des identifiants, la validation contractuelle et un test de collecte réelle. Le format de capture et son moteur de relecture sont prêts et testés avec des événements synthétiques.
- La distribution macOS nécessite une notarisation Apple valide. Ne pas remplacer la version publique notarialisée par un binaire seulement signé.

## Vérification

`npm run test:backtest` couvre la comptabilité, les protections, le passage d’événements atomiques, l’absence de fuite du futur, les limites passives, les gaps, la reprise, toutes les vitesses, la collecte normalisée, la rétention et l’isolation HTTP.

`node tools/smoke-backtest-dbn.mjs <fichier.dbn.zst> <contrat>` normalise puis reconstruit intégralement un fichier local. Le harness `tools/serve-backtest-qa.mjs` est exclusivement local et n’est jamais embarqué ; sa fausse identité n’est acceptée par aucun compagnon livré.
