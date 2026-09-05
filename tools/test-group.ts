// Tests des briques pures du mode sync (npx tsx tools/test-group.ts).
import assert from "node:assert/strict";
import { computeDesync, exitPrices, majority, productRoot, roundToTick, scaledQty, tickDecimals } from "../src/copier/group";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("✓", name); };

t("scaledQty floors (never rounds up)", () => {
  assert.equal(scaledQty(1, 1), 1);
  assert.equal(scaledQty(1, 0.5), 0);
  assert.equal(scaledQty(2, 1.5), 3);
  assert.equal(scaledQty(3, 0.34), 1);
  assert.equal(scaledQty(1, 3), 3);
  assert.equal(scaledQty(1, 0), 0);
});

t("tickDecimals / roundToTick", () => {
  assert.equal(tickDecimals(0.25), 2);
  assert.equal(tickDecimals(0.01), 2);
  assert.equal(tickDecimals(1), 0);
  assert.equal(tickDecimals(0.0001), 4);
  assert.equal(roundToTick(21050.13, 0.25), 21050.25);
  assert.equal(roundToTick(21050.12, 0.25), 21050);
  assert.equal(roundToTick(1.23456, 0.0001), 1.2346);
  assert.equal(roundToTick(5000.6, 1), 5001);
});

t("exitPrices — achat : stop dessous, objectif dessus", () => {
  const r = exitPrices("Buy", 21000, 0.25, 20, 40);
  assert.deepEqual(r, { exitAction: "Sell", stop: 20995, target: 21010 });
});
t("exitPrices — vente : stop dessus, objectif dessous", () => {
  const r = exitPrices("Sell", 21000, 0.25, 20, 40);
  assert.deepEqual(r, { exitAction: "Buy", stop: 21005, target: 20990 });
});
t("exitPrices — stop seul / objectif seul / rien", () => {
  assert.deepEqual(exitPrices("Buy", 100, 0.25, 8, undefined), { exitAction: "Sell", stop: 98 });
  assert.deepEqual(exitPrices("Buy", 100, 0.25, undefined, 8), { exitAction: "Sell", target: 102 });
  assert.deepEqual(exitPrices("Buy", 100, 0.25, 0, 0), { exitAction: "Sell" });
});
t("exitPrices — arrondi au tick sur un fill hors grille", () => {
  const r = exitPrices("Buy", 6100.37, 0.25, 4, 4);
  assert.equal(r.stop, 6099.25);
  assert.equal(r.target, 6101.25);
});

t("productRoot", () => {
  assert.equal(productRoot("MNQZ6"), "MNQ");
  assert.equal(productRoot("MESH27"), "MES");
  assert.equal(productRoot("6EU6"), "6E");
  assert.equal(productRoot("ZNZ6"), "ZN");
  assert.equal(productRoot("mnqz6"), "MNQ");
});

t("majority", () => {
  assert.equal(majority([1, 1, 2]), 1);
  assert.equal(majority([0, 1]), 1); // égalité → la plus grande en valeur absolue
  assert.equal(majority([-2, 0]), -2);
  assert.equal(majority([]), 0);
});

t("computeDesync — groupe synchrone → vide", () => {
  const r = computeDesync([
    { label: "A", spec: "a", multiplier: 1, netPos: 1 },
    { label: "B", spec: "b", multiplier: 1, netPos: 1 },
    { label: "C", spec: "c", multiplier: 3, netPos: 3 },
  ]);
  assert.equal(r.length, 0);
  assert.equal(r.reference, 1);
});
t("computeDesync — un compte a raté l'entrée", () => {
  const r = computeDesync([
    { label: "A", spec: "a", multiplier: 1, netPos: 1 },
    { label: "B", spec: "b", multiplier: 1, netPos: 0 },
    { label: "C", spec: "c", multiplier: 1, netPos: 1 },
  ]);
  assert.deepEqual([...r], [{ label: "B", spec: "b", actual: 0, expected: 1, delta: -1 }]);
});
t("computeDesync — un compte a doublé", () => {
  const r = computeDesync([
    { label: "A", spec: "a", multiplier: 1, netPos: -1 },
    { label: "B", spec: "b", multiplier: 1, netPos: -2 },
    { label: "C", spec: "c", multiplier: 2, netPos: -2 },
  ]);
  assert.deepEqual([...r], [{ label: "B", spec: "b", actual: -2, expected: -1, delta: -1 }]);
});
t("computeDesync — multiplicateur 0 ignoré", () => {
  const r = computeDesync([
    { label: "A", spec: "a", multiplier: 1, netPos: 1 },
    { label: "Z", spec: "z", multiplier: 0, netPos: 0 },
  ]);
  assert.equal(r.length, 0);
});

console.log(`\n${n} tests OK`);
