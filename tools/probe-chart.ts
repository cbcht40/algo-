// Sonde locale : format des bougies renvoyées par md/getChart (aucun secret affiché).
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { renewAccessToken, REST_BASE } from "../src/tradovate/auth";

const symbol = process.argv[2] || "MNQZ6";
const tf = Number(process.argv[3] || 1);
const MD: Record<string, string> = { demo: "wss://md-demo.tradovateapi.com/v1/websocket", live: "wss://md.tradovateapi.com/v1/websocket" };

const all = JSON.parse(readFileSync(".tradovate-tokens.json", "utf8")) as Record<string, { accessToken: string; expirationTime: string }>;
const entry = Object.entries(all).find(([, t]) => new Date(t.expirationTime).getTime() > Date.now());
if (!entry) { console.log("aucun token valide en cache"); process.exit(0); }
const env = entry[0].split("|")[1] === "live" ? "live" : "demo";
const r = await renewAccessToken(REST_BASE[env], entry[1].accessToken);
const token = r.mdAccessToken || r.accessToken;

const ws = new WebSocket(MD[env]);
let n = 0;
const timer = setTimeout(() => { console.log("fin (timeout)"); ws.close(); }, 12_000);
ws.on("message", (raw) => {
  const s = raw.toString();
  if (s === "o") { ws.send(`authorize\n1\n\n${token}`); return; }
  if (s[0] !== "a") return;
  let arr: any[] = [];
  try { arr = JSON.parse(s.slice(1)); } catch { return; }
  for (const m of arr) {
    if (m.i === 1) {
      console.log("authorize", m.s);
      const body = { symbol, chartDescription: { underlyingType: "MinuteBar", elementSize: tf, elementSizeUnit: "UnderlyingUnits", withHistogram: false }, timeRange: { asMuchAsElements: 5 } };
      ws.send(`md/getChart\n2\n\n${JSON.stringify(body)}`);
    } else if (m.i === 2) {
      console.log("getChart réponse s=", m.s, JSON.stringify(m.d));
    } else if (m.e === "chart") {
      n++;
      const charts = m.d?.charts || [];
      for (const c of charts) {
        const keys = Object.keys(c);
        const bars = c.bars || [];
        console.log(`chart event #${n}: id=${c.id} keys=${keys.join(",")} bars=${bars.length}${c.eoh ? " EOH" : ""}`);
        if (bars.length) console.log("   1ère barre :", JSON.stringify(bars[0]), "\n   dernière :", JSON.stringify(bars[bars.length - 1]));
      }
      if (n >= 3) { clearTimeout(timer); ws.close(); }
    } else if (m.e) console.log("event", m.e, JSON.stringify(m.d).slice(0, 200));
  }
});
ws.on("close", () => process.exit(0));
