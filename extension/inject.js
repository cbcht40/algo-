// Let Trade Copieur — MAIN-world hook injected into the Tradovate page.
//
// 1) Token : wraps fetch / XHR / WebSocket to grab the Bearer token wherever it appears
//    (REST headers or the WebSocket "authorize" frame).
// 2) Relais : intercepts the ORDER requests the web client sends (placeorder, OCO/OSO,
//    bracket strategies, modify, cancel, liquidate) at the very instant they leave the
//    browser — BEFORE they reach Tradovate — and hands them to the local copier, which
//    fires the same order on the other accounts of the group at the same time. The
//    server response (orderId) is relayed too so later modifications/cancels map exactly.
//
// Everything goes to the isolated relay via window.postMessage; nothing leaves the machine.
// Runs at document_start so it wraps the primitives before the app uses them.
(function () {
  const TEE = new Set([
    "order/placeorder",
    "order/placeoco",
    "order/placeoso",
    "orderstrategy/startorderstrategy",
    "order/modifyorder",
    "order/cancelorder",
    "order/liquidateposition",
  ]);
  const post = (payload) => window.postMessage(Object.assign({ __copilink: true }, payload), "*");
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  function emit(token) {
    if (token && /^eyJ[\w-]+\.eyJ[\w-]+\./.test(token)) post({ token: token });
  }

  function authFrom(init) {
    try {
      const h = init && init.headers;
      if (!h) return null;
      if (typeof h.get === "function") return h.get("Authorization") || h.get("authorization");
      if (Array.isArray(h)) {
        const f = h.find((p) => String(p[0]).toLowerCase() === "authorization");
        return f ? f[1] : null;
      }
      return h["Authorization"] || h["authorization"] || null;
    } catch {
      return null;
    }
  }

  // --- relais -----------------------------------------------------------------------
  function relayRequest(endpoint, bodyText, via) {
    let body;
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { return null; }
    if (!body || typeof body !== "object") return null;
    const teeId = uid();
    post({ relay: { kind: "request", teeId: teeId, endpoint: endpoint, body: body, t: Date.now(), via: via } });
    return teeId;
  }
  function relayResponse(teeId, status, data) {
    post({ relay: { kind: "response", teeId: teeId, status: status, data: data && typeof data === "object" ? data : {} } });
  }

  // Per-socket map of request id -> teeId, to catch the server's answer ({i, s, d}).
  const pending = new WeakMap();
  const listening = new WeakSet();
  function onSocketMessage(sock, ev) {
    const map = pending.get(sock);
    if (!map || !map.size) return;
    const raw = ev && ev.data;
    if (typeof raw !== "string" || raw[0] !== "a") return;
    let arr;
    try { arr = JSON.parse(raw.slice(1)); } catch { return; }
    if (!Array.isArray(arr)) return;
    for (const m of arr) {
      if (!m || typeof m.i !== "number") continue;
      const key = String(m.i);
      const teeId = map.get(key);
      if (!teeId) continue;
      map.delete(key);
      relayResponse(teeId, m.s, m.d);
    }
  }

  // WebSocket : "endpoint\nid\nquery\nbody" frames (authorize + orders).
  const _send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      if (typeof data === "string") {
        if (data.slice(0, 9) === "authorize") {
          const parts = data.split("\n");
          if (parts.length >= 4) emit(parts.slice(3).join("\n").trim());
        } else {
          const i1 = data.indexOf("\n");
          const endpoint = i1 > 0 ? data.slice(0, i1).toLowerCase() : "";
          if (TEE.has(endpoint)) {
            const i2 = data.indexOf("\n", i1 + 1);
            const i3 = i2 >= 0 ? data.indexOf("\n", i2 + 1) : -1;
            const reqId = i2 >= 0 ? data.slice(i1 + 1, i2) : "";
            const bodyText = i3 >= 0 ? data.slice(i3 + 1) : "";
            const teeId = relayRequest(endpoint, bodyText, "ws");
            if (teeId && reqId) {
              let map = pending.get(this);
              if (!map) { map = new Map(); pending.set(this, map); }
              map.set(reqId, teeId);
              if (!listening.has(this)) {
                listening.add(this);
                this.addEventListener("message", (ev) => onSocketMessage(this, ev));
              }
            }
          }
        }
      }
    } catch {}
    return _send.apply(this, arguments);
  };

  // fetch : token header + REST orders (if the client ever uses REST for them).
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      let teeId = null;
      try {
        const a = authFrom(init);
        if (a) emit(String(a).replace(/^Bearer\s+/i, "").trim());
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const m = /\/v1\/((?:order|orderStrategy)\/[a-zA-Z]+)/.exec(url);
        const ep = m ? m[1].toLowerCase() : "";
        if (ep && TEE.has(ep) && init && typeof init.body === "string") teeId = relayRequest(ep, init.body, "rest");
      } catch {}
      const p = _fetch.apply(this, arguments);
      if (teeId) {
        p.then((r) => {
          try { r.clone().json().then((d) => relayResponse(teeId, r.status, d)).catch(() => {}); } catch {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // XMLHttpRequest : token header.
  const _setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === "authorization" && v) {
      emit(String(v).replace(/^Bearer\s+/i, "").trim());
    }
    return _setHeader.apply(this, arguments);
  };
})();
