// Tests des briques pures du flux de marché : npx tsx tools/test-md.ts
import assert from "node:assert/strict";
import { chartKey, toBar } from "../src/tradovate/marketData";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("✓", name); };

t("toBar : barre Tradovate → Bar (secondes UTC, volume = up+down)", () => {
  const b = toBar({ timestamp: "2026-09-04T20:59Z", open: 29820, high: 29830, low: 29818.5, close: 29830, upVolume: 4, downVolume: 2, upTicks: 4, downTicks: 2, histogram: {} })!;
  assert.equal(b.time, Math.floor(Date.parse("2026-09-04T20:59Z") / 1000));
  assert.equal(b.time % 60, 0);
  assert.deepEqual([b.open, b.high, b.low, b.close, b.volume], [29820, 29830, 29818.5, 29830, 6]);
});
t("toBar : barre sans high/low → bornée par open/close", () => {
  const b = toBar({ timestamp: "2026-09-04T20:59:00Z", open: 10, close: 12 })!;
  assert.equal(b.high, 12); assert.equal(b.low, 10); assert.equal(b.volume, 0);
});
t("toBar : illisible → null", () => {
  assert.equal(toBar({ timestamp: "n/a", open: 1, close: 1 }), null);
  assert.equal(toBar({ timestamp: "2026-09-04T20:59Z" }), null);
  assert.equal(toBar(null), null);
});
t("chartKey", () => { assert.equal(chartKey("mnqz6", 5), "MNQZ6|5"); });

console.log(`\n${n} tests OK`);
