// Official Rust DBN decoder, pinned and checksum-verified. No system Rust/Python needed.
import { createHash } from 'node:crypto'
import { mkdir, writeFile, chmod, readFile, copyFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
const version = '0.70.0'
const targets = {
  'darwin-arm64': ['aarch64-apple-darwin', '33740551feba9eab98e5e44c7149ae35694abf94291dacc26c727372e1c9196d'],
  'darwin-x64': ['x86_64-apple-darwin', 'a3675f7367a424e478adbf76b6830faa137bca5a610a758f162a6bedf983961f'],
  'win32-x64': ['x86_64-pc-windows-msvc', '45c8279a46740d9e7d02965902286a146a16d3cdce94ffc6b6af9d40d6576276'],
}
const platform = process.argv[2] || `${process.platform}-${process.arch}`
if (!targets[platform]) throw new Error(`DBN decoder: unsupported platform ${platform}`)
const [target, sha256] = targets[platform]
const dir = resolve('build', 'backtest-native', platform)
const extension = platform.startsWith('win32') ? 'zip' : 'tar.gz'
const name = `dbn-${version}-${target}.${extension}`
await mkdir(dir, { recursive: true })
const archive = join(dir, name)
let bytes
try { bytes = await readFile(archive) } catch { /* first build */ }
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) {
  const response = await fetch(`https://github.com/databento/dbn/releases/download/v${version}/${name}`)
  if (!response.ok) throw new Error(`DBN download: ${response.status}`)
  bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('DBN checksum mismatch')
  await writeFile(archive, bytes)
}
if (extension === 'zip') {
  if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:LETTRADE_DBN_ARCHIVE -DestinationPath $env:LETTRADE_DBN_DIRECTORY -Force'], { env: { ...process.env, LETTRADE_DBN_ARCHIVE: archive, LETTRADE_DBN_DIRECTORY: dir } })
  else execFileSync('unzip', ['-o', '-q', archive, '-d', dir])
} else execFileSync('tar', ['-xzf', archive, '-C', dir])
const binary = platform.startsWith('win32') ? 'dbn.exe' : 'dbn'
await copyFile(join(dir, `dbn-${version}-${target}`, binary), join(dir, binary))
await copyFile(join(dir, `dbn-${version}-${target}`, 'LICENSE'), join(dir, 'LICENSE'))
if (!platform.startsWith('win32')) await chmod(join(dir, 'dbn'), 0o755)
await writeFile(join(dir, 'VERSION'), version + '\n')
console.log(`DBN ${version}: ${platform}, SHA-256 verified`)
