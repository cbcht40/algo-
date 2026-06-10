const COPIER = "http://127.0.0.1:7878";

const $ = (id) => document.getElementById(id);

function fmtExp(exp) {
  if (!exp) return "";
  const mins = Math.round((exp * 1000 - Date.now()) / 60000);
  if (mins <= 0) return "expiré";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
}

function shortName(info, copierLogins) {
  // Prefer the account label the copier reports for this login.
  const match = copierLogins.find((l) => String(l.userId) === info.sub);
  if (match && match.label) return match.label;
  if (info.email) return info.email;
  return `Login ${info.sub}`;
}

async function fetchStatus() {
  try {
    const r = await fetch(`${COPIER}/status`, { cache: "no-store" });
    if (!r.ok) throw 0;
    return await r.json();
  } catch {
    return null;
  }
}

async function render() {
  const status = await fetchStatus();
  const online = !!status;

  // Copier card
  const dot = $("copier-dot");
  dot.className = "dot " + (online ? "on" : "off");
  $("copier-title").textContent = online
    ? `Copieur en ligne — ${status.logins.length} login(s)`
    : "Copieur hors ligne";
  $("copier-sub").textContent = online ? "Connecté à 127.0.0.1:7878" : "Lance le copieur (npm start)";

  // Logins list
  const logins = (await chrome.storage.local.get("logins")).logins || {};
  const subs = Object.keys(logins);
  const ul = $("logins");
  ul.innerHTML = "";
  if (subs.length === 0) {
    ul.innerHTML = `<li class="empty">Ouvre une session Tradovate pour capter un token…</li>`;
  } else {
    const copierLogins = online ? status.logins : [];
    for (const sub of subs) {
      const info = logins[sub];
      const ready = copierLogins.find((l) => String(l.userId) === sub)?.ready;
      const ok = info.sentOk && online;
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="dot ${ok ? "on" : "wait"}"></span>
        <div class="li-text">
          <div class="li-name">${shortName(info, copierLogins)}</div>
          <div class="li-sub">token valide ${fmtExp(info.exp)}</div>
        </div>
        <div class="li-state ${ok ? "ok" : "off"}">${
          ok ? (ready ? "✓ relié" : "✓ envoyé") : online ? "en attente" : "copieur off"
        }</div>`;
      ul.appendChild(li);
    }
  }
}

$("resend").addEventListener("click", async () => {
  const btn = $("resend");
  btn.disabled = true;
  btn.textContent = "Envoi…";
  await chrome.runtime.sendMessage("resend").catch(() => {});
  await render();
  btn.textContent = "Renvoyer les tokens maintenant";
  btn.disabled = false;
});

render();
setInterval(render, 3000);
