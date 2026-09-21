// Local test harness, never bundled into the application. Real decoding + HTTP + simulation.
import { createBacktestService } from '../src/backtest/service.mjs'
import { readdir, readFile, mkdir, link, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
const owner = '00000000-0000-4000-8000-000000000001', file = '/Users/clem/vacuum/data/dbn/glbx-mdp3-20240501.mbo.dbn.zst'
const root = join(process.cwd(), '.backtest-qa/service'), decoder = join(process.cwd(), 'build/backtest-native/darwin-arm64/dbn')
const service = await createBacktestService({ root, decoder, port: 7880, extraOrigins: ['http://127.0.0.1:4240', 'https://localhost:4241', 'https://backtesting-bridge-let-tradejournal.clement-pagney.workers.dev'],
 onPairCode: code => console.log(JSON.stringify({ code })),
 authenticate: async token => { if (token !== 'qa-local-only') throw new Error('Test identity required'); return owner }, pickFiles: async () => [file] })
const catalog = await service.catalog(owner); await catalog.add([file])
const selected = catalog.get(catalog.entries[0].id, 'ESM4'), oldDir = join(process.cwd(), '.backtest-qa/real-data/cache')
await mkdir(join(root, owner, 'data/cache'), { recursive: true })
for (const name of await readdir(oldDir)) if (name.endsWith('.json')) {
 const info = JSON.parse(await readFile(join(oldDir, name), 'utf8'))
 if (info.sourceHash === '52041b4163d71c2f3da4ca8c170c1579dd3fae49a95b8cc94fcdb1058fe40128') {
  await link(join(oldDir, name.replace(/\.json$/, '')), selected.cache).catch(e => { if (e.code !== 'EEXIST') throw e })
  await copyFile(join(oldDir, name), selected.cache + '.json'); break
 }
}
console.log(JSON.stringify({ port: service.port, code: service.pairCode(), datasetId: selected.entry.id }))
for(const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0) })
