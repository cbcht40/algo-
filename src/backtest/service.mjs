import { createServer } from 'node:http'
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, readdir, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { ArchiveCatalog, loadJson, atomicJson, hashArchive } from './archive.mjs'
import { ReplayRunner } from './runner.mjs'
import { ReplayStorage } from './storage.mjs'
export const PROTOCOL_VERSION = 1
const PROD_ORIGINS = ['https://let-tradejournal.com', 'https://www.let-tradejournal.com']
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const uuid = value => /^[a-f0-9-]{36}$/i.test(String(value))
async function verifyUser(accessToken) {
  const response = await fetch('https://let-tradejournal.com/api/backtest?op=entitlement', {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(12000), redirect: 'error',
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.unlocked || !uuid(result.userId)) throw new Error(result.error || 'Le backtesting nécessite un abonnement Edge actif')
  return result.userId
}
async function body(req) {
  let size = 0; const chunks = []
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new Error('Requête trop volumineuse'); chunks.push(chunk) }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('JSON invalide')
  return value
}
export async function createBacktestService({ root, decoder, port = 7880, extraOrigins = [], authenticate = verifyUser, pickFiles, onPairCode = () => {}, onActivity = () => {} }) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const origins = new Set([...PROD_ORIGINS, ...extraOrigins]), grants = new Map(), users = new Map(), runners = new Map(), jobs = new Map(), streams = new Set()
  let pairCode = String(randomInt(100000, 1000000)), failures = [], server
  onPairCode(pairCode)
  const userStore = async owner => {
    if (!users.has(owner)) {
      users.set(owner, (async () => {
        const dir = join(root, owner); await mkdir(join(dir, 'sessions'), { recursive: true, mode: 0o700 })
        return { dir, catalog: await new ArchiveCatalog(join(dir, 'data'), decoder).load(), storage: await new ReplayStorage(dir).load() }
      })().catch(error => { users.delete(owner); throw error }))
    }
    return users.get(owner)
  }
  const listSessions = async owner => {
    const { dir } = await userStore(owner), out = []
    for (const file of await readdir(join(dir, 'sessions'))) if (/^[a-f0-9-]{36}\.json$/.test(file)) {
      const s = await loadJson(join(dir, 'sessions', file), null)
      if (s?.owner === owner) out.push(s.result)
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  const getRunner = async (owner, id) => {
    if (!uuid(id)) throw new Error('Session invalide')
    if (runners.has(id)) { const r = runners.get(id); if (r.owner !== owner) throw new Error('Session introuvable'); return r }
    const { dir } = await userStore(owner), file = join(dir, 'sessions', id + '.json'), saved = await loadJson(file, null)
    if (!saved || saved.owner !== owner) throw new Error('Session introuvable')
    const r = new ReplayRunner({ file, cache: saved.cache, dataset: saved.dataset, instrument: saved.instrument, start: saved.start, owner, saved })
    runners.set(id, r)
    // Restoring a large archive remains asynchronous; status is visible to the browser.
    r.prepare().catch(e => { r.status = 'error'; r.error = e.message })
    return r
  }
  const startJob = (owner, work) => {
    if ([...jobs.values()].some(j => j.owner === owner && j.status === 'running')) throw new Error('Une préparation est déjà en cours')
    const job = { id: randomUUID(), owner, status: 'running', progress: 0, controller: new AbortController() }
    jobs.set(job.id, job)
    Promise.resolve().then(() => work(job)).then(result => { job.status = job.controller.signal.aborted ? 'cancelled' : 'done'; job.result = result; job.progress = 100 }, e => { job.status = job.controller.signal.aborted ? 'cancelled' : 'error'; job.error = e.message })
    return { jobId: job.id }
  }
  const prepareCache = (selected, job) => new Promise((ok, fail) => {
    const worker = new Worker(new URL('./import-worker.mjs', import.meta.url), { workerData: {
      decoder, file: selected.entry.path, output: selected.cache, intervals: selected.instrument.intervals, start: selected.entry.start, end: selected.entry.end,
      maxBytes: job.maxBytes,
    } })
    const cancel = () => worker.postMessage('cancel'); job.controller.signal.addEventListener('abort', cancel, { once: true })
    worker.on('message', m => {
      if (m.type === 'progress') Object.assign(job, m.value)
      if (m.type === 'done') ok(m.value)
      if (m.type === 'error') fail(new Error(m.error))
    })
    worker.on('error', fail)
    worker.on('exit', code => { job.controller.signal.removeEventListener('abort', cancel); if (code) fail(new Error('Le décodage a été interrompu')) })
  })
  server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }
    // Binding to loopback is not authentication. Host + Origin + capability token are all checked.
    const origin = String(req.headers.origin || ''), host = String(req.headers.host || '')
    if (host !== `127.0.0.1:${server.address().port}` && host !== `localhost:${server.address().port}`) return reply(403, { error: 'Hôte interdit' })
    const localOrigin = `http://localhost:${server.address().port}`
    const asset = new URL(req.url, localOrigin).pathname
    if (req.method === 'GET' && ['/bridge.html','/bridge.js','/bridge.css'].includes(asset)) {
      if (origin && origin !== localOrigin && !origins.has(origin)) return reply(403, { error: 'Origine interdite' })
      const mime = { '/bridge.html':'text/html; charset=utf-8', '/bridge.js':'application/javascript; charset=utf-8', '/bridge.css':'text/css; charset=utf-8' }
      try {
        let content = await readFile(new URL('.' + asset, import.meta.url), 'utf8')
        if (asset === '/bridge.js') content = content.replace('__ALLOWED_PARENT_ORIGINS__', JSON.stringify([...origins]))
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src http://127.0.0.1:${server.address().port}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`)
        res.setHeader('Referrer-Policy','no-referrer'); res.writeHead(200, { 'Content-Type': mime[asset] }); res.end(content)
      } catch { reply(500, { error:'Liaison locale indisponible : réinstalle l’application.' }) }
      return
    }
    if (!origins.has(origin) && origin !== localOrigin) return reply(403, { error: 'Origine interdite' })
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') return reply(204, {})
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname
      if (path === '/v1/status' && req.method === 'GET') return reply(200, { version: PROTOCOL_VERSION, name: 'Let-Trade Backtesting', rithmic: { available: false, reason: 'Intégration officielle Rithmic en attente de validation' } })
      if (path === '/v1/pair' && req.method === 'POST') {
        failures = failures.filter(t => t > Date.now() - 10 * 60000)
        if (failures.length >= 6) return reply(429, { error: 'Trop d’essais : attends dix minutes ou renouvelle le code dans l’application' })
        const b = await body(req)
        if (!equal(String(b.code || ''), pairCode)) { failures.push(Date.now()); return reply(403, { error: 'Code incorrect. Consulte l’application installée.' }) }
        if (typeof b.accessToken !== 'string' || b.accessToken.length > 12000) return reply(401, { error: 'Connexion au journal requise' })
        const owner = await authenticate(b.accessToken)
        if (!uuid(owner)) throw new Error('Identité invalide')
        const token = randomBytes(32).toString('base64url')
        grants.set(token, { owner, origin, expires: Date.now() + 3600000 })
        pairCode = String(randomInt(100000, 1000000)); onPairCode(pairCode); failures = []
        await userStore(owner); return reply(200, { token, userId: owner, expiresAt: Date.now() + 3600000 })
      }
      const token = String(req.headers.authorization || '').replace(/^Bearer /, ''), grant = grants.get(token)
      if (!grant || grant.origin !== origin || grant.expires < Date.now()) return reply(401, { error: 'Reconnecte le compagnon local depuis la section Backtesting' })
      const owner = grant.owner, { catalog, dir, storage } = await userStore(owner)
      if (path === '/v1/storage' && req.method === 'GET') return reply(200, await storage.status())
      if (path === '/v1/storage' && req.method === 'POST') { const b = await body(req); return reply(200, await storage.configure(b.limitGB)) }
      if (path === '/v1/renew' && req.method === 'POST') {
        const b = await body(req); if (await authenticate(b.accessToken) !== owner) throw new Error('Ce compte ne correspond pas à la connexion locale')
        grant.expires = Date.now() + 3600000; return reply(200, { expiresAt: grant.expires })
      }
      if (path === '/v1/disconnect' && req.method === 'POST') {
        grants.delete(token); for (const r of runners.values()) if (r.owner === owner && r.ready) await r.action({ type: 'pause' })
        return reply(200, { ok: true })
      }
      if (path === '/v1/catalog' && req.method === 'GET') return reply(200, { datasets: catalog.list() })
      if (path === '/v1/import' && req.method === 'POST') {
        const b = await body(req)
        if (!pickFiles) throw new Error('Le sélecteur de fichiers nécessite l’application installée')
        return reply(202, startJob(owner, async job => {
          const paths = await pickFiles(b.kind === 'directory' ? 'directory' : 'files')
          if (!paths?.length) return { cancelled: true }
          return catalog.add(paths, job.controller.signal, p => Object.assign(job, p))
        }))
      }
      const jobMatch = path.match(/^\/v1\/jobs\/([a-f0-9-]{36})$/)
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]); if (!job || job.owner !== owner) return reply(404, { error: 'Préparation introuvable' })
        if (req.method === 'DELETE') job.controller.abort()
        const { controller, owner: _owner, ...view } = job; return reply(200, view)
      }
      if (path === '/v1/sessions' && req.method === 'GET') return reply(200, { sessions: await listSessions(owner) })
      if (path === '/v1/sessions' && req.method === 'POST') {
        const b = await body(req), selected = catalog.get(b.datasetId, b.symbol)
        // Validate financial settings before starting expensive decoding.
        const { ReplayEngine } = await import('./engine.mjs'); new ReplayEngine({ instrument: selected.instrument, ...b.settings })
        const start = String(b.start || selected.entry.start)
        if (!/^\d{16,20}$/.test(start) || BigInt(start) < BigInt(selected.entry.start) || BigInt(start) >= BigInt(selected.entry.end)) throw new Error('Heure de début hors des données disponibles')
        return reply(202, startJob(owner, async job => {
          for (const r of runners.values()) if (r.owner === owner && r.ready) await r.action({ type: 'pause' })
          let info = await loadJson(selected.cache + '.json', null)
          const current = await stat(selected.entry.path)
          if (current.size !== selected.entry.bytes || current.mtimeMs !== selected.entry.mtimeMs) throw new Error('Le fichier source a changé. Réimporte-le pour conserver la précision des sessions.')
          if (info) {
            job.stage = 'Vérification du fichier original'
            const hash = await hashArchive(selected.entry.path, job.controller.signal)
            if (hash !== info.sourceHash) throw new Error('Ce fichier ne correspond pas au cache sauvegardé. Sélectionne l’original de cette séance.')
          }
          if (!info) {
            const held = [...runners.values()].filter(r => r.owner === owner).map(r => r.cache)
            job.maxBytes = await storage.reserve(Math.min(selected.entry.bytes * 3, 4 * 1024 ** 3), held)
            info = await prepareCache(selected, job)
          }
          if (job.controller.signal.aborted) throw new Error('Préparation annulée')
          const id = randomUUID(), file = join(dir, 'sessions', id + '.json')
          const r = new ReplayRunner({ file, cache: selected.cache, dataset: { ...selected.entry, path: undefined, fingerprint: info.sourceHash }, instrument: selected.instrument, settings: b.settings, start, owner })
          r.id = id
          if (b.attemptOf) { const prior = await loadJson(join(dir, 'sessions', uuid(b.attemptOf) ? b.attemptOf + '.json' : 'invalid'), null); if (prior?.owner === owner) r.attemptOf = b.attemptOf }
          runners.set(id, r); job.stage = 'Préparation du replay'
          const cancel = () => { r.closed = true }; job.controller.signal.addEventListener('abort', cancel, { once: true })
          try { await r.prepare(p => Object.assign(job, p)) } finally { job.controller.signal.removeEventListener('abort', cancel) }
          return { sessionId: id }
        }))
      }
      const match = path.match(/^\/v1\/sessions\/([a-f0-9-]{36})(?:\/(commands|events|export))?$/)
      if (match) {
        const r = await getRunner(owner, match[1]); r.lastSeen = Date.now()
        const interval = Number(url.searchParams.get('seconds') || 60)
        const comparison = url.searchParams.has('comparison') ? Number(url.searchParams.get('comparison')) : null
        if (![15,30,60,120,180,300,600,900,1800,3600,14400,86400].includes(interval)) throw new Error('Unité de temps invalide')
        if (comparison && ![15,30,60,120,180,300,600,900,1800,3600,14400,86400].includes(comparison)) throw new Error('Unité de comparaison invalide')
        if (match[2] === 'commands' && req.method === 'POST') { const result = await r.action(await body(req)); onActivity([...runners.values()].some(x => x.status === 'playing')); return reply(200, result) }
        if (match[2] === 'export' && req.method === 'GET') return reply(200, r.exportResult())
        if (match[2] === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
          streams.add(res)
          const send = () => {
            if (!grants.has(token) || grant.expires < Date.now()) { res.end(); return }
            r.lastSeen = Date.now()
            try { if (!res.writableNeedDrain) res.write(`data: ${JSON.stringify(r.view(interval, comparison))}\n\n`) } catch { res.end() }
          }
          send(); const timer = setInterval(send, 350)
          res.on('close', () => { clearInterval(timer); streams.delete(res) }); return
        }
        if (req.method === 'GET' && !match[2]) return reply(200, r.view(interval, comparison))
      }
      return reply(404, { error: 'Route introuvable' })
    } catch (e) { if (!res.headersSent) reply(400, { error: e.message || 'Erreur du compagnon local' }); else res.end() }
  })
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok) })
  return {
    port: server.address().port,
    pairCode: () => pairCode,
    renewPairCode: () => { failures = []; pairCode = String(randomInt(100000, 1000000)); onPairCode(pairCode); return pairCode },
    // Used by trusted native UI / test harness only; never exposed to HTTP clients.
    catalog: async owner => (await userStore(owner)).catalog,
    close: async () => { for (const j of jobs.values()) j.controller.abort(); for (const s of streams) s.end(); await Promise.allSettled([...runners.values()].map(r => r.close())); await new Promise(ok => server.close(ok)) },
  }
}
