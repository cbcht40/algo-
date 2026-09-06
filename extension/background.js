// Let Trade Copieur background service worker.
// 1) Sniffs the Authorization: Bearer token from your live Tradovate requests and forwards
//    it to the local copier bridge. 2) Pairs with the bridge (shared key) so that only this
//    extension — never a random web page — can talk to it. 3) Fallback path for relayed
//    orders when the content script cannot reach the bridge directly. Nothing leaves your machine.

const COPIER = "http://127.0.0.1:7878";

// sub -> { token, exp }. Conservés dans chrome.storage.SESSION : mémoire vive du navigateur,
// jamais le disque, effacé à la fermeture de Chrome — et réservé aux contextes de confiance
// (pas les pages web). Indispensable : le service worker MV3 est déchargé après ~30 s
// d'inactivité ; sans ça il perdait le jeton et ne pouvait plus ranimer le copieur tant que
// l'onglet Tradovate ne refaisait pas une requête (onglet en arrière-plan = gelé par Chrome).
const tokens = {};
let loading = null;
function loadTokens() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const s = await chrome.storage.session.get("tokens");
      if (s && s.tokens) for (const sub of Object.keys(s.tokens)) if (!tokens[sub]) tokens[sub] = s.tokens[sub];
    } catch {}
  })();
  return loading;
}
function saveTokens() {
  try { chrome.storage.session.set({ tokens: tokens }); } catch {}
}
let bridgeKey = "";
let pairing = null;

function decode(jwt) {
  try {
    const b = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(b));
    return { sub: String(p.sub), exp: Number(p.exp) || 0, email: p.email };
  } catch {
    return {};
  }
}

// --- appairage avec le pont (clé partagée) ------------------------------------------
async function loadKey() {
  if (bridgeKey) return bridgeKey;
  try { bridgeKey = (await chrome.storage.local.get("bridgeKey")).bridgeKey || ""; } catch {}
  return bridgeKey;
}
async function pair() {
  if (pairing) return pairing;
  pairing = (async () => {
    try {
      const r = await fetch(`${COPIER}/pair`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.key) {
        bridgeKey = j.key;
        await chrome.storage.local.set({ bridgeKey: j.key, pairedAt: Date.now() });
        return j.key;
      }
    } catch {}
    return "";
  })();
  const k = await pairing;
  pairing = null;
  return k;
}
/** POST JSON au pont avec la clé ; sur 403 on ré-appaire une fois et on réessaie. */
async function postBridge(path, payload) {
  let key = (await loadKey()) || (await pair());
  let r = await fetch(`${COPIER}${path}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ ...payload, key }), keepalive: true });
  if (r.status === 403) {
    key = await pair();
    if (key) r = await fetch(`${COPIER}${path}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ ...payload, key }), keepalive: true });
  }
  return r;
}

async function getDisplay() {
  return (await chrome.storage.local.get("logins")).logins || {};
}

async function setDisplay(logins) {
  await chrome.storage.local.set({ logins });
  const subs = Object.keys(logins);
  const anyOk = subs.some((s) => logins[s].sentOk);
  chrome.action.setBadgeText({ text: subs.length ? String(subs.length) : "" });
  chrome.action.setBadgeBackgroundColor({ color: anyOk ? "#4f7cff" : "#9ca3af" });
}

/** Le jeton est-il encore utilisable ? (30 s de marge) */
function alive(entry) {
  return !!entry && (!entry.exp || entry.exp * 1000 > Date.now() + 30000);
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
    const r = await postBridge("/token", { token: entry.token });
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
  if (prev && prev.token === jwt) return; // Tradovate renvoie le même bearer très souvent
  tokens[sub] = { token: jwt, exp, email };
  saveTokens();
  send(sub);
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

// 2) Battement de cœur, toutes les minutes (une alarme réveille le service worker même si
// l'onglet Tradovate est en arrière-plan et gelé par Chrome — contrairement à un setInterval
// de la page). On repousse le jeton À CHAQUE FOIS, pas seulement après un échec : c'est ce
// qui ranime la session du copieur quand elle est tombée (Mac en veille, socket coupé) sans
// que l'utilisateur ait à recharger son onglet. Côté copieur c'est gratuit quand la session
// est saine (le jeton identique n'est pas rejoué). Un simple ping garde l'indicateur
// « extension vue il y a … » juste, même quand tous les jetons sont expirés.
chrome.alarms.create("retry", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "retry") return;
  await loadTokens();
  if (!(await loadKey())) await pair();
  let sent = 0;
  for (const sub of Object.keys(tokens)) {
    if (alive(tokens[sub])) { await send(sub); sent++; }
  }
  if (!sent) await postBridge("/ping", {}).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => { pair(); loadTokens(); });
chrome.runtime.onStartup.addListener(() => { pair(); loadTokens(); });
loadTokens();

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
    postBridge("/relay", msg.relay).catch(() => {});
    reply({ ok: true });
    return true;
  }
  // Le content script demande la clé d'appairage (pour son chemin direct).
  if (msg === "key") {
    (async () => reply({ key: (await loadKey()) || (await pair()) }))();
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
