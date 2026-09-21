import { readdir, stat, unlink, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicJson, loadJson } from './archive.mjs'

// Only generated files inside these directories can be evicted. Originals are never candidates.
export class ReplayStorage {
  constructor(root) { this.root = root; this.settings = { version: 1, limitGB: 20, captureRetentionDays: 60 } }
  async load() { this.settings = await loadJson(join(this.root, 'storage.json'), this.settings); return this }
  async configure(limitGB) {
    if (!Number.isInteger(limitGB) || limitGB < 1 || limitGB > 2000) throw new Error('Limite de stockage : de 1 à 2 000 Go')
    this.settings.limitGB = limitGB; await atomicJson(join(this.root, 'storage.json'), this.settings)
    return this.status()
  }
  async scan() {
    const protectedFiles = new Set(), files = []
    for (const name of await readdir(join(this.root, 'sessions')).catch(() => [])) if (/^[a-f0-9-]{36}\.json$/i.test(name)) {
      const session = await loadJson(join(this.root, 'sessions', name), null)
      if (session?.cache) protectedFiles.add(resolve(session.cache))
    }
    for (const folder of ['data/cache', 'captures']) {
      const dir = join(this.root, folder); await mkdir(dir, { recursive: true, mode: 0o700 })
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(mbo|events)\.gz$/.test(entry.name)) continue
        const path = join(dir, entry.name), info = await stat(path)
        files.push({ path, bytes: info.size, time: info.mtimeMs, capture: folder === 'captures', protected: protectedFiles.has(resolve(path)) })
      }
    }
    return files
  }
  async status() {
    const files = await this.scan()
    return { ...this.settings, usedBytes: files.reduce((n, f) => n + f.bytes, 0), protectedBytes: files.filter(f => f.protected).reduce((n, f) => n + f.bytes, 0) }
  }
  async reserve(bytes, keep = [], now = Date.now()) {
    const files = await this.scan(), limit = this.settings.limitGB * 1024 ** 3, retained = new Set(keep.map(p => resolve(p)))
    let used = files.reduce((n, f) => n + f.bytes, 0)
    for (const file of files.sort((a, b) => a.time - b.time)) {
      if (file.protected || retained.has(resolve(file.path))) continue
      const expired = file.capture && now - file.time > this.settings.captureRetentionDays * 86400000
      if (!expired && used + bytes <= limit) continue
      await unlink(file.path); await unlink(file.path + '.json').catch(e => { if (e.code !== 'ENOENT') throw e }); used -= file.bytes
    }
    if (used + bytes > limit) throw new Error('Limite de stockage atteinte. Les séances sauvegardées sont protégées. Augmente la limite avant de continuer.')
    return limit - used
  }
}
