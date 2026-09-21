import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, rename, stat, readdir, unlink, open, statfs } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import { createGzip, createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { instrumentSpec } from './instruments.mjs'
const execute = promisify(execFile)
export const digest = value => createHash('sha256').update(value).digest('hex')
export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  const handle = await open(tmp, 'w', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(tmp, file)
}
export async function loadJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return fallback; throw e } }
export async function metadata(decoder, file, signal) {
  const { stdout } = await execute(decoder, [file, '--metadata', '--json'], { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal })
  return JSON.parse(stdout)
}
export async function hashArchive(file, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk) }
  return hash.digest('hex')
}
export async function* binaryRecords(stream) {
  let pending = Buffer.alloc(0)
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let offset = 0
    while (offset < pending.length) {
      const length = pending[offset] * 4
      if (length < 16 || length > 1020) throw new Error('Enregistrement DBN invalide')
      if (offset + length > pending.length) break
      const raw = pending.subarray(offset, offset + length)
      offset += length
      if (raw[1] !== 160) continue
      if (length < 56) throw new Error('Enregistrement MBO tronqué')
      yield { raw, instrumentId: raw.readUInt32LE(4), exchangeTs: raw.readBigUInt64LE(8).toString(), orderId: raw.readBigUInt64LE(16).toString(),
        price: raw.readBigInt64LE(24).toString(), size: raw.readUInt32LE(32), flags: raw[36], channel: raw[37],
        action: String.fromCharCode(raw[38]), side: String.fromCharCode(raw[39]), ts: raw.readBigUInt64LE(40).toString(), sequence: raw.readUInt32LE(52) }
    }
    pending = pending.subarray(offset)
  }
  if (pending.length) throw new Error('Fin DBN tronquée : import refusé')
}
export async function* readCache(file) {
  const source = createReadStream(file), unzip = createGunzip()
  source.on('error', e => unzip.destroy(e)); source.pipe(unzip)
  try { yield* binaryRecords(unzip) } finally { source.destroy(); unzip.destroy() }
}

export async function normalizeArchive({ decoder, file, output, intervals, start, end, signal, maxBytes = Infinity, onProgress = () => {} }) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  const before = await stat(file)
  const space = await statfs(dirname(output))
  if (space.bavail * space.bsize < 1024 ** 3) throw new Error('Moins de 1 Go libre : libère de l’espace avant cet import')
  const sourceHash = createHash('sha256')
  for await (const b of createReadStream(file)) { if (signal?.aborted) throw new Error('Import annulé'); sourceHash.update(b) }
  const proc = spawn(decoder, [file, '--fragment'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal })
  const exited = new Promise((ok, fail) => { proc.once('error', fail); proc.once('close', code => code === 0 ? ok() : fail(new Error('Le décodeur DBN a refusé ce fichier'))) })
  exited.catch(() => {})
  // Never print file paths or decoder output into server logs.
  proc.stderr.resume()
  const tmp = output + '.part', gzip = createGzip({ level: 1 }), dest = createWriteStream(tmp, { mode: 0o600 })
  const written = pipeline(gzip, dest); written.catch(() => {})
  let buffer = [], bytes = 0, count = 0, scanned = 0, first = null, last = null, complete = true
  const ranges = intervals.map(v => ({ ...v, from: BigInt(v.from), to: BigInt(v.to) }))
  try {
    for await (const record of binaryRecords(proc.stdout)) {
      if (signal?.aborted) throw new Error('Import annulé')
      const ts = BigInt(record.ts)
      if (ranges.some(r => r.id === record.instrumentId && ts >= r.from && ts < r.to)) {
        buffer.push(Buffer.from(record.raw)); bytes += record.raw.length; count++
        first ??= record.ts; last = record.ts; complete = !!(record.flags & 128)
        if (bytes >= 256 * 1024) { if (!gzip.write(Buffer.concat(buffer, bytes))) await once(gzip, 'drain'); buffer = []; bytes = 0 }
      }
      if (++scanned % 100000 === 0) onProgress({ count, scanned, progress: Math.max(0, Math.min(99, Number(ts - BigInt(start)) / Number(BigInt(end) - BigInt(start)) * 100)) })
      if (dest.bytesWritten > maxBytes) throw new Error('Limite du cache atteinte. Augmente la limite de stockage.')
    }
    await exited
    if (!count) throw new Error('Aucun événement disponible pour cette échéance')
    if (!complete) throw new Error('Le fichier se termine au milieu d’un événement : import incomplet')
    if (bytes) gzip.write(Buffer.concat(buffer, bytes))
    gzip.end(); await written
    const after = await stat(file)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Le fichier a changé pendant l’import')
    await rename(tmp, output)
    const info = { version: 1, count, first, last, sourceHash: sourceHash.digest('hex'), bytes: (await stat(output)).size, createdAt: new Date().toISOString() }
    await atomicJson(output + '.json', info)
    return info
  } catch (e) {
    proc.kill(); gzip.destroy(); dest.destroy(); await written.catch(() => {}); await unlink(tmp).catch(() => {}); throw e
  }
}

