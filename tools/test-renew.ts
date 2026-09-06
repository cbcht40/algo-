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

await t("dans la marge (5 min) → renouvellement tenté ; échec réseau → ré-authentification", async () => {
  const c = client();
  c.saveToken = () => undefined;
  let auth = 0;
  c.authenticate = async () => { auth++; };
  c.token = { accessToken: "tok", expirationTime: inMin(5) };
  await c.renewIfDue(); // pas de réseau en test → renewAccessToken échoue → authenticate()
  assert.equal(auth, 1, "ré-authentification déclenchée");
  assert.equal(c.renewing, false, "verrou relâché même en cas d'échec");
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
