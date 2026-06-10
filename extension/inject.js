// Copilink — MAIN-world hook injected into the Tradovate page.
// Wraps the app's own network primitives to grab the Bearer token wherever it
// appears (REST headers or the WebSocket "authorize" frame), then hands it to
// the isolated relay via window.postMessage. Runs at document_start so it wraps
// fetch/WebSocket before the app uses them.
(function () {
  function emit(token) {
    if (token && /^eyJ[\w-]+\.eyJ[\w-]+\./.test(token)) {
      window.postMessage({ __copilink: true, token: token }, "*");
    }
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

  // fetch
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      const a = authFrom(init);
      if (a) emit(String(a).replace(/^Bearer\s+/i, "").trim());
      return _fetch.apply(this, arguments);
    };
  }

  // XMLHttpRequest
  const _setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === "authorization" && v) {
      emit(String(v).replace(/^Bearer\s+/i, "").trim());
    }
    return _setHeader.apply(this, arguments);
  };

  // WebSocket authorize frame:  "authorize\n<id>\n\n<token>"
  const _send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      if (typeof data === "string" && data.slice(0, 9) === "authorize") {
        const parts = data.split("\n");
        if (parts.length >= 4) emit(parts.slice(3).join("\n").trim());
      }
    } catch {}
    return _send.apply(this, arguments);
  };
})();