export class ArchiveCatalog {
  constructor(root, decoder) { this.root = root; this.decoder = decoder; this.entries = []; this.definitions = {} }
  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    this.entries = await loadJson(join(this.root, 'catalog.json'), [])
    this.definitions = await loadJson(join(this.root, 'definitions.json'), {})
    return this
  }
  async add(paths, signal, onProgress = () => {}) {
    const files = []
    const walk = async (file, depth = 0) => {
      if (signal?.aborted) throw new Error('Import annulé')
      const s = await stat(file)
      if (s.isDirectory()) {
        if (depth > 6) return
        for (const entry of await readdir(file, { withFileTypes: true })) if (!entry.isSymbolicLink() && !entry.name.startsWith('.')) await walk(join(file, entry.name), depth + 1)
      } else if (/\.dbn(?:\.zst)?$/i.test(file)) files.push(resolve(file))
      if (files.length > 10000) throw new Error('Choisis un dossier contenant moins de 10 000 fichiers DBN')
    }
    for (const file of paths) await walk(file)
    if (!files.length) throw new Error('Aucun fichier .dbn ou .dbn.zst trouvé')
    const errors = []
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) break
      const path = files[i]
      try {
        const data = await metadata(this.decoder, path, signal), s = await stat(path)
        if (data.schema === 'definition') { await this.readDefinitions(path, signal); continue }
        if (data.schema !== 'mbo' || data.dataset !== 'GLBX.MDP3') throw new Error('Import MBO CME GLBX.MDP3 requis ; les autres normalisations nécessitent leur propre validation')
        const handle = await open(path, 'r'), first = Buffer.alloc(Math.min(s.size, 65536))
        try { await handle.read(first, 0, first.length, 0) } finally { await handle.close() }
        // File identity survives moving the original; mtime is only an integrity check.
        const fingerprint = digest(Buffer.concat([first, Buffer.from(`${s.size}|${JSON.stringify(data)}`)]))
        const id = fingerprint.slice(0, 32)
        const instruments = (data.mappings || []).map(m => ({ ...instrumentSpec(m.raw_symbol, this.definitions), intervals: m.intervals.map(v => {
          const day = n => { const x = String(n); return BigInt(Date.parse(`${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}T00:00:00Z`)) * 1000000n }
          return { id: Number(v.symbol), from: day(v.start_date).toString(), to: day(v.end_date).toString() }
        }) })).sort((a, b) => a.symbol.localeCompare(b.symbol))
        const entry = { version: 1, id, path, name: basename(path), source: 'databento', start: data.start, end: data.end,
          bytes: s.size, mtimeMs: s.mtimeMs, fingerprint, schema: data.schema, instruments, partial: data.partial || [],
          capabilities: { trades: true, depth: true, aggressor: true }, addedAt: new Date().toISOString() }
        this.entries = this.entries.filter(x => x.id !== id && x.path !== path); this.entries.push(entry)
      } catch (e) { errors.push({ name: basename(path), error: e.message }) }
      onProgress({ scanned: i + 1, total: files.length, progress: (i + 1) / files.length * 100 })
    }
    await atomicJson(join(this.root, 'catalog.json'), this.entries)
    return { added: files.length - errors.length, cancelled: !!signal?.aborted, errors }
  }
  async readDefinitions(path, signal) {
    const proc = spawn(this.decoder, [path, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal })
    proc.stderr.resume()
    const { createInterface } = await import('node:readline')
    const exited = new Promise((ok, fail) => { proc.on('error', fail); proc.on('close', c => c ? fail(new Error('Définitions invalides')) : ok()) }); exited.catch(() => {})
    const definitions = { ...this.definitions }
    try { for await (const line of createInterface({ input: proc.stdout })) {
      signal?.throwIfAborted()
      const d = JSON.parse(line), tick = Number(d.min_price_increment) / 1e9, amount = Number(d.min_price_increment_amount) / 1e9
      if (d.instrument_class !== 'F' || !d.raw_symbol || tick <= 0 || amount <= 0 || tick > 1e6 || amount > 1e6 || !/^[A-Z]{3}$/.test(d.currency || '')) continue
      const pointValue = amount / tick
      // The engine uses cents per point. Reject unsupported precision, never round it away.
      if (Math.abs(pointValue * 100 - Math.round(pointValue * 100)) > 1e-6) continue
      definitions[d.raw_symbol] = { tickSize: String(tick), pointValue: pointValue.toFixed(2), currency: d.currency,
        verified: true, specificationSource: 'Définition Databento · valeur monétaire du tick', timezone: 'America/Chicago' }
    }
    await exited
    } finally { if (proc.exitCode == null) proc.kill() }
    this.definitions = definitions
    await atomicJson(join(this.root, 'definitions.json'), this.definitions)
    for (const e of this.entries) for (const i of e.instruments) Object.assign(i, instrumentSpec(i.symbol, this.definitions))
  }
  list() { return this.entries.map(({ path, mtimeMs, ...e }) => ({ ...e, instruments: e.instruments.map(({ intervals, ...i }) => i) })) }
  get(id, symbol) {
    const entry = this.entries.find(e => e.id === id), instrument = entry?.instruments.find(i => i.symbol === symbol)
    if (!entry || !instrument) throw new Error('Fichier ou contrat introuvable dans ta bibliothèque')
    if (!instrument.verified) throw new Error('Importe les définitions de ce contrat : son tick et sa valeur monétaire ne sont pas vérifiés')
    return { entry, instrument, cache: join(this.root, 'cache', digest(`${id}|${symbol}`).slice(0, 40) + '.mbo.gz') }
  }
}
