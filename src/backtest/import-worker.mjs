import { parentPort, workerData } from 'node:worker_threads'
import { normalizeArchive } from './archive.mjs'
const controller = new AbortController()
parentPort.on('message', m => { if (m === 'cancel') controller.abort() })
try {
  const result = await normalizeArchive({ ...workerData, signal: controller.signal, onProgress: value => parentPort.postMessage({ type: 'progress', value }) })
  parentPort.postMessage({ type: 'done', value: result })
} catch (e) { parentPort.postMessage({ type: 'error', error: e.name === 'AbortError' ? 'Import annulé' : e.message }) }
parentPort.close()
