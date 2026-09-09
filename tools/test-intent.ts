// Intention d'un ordre : décision (à noter) vs geste de gestion (à ne PAS ré-analyser).
// npx tsx tools/test-intent.ts
import assert from "node:assert/strict";
import { classifyOrderIntent, intentNote, type IntentInput } from "../src/copier/intent";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("✓", name); };
const c = (o: Partial<IntentInput>) => classifyOrderIntent({
  endpoint: "order/placeorder", action: "Buy", orderType: "Market", qty: 1, netPos: 0, ...o,
});

// LE cas du fondateur : entrée au marché, puis stop quelques secondes après.
t("entrée au marché puis stop : la 2ᵉ n'est PAS notée", () => {
  const entree = c({ action: "Buy", orderType: "Market", qty: 2, netPos: 0 });
  assert.equal(entree.intent, "entry"); assert.equal(entree.score, true);
  const stop = c({ action: "Sell", orderType: "Stop", qty: 2, netPos: 2 });
  assert.equal(stop.intent, "protection"); assert.equal(stop.role, "stop"); assert.equal(stop.score, false);
});

t("stop posé AVANT le retour du fill : la position présumée suffit", () => {
  const r = c({ action: "Sell", orderType: "Stop", qty: 2, netPos: 0, presumedDir: 1, presumedQty: 2 });
  assert.equal(r.intent, "protection"); assert.equal(r.score, false);
  assert.match(r.reason, /déduite de l'entrée/);
});

t("présomption invalidée si on est déjà ressorti", () => {
  const r = c({ action: "Sell", orderType: "Stop", qty: 2, netPos: 0, presumedDir: 1, presumedQty: 2, exitedSince: true });
  assert.equal(r.intent, "entry", "sans position réelle ni présomption valide, c'est un stop d'entrée");
  assert.equal(r.score, true);
});

t("objectif et OCO posés après coup : pas de note non plus", () => {
  assert.equal(c({ action: "Sell", orderType: "Limit", qty: 2, netPos: 2 }).role, "target");
  const oco = c({ endpoint: "order/placeoco", action: "Sell", orderType: "Stop", qty: 2, netPos: 2, hasOther: true, otherOrderType: "Limit" });
  assert.equal(oco.intent, "protection"); assert.equal(oco.role, "bracket"); assert.equal(oco.score, false);
});

t("sortie au marché : geste de gestion", () => {
  const r = c({ action: "Sell", orderType: "Market", qty: 2, netPos: 2 });
  assert.equal(r.intent, "exit"); assert.equal(r.score, false);
});

// Ce qui DOIT rester noté — le risque inverse : rater une vraie décision.
t("à plat, un Stop ou une Limite est une ENTRÉE (breakout, limite)", () => {
  assert.equal(c({ action: "Buy", orderType: "Stop", qty: 1, netPos: 0 }).intent, "entry");
  assert.equal(c({ action: "Sell", orderType: "Limit", qty: 1, netPos: 0 }).intent, "entry");
});

t("renfort : même sens que la position → noté, mais nommé renfort", () => {
  const r = c({ action: "Buy", orderType: "Market", qty: 1, netPos: 2 });
  assert.equal(r.intent, "add"); assert.equal(r.score, true);
});

t("retournement : opposé et plus gros que la position → noté", () => {
  const r = c({ action: "Sell", orderType: "Market", qty: 4, netPos: 2 });
  assert.equal(r.intent, "reverse"); assert.equal(r.score, true);
  // opposé mais plus petit = sortie partielle, pas un retournement
  assert.equal(c({ action: "Sell", orderType: "Market", qty: 1, netPos: 2 }).intent, "exit");
});

t("ordre déjà protégé (stratégie / OSO) : toujours une décision", () => {
  for (const ep of ["orderStrategy/startOrderStrategy", "order/placeoso"]) {
    const r = c({ endpoint: ep, action: "Sell", orderType: "Stop", qty: 2, netPos: 2 });
    assert.equal(r.score, true, `${ep} doit rester une décision`);
    assert.equal(r.intent, "reverse" === r.intent ? "reverse" : "entry");
  }
  // même sens qu'une position ouverte → renfort protégé
  assert.equal(c({ endpoint: "order/placeoso", action: "Buy", qty: 1, netPos: 3 }).intent, "add");
});

t("contrat inconnu juste après une entrée : on s'abstient plutôt que de noter deux fois", () => {
  const r = c({ action: "Sell", orderType: "Stop", qty: 2, netPos: null, recentEntry: true });
  assert.equal(r.intent, "unknown"); assert.equal(r.score, false);
  // sans entrée récente, on garde le comportement historique : c'est une entrée
  assert.equal(c({ action: "Buy", orderType: "Market", qty: 1, netPos: null }).intent, "entry");
});

t("short : les signes ne sont pas inversés", () => {
  assert.equal(c({ action: "Buy", orderType: "Stop", qty: 2, netPos: -2 }).role, "stop", "stop d'un short = Buy");
  assert.equal(c({ action: "Sell", orderType: "Market", qty: 1, netPos: -2 }).intent, "add", "vendre encore = renfort du short");
  assert.equal(c({ action: "Buy", orderType: "Market", qty: 5, netPos: -2 }).intent, "reverse");
});

t("aucune suppression n'est silencieuse", () => {
  const stop = c({ action: "Sell", orderType: "Stop", qty: 2, netPos: 2 });
  assert.match(intentNote(stop), /Stop détecté — pas de nouvelle analyse/);
  assert.equal(intentNote(c({ action: "Buy", orderType: "Market", qty: 1, netPos: 0 })), "", "une décision n'a pas de note de suppression");
});

console.log(`\n${n} tests OK`);
