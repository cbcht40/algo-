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
// Les ids d'ordre Tradovate sont uniques GLOBALEMENT (pas par compte) → compteur partagé.
let nextOrderId = 1000;
function fakeClient(spec: string, calls: Call[], opts: { orders?: Record<number, any>; versions?: Record<number, any>; working?: any[]; positions?: any[] } = {}) {
  return {
    isReady: true,
    accounts: [] as any[],
    onEntity: () => undefined,
    onStatus: () => undefined,
    request: async (endpoint: string, body: any) => {
      calls.push({ spec, endpoint, body });
      const d: any = { orderId: ++nextOrderId };
      if (endpoint === "order/placeoco") d.ocoId = ++nextOrderId;
      if (/startorderstrategy/i.test(endpoint)) d.orderStrategy = { id: ++nextOrderId };
      return { s: 200, d };
    },
    openPositions: () => opts.positions ?? [],
    workingOrders: () => opts.working ?? [],
    order: (id: number) => opts.orders?.[id],
    orderVersion: (id: number) => opts.versions?.[id],
    accountOfOrder: (id: number) => opts.orders?.[id]?.accountId,
    symbolOf: () => "MNQZ6",
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
  const before = nextOrderId;
  await e.relay({ kind: "request", teeId: "o1", endpoint: "order/placeoco", body: { accountId: 1, accountSpec: "A", action: "Sell", symbol: "MNQZ6", orderQty: 1, orderType: "Stop", stopPrice: 100, other: { action: "Sell", orderType: "Limit", price: 110 } } });
  const ids = calls.map((c) => c.spec); assert.deepEqual(ids, ["B", "C"]);
  // ids attribués : B → stop before+1 / cible before+2, C → before+3 / before+4
  const bStop = before + 1, bTarget = before + 2, cStop = before + 3, cTarget = before + 4;
  await e.relay({ kind: "response", teeId: "o1", status: 200, data: { orderId: 555, ocoId: 556 } });
  calls.length = 0;
  // modif du stop source → stops copiés
  const m = await e.relay({ kind: "request", teeId: "m1", endpoint: "order/modifyorder", body: { orderId: 555, orderQty: 1, orderType: "Stop", stopPrice: 99 } });
  assert.equal(m.ok, true);
  assert.deepEqual(calls.map((c) => [c.spec, c.endpoint, c.body.orderId, c.body.stopPrice, c.body.orderQty]), [["B", "order/modifyorder", bStop, 99, 1], ["C", "order/modifyorder", cStop, 99, 2]]);
  assert.equal(events.at(-1)!.kind, "modify");
  assert.doesNotMatch(events.at(-1)!.note ?? "", /correspondance/);
  calls.length = 0;
  // annulation de la cible (ocoId) → jumeaux annulés
  const c = await e.relay({ kind: "request", teeId: "c1", endpoint: "order/cancelorder", body: { orderId: 556 } });
  assert.equal(c.ok, true);
  assert.deepEqual(calls.map((x) => [x.spec, x.endpoint, x.body.orderId]), [["B", "order/cancelorder", bTarget], ["C", "order/cancelorder", cTarget]]);
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

// --- incidents : échec → incident → relance (auto à la reconnexion / manuelle) -----------
function flakyClient(spec: string, calls: Call[], failTimes: number) {
  let fails = failTimes;
  let next = 5000;
  const c: any = fakeClient(spec, calls);
  c.isReady = true;
  c.request = async (endpoint: string, body: any) => {
    calls.push({ spec, endpoint, body });
    if (fails > 0) { fails--; throw new Error("socket closed"); }
    return { s: 200, d: { orderId: ++next } };
  };
  return c;
}
await t("incident : échec réseau → incident auto, relance manuelle réussie", async () => {
  const calls: Call[] = [];
  const b = flakyClient("B", calls, 1);
  const { e, events } = engineWith([
    { spec: "A", mult: 1, id: 1, client: fakeClient("A", calls) },
    { spec: "B", mult: 1, id: 2, client: b },
  ]);
  const r = await e.relay({ kind: "request", teeId: "i1", endpoint: "order/placeorder", body: { accountId: 1, accountSpec: "A", action: "Buy", symbol: "MNQZ6", orderQty: 1, orderType: "Market" } });
  assert.equal(r.ok, false);
  const st = e.dashboardState();
  assert.equal(st.incidents.length, 1);
  const inc = st.incidents[0]!;
  assert.equal(inc.kind, "entry"); assert.equal(inc.label, "B"); assert.equal(inc.auto, true); assert.equal(inc.status, "open");
  assert.match(inc.error, /socket closed/);
  const rr = await e.retryIncident(inc.id);
  assert.equal(rr.ok, true);
  assert.equal(e.dashboardState().incidents[0]!.status, "resolved");
  assert.equal(calls.filter((c) => c.spec === "B").length, 2);
  assert.equal(events.at(-1)!.kind, "retry"); assert.equal(events.at(-1)!.ok, 1);
});
await t("incident : refus Tradovate → pas de relance auto ; ignorer", async () => {
  const calls: Call[] = [];
  const b: any = fakeClient("B", calls);
  b.request = async (endpoint: string, body: any) => { calls.push({ spec: "B", endpoint, body }); return { s: 200, d: { failureReason: "RiskLimit", failureText: "Max position exceeded" } }; };
  const { e } = engineWith([
    { spec: "A", mult: 1, id: 1, client: fakeClient("A", calls) },
    { spec: "B", mult: 1, id: 2, client: b },
  ]);
  await e.placeGroupOrder({ symbol: "MNQZ6", action: "Buy", qty: 1, orderType: "Market" });
  const inc = e.dashboardState().incidents[0]!;
  assert.equal(inc.auto, false); assert.match(inc.error, /Max position/);
  assert.equal(e.ignoreIncident(inc.id).ok, true);
  assert.equal(e.dashboardState().incidents[0]!.status, "ignored");
});
await t("incident : relance automatique quand le login revient", async () => {
  const calls: Call[] = [];
  const b = flakyClient("B", calls, 1);
  const { e, events } = engineWith([
    { spec: "A", mult: 1, id: 1, client: fakeClient("A", calls) },
    { spec: "B", mult: 1, id: 2, client: b },
  ]);
  await e.placeGroupOrder({ symbol: "MNQZ6", action: "Sell", qty: 2, orderType: "Market" });
  assert.equal(e.dashboardState().incidents[0]!.status, "open");
  (e as any).onLoginReady(b); // le login de B redevient prêt
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(e.dashboardState().incidents[0]!.status, "resolved");
  assert.match(events.at(-1)!.note ?? "", /relance auto/);
});

// --- breakeven / décalage groupés --------------------------------------------------------
await t("breakeven : chaque stop revient au fill de SON compte (+offset), décalage relatif", async () => {
  const calls: Call[] = [];
  const A = fakeClient("A", calls), B = fakeClient("B", calls);
  const { e } = engineWith([
    { spec: "A", mult: 1, id: 1, client: A },
    { spec: "B", mult: 1, id: 2, client: B },
  ]);
  (e as any).instruments.set("MNQZ6", { symbol: "MNQZ6", contractId: 42, root: "MNQ", productName: "MNQ", tickSize: 0.25, valuePerPoint: 2, tickValue: 0.5, fetchedAt: Date.now() });
  const acc = (e as any).accounts;
  (e as any).registerExit({ orderId: 11, account: acc[0], contractId: 42, symbol: "MNQZ6", role: "stop", action: "Sell", price: 20990, qty: 1, groupId: "g", fillPrice: 21000 });
  (e as any).registerExit({ orderId: 12, account: acc[1], contractId: 42, symbol: "MNQZ6", role: "stop", action: "Sell", price: 20990.5, qty: 1, groupId: "g", fillPrice: 21000.5 });
  const be = await e.breakevenExits("MNQZ6|stop|Sell", 2);
  assert.equal(be.ok, true); assert.equal(be.modified, 2);
  assert.deepEqual(calls.map((c) => [c.spec, c.body.orderId, c.body.stopPrice]), [["A", 11, 21000.5], ["B", 12, 21001]]);
  calls.length = 0;
  const sh = await e.shiftExits("MNQZ6|stop|Sell", -4);
  assert.equal(sh.modified, 2);
  assert.deepEqual(calls.map((c) => [c.spec, c.body.stopPrice]), [["A", 20999.5], ["B", 21000]]);
  // short : stop Buy → BE en dessous de l'entrée avec offset
  calls.length = 0;
  (e as any).registerExit({ orderId: 21, account: acc[0], contractId: 42, symbol: "MNQZ6", role: "stop", action: "Buy", price: 21010, qty: 1, groupId: "g2", fillPrice: 21000 });
  await e.breakevenExits("MNQZ6|stop|Buy", 4);
  assert.deepEqual(calls.map((c) => [c.spec, c.body.stopPrice]), [["A", 20999]]);
});

// --- SL/TP au fill : même prix pour tout le groupe (défaut) vs même distance ------------
async function fillScenario(mode: "samePrice" | "sameDistance") {
  const calls: Call[] = [];
  const A = fakeClient("A", calls), B = fakeClient("B", calls);
  const { e } = engineWith([
    { spec: "A", mult: 1, id: 1, client: A },
    { spec: "B", mult: 1, id: 2, client: B },
  ], { bracketMode: mode } as any);
  const acc = (e as any).accounts;
  const pb = (account: any, orderId: number) => ({ orderId, account, symbol: "MNQZ6", entryAction: "Buy", stopTicks: 20, targetTicks: 40, tickSize: 0.25, tif: "Day", groupId: "g1", createdAt: Date.now(), filledQty: 0 });
  (e as any).pendingBrackets.set(101, pb(acc[0], 101));
  (e as any).pendingBrackets.set(102, pb(acc[1], 102));
  await (e as any).onFill(A, { id: 1, orderId: 101, contractId: 42, action: "Buy", qty: 1, price: 21000 });
  await (e as any).onFill(B, { id: 2, orderId: 102, contractId: 42, action: "Buy", qty: 1, price: 21000.5 }); // servi 2 ticks plus haut
  return calls.filter((c) => c.endpoint === "order/placeoco").map((c) => [c.spec, c.body.stopPrice, c.body.other.price]);
}
await t("SL/TP « même prix » : le premier fill fixe stop et objectif pour tous les comptes", async () => {
  assert.deepEqual(await fillScenario("samePrice"), [["A", 20995, 21010], ["B", 20995, 21010]]);
});
await t("SL/TP « même distance » : chaque compte à 20/40 ticks de SON fill", async () => {
  assert.deepEqual(await fillScenario("sameDistance"), [["A", 20995, 21010], ["B", 20995.5, 21010.5]]);
});
await t("breakeven en « même prix » : tous les stops reviennent à la référence du groupe", async () => {
  const calls: Call[] = [];
  const A = fakeClient("A", calls), B = fakeClient("B", calls);
  const { e } = engineWith([
    { spec: "A", mult: 1, id: 1, client: A },
    { spec: "B", mult: 1, id: 2, client: B },
  ]);
  (e as any).instruments.set("MNQZ6", { symbol: "MNQZ6", contractId: 42, root: "MNQ", productName: "MNQ", tickSize: 0.25, valuePerPoint: 2, tickValue: 0.5, fetchedAt: Date.now() });
  const acc = (e as any).accounts;
  const pb = (account: any, orderId: number) => ({ orderId, account, symbol: "MNQZ6", entryAction: "Buy", stopTicks: 20, targetTicks: 40, tickSize: 0.25, tif: "Day", groupId: "g2", createdAt: Date.now(), filledQty: 0 });
  (e as any).pendingBrackets.set(201, pb(acc[0], 201));
  (e as any).pendingBrackets.set(202, pb(acc[1], 202));
  await (e as any).onFill(A, { id: 1, orderId: 201, contractId: 42, action: "Buy", qty: 1, price: 21000 });
  await (e as any).onFill(B, { id: 2, orderId: 202, contractId: 42, action: "Buy", qty: 1, price: 21000.75 });
  calls.length = 0;
  await e.breakevenExits("MNQZ6|stop|Sell", 0);
  assert.deepEqual(calls.map((c) => [c.spec, c.body.stopPrice]), [["A", 21000], ["B", 21000]]);
});

// --- garde-fou du relais : fill hors relais → incident « relais manqué » + rattrapage --------
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function guardEngine(opts: { guard?: "auto" | "alert" | "off"; posA?: any[] } = {}) {
  const calls: Call[] = [];
  const A = fakeClient("A", calls, { positions: opts.posA ?? [{ symbol: "MNQZ6", contractId: 42, netPos: 1 }] });
  const B = fakeClient("B", calls);
  const C = fakeClient("C", calls);
  const { e, events } = engineWith([
    { spec: "A", mult: 1, id: 1, client: A },
    { spec: "B", mult: 1, id: 2, client: B },
    { spec: "C", mult: 3, id: 3, client: C },
  ], { relayGuard: opts.guard ?? "auto" } as any);
  (e as any).guardGraceMs = 30;
  return { e, events, calls, A, B, C };
}
const fill = (id: number, orderId: number, action: "Buy" | "Sell", qty = 1) => ({ id, orderId, contractId: 42, action, qty, price: 21000 });

await t("garde-fou : entrée hors relais sur A → rattrapage auto au marché sur B et C (× multiplicateur)", async () => {
  const { e, calls, A, B, events } = guardEngine();
  await (e as any).onFill(A, fill(9001, 70001, "Buy"));
  assert.equal(calls.length, 0); // rien avant le délai de grâce
  await wait(120);
  assert.deepEqual(calls.map((c) => [c.spec, c.endpoint, c.body.action, c.body.orderQty, c.body.orderType]), [["B", "order/placeorder", "Buy", 1, "Market"], ["C", "order/placeorder", "Buy", 3, "Market"]]);
  const inc = e.dashboardState().incidents[0]!;
  assert.equal(inc.kind, "relay"); assert.equal(inc.label, "A"); assert.equal(inc.status, "resolved"); assert.equal(inc.critical, true);
  assert.match(inc.error, /entrée passée hors relais/);
  assert.match(events.find((x) => x.kind === "entry")?.note ?? "", /rattrapage · relais manqué · A/);
  assert.equal(e.dashboardState().relay.guardCaught, 1);
  // le fill du rattrapage sur B (id connu) ne relance rien
  const n0 = calls.length;
  await (e as any).onFill(B, fill(9002, nextOrderId - 1, "Buy"));
  await wait(80);
  assert.equal(calls.length, n0);
  assert.equal(e.dashboardState().incidents.length, 1);
});

await t("garde-fou : fill d'un ordre relayé (id via la réponse) ou du panneau → rien", async () => {
  const { e, calls, A } = guardEngine();
  await e.relay({ kind: "request", teeId: "g1", endpoint: "order/placeorder", body: { accountId: 1, accountSpec: "A", action: "Buy", symbol: "MNQZ6", orderQty: 1, orderType: "Market" } });
  await e.relay({ kind: "response", teeId: "g1", status: 200, data: { orderId: 80001 } });
  const ev = await e.placeGroupOrder({ symbol: "MNQZ6", action: "Buy", qty: 1, orderType: "Market" });
  const idA = ev.legs.find((l) => l.label === "A")!.orderId!;
  const n0 = calls.length;
  await (e as any).onFill(A, fill(9101, 80001, "Buy"));
  await (e as any).onFill(A, fill(9102, idA, "Buy"));
  await wait(80);
  assert.equal(calls.length, n0);
  assert.equal(e.dashboardState().incidents.length, 0);
});

await t("garde-fou : relais récent sans réponse (id inconnu) et stratégie relayée → couverts, jamais de double", async () => {
  const { e, calls, A, C } = guardEngine();
  await e.relay({ kind: "request", teeId: "g2", endpoint: "order/placeorder", body: { accountId: 1, accountSpec: "A", action: "Buy", symbol: "MNQZ6", orderQty: 1, orderType: "Limit", price: 20990 } });
  let n0 = calls.length;
  await (e as any).onFill(A, fill(9201, 80002, "Buy"));
  await wait(80);
  assert.equal(calls.length, n0);
  // stratégie : couverture par compte+symbole, même une fois le tee oublié
  const params = JSON.stringify({ entryVersion: { orderQty: 1, orderType: "Market" }, brackets: [{ qty: 1, profitTarget: 10, stopLoss: -5 }] });
  await e.relay({ kind: "request", teeId: "g3", endpoint: "orderStrategy/startOrderStrategy", body: { accountId: 1, accountSpec: "A", symbol: "MNQZ6", orderStrategyTypeId: 2, action: "Buy", params, uuid: "u" } });
  (e as any).tees.clear();
  n0 = calls.length;
  await (e as any).onFill(A, fill(9202, 80003, "Buy"));   // entrée de la stratégie source
  await (e as any).onFill(C, fill(9203, 80004, "Buy", 3)); // entrée de la stratégie copiée
  await (e as any).onFill(A, fill(9204, 80005, "Sell"));  // stop de la stratégie source
  await wait(80);
  assert.equal(calls.length, n0);
  assert.equal(e.dashboardState().incidents.length, 0);
});

await t("garde-fou : les autres comptes ont bougé ensemble → rien", async () => {
  const { e, calls, A, B, C } = guardEngine();
  await (e as any).onFill(A, fill(9301, 70301, "Buy"));
  await (e as any).onFill(B, fill(9302, 70302, "Buy"));
  await (e as any).onFill(C, fill(9303, 70303, "Buy", 3));
  await wait(80);
  assert.equal(calls.length, 0);
  assert.equal(e.dashboardState().incidents.length, 0);
});

await t("garde-fou : sortie hors relais → incident ouvert, rattrapage sur clic (sorties connues annulées d'abord)", async () => {
  const { e, calls, A } = guardEngine({ posA: [] }); // A revenu à plat
  const acc = (e as any).accounts;
  (e as any).registerExit({ orderId: 501, account: acc[1], contractId: 42, symbol: "MNQZ6", role: "stop", action: "Sell", price: 20990, qty: 1, groupId: "g", fillPrice: 21000 });
  await (e as any).onFill(A, fill(9401, 70401, "Sell"));
  await wait(80);
  assert.equal(calls.length, 0);
  const inc = e.dashboardState().incidents[0]!;
  assert.equal(inc.kind, "relay"); assert.equal(inc.status, "open"); assert.equal(inc.auto, false);
  assert.match(inc.error, /sortie passée hors relais/);
  const r = await e.retryIncident(inc.id);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.filter((c) => c.spec === "B").map((c) => [c.endpoint, c.body.orderId ?? c.body.orderQty]), [["order/cancelorder", 501], ["order/placeorder", 1]]);
  assert.deepEqual(calls.filter((c) => c.spec === "C").map((c) => [c.endpoint, c.body.orderQty, c.body.action]), [["order/placeorder", 3, "Sell"]]);
  assert.equal(e.dashboardState().incidents[0]!.status, "resolved");
  assert.equal((e as any).exits.size, 0);
});

await t("garde-fou : mode alerte → incident sans rattrapage auto ; échec partiel → seuls les comptes restants sont relancés", async () => {
  const { e, calls, A, C } = guardEngine({ guard: "alert" });
  let failC = true;
  C.request = async (endpoint: string, body: any) => { calls.push({ spec: "C", endpoint, body }); if (failC) throw new Error("socket closed"); return { s: 200, d: { orderId: ++nextOrderId } }; };
  await (e as any).onFill(A, fill(9501, 70501, "Buy"));
  await wait(80);
  assert.equal(calls.length, 0);
  const inc = e.dashboardState().incidents[0]!;
  assert.equal(inc.status, "open");
  const r1 = await e.retryIncident(inc.id);
  assert.equal(r1.ok, false); assert.match(r1.error ?? "", /C: socket closed/);
  assert.deepEqual(calls.map((c) => c.spec), ["B", "C"]);
  failC = false;
  const r2 = await e.retryIncident(inc.id);
  assert.equal(r2.ok, true);
  assert.deepEqual(calls.map((c) => c.spec), ["B", "C", "C"]); // B n'est pas renvoyé
  assert.equal(e.dashboardState().incidents[0]!.status, "resolved");
});

await t("garde-fou : off, ou relais désactivé, ou compte hors groupe → rien", async () => {
  const off = guardEngine({ guard: "off" });
  await (off.e as any).onFill(off.A, fill(9601, 70601, "Buy"));
  const g2 = guardEngine();
  (g2.e as any).relayEnabled = false;
  await (g2.e as any).onFill(g2.A, fill(9602, 70602, "Buy"));
  const g3 = guardEngine();
  (g3.e as any).accounts[0].enabled = false;
  await (g3.e as any).onFill(g3.A, fill(9603, 70603, "Buy"));
  await wait(80);
  assert.equal(off.calls.length + g2.calls.length + g3.calls.length, 0);
  assert.equal(off.e.dashboardState().incidents.length + g2.e.dashboardState().incidents.length + g3.e.dashboardState().incidents.length, 0);
  assert.equal(g2.e.setRelayGuard("alert"), "alert");
  assert.equal(g2.e.setRelayGuard("bidon"), "auto");
});

console.log(`\n${n} tests OK`);
