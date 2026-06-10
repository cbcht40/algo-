// Copilink — isolated-world relay on the Tradovate page.
// Receives tokens from the MAIN-world hook (inject.js), scans page storage as a
// backstop, and forwards everything to the background service worker.
function forward(token) {
  if (token && /^eyJ[\w-]+\.eyJ[\w-]+\./.test(token)) {
    try {
      chrome.runtime.sendMessage({ type: "token", token: token });
    } catch {}
  }
}

// 1) Tokens caught in flight by the MAIN-world hook.
window.addEventListener("message", (e) => {
  if (e.source === window && e.data && e.data.__copilink && e.data.token) {
    forward(e.data.token);
  }
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
