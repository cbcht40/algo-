// Top-level localhost window for browsers that reject mixed-content loopback fetches.
// Only the opening, explicitly allowlisted site can use this scoped transport.
const allowedParents = __ALLOWED_PARENT_ORIGINS__
const parentOrigin = new URL(location.href).searchParams.get('parent')
const parentWindow = window.opener
const requests = new Map()
const base = `http://127.0.0.1:${location.port}/v1`
let channel = null
const validPath = path => typeof path === 'string' && /^\/(?:pair|renew|disconnect|catalog|import|storage|status|jobs\/[a-f0-9-]{36}|sessions(?:\/[a-f0-9-]{36}(?:\/(?:commands|events|export))?)?)(?:\?seconds=\d+(?:&comparison=\d+)?)?$/.test(path)
const send = data => parentWindow.postMessage({ backtestBridge: 1, channel, ...data }, parentOrigin)
if (!allowedParents.includes(parentOrigin) || !parentWindow) {
  document.getElementById('status').textContent = 'Ouvre cette liaison depuis la section Backtesting de Let-Trade.'
} else {
  const ready = setInterval(() => send({ type: 'ready' }), 300)
  window.addEventListener('message', async event => {
    const m = event.data
    if (event.source !== parentWindow || event.origin !== parentOrigin || !m || m.backtestBridge !== 1) return
    if (m.type === 'hello' && typeof m.channel === 'string' && /^[a-f0-9-]{36}$/.test(m.channel)) {
      if (channel && channel !== m.channel) return
      channel = m.channel; clearInterval(ready); send({ type: 'connected' })
      document.getElementById('status').textContent = 'Liaison prête. Reviens au site pour connecter ton compte.'; return
    }
    if (!channel || m.channel !== channel || typeof m.id !== 'string' || m.id.length > 100) return
    if (m.type === 'abort') { requests.get(m.id)?.abort(); return }
    if (m.type !== 'request' || !validPath(m.path) || !['GET','POST','DELETE'].includes(m.method) || requests.size > 20 || requests.has(m.id)) return
    const controller = new AbortController(); requests.set(m.id, controller)
    const timer = m.stream ? null : setTimeout(() => controller.abort(), 45000)
    try {
      const response = await fetch(base + m.path, { method: m.method, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { ...(typeof m.token === 'string' ? { Authorization: `Bearer ${m.token}` } : {}), ...(m.body ? {'Content-Type':'application/json'} : {}) },
        body: m.body ? JSON.stringify(m.body) : undefined })
      if (!m.stream || !response.ok) { send({ type: 'response', id: m.id, status: response.status, value: await response.json().catch(() => ({})) }); return }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = ''
      try { for (;;) {
        const { value, done } = await reader.read(); if (done) break
        pending += decoder.decode(value, { stream: true }); let end
        while ((end = pending.indexOf('\n\n')) >= 0) { const part = pending.slice(0, end); pending = pending.slice(end + 2); if (part.startsWith('data: ')) send({ type: 'state', id: m.id, value: JSON.parse(part.slice(6)) }) }
      } } finally { reader.releaseLock() }
      send({ type: 'end', id: m.id })
    } catch (error) { send({ type: 'error', id: m.id, error: controller.signal.aborted ? 'Connexion locale interrompue.' : error.message }) }
    finally { clearTimeout(timer); requests.delete(m.id) }
  })
  window.addEventListener('beforeunload', () => { for (const c of requests.values()) c.abort() })
}
document.getElementById('back').onclick = () => parentWindow?.focus()
