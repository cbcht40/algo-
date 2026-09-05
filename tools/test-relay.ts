// Tests du relais Tradovate (ordre intercepté dans le navigateur → autres comptes) avec des
// clients Tradovate factices : npx tsx tools/test-relay.ts
import assert from "node:assert/strict";
import { GroupEngine, relayQty, scaleStrategyParams, teeBody, type GroupEvent } from "../src/copier/group";
import type { Config } from "../src/config";

let n = 0;
const t = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log("✓", name); });

// --- briques pures -----------------------------------------------------------------
await t("relayQty : × mult cible ÷ mult source, floor", () => {
  assert.equal(relayQty(2, 1, 1), 2);
  assert.equal(relayQty(2, 1, 3), 6);
  assert.equal(relayQty(2, 1, 0.5), 1);
  assert.equal(relayQty(1, 1, 0.5), 0);
  assert.equal(relayQty(6, 3, 1), 2);
  assert.equal(relayQty(2, 3, 1), 0);
  assert.equal(relayQty(2, 0, 2), 4); // mult source 0 → 1
});
await t("scaleStrategyParams : entryVersion + brackets", () => {
  const p = JSON.stringify({ entryVersion: { orderQty: 2, orderType: "Market" }, brackets: [{ qty: 1, profitTarget: 10, stopLoss: -5 }, { qty: 1, profitTarget: 20, stopLoss: -5 }] });
  const r = scaleStrategyParams(p, (q) => q * 3);
  const j = JSON.parse(r.params);
  assert.equal(r.entryQty, 6);
  assert.equal(j.entryVersion.orderQty, 6);
  assert.deepEqual(j.brackets.map((b: any) => b.qty), [3, 3]);
  assert.equal(j.brackets[0].profitTarget, 10);
  assert.equal(scaleStrategyParams("not json", (q) => q).entryQty, 0);
});
await t("teeBody : compte + quantité changés, uuid retiré/régénéré, qty 0 → null", () => {
  const b = teeBody("order/placeorder", { accountId: 1, accountSpec: "A", action: "Buy", symbol: "MNQZ6", orderQty: 2, orderType: "Market", uuid: "x" }, { accountId: 9, spec: "B" }, (q) => q * 2)!;
  assert.equal(b.accountId, 9); assert.equal(b.accountSpec, "B"); assert.equal(b.orderQty, 4); assert.equal(b.isAutomated, true); assert.equal("uuid" in b, false);
  assert.equal(teeBody("order/placeorder", { orderQty: 1 }, { accountId: 9, spec: "B" }, () => 0), null);
  const s = teeBody("orderstrategy/startorderstrategy", { accountId: 1, accountSpec: "A", symbol: "MNQZ6", action: "Buy", orderStrategyTypeId: 2, uuid: "src", params: JSON.stringify({ entryVersion: { orderQty: 1 }, brackets: [{ qty: 1 }] }) }, { accountId: 9, spec: "B" }, (q) => q)!;
  assert.notEqual(s.uuid, "src"); assert.equal(s.accountSpec, "B");
  const l = teeBody("order/liquidateposition", { accountId: 1, contractId: 42 }, { accountId: 9, spec: "B" }, (q) => q)!;
  assert.deepEqual(l, { accountId: 9, contractId: 42, admin: false });
});

// --- moteur avec clients factices ----------------------------------------------------
type Call = { spec: string; endpoint: string; body: any };
function fakeClient(spec: string, calls: Call[], opts: { orders?: Record<number, any>; versions?: Record<number, any>; working?: any[]; positions?: any[] } = {}) {
  let next = 1000;
  return {
    isReady: true,
    request: async (endpoint: string, body: any) => {
      calls.push({ spec, endpoint, body });
      const d: any = { orderId: ++next };
      if (endpoint === "order/placeoco") d.ocoId = ++next;
      if (/startorderstrategy/i.test(endpoint)) d.orderStrategy = { id: ++next };
      return { s: 200, d };
    },
    openPositions: () => opts.positions ?? [],
    workingOrders: () => opts.working ?? [],
    order: (id: number) => opts.orders?.[id],
    orderVersion: (id: number) => opts.versions?.[id],
    contractName: async () => "MNQZ6",
  };
}
function engineWith(accounts: Array<{ spec: string; mult: number; enabled?: boolean; client: any; id: number }>, extra: Partial<Config> = {}) {
  const cfg = { mode: "sync", environment: "demo", appId: "t", appVersion: "0", dryRun: false, auth: { mode: "credentials" }, accounts: [], master: { label: "x" }, followers: [], relay: true, ...extra } as unknown as Config;
  const e = new GroupEngine(cfg);
  (e as any).accounts = accounts.map((a) => ({ key: a.spec.toLowerCase(), label: a.spec, spec: a.spec, accountId: a.id, client: a.client, multiplier: a.mult, enabled: a.enabled !== false, environment: "demo" }));
  const events: GroupEvent[] = [];
  e.onEvent((ev) => events.push(ev));
  return { e, events };
}

