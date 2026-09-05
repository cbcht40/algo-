// Sonde (locale) : la session Tradovate en cache donne-t-elle accès au flux de marché ?
// N'affiche AUCUN secret (ni token, ni identifiant) — seulement des booléens/statuts.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { renewAccessToken, REST_BASE } from "../src/tradovate/auth";

const MD_URL: Record<string, string> = {
  demo: "wss://md-demo.tradovateapi.com/v1/websocket",
  live: "wss://md.tradovateapi.com/v1/websocket",
};
const symbol = process.argv[2] || "MNQZ6";

function probeMd(url: string, token: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const out: string[] = [];
    const done = (s: string) => { out.push(s); try { ws.close(); } catch {} resolve(out.join(" | ")); };
    const timer = setTimeout(() => done("timeout 10s"), 10_000);
    let gotEvent = false;
    ws.on("open", () => out.push("ws open"));
    ws.on("error", (e) => { clearTimeout(timer); done("ws error " + String(e).slice(0, 60)); });
    ws.on("message", (raw) => {
      const s = raw.toString();
      if (s === "o") { ws.send(`authorize\n1\n\n${token}`); return; }
      if (s === "h") return;
      if (s[0] !== "a") return;
      let arr: any[] = [];
      try { arr = JSON.parse(s.slice(1)); } catch { return; }
      for (const m of arr) {
        if (m.i === 1) { out.push(`authorize s=${m.s}`); if (m.s === 200) ws.send(`md/subscribeQuote\n2\n\n${JSON.stringify({ symbol })}`); else { clearTimeout(timer); done("auth refused"); } }
        else if (m.i === 2) out.push(`subscribeQuote s=${m.s} ${m.d?.errorText ? "err=" + m.d.errorText : ""}`);
        else if (m.e === "md" && !gotEvent) {
          gotEvent = true;
          const q = m.d?.quotes?.[0];
          const entries = q?.entries ? Object.keys(q.entries).join(",") : "?";
          out.push(`md event: contractId=${q?.contractId} entries=${entries} trade=${q?.entries?.Trade?.price ?? "-"} bid=${q?.entries?.Bid?.price ?? "-"} ask=${q?.entries?.Offer?.price ?? "-"}`);
          clearTimeout(timer); done("ok");
        }
      }
    });
  });
}

const all = JSON.parse(readFileSync(".tradovate-tokens.json", "utf8")) as Record<string, { accessToken: string; expirationTime: string }>;
for (const [key, t] of Object.entries(all)) {
  const env = key.split("|")[1] === "live" ? "live" : "demo";
  const label = key.replace(/\|[^|]+$/, "|<id>");
  const expired = new Date(t.expirationTime).getTime() < Date.now();
  if (expired) { console.log(label, "→ token en cache expiré"); continue; }
  try {
    const r = await renewAccessToken(REST_BASE[env], t.accessToken);
    console.log(label, `→ renew OK · mdAccessToken présent: ${!!r.mdAccessToken}`);
    const mdTok = r.mdAccessToken || r.accessToken;
    console.log("   md via", r.mdAccessToken ? "mdAccessToken" : "accessToken", "→", await probeMd(MD_URL[env], mdTok));
    if (r.mdAccessToken) console.log("   md via accessToken →", await probeMd(MD_URL[env], r.accessToken));
  } catch (e) {
    console.log(label, "→ renew échoué :", String((e as Error).message || e).slice(0, 90));
  }
}
