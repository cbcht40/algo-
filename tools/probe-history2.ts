// Sonde locale : le journal de caisse (cashBalanceLog) référence des fillId → les fills
// anciens sont-ils encore lisibles par id (fill/item, fill/items) ? Aucun secret affiché.
import { readFileSync } from "node:fs";
import { renewAccessToken, REST_BASE } from "../src/tradovate/auth";

const all = JSON.parse(readFileSync(".tradovate-tokens.json", "utf8")) as Record<string, { accessToken: string; expirationTime: string }>;
const entry = Object.entries(all).find(([, t]) => new Date(t.expirationTime).getTime() > Date.now());
if (!entry) { console.log("aucun token valide en cache"); process.exit(0); }
const env = entry[0].split("|")[1] === "live" ? "live" : "demo";
const r = await renewAccessToken(REST_BASE[env], entry[1].accessToken);
const base = REST_BASE[env];
const H = { Authorization: `Bearer ${r.accessToken}` };
const get = async (p: string) => { const res = await fetch(`${base}/${p}`, { headers: H }); const t = await res.text(); try { return { s: res.status, d: JSON.parse(t) }; } catch { return { s: res.status, d: t.slice(0, 100) }; } };

const accounts = (await get("account/list")).d as any[];
const aid = accounts[0].id;
const log = (await get(`cashBalanceLog/deps?masterid=${aid}`)).d as any[];
const types = new Map<string, number>();
for (const e of log) types.set(e.cashChangeType, (types.get(e.cashChangeType) ?? 0) + 1);
console.log("cashChangeType :", JSON.stringify([...types]));
console.log("exemples :", JSON.stringify(log.slice(0, 3).map((e) => ({ ts: e.timestamp, tradeDate: e.tradeDate, type: e.cashChangeType, fillId: e.fillId, delta: e.delta, realizedPnL: e.realizedPnL, amount: e.amount }))));
const withFill = log.filter((e) => e.fillId);
const days = new Set(log.map((e) => e.tradeDate?.year ? `${e.tradeDate.year}-${e.tradeDate.month}-${e.tradeDate.day}` : String(e.tradeDate)));
console.log(`${log.length} lignes, ${withFill.length} avec fillId, jours : ${[...days].join(", ")}`);
const ids = [...new Set(withFill.map((e) => e.fillId))].slice(0, 5) as number[];
console.log("fill/item?id=", ids[0], "→", JSON.stringify((await get(`fill/item?id=${ids[0]}`))).slice(0, 300));
console.log("fill/items?ids=", ids.join(","), "→", JSON.stringify((await get(`fill/items?ids=${ids.join(",")}`))).slice(0, 400));
console.log("fillFee/items?ids=", "→", JSON.stringify((await get(`fillFee/items?ids=${ids.join(",")}`))).slice(0, 300));
const f = (await get(`fill/item?id=${ids[0]}`)).d as any;
if (f?.contractId) console.log("contract/item?id=", f.contractId, "→", JSON.stringify((await get(`contract/item?id=${f.contractId}`))).slice(0, 200));
if (f?.orderId) console.log("order/item?id=", f.orderId, "→", JSON.stringify((await get(`order/item?id=${f.orderId}`))).slice(0, 200));
// Le journal de caisse remonte-t-il plus loin que la création du compte visible ? (autre compte du login)
console.log("comptes du login :", accounts.map((a) => `${a.name}#${a.id} (${a.archived ? "archivé" : "actif"})`).join(", "));
