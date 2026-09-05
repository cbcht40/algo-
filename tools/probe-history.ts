// Sonde locale : quelle profondeur d'historique l'API Tradovate expose-t-elle (fills, paires,
// positions, journal de caisse) avec la session en cache ? N'affiche aucun secret.
import { readFileSync } from "node:fs";
import { renewAccessToken, REST_BASE } from "../src/tradovate/auth";

const all = JSON.parse(readFileSync(".tradovate-tokens.json", "utf8")) as Record<string, { accessToken: string; expirationTime: string }>;
const entry = Object.entries(all).find(([, t]) => new Date(t.expirationTime).getTime() > Date.now());
if (!entry) { console.log("aucun token valide en cache"); process.exit(0); }
const env = entry[0].split("|")[1] === "live" ? "live" : "demo";
const r = await renewAccessToken(REST_BASE[env], entry[1].accessToken);
const token = r.accessToken;
const base = REST_BASE[env];
const H = { Authorization: `Bearer ${token}` };

async function get(path: string) {
  const res = await fetch(`${base}/${path}`, { headers: H });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data, text: text.slice(0, 120) };
}
function summarize(name: string, x: { status: number; data: any; text: string }) {
  if (!Array.isArray(x.data)) { console.log(`${name.padEnd(34)} → ${x.status} ${x.data ? JSON.stringify(x.data).slice(0, 100) : x.text}`); return; }
  const ts = x.data.map((e: any) => e.timestamp || e.tradeDate || e.date || e.timestamp).filter(Boolean).sort();
  const keys = x.data[0] ? Object.keys(x.data[0]).slice(0, 12).join(",") : "";
  console.log(`${name.padEnd(34)} → ${x.status} · ${x.data.length} élément(s)` + (ts.length ? ` · de ${ts[0]} à ${ts[ts.length - 1]}` : "") + (keys ? ` · champs: ${keys}` : ""));
}

const accounts = await get("account/list");
summarize("account/list", accounts);
const acct = Array.isArray(accounts.data) ? accounts.data[0] : null;
const aid = acct?.id;
for (const p of ["fill/list", "fillPair/list", "position/list", "order/list", "executionReport/list", "command/list", "commandReport/list", "cashBalance/list", "contract/list"]) summarize(p, await get(p));
if (aid) {
  for (const p of [`fill/deps?masterid=${aid}`, `fill/ldeps?masterids=${aid}`, `fillPair/deps?masterid=${aid}`, `position/deps?masterid=${aid}`, `cashBalanceLog/deps?masterid=${aid}`, `cashBalance/deps?masterid=${aid}`, `order/deps?masterid=${aid}`, `executionReport/deps?masterid=${aid}`]) summarize(p, await get(p));
  const snap = await fetch(`${base}/cashBalance/getcashbalancesnapshot`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ accountId: aid }) });
  console.log("cashBalance/getcashbalancesnapshot →", snap.status, (await snap.text()).slice(0, 200));
}
