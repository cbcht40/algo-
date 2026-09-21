import { ArchiveCatalog, normalizeArchive, readCache, loadJson } from '../src/backtest/archive.mjs'
import { MboMarket } from '../src/backtest/market.mjs'
import { ReplayRunner } from '../src/backtest/runner.mjs'
import { join } from 'node:path'
const decoder = join(process.cwd(), 'build/backtest-native/darwin-arm64/dbn')
const root = join(process.cwd(), '.backtest-qa/real-data')
const input = process.argv[2] || '/Users/clem/vacuum/data/dbn/glbx-mdp3-20240501.mbo.dbn.zst'
const catalog = await new ArchiveCatalog(root, decoder).load()
await catalog.add([input])
const entry = catalog.entries.find(x => x.path === input)
if (!entry) throw new Error('Import failed')
const symbol = process.argv[3] || 'ESM4'
const selected = catalog.get(entry.id, symbol)
let last = 0
const begun = performance.now()
const info = await loadJson(selected.cache + '.json', null) || await normalizeArchive({ decoder, file: input, output: selected.cache, intervals: selected.instrument.intervals, start: entry.start, end: entry.end,
 onProgress: p => { if (Date.now() - last > 15000) { console.log(JSON.stringify(p)); last = Date.now() } } })
console.log(JSON.stringify({stage: 'decoded', seconds: (performance.now() - begun) / 1000, ...info}))
const market = new MboMarket(); let n = 0, events = 0, valid = 0, corrupt = 0, volume = 0, reasons = {}, firstBad = null
for await (const r of readCache(selected.cache)) {
 const event = market.apply(r); n++
 if (event) { events++; if (event.valid) valid++; if(market.corrupt) {corrupt++; firstBad ??= {n, action:r.action, reason:market.reason, ts:r.ts}; reasons[market.reason] = (reasons[market.reason] || 0)+1} for (const t of event.trades) volume += t.size }
 if (n % 1000000 === 0) console.log(JSON.stringify({stage:'book', n, events, valid, corrupt}))
}
console.log(JSON.stringify({stage:'complete', n, events, valid, corrupt, volume, firstBad, reasons, seconds:(performance.now()-begun)/1000, bars:market.bars.length, memoryMB:Math.round(process.memoryUsage().rss/1024**2)}))
if (corrupt) process.exitCode = 1