await t("entrée : source exclue, quantités par multiplicateur, compte hors groupe ignoré", async () => {
  const calls: Call[] = [];
  const { e, events } = engineWith([
    { spec: "A", mult: 1, id: 1, client: fakeClient("A", calls) },
    { spec: "B", mult: 1, id: 2, client: fakeClient("B", calls) },
    { spec: "C", mult: 3, id: 3, client: fakeClient("C", calls) },
    { spec: "D", mult: 1, id: 4, enabled: false, client: fakeClient("D", calls) },
  ]);
  const r = await e.relay({ kind: "request", teeId: "t1", endpoint: "order/placeorder", t: Date.now() - 3, body: { accountId: 1, accountSpec: "A", action: "Buy", symbol: "MNQZ6", orderQty: 2, orderType: "Market", timeInForce: "Day" } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => [c.spec, c.body.orderQty, c.body.accountSpec]), [["B", 2, "B"], ["C", 6, "C"]]);
  assert.equal(calls[0]!.body.isAutomated, true);
  const ev = events.at(-1)!;
  assert.equal(ev.kind, "entry"); assert.equal(ev.ok, 2); assert.equal(ev.legs.length, 2);
  assert.match(ev.note ?? "", /relais Tradovate · A · relais \d+ ms/);
  // doublon
  const r2 = await e.relay({ kind: "request", teeId: "t1", endpoint: "order/placeorder", body: { accountId: 1, orderQty: 1 } });
  assert.equal(r2.note, "doublon");
  // source hors groupe → rien
  const before = calls.length;
  const r3 = await e.relay({ kind: "request", teeId: "t2", endpoint: "order/placeorder", body: { accountId: 4, accountSpec: "D", action: "Buy", symbol: "MNQZ6", orderQty: 1, orderType: "Market" } });
  assert.equal(r3.ok, false); assert.equal(calls.length, before);
  // source inconnue → rien
  const r4 = await e.relay({ kind: "request", teeId: "t3", endpoint: "order/placeorder", body: { accountId: 99, accountSpec: "ZZ", orderQty: 1 } });
  assert.equal(r4.ok, false); assert.equal(calls.length, before);
});

await t("réponse → mapping exact des modifications et annulations", async () => {
  const calls: Call[] = [];
  const { e, events } = engineWith([
    { spec: "A", mult: 1, id: 1, client: fakeClient("A", calls) },
    { spec: "B", mult: 1, id: 2, client: fakeClient("B", calls) },
    { spec: "C", mult: 2, id: 3, client: fakeClient("C", calls) },
  ]);
  await e.relay({ kind: "request", teeId: "o1", endpoint: "order/placeoco", body: { accountId: 1, accountSpec: "A", action: "Sell", symbol: "MNQZ6", orderQty: 1, orderType: "Stop", stopPrice: 100, other: { action: "Sell", orderType: "Limit", price: 110 } } });
  const ids = calls.map((c) => c.spec); assert.deepEqual(ids, ["B", "C"]);
  await e.relay({ kind: "response", teeId: "o1", status: 200, data: { orderId: 555, ocoId: 556 } });
  calls.length = 0;
  // modif du stop source → stops copiés (ids B=1001, C=1001 de leur propre compteur)
  const m = await e.relay({ kind: "request", teeId: "m1", endpoint: "order/modifyorder", body: { orderId: 555, orderQty: 1, orderType: "Stop", stopPrice: 99 } });
  assert.equal(m.ok, true);
  assert.deepEqual(calls.map((c) => [c.spec, c.endpoint, c.body.orderId, c.body.stopPrice, c.body.orderQty]), [["B", "order/modifyorder", 1001, 99, 1], ["C", "order/modifyorder", 1001, 99, 2]]);
  assert.equal(events.at(-1)!.kind, "modify");
  assert.doesNotMatch(events.at(-1)!.note ?? "", /correspondance/);
  calls.length = 0;
  // annulation de la cible (ocoId) → jumeaux annulés
  const c = await e.relay({ kind: "request", teeId: "c1", endpoint: "order/cancelorder", body: { orderId: 556 } });
  assert.equal(c.ok, true);
  assert.deepEqual(calls.map((x) => [x.spec, x.endpoint, x.body.orderId]), [["B", "order/cancelorder", 1002], ["C", "order/cancelorder", 1002]]);
});

