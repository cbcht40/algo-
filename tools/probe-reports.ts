// Sonde locale : le service de RAPPORTS Tradovate (celui de l'onglet Reports du site) —
// définitions disponibles + rapport « Fills » / « Performance » en CSV sur une plage de dates.
// Usage : npx tsx tools/probe-reports.ts [baseUrl] [startDate MM/DD/YYYY] [endDate]
// Aucun secret affiché.
import { readFileSync } from "node:fs";
import { renewAccessToken, REST_BASE } from "../src/tradovate/auth";

const all = JSON.parse(readFileSync(".tradovate-tokens.json", "utf8")) as Record<string, { accessToken: string; expirationTime: string }>;
const entry = Object.entries(all).find(([, t]) => new Date(t.expirationTime).getTime() > Date.now());
if (!entry) { console.log("aucun token valide en cache"); process.exit(0); }
const env = entry[0].split("|")[1] === "live" ? "live" : "demo";
const r = await renewAccessToken(REST_BASE[env], entry[1].accessToken);
const H = { Authorization: `Bearer ${r.accessToken}` };
const argBase = process.argv[2];
const start = process.argv[3] || "08/25/2026";
const end = process.argv[4] || "09/07/2026";
const candidates = argBase ? [argBase] : [`${REST_BASE[env]}/`, `https://${env}.tradovateapi.com/`, `https://${env}-reporting.tradovateapi.com/v1/`, `https://reporting-${env}.tradovateapi.com/v1/`];

const accounts = (await (await fetch(`${REST_BASE[env]}/account/list`, { headers: H })).json()) as any[];
const acct = accounts[0];
console.log("compte :", acct?.name, "· env", env);

for (const base of candidates) {
  let res: Response;
  try {
    res = await fetch(`${base}reports/requestreportdefinitions`, { headers: H });
  } catch (e) { console.log(base, "→ erreur réseau", String((e as Error).message).slice(0, 60)); continue; }
  const text = await res.text();
  console.log(`\n${base}reports/requestreportdefinitions → ${res.status} ${text.slice(0, 160).replace(/\s+/g, " ")}`);
  if (res.status !== 200) continue;
  let defs: any;
  try { defs = JSON.parse(text); } catch { continue; }
  const reports = defs.reports || [];
  console.log("rapports :", reports.map((x: any) => `${x.name} [${(x.params || []).map((p: any) => p.name + ":" + p.paramType).join(",")}]`).join("\n           "));
  for (const name of ["Fills", "Performance", "Trade Log", "Orders", "Positions"]) {
    const def = reports.find((x: any) => x.name === name);
    if (!def) continue;
    const params: Array<{ name: string; value: string }> = [];
    for (const p of def.params || []) {
      if (p.name === "startDate") params.push({ name: p.name, value: start });
      else if (p.name === "endDate") params.push({ name: p.name, value: end });
      else if (p.name === "startTime") params.push({ name: p.name, value: "00:00:00" });
      else if (p.name === "endTime") params.push({ name: p.name, value: "00:00:00" });
      else if (p.name === "account") params.push({ name: p.name, value: acct.name });
    }
    const body: any = { name, params, representationType: "csv", timezone: 0 };
    if (name === "Performance") body.template = "Flex.html";
    const rr = await fetch(`${base}reports/requestreport`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const t = await rr.text();
    let data = "";
    try { data = JSON.parse(t).data ?? ""; } catch { data = t; }
    const lines = String(data).split(/\r?\n/).filter(Boolean);
    console.log(`\n▶ ${name} (${params.map((p) => p.name + "=" + p.value).join(", ")}) → ${rr.status} · ${lines.length} ligne(s)`);
    console.log("  en-tête :", lines[0]?.slice(0, 220));
    console.log("  ligne 2 :", lines[1]?.slice(0, 220));
    console.log("  dernière:", lines[lines.length - 1]?.slice(0, 220));
  }
  break;
}
