// Let Trade Copieur — isolated-world relay on the Tradovate page.
// Receives tokens AND intercepted orders from the MAIN-world hook (inject.js), scans page
// storage as a backstop for tokens, and forwards everything to the local copier.
//
// Orders take the FASTEST path: a direct fetch to 127.0.0.1:7878 from this content script
// (loopback = secure context, no service-worker wake-up). If that fails (blocked by the
// browser, copier offline…), they fall back to the background service worker.
const COPIER = "http://127.0.0.1:7878";

function forward(token) {
  if (token && /^eyJ[\w-]+\.eyJ[\w-]+\./.test(token)) {
    try {
      chrome.runtime.sendMessage({ type: "token", token: token });
    } catch {}
  }
}

let directOk = true; // switches to false after a direct failure, retried every minute
let directRetryAt = 0;
function relayViaBackground(relay) {
  try {
    chrome.runtime.sendMessage({ type: "relay", relay: relay });
  } catch {}
}
function relayOrder(relay) {
  const now = Date.now();
  if (!directOk && now < directRetryAt) {
    relayViaBackground(relay);
    return;
  }
  try {
    const p = fetch(COPIER + "/relay", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(relay),
      keepalive: true,
      cache: "no-store",
    });
    p.then(
      (r) => { if (!r.ok) { directOk = false; directRetryAt = now + 60000; relayViaBackground(relay); } else directOk = true; },
      () => { directOk = false; directRetryAt = now + 60000; relayViaBackground(relay); },
    );
  } catch {
    directOk = false;
    directRetryAt = now + 60000;
    relayViaBackground(relay);
  }
}

// 1) Messages from the MAIN-world hook.
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || !e.data.__copilink) return;
  if (e.data.token) forward(e.data.token);
  if (e.data.relay) relayOrder(e.data.relay);
});

// 2) Backstop: scan localStorage/sessionStorage for a stored JWT.
function scanStorage() {
  for (const store of [window.localStorage, window.sessionStorage]) {
    if (!store) continue;
    for (let i = 0; i < store.length; i++) {
      const v = store.getItem(store.key(i));
      if (!v) continue;
      if (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(v)) {
        forward(v);
      } else if (v.indexOf("eyJ") !== -1) {
        try {
          const o = JSON.parse(v);
          const t = o && (o.accessToken || o.token || o.access_token);
          if (typeof t === "string") forward(t);
        } catch {}
      }
    }
  }
}
scanStorage();
setInterval(scanStorage, 5000);

// 3) Keep the background service worker warm while a Tradovate tab is open, so the
//    fallback path never pays a cold start at the moment an order is placed.
setInterval(() => {
  try { chrome.runtime.sendMessage("ping", () => void chrome.runtime.lastError); } catch {}
}, 20000);
