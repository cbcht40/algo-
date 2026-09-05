// Let Trade Copieur background service worker.
// Sniffs the Authorization: Bearer token from your live Tradovate requests and
// forwards it to the local copier bridge. Nothing leaves your machine.

const COPIER = "http://127.0.0.1:7878";

// In-memory: sub -> { token, exp }. Tokens never touch chrome.storage (only
// non-secret display info does), so an unloaded worker simply re-learns them
// from the next Tradovate request.
const tokens = {};

function decode(jwt) {
  try {
    const b = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(b));
    return { sub: String(p.sub), exp: Number(p.exp) || 0, email: p.email };
  } catch {
    return {};
  }
}

async function getDisplay() {
  return (await chrome.storage.local.get("logins")).logins || {};
}

async function setDisplay(logins) {
  await chrome.storage.local.set({ logins });
  const subs = Object.keys(logins);
  const anyOk = subs.some((s) => logins[s].sentOk);
  chrome.action.setBadgeText({ text: subs.length ? String(subs.length) : "" });
  chrome.action.setBadgeBackgroundColor({ color: anyOk ? "#16a34a" : "#9ca3af" });
}

async function send(sub) {
  const entry = tokens[sub];
  if (!entry) return;
  const logins = await getDisplay();
  const info = logins[sub] || {};
  info.sub = sub;
  info.exp = entry.exp;
  info.email = entry.email;
  info.lastSeen = Date.now();
  try {
    const r = await fetch(`${COPIER}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: entry.token }),
    });
    const j = await r.json().catch(() => ({}));
    info.sentOk = !!(r.ok && j.ok);
    info.login = j.login || null;
    info.error = info.sentOk ? null : j.error || `HTTP ${r.status}`;
    info.copierOnline = true;
  } catch {
    info.sentOk = false;
    info.error = "copieur hors ligne";
    info.copierOnline = false;
  }
  info.lastSent = Date.now();
  logins[sub] = info;
  await setDisplay(logins);
}

function onToken(jwt) {
  const { sub, exp, email } = decode(jwt);
  if (!sub) return;
  const prev = tokens[sub];
  tokens[sub] = { token: jwt, exp, email };
  // Only hit the copier when the token actually changed (Tradovate fires lots
  // of requests with the same bearer).
  if (!prev || prev.token !== jwt) send(sub);
}

// 1) Capture the bearer from every Tradovate API request.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const h = (details.requestHeaders || []).find(
      (x) => x.name.toLowerCase() === "authorization",
    );
    if (h && h.value && /^Bearer\s+/i.test(h.value)) {
      onToken(h.value.replace(/^Bearer\s+/i, "").trim());
    }
  },
  { urls: ["https://*.tradovateapi.com/*"] },
  ["requestHeaders", "extraHeaders"],
);

// 2) Retry every minute: when the copier was offline (just launched, rebooted),
// re-deliver the latest known tokens automatically.
chrome.alarms.create("retry", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "retry") return;
  const logins = await getDisplay();
  for (const sub of Object.keys(tokens)) {
    if (!logins[sub]?.sentOk) await send(sub);
  }
});

// 3) Popup + content-script messages.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  // Token forwarded by the page relay (content script) — the reliable path.
  if (msg && msg.type === "token" && msg.token) {
    onToken(msg.token);
    return; // no async reply needed
  }
  // Ordre intercepté dans la page (relais) — chemin de secours quand le content script
  // n'a pas pu joindre le copieur en direct. Réponse immédiate, envoi en fond.
  if (msg && msg.type === "relay" && msg.relay) {
    fetch(`${COPIER}/relay`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(msg.relay),
      keepalive: true,
    }).catch(() => {});
    reply({ ok: true });
    return true;
  }
  // Keep-alive : tant qu'un onglet Tradovate est ouvert, le content script nous pingue
  // → le service worker reste chaud (pas de démarrage à froid au moment d'un ordre).
  if (msg === "ping") {
    reply({ ok: true });
    return true;
  }
  if (msg === "resend") {
    Promise.all(Object.keys(tokens).map(send)).then(() => reply({ ok: true }));
    return true; // async reply
  }
  if (msg === "haveTokens") {
    reply({ count: Object.keys(tokens).length });
    return true;
  }
});
