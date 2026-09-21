import { resolve } from 'node:path'
import { createBacktestService } from './service.mjs'
const packaged = !!process.env.BACKTEST_PACKAGED
const root = process.env.BACKTEST_DATA_DIR || resolve('.backtest-data')
const decoder = process.env.BACKTEST_DECODER || resolve('build/backtest-native', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'dbn.exe' : 'dbn')
const picks = new Map(); let next = 0
const service = await createBacktestService({ root, decoder,
  extraOrigins: !packaged && process.env.BACKTEST_DEV_ORIGIN ? [process.env.BACKTEST_DEV_ORIGIN] : [],
  onPairCode: code => { process.send?.({ type: 'backtest:pairCode', code }) },
  onActivity: active => process.send?.({ type: 'backtest:activity', active }),
  pickFiles: process.send ? kind => new Promise((ok, fail) => {
    const id = ++next; const timer = setTimeout(() => { picks.delete(id); fail(new Error('Sélection expirée')) }, 300000)
    picks.set(id, { ok: paths => { clearTimeout(timer); ok(paths) } }); process.send({ type: 'backtest:pick', kind, id })
  }) : undefined,
})
process.on('message', m => {
  if (m?.type === 'backtest:pickResult') { picks.get(m.id)?.ok(m.paths); picks.delete(m.id) }
  if (m?.type === 'backtest:newCode') service.renewPairCode()
})
process.send?.({ type: 'backtest:ready', port: service.port })
console.log('Backtesting local disponible sur le port', service.port)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { service.close().finally(() => process.exit(0)) })
