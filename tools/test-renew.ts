// Renouvellement du jeton de session : contrôle PÉRIODIQUE (survit à la veille du Mac)
// plutôt qu'un minuteur unique posé à l'échéance.  npx tsx tools/test-renew.ts
import assert from "node:assert/strict";
import { TradovateClient } from "../src/tradovate/client";

let n = 0;
const t = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve(fn()).then(() => { n++; console.log("✓", name); });

const client = () => new TradovateClient({ label: "t", environment: "demo", appId: "a", appVersion: "1", accessToken: "x" }) as any;
const inMin = (m: number) => new Date(Date.now() + m * 60000).toISOString();

await t("hors marge (60 min restantes) → aucun renouvellement, mais un intervalle armé", async () => {
  const c = client();
  c.saveToken = () => undefined;
  let auth = 0;
  c.authenticate = async () => { auth++; };
  c.token = { accessToken: "tok", expirationTime: inMin(60) };
  c.scheduleRenewal();
  assert.ok(c.renewTimer, "intervalle armé");
  await c.renewIfDue();
  assert.equal(auth, 0);
  clearInterval(c.renewTimer);
});

await t("dans la marge (3 min) → renouvellement tenté ; échec réseau → ré-authentification", async () => {
  const c = client();
  c.saveToken = () => undefined;
  let auth = 0;
  c.authenticate = async () => { auth++; };
  c.token = { accessToken: "tok", expirationTime: inMin(3) };
  await c.renewIfDue(); // pas de réseau en test → renewAccessToken échoue → authenticate()
  assert.equal(auth, 1, "ré-authentification déclenchée");
  assert.equal(c.renewing, false, "verrou relâché même en cas d'échec");
});

// RÉGRESSION 0.5.3 : renouveler referme le websocket. Sans « une tentative par jeton », la
// fenêtre de fin de vie provoquait une reconnexion toutes les 30 s (constaté en séance).
await t("un SEUL renouvellement par jeton — pas de reconnexion toutes les 30 s en fin de vie", async () => {
  const c = client();
  c.saveToken = () => undefined;
  let tries = 0;
  c.authenticate = async () => { tries++; };
  c.token = { accessToken: "meme-jeton", expirationTime: inMin(3) };
  for (let i = 0; i < 10; i++) await c.renewIfDue(); // 10 tours d'horloge = 5 minutes
  assert.equal(tries, 1, "une seule tentative malgré 10 passages");
});

await t("jeton marqué non renouvelable (renouvellement sans gain) → plus aucune tentative", async () => {
  const c = client();
  c.saveToken = () => undefined;
  let tries = 0;
  c.authenticate = async () => { tries++; };
  // état laissé par un renouvellement qui n'a pas repoussé l'échéance : renewedFrom = jeton courant
  c.token = { accessToken: "b1", expirationTime: inMin(3) };
  c.renewedFrom = "b1";
  c.lastRenewAt = 0;
  for (let i = 0; i < 5; i++) await c.renewIfDue();
  assert.equal(tries, 0, "on attend un jeton frais plutôt que de couper la session en boucle");
});

await t("plancher d'une minute entre deux renouvellements", async () => {
  const c = client();
  c.saveToken = () => undefined;
  let tries = 0;
  c.authenticate = async () => { tries++; };
  c.token = { accessToken: "t1", expirationTime: inMin(3) };
  await c.renewIfDue();
  assert.equal(tries, 1);
  c.token = { accessToken: "t2", expirationTime: inMin(3) }; // jeton différent, mais < 1 min après
  await c.renewIfDue();
  assert.equal(tries, 1, "le plancher temporel tient même si le jeton change");
});

await t("un nouveau jeton (poussé par l'extension) débloque le renouvellement", async () => {
  const c = client();
  c.saveToken = () => undefined;
  let tries = 0;
  c.authenticate = async () => { tries++; };
  c.token = { accessToken: "vieux", expirationTime: inMin(3) };
  await c.renewIfDue();
  assert.equal(tries, 1);
  c.token = { accessToken: "frais", expirationTime: inMin(3) };
  c.lastRenewAt = 0; // une minute plus tard
  await c.renewIfDue();
  assert.equal(tries, 2, "le jeton frais est bien retenté");
});

await t("jeton déjà expiré → tentative aussi (une session morte doit se ranimer)", async () => {
  const c = client();
  c.saveToken = () => undefined;
  let auth = 0;
  c.authenticate = async () => { auth++; };
  c.token = { accessToken: "tok", expirationTime: inMin(-30) };
  await c.renewIfDue();
  assert.equal(auth, 1);
});

await t("client en cours d'arrêt, ou sans jeton → ne fait rien", async () => {
  const c = client();
  let auth = 0;
  c.authenticate = async () => { auth++; };
  c.token = { accessToken: "tok", expirationTime: inMin(1) };
  c.closing = true;
  await c.renewIfDue();
  c.closing = false;
  c.token = undefined;
  await c.renewIfDue();
  assert.equal(auth, 0);
});

console.log(`\n${n} tests OK`);