await t("modification sans mapping → par correspondance (contrat + sens + type)", async () => {
  const calls: Call[] = [];
  const srcOrders = { 777: { id: 777, accountId: 1, contractId: 42, action: "Sell", ordStatus: "Working" } };
  const bWorking = [{ id: 31, accountId: 2, contractId: 42, action: "Sell", ordStatus: "Working" }, { id: 32, accountId: 2, contractId: 42, action: "Buy", ordStatus: "Working" }, { id: 33, accountId: 2, contractId: 7, action: "Sell", ordStatus: "Working" }];
  const { e, events } = engineWith([
    { spec: "A", mult: 1, id: 1, client: fakeClient("A", calls, { orders: srcOrders, versions: { 777: { id: 1, orderId: 777, orderQty: 1, orderType: "Stop" } } }) },
    { spec: "B", mult: 1, id: 2, client: fakeClient("B", calls, { working: bWorking, versions: { 31: { orderType: "Stop" }, 32: { orderType: "Stop" }, 33: { orderType: "Stop" } } }) },
    { spec: "E", mult: 1, id: 5, client: fakeClient("E", calls, { working: [] }) },
  ]);
  const m = await e.relay({ kind: "request", teeId: "m2", endpoint: "order/modifyorder", body: { orderId: 777, orderQty: 1, orderType: "Stop", stopPrice: 95 } });
  assert.equal(m.ok, true);
  assert.deepEqual(calls.map((c) => [c.spec, c.body.orderId, c.body.stopPrice]), [["B", 31, 95]]);
  const ev = events.at(-1)!;
  assert.match(ev.note ?? "", /correspondance/);
  assert.equal(ev.skipped, 1); // E : aucun ordre correspondant
});

await t("stratégie bracket relayée telle quelle (quantités rescalées, uuid neuf)", async () => {
  const calls: Call[] = [];
  const { e, events } = engineWith([
    { spec: "A", mult: 1, id: 1, client: fakeClient("A", calls) },
    { spec: "C", mult: 3, id: 3, client: fakeClient("C", calls) },
  ]);
  const params = JSON.stringify({ entryVersion: { orderQty: 1, orderType: "Market" }, brackets: [{ qty: 1, profitTarget: 10, stopLoss: -5, trailingStop: false }] });
  const r = await e.relay({ kind: "request", teeId: "s1", endpoint: "orderStrategy/startOrderStrategy", body: { accountId: 1, accountSpec: "A", symbol: "MNQZ6", orderStrategyTypeId: 2, action: "Buy", params, uuid: "src-uuid" } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.endpoint, "orderStrategy/startOrderStrategy");
  const p = JSON.parse(c.body.params);
  assert.equal(p.entryVersion.orderQty, 3); assert.equal(p.brackets[0].qty, 3); assert.equal(p.brackets[0].stopLoss, -5);
  assert.notEqual(c.body.uuid, "src-uuid");
  const ev = events.at(-1)!;
  assert.equal(ev.qty, 1); assert.equal(ev.orderType, "Market"); assert.match(ev.note ?? "", /brackets/);
});

await t("verrou / relais désactivé / dry-run", async () => {
  const calls: Call[] = [];
  const { e, events } = engineWith([
    { spec: "A", mult: 1, id: 1, client: fakeClient("A", calls) },
    { spec: "B", mult: 1, id: 2, client: fakeClient("B", calls) },
  ]);
  e.setLocked(true);
  const r = await e.relay({ kind: "request", teeId: "l1", endpoint: "order/placeorder", body: { accountId: 1, accountSpec: "A", action: "Buy", symbol: "MNQZ6", orderQty: 1, orderType: "Market" } });
  assert.equal(r.ok, false); assert.equal(events.at(-1)!.kind, "blocked"); assert.equal(calls.length, 0);
  e.setLocked(false);
  (e as any).relayEnabled = false;
  const r2 = await e.relay({ kind: "request", teeId: "l2", endpoint: "order/placeorder", body: { accountId: 1, accountSpec: "A", action: "Buy", symbol: "MNQZ6", orderQty: 1, orderType: "Market" } });
  assert.equal(r2.note, "relais désactivé"); assert.equal(calls.length, 0);
  (e as any).relayEnabled = true;
  (e as any).cfg.dryRun = true;
  const r3 = await e.relay({ kind: "request", teeId: "l3", endpoint: "order/placeorder", body: { accountId: 1, accountSpec: "A", action: "Buy", symbol: "MNQZ6", orderQty: 1, orderType: "Market" } });
  assert.equal(r3.ok, true); assert.equal(calls.length, 0); assert.equal(events.at(-1)!.legs[0]!.status, "dry");
});

await t("liquidateposition relayée sur les comptes en position", async () => {
  const calls: Call[] = [];
  const { e, events } = engineWith([
    { spec: "A", mult: 1, id: 1, client: fakeClient("A", calls) },
    { spec: "B", mult: 1, id: 2, client: fakeClient("B", calls, { positions: [{ symbol: "MNQZ6", contractId: 42, netPos: 2 }] }) },
    { spec: "C", mult: 1, id: 3, client: fakeClient("C", calls, { positions: [] }) },
  ]);
  const r = await e.relay({ kind: "request", teeId: "f1", endpoint: "order/liquidateposition", body: { accountId: 1, contractId: 42, admin: false } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => [c.spec, c.endpoint, c.body.contractId]), [["B", "order/liquidateposition", 42]]);
  const ev = events.at(-1)!;
  assert.equal(ev.kind, "flatten"); assert.equal(ev.ok, 1); assert.equal(ev.skipped, 1);
});

console.log(`\n${n} tests OK`);
