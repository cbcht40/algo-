// Electron shell for the Tradovate copier. Double-click → launches the copier
// (if it isn't already running) and shows the local dashboard as the app window.
// No terminal, no browser. Closing the app stops the copier it started.
const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')
const fs = require('node:fs')
// Auto-update from GitHub Releases (Windows + signed/notarized macOS). Wrapped so a
// dev run (electron-updater absent) or an unsigned build never crashes.
let autoUpdater = null
try { autoUpdater = require('electron-updater').autoUpdater } catch { /* not installed in dev */ }

const ROOT = path.join(__dirname, '..')
const PORT = Number(process.env.DASHBOARD_PORT) || 7879
const DASH_URL = `http://127.0.0.1:${PORT}`

// Pin the app name so the user-data dir is stable + branded (otherwise Electron
// derives it from the package "name", e.g. "tradovate-copier").
app.setName('Let Trade Copieur')

// Packaged: config + caches live in the writable user-data dir (the app bundle is
// read-only). Dev: they live in the project root.
const dataDir = () => (app.isPackaged ? app.getPath('userData') : ROOT)
const masterFile = () => path.join(dataDir(), '.copier-master.json')

let copier = null
let win = null
let quitting = false
let restarting = false
let lastWasSetup = false

function dashboardUp() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 700 },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForDashboard(tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await dashboardUp()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function startCopier() {
  const env = { ...process.env }
  lastWasSetup = !fs.existsSync(path.join(dataDir(), 'config.json'))
  let cmd
  let args
  let cwd
  if (app.isPackaged) {
    // Run the bundled copier with Electron's own Node — no system node/npm/tsx.
    // Config + token/license/master caches all live in the user-data dir.
    cmd = process.execPath
    args = [path.join(ROOT, 'build', 'copier.mjs')]
    cwd = dataDir()
    env.ELECTRON_RUN_AS_NODE = '1'
  } else {
    cmd = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
    args = ['src/index.ts']
    cwd = ROOT
  }
  copier = spawn(cmd, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: !app.isPackaged && process.platform === 'win32',
  })
  copier.on('exit', async (code) => {
    copier = null
    console.log(`[electron] copier exited (${code})`)
    if (quitting || restarting) return
    // Onboarding just finished → config now exists → restart into the copier.
    if (lastWasSetup && fs.existsSync(path.join(dataDir(), 'config.json'))) {
      startCopier()
      const ok = await waitForDashboard()
      if (win && !win.isDestroyed()) win.loadURL(ok ? DASH_URL : ERROR_HTML)
    }
  })
  copier.on('error', (err) => console.error('[electron] failed to start copier:', err))
}

// Restart the copier WE started (e.g. after the user picked a new master): kill
// the child, respawn it (it re-reads the chosen master), then reload the window.
function restartCopier() {
  if (!copier || restarting || quitting) return
  restarting = true
  const old = copier
  copier = null
  if (win && !win.isDestroyed()) win.loadURL(LOADING_HTML)
  old.once('exit', async () => {
    restarting = false
    if (quitting) return
    startCopier()
    const ok = await waitForDashboard()
    if (win && !win.isDestroyed()) win.loadURL(ok ? DASH_URL : ERROR_HTML)
  })
  old.kill()
}

// The dashboard writes .copier-master.json when the user picks a new master.
function watchMaster() {
  try {
    fs.watchFile(masterFile(), { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) restartCopier()
    })
  } catch (err) {
    console.error('[electron] cannot watch master file:', err)
  }
}

const LOADING_HTML =
  'data:text/html,' +
  encodeURIComponent(
    `<body style="background:#0a0a10;color:#9090aa;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
       <div style="text-align:center">
         <div style="font-size:18px;color:#ececf4;font-weight:700">Démarrage du copieur…</div>
         <div style="margin-top:8px;font-size:13px;font-family:ui-monospace,monospace">connexion à tes comptes</div>
       </div>
     </body>`,
  )

const ERROR_HTML =
  'data:text/html,' +
  encodeURIComponent(
    `<body style="background:#0a0a10;color:#fb7185;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
       <div style="text-align:center;max-width:460px;padding:20px">
         <div style="font-size:18px;font-weight:700">Le copieur n'a pas démarré</div>
         <div style="margin-top:8px;font-size:13px;color:#9090aa">Aucune configuration trouvée (ou une erreur au démarrage). L'assistant de configuration arrive bientôt.</div>
       </div>
     </body>`,
  )

async function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 840,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#0a0a10',
    title: 'Let Trade Copieur',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.loadURL(LOADING_HTML)
  const ok = await waitForDashboard()
  win.loadURL(ok ? DASH_URL : ERROR_HTML)
}

app.whenReady().then(async () => {
  // Reuse an already-running copier (e.g. the launchd service); else start one.
  if (!(await dashboardUp())) startCopier()
  await createWindow()
  watchMaster()
  // Check for updates (packaged builds only). On an unsigned macOS build this rejects
  // harmlessly until the app is notarized; on Windows it downloads + notifies.
  if (app.isPackaged && autoUpdater) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => console.warn('[update]', err?.message || err))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (copier) copier.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  if (copier) {
    copier.kill()
    copier = null
  }
})
