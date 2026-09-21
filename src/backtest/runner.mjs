import { randomUUID } from 'node:crypto'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { readCache, atomicJson } from './archive.mjs'
import { ReplayEngine } from './engine.mjs'
import { MboMarket } from './market.mjs'
import { RecordedMarket, readCapture } from './capture.mjs'
export class ReplayRunner {
  constructor({ file, cache, dataset, instrument, settings, start, owner, saved }) {
    this.file = file; this.cache = cache; this.dataset = dataset; this.instrument = instrument; this.owner = owner
    this.id = saved?.id || randomUUID(); this.createdAt = saved?.createdAt || new Date().toISOString()
    this.name = saved?.name || `${instrument.symbol} · ${new Date(Number(BigInt(start) / 1000000n)).toLocaleDateString('fr-FR', { timeZone: 'UTC' })}`
    this.start = saved?.start || start; this.notes = saved?.notes || ''; this.drawings = saved?.drawings || []
    this.attemptOf = saved?.attemptOf || null; this.speed = saved?.speed || 1
    this.engine = saved ? ReplayEngine.restore(saved.engine) : new ReplayEngine({ instrument, ...settings })
    this.market = dataset.source === 'rithmic' ? new RecordedMarket() : new MboMarket(); this.cursor = 0; this.virtualClock = BigInt(saved?.virtualClock || start)
    this.iterator = null; this.next = null; this.status = 'preparing'; this.error = null; this.busy = Promise.resolve()
    this.timer = null; this.closed = false; this.ready = false; this.saved = saved; this.lastSeen = Date.now()
    this.inAtomicEvent = false; this.views = new Map()
  }
  enqueue(fn) { const result = this.busy.then(fn); this.busy = result.catch(() => {}); return result }
  async prepare(onProgress = () => {}) {
    this.iterator = (this.dataset.source === 'rithmic' ? readCapture(this.cache) : readCache(this.cache))[Symbol.asyncIterator]()
    let lastEvent = null, count = 0, atBoundary = true
    for (;;) {
      this.next = await this.iterator.next()
      if (this.closed) throw new Error('Préparation annulée')
      if (this.next.done) break
      const r = this.next.value
      if (this.saved ? this.cursor >= this.saved.cursor : BigInt(r.ts) >= BigInt(this.start) && lastEvent && atBoundary) break
      const event = this.market.apply(r); this.cursor++
      atBoundary = !!event
      if (event) lastEvent = event
      if (++count % 10000 === 0) { onProgress({ scanned: count }); await yieldTurn() }
    }
    // Complete the current atomic event before exposing a book or accepting commands.
    if (!this.saved && this.next && !this.next.done && !lastEvent) await this.consumeEvent()
    if (!this.saved && lastEvent) this.engine.advance(lastEvent)
    if (this.saved && this.cursor !== this.saved.cursor) throw new Error('Les données ne correspondent plus à cette session')
    this.virtualClock = this.virtualClock > BigInt(this.engine.clock) ? this.virtualClock : BigInt(this.engine.clock)
    this.status = this.next?.done ? 'finished' : 'paused'; this.ready = true
    await this.persist(); return this
  }
  async consumeEvent() {
    let n = 0
    this.inAtomicEvent = true
    while (this.next && !this.next.done) {
      if (this.closed) return null
      const event = this.market.apply(this.next.value); this.cursor++
      this.next = await this.iterator.next()
      if (++n % 10000 === 0) await yieldTurn()
      if (event) { this.engine.advance(event); this.inAtomicEvent = false; if (BigInt(event.ts) > this.virtualClock) this.virtualClock = BigInt(event.ts); return event }
    }
    this.inAtomicEvent = false; this.status = 'finished'; return null
  }
  async advanceTo(target, single = false) {
    let n = 0
    while (this.next && !this.next.done && (single || BigInt(this.next.value.ts) <= target)) {
      const event = await this.consumeEvent()
      if (!event) break
      if (!event.valid && (this.engine.pending.length || this.engine.quantity)) { this.status = 'paused'; this.error = event.reason; break }
      if (single) break
      if (++n % 2000 === 0) await yieldTurn()
    }
    if (this.next?.done) this.status = 'finished'
    if (!single && target > this.virtualClock && this.status !== 'finished') this.virtualClock = target
  }
  play() {
    if (!this.ready || this.status === 'finished') throw new Error('Cette session ne peut pas démarrer')
    if (this.status === 'playing') return
    this.status = 'playing'; this.error = null; let previous = performance.now()
    const tick = async () => {
      if (this.closed || this.status !== 'playing') return
      try {
        await this.enqueue(async () => {
          if (this.status !== 'playing') return
          if (Date.now() - this.lastSeen > 10000) { this.status = 'paused'; await this.persist(); return }
          const now = performance.now(), elapsed = Math.min(now - previous, 1000); previous = now
          await this.advanceTo(this.virtualClock + BigInt(Math.round(elapsed * this.speed * 1e6)))
          if (!this.lastSaved || Date.now() - this.lastSaved > 2000 || this.status !== 'playing') await this.persist()
        })
      } catch (e) { this.status = 'paused'; this.error = e.message; await this.persist().catch(() => {}) }
      if (this.status === 'playing') this.timer = setTimeout(tick, 40)
    }
    this.timer = setTimeout(tick, 0)
  }
  async action(c) {
    return this.enqueue(async () => {
      if (!this.ready) throw new Error('La session se prépare encore')
      this.lastSeen = Date.now()
      if (c.type === 'play') this.play()
      else if (c.type === 'pause') { this.status = this.next?.done ? 'finished' : 'paused'; clearTimeout(this.timer) }
      else if (c.type === 'speed') { if (![1, 2, 5, 10, 30].includes(c.speed)) throw new Error('Vitesse invalide'); this.speed = c.speed }
      else if (c.type === 'step') { clearTimeout(this.timer); this.status = 'paused'; await this.advanceTo(this.virtualClock, true) }
      else if (c.type === 'nextBar') {
        if (![15,30,60,120,180,300,600,900,1800,3600,14400,86400].includes(c.seconds)) throw new Error('Unité de temps invalide')
        clearTimeout(this.timer); this.status = 'paused'
        const unit = BigInt(c.seconds) * 1000000000n
        await this.advanceTo((this.virtualClock / unit + 1n) * unit)
      } else if (c.type === 'notes') { this.notes = String(c.notes || '').slice(0, 10000) }
      else if (c.type === 'drawings') {
        if (!Array.isArray(c.drawings) || c.drawings.length > 100 || JSON.stringify(c.drawings).length > 30000) throw new Error('Trop de dessins')
        this.drawings = c.drawings
      } else {
        if (this.status === 'finished') throw new Error('Fin des données : aucun nouveau prix ne peut exécuter cet ordre')
        this.engine.command(c)
      }
      await this.persist(); return this.view()
    })
  }
  view(seconds = 60, comparisonSeconds = null) {
    // HTTP can run while the file iterator awaits I/O inside an atomic MBO event.
    // Never expose that partially reconstructed book (or its transaction volume).
    const viewKey = `${seconds}:${comparisonSeconds || ''}`
    if ((this.inAtomicEvent || !this.ready) && this.views.has(viewKey)) return this.views.get(viewKey)
    const state = { id: this.id, name: this.name, createdAt: this.createdAt, updatedAt: this.updatedAt, status: this.status,
      source: this.dataset.source, datasetId: this.dataset.id, datasetName: this.dataset.name, speed: this.speed,
      clock: this.virtualClock.toString(), start: this.start, end: this.dataset.end, notes: this.notes, drawings: this.drawings,
      attemptOf: this.attemptOf, ready: this.ready, ...this.engine.snapshot(),
      error: this.error || this.engine.lastError,
      replayClock: this.virtualClock.toString(), market: this.inAtomicEvent || !this.ready ? new MboMarket().view(seconds) : this.market.view(seconds) }
    if (!this.inAtomicEvent && this.ready) {
      if (comparisonSeconds) { const comparison = this.market.view(comparisonSeconds); state.comparison = { bars: comparison.bars, last: comparison.last, clock: comparison.clock } }
      this.views.set(viewKey, state)
    }
    return state
  }
  exportResult() {
    const state = this.engine.snapshot()
    return { version: 1, id: this.id, name: this.name, source: this.dataset.source, symbol: this.instrument.symbol, currency: this.instrument.currency,
      createdAt: this.createdAt, updatedAt: this.updatedAt, status: this.status === 'playing' ? 'paused' : this.status,
      datasetFingerprint: this.dataset.fingerprint, start: this.start, clock: this.virtualClock.toString(), attemptOf: this.attemptOf,
      settings: state.settings, stats: state.stats, position: state.position, trades: state.trades.slice(-2000), equity: state.equity.slice(-2000), notes: this.notes }
  }
  async persist() {
    this.updatedAt = new Date().toISOString()
    await atomicJson(this.file, { version: 1, id: this.id, owner: this.owner, cache: this.cache, dataset: this.dataset, instrument: this.instrument,
      name: this.name, createdAt: this.createdAt, updatedAt: this.updatedAt, start: this.start, cursor: this.cursor,
      virtualClock: this.virtualClock.toString(), speed: this.speed, notes: this.notes, drawings: this.drawings, attemptOf: this.attemptOf,
      engine: this.engine.serialize(), result: this.exportResult() })
    this.lastSaved = Date.now()
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.status = 'paused'; await this.busy; if (this.ready) await this.persist(); await this.iterator?.return?.() }
}
