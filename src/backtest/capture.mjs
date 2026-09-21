// Normalized personal recordings. The official Rithmic transport is intentionally separate;
// production collection stays unavailable until our own developer access/conformance exists.
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, unlink, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createGzip, createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { atomicJson } from './archive.mjs'
import { MboMarket } from './market.mjs'

export class PersonalCapture {
  constructor({ file, instrument, depthRecorded = false, maxBytes = 1024 ** 3 }) {
    if (!instrument?.verified) throw new Error('Contrat vérifié requis pour enregistrer')
    this.file = file; this.instrument = instrument; this.depthRecorded = depthRecorded; this.maxBytes = maxBytes
    this.first = null; this.last = null; this.count = 0; this.sequence = 0; this.queue = Promise.resolve(); this.closed = false
  }
  async open() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    this.gzip = createGzip({ level: 1 }); this.dest = createWriteStream(this.file + '.part', { mode: 0o600, flags: 'wx' })
    this.written = pipeline(this.gzip, this.dest); this.written.catch(() => {})
    return this
  }
  append(event) {
    const task = this.queue.then(async () => {
      if (this.closed) throw new Error('Enregistrement fermé')
      if (!/^\d{16,20}$/.test(event.ts || '') || (this.last && BigInt(event.ts) < BigInt(this.last))) throw new Error('Horodatage de collecte invalide')
      if (!Array.isArray(event.trades) || event.trades.length > 10000) throw new Error('Événement de collecte invalide')
      const normalized = { version: 1, sequence: ++this.sequence, ts: event.ts, valid: !!event.valid, gap: !!event.gap,
        reason: event.gap ? 'Collecte interrompue : trou de données enregistré' : event.reason || null,
        bid: event.bid, ask: event.ask, trades: event.trades.map(t => ({ price: t.price, size: t.size, side: ['buy', 'sell'].includes(t.side) ? t.side : 'unknown' })),
        depth: this.depthRecorded ? event.depth || null : null }
      if (!this.gzip.write(JSON.stringify(normalized) + '\n')) await once(this.gzip, 'drain')
      this.first ??= event.ts; this.last = event.ts; this.count++
      if (this.dest.bytesWritten >= this.maxBytes) throw new Error('Limite de stockage de la collecte atteinte')
    })
    this.queue = task.catch(() => {}); return task
  }
  async close() {
    await this.queue; if (this.closed) return; this.closed = true
    this.gzip.end(); await this.written
    if (!this.count) { await unlink(this.file + '.part'); return null }
    await rename(this.file + '.part', this.file)
    const manifest = { version: 1, source: 'rithmic', instrument: this.instrument, start: this.first, end: this.last, count: this.count,
      bytes: (await stat(this.file)).size, capabilities: { trades: true, depth: this.depthRecorded, aggressor: false }, createdAt: new Date().toISOString() }
    await atomicJson(this.file + '.json', manifest); return manifest
  }
}
export async function* readCapture(file) {
  const source = createReadStream(file), unzip = createGunzip()
  source.on('error', error => unzip.destroy(error)); source.pipe(unzip)
  const lines = createInterface({ input: unzip, crlfDelay: Infinity })
  try { for await (const line of lines) { if (line.length > 4 * 1024 * 1024) throw new Error('Capture invalide'); yield JSON.parse(line) } }
  finally { lines.close(); source.destroy(); unzip.destroy() }
}
export class RecordedMarket extends MboMarket {
  apply(event) {
    if (BigInt(event.ts) < this.clock) throw new Error('Capture hors ordre')
    this.clock = BigInt(event.ts); this.valid = event.valid && !event.gap
    this.reason = this.valid ? null : event.reason || 'Capture interrompue'
    this.recordedDepth = this.valid ? event.depth : null
    for (const trade of event.trades) this.recordTrade(trade, this.clock)
    return { ...event, valid: this.valid }
  }
  view(seconds) {
    const base = super.view(seconds)
    return { ...base, bids: this.recordedDepth?.bids || [], asks: this.recordedDepth?.asks || [], depthAvailable: !!this.recordedDepth }
  }
}
