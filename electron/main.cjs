// Electron shell for the Tradovate copier. Double-click → launches the copier
// (if it isn't already running) and shows the local dashboard as the app window.
// No terminal, no browser. Closing the app stops the copier it started.
const { app, BrowserWindow, shell, ipcMain, screen, Notification, dialog, powerSaveBlocker, Menu, Tray, nativeImage } = require('electron')
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

// The replay companion starts independently: it never imports or calls the order copier.
let backtestProcess = null
let backtestWindow = null
let backtestCode = null
let backtestReady = false
let backtestError = null
let backtestPower = null
let backtestTray = null
let backtestOnly = process.argv.some(a => a === '--backtest-only' || a.startsWith('lettrade://backtest'))
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', (_event, argv) => {
  if (argv.some(a => a.startsWith('lettrade://backtest') || a === '--backtest-only')) showBacktest()
  else if (win && !win.isDestroyed()) { win.show(); win.focus() }
  else showBacktest()
})
function startBacktest() {
  if (backtestProcess) return
  backtestError = null
  const entry = app.isPackaged ? path.join(ROOT, 'build/backtest/serve.mjs') : path.join(ROOT, 'src/backtest/serve.mjs')
  const decoder = app.isPackaged ? path.join(ROOT, 'build/backtest', process.platform === 'win32' ? 'dbn.exe' : 'dbn')
    : path.join(ROOT, 'build/backtest-native', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'dbn.exe' : 'dbn')
  backtestProcess = spawn(process.execPath, [entry], { cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BACKTEST_PACKAGED: app.isPackaged ? '1' : '',
      BACKTEST_DATA_DIR: path.join(dataDir(), 'backtesting'), BACKTEST_DECODER: decoder },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  backtestProcess.stdout.on('data', () => {})
  backtestProcess.stderr.on('data', data => { if (data.toString().includes('EADDRINUSE')) backtestError = 'Le port du compagnon est déjà utilisé. Ferme l’autre instance de Let-Trade puis réessaie.' })
  backtestProcess.on('message', async message => {
    if (message.type === 'backtest:pairCode') { backtestCode = message.code; backtestWindow?.webContents.send('backtest:changed') }
    if (message.type === 'backtest:ready') { backtestReady = true; backtestWindow?.webContents.send('backtest:changed') }
    if (message.type === 'backtest:activity') {
      if (message.active && backtestPower == null) backtestPower = powerSaveBlocker.start('prevent-app-suspension')
      if (!message.active && backtestPower != null) { powerSaveBlocker.stop(backtestPower); backtestPower = null }
    }
    if (message.type === 'backtest:pick') {
      const result = await dialog.showOpenDialog({ title: 'Importer des données Databento',
        properties: message.kind === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections'],
        filters: message.kind === 'directory' ? undefined : [{ name: 'Databento DBN', extensions: ['dbn', 'zst'] }] })
      backtestProcess?.send({ type: 'backtest:pickResult', id: message.id, paths: result.canceled ? [] : result.filePaths })
    }
  })
  backtestProcess.on('error', () => { backtestReady = false; backtestError = 'Le moteur local n’a pas pu démarrer. Réessaie avec le bouton ci-dessous.'; backtestWindow?.webContents.send('backtest:changed') })
  backtestProcess.on('exit', () => { backtestProcess = null; backtestReady = false; backtestCode = null; backtestError ||= 'Le moteur local est arrêté. Réessaie avec le bouton ci-dessous.'; if (backtestPower != null) powerSaveBlocker.stop(backtestPower); backtestPower = null; backtestWindow?.webContents.send('backtest:changed') })
}
function showBacktest() {
  startBacktest()
  if (backtestWindow && !backtestWindow.isDestroyed()) { backtestWindow.show(); backtestWindow.focus(); return }
  backtestWindow = new BrowserWindow({ width: 620, height: 550, minWidth: 460, minHeight: 480,
    title: 'Let-Trade · Backtesting', backgroundColor: '#0a0817',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.cjs') } })
  backtestWindow.loadFile(path.join(__dirname, 'backtest.html'))
  backtestWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  backtestWindow.on('closed', () => { backtestWindow = null })
}
const fromBacktestWindow = event => backtestWindow && event.sender.id === backtestWindow.webContents.id
ipcMain.handle('backtest:info', event => fromBacktestWindow(event) ? { code: backtestCode, ready: backtestReady, error: backtestError } : null)
ipcMain.on('backtest:newCode', event => { if (fromBacktestWindow(event)) { if (!backtestProcess) startBacktest(); else backtestProcess.send({ type: 'backtest:newCode' }) } })
ipcMain.on('backtest:site', event => { if (fromBacktestWindow(event)) shell.openExternal('https://let-tradejournal.com/backtest') })
ipcMain.on('backtest:open', () => showBacktest())
app.on('open-url', (event, url) => {
  if (url !== 'lettrade://backtest' && url !== 'lettrade://backtest/') return
  event.preventDefault(); backtestOnly = true
  if (app.isReady()) showBacktest()
})

// État de mise à jour poussé vers la page dashboard (bandeau + bouton « Installer »).
// Le preload redemande le statut courant ('update:ready') à chaque chargement de page,
// donc un rechargement du dashboard (ex. changement de maître) réaffiche le bon état.
let lastUpdateStatus = { state: 'none' }
function sendUpdate(status) {
  lastUpdateStatus = status
  if (win && !win.isDestroyed()) win.webContents.send('update:status', status)
}
ipcMain.on('update:ready', (e) => { try { e.sender.send('update:status', lastUpdateStatus) } catch (_) { /* fenêtre partie */ } })

// Espace libre requis pour installer : ShipIt dézippe la nouvelle app (~250 Mo) PUIS
// échange le bundle dans /Applications → il faut de la marge, sinon l'install échoue en
// silence (le bouton tournait à l'infini). On pré-vérifie et on remonte une vraie erreur.
const MIN_FREE_INSTALL = 600 * 1024 * 1024
function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize } catch (_) { return null }
}
ipcMain.on('update:install', () => {
  const free = freeBytes(dataDir())
  if (free !== null && free < MIN_FREE_INSTALL) {
    sendUpdate({ state: 'error', version: lastUpdateStatus.version,
      message: `Espace disque insuffisant (${Math.round(free / 1048576)} Mo libres) — libère ~1 Go, puis réessaie.` })
    return
  }
  try { if (autoUpdater) autoUpdater.quitAndInstall() }
  catch (err) {
    console.warn('[update] install', err)
    sendUpdate({ state: 'error', version: lastUpdateStatus.version, message: String((err && err.message) || err) })
  }
})

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
  // Persistent engine log (stdout is lost when launched from Finder) → user-data/logs.
  try {
    const logDir = path.join(dataDir(), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    env.COPIER_LOG_FILE = path.join(logDir, 'copier.log')
  } catch (_) { /* logging is best-effort — never block startup */ }
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
      if (ok) createPill()
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
    `<body style="background:radial-gradient(720px 420px at 50% 0%,rgba(99,91,255,.24),transparent 68%),#0a0817;color:#b3b1d6;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
       <div style="text-align:center">
         <div style="font-size:18px;color:#f2f1fb;font-weight:700">Démarrage du copieur…</div>
         <div style="margin-top:8px;font-size:13px;font-family:ui-monospace,monospace">connexion à tes comptes</div>
       </div>
     </body>`,
  )

const ERROR_HTML =
  'data:text/html,' +
  encodeURIComponent(
    `<body style="background:radial-gradient(720px 420px at 50% 0%,rgba(99,91,255,.2),transparent 68%),#0a0817;color:#f26e8a;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
       <div style="text-align:center;max-width:460px;padding:20px">
         <div style="font-size:18px;font-weight:700">Le copieur n'a pas démarré</div>
         <div style="margin-top:8px;font-size:13px;color:#b3b1d6">Aucune configuration trouvée (ou une erreur au démarrage). L'assistant de configuration arrive bientôt.</div>
       </div>
     </body>`,
  )

// ── Mini-fenêtre flottante « avis IA » ───────────────────────────────────────
// Sans cadre, transparente, toujours au premier plan, sur tous les bureaux : la pastille
// surgit par-dessus le navigateur (Tradovate) même quand le Copieur n'est pas au premier
// plan. La page (pill.html, servie par le moteur) pilote show/hide/resize via IPC.
let pill = null
const PILL_MARGIN = 18
function placePill(w, h) {
  if (!pill || pill.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  pill.setBounds({ x: Math.round(wa.x + wa.width - w - PILL_MARGIN), y: Math.round(wa.y + wa.height - h - PILL_MARGIN), width: Math.round(w), height: Math.round(h) })
}
function createPill() {
  if (pill && !pill.isDestroyed()) return
  pill = new BrowserWindow({
    width: 360, height: 78, show: false, frame: false, transparent: true, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#00000000', title: 'Avis IA',
    // macOS : seule une fenêtre « panel » flotte par-dessus les apps en PLEIN ÉCRAN (navigateur,
    // Tradovate…) ; une fenêtre normale « toujours au premier plan » reste sous un espace plein écran.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') },
  })
  pill.setAlwaysOnTop(true, 'screen-saver')
  try { pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }) } catch (_) { /* plateforme */ }
  placePill(360, 78)
  pill.loadURL(`${DASH_URL}/pill`)
  pill.on('closed', () => { pill = null })
  // Diagnostic dans le log : la page de la pastille n'a pas de console visible.
  pill.webContents.on('console-message', (_e, _level, message) => console.log('[pill:page]', String(message).slice(0, 200)))
  pill.webContents.on('did-fail-load', (_e, code, desc) => console.warn('[pill] chargement échoué', code, desc))
  pill.webContents.on('did-finish-load', () => console.log('[pill] page chargée', JSON.stringify(pill.getBounds())))
  console.log('[pill] fenêtre créée', JSON.stringify(pill.getBounds()), 'écran', JSON.stringify(screen.getPrimaryDisplay().workArea))
}
ipcMain.on('pill:show', (_e, focus) => {
  if (!pill || pill.isDestroyed()) { console.warn('[pill] show demandé mais fenêtre absente'); return }
  // Toujours montrée (la pastille interne du dashboard est désactivée dans l'app) : pas de
  // condition sur le focus, qui rendait l'affichage aléatoire selon la fenêtre active.
  if (focus) pill.show(); else pill.showInactive()
  try { pill.moveTop() } catch (_) { /* plateforme */ }
  console.log('[pill] show', focus ? '(focus)' : '(inactif)', 'visible=', pill.isVisible(), 'onTop=', pill.isAlwaysOnTop(), 'opacity=', pill.getOpacity(), 'bounds=', JSON.stringify(pill.getBounds()), 'écrans=', screen.getAllDisplays().map(d => `${d.id}:${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y}${d.id === screen.getPrimaryDisplay().id ? '*' : ''}`).join(' '))
  // Diagnostic : capture du rendu de la mini-fenêtre (ce que macOS devrait afficher).
  setTimeout(async () => {
    try {
      if (!pill || pill.isDestroyed()) return
      const img = await pill.webContents.capturePage()
      const out = path.join(dataDir(), 'logs', 'pill-last.png')
      fs.writeFileSync(out, img.toPNG())
      console.log('[pill] capture', out, JSON.stringify(img.getSize()))
    } catch (err) { console.warn('[pill] capture impossible', err?.message || err) }
  }, 1500)
})
ipcMain.on('pill:hide', () => { if (pill && !pill.isDestroyed()) pill.hide() })
ipcMain.on('pill:resize', (_e, { w, h }) => placePill(w, h))
ipcMain.on('pill:focus-main', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() } })
ipcMain.on('pill:notify', (_e, { title, body }) => {
  try {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: String(title || 'Avis IA'), body: String(body || ''), silent: true })
    n.on('click', () => { if (pill && !pill.isDestroyed()) { pill.show(); pill.webContents.send('pill:open') } })
    n.show()
  } catch (err) { console.warn('[pill] notification', err?.message || err) }
})

// En dev (`npm run app`), Electron affiche SA propre icône dans le Dock : l'icône « Lentille »
// n'est appliquée par electron-builder qu'au build empaqueté. On la force ici hors paquet.
const ICON_PNG = path.join(ROOT, 'icon.png')
function applyDevIcon() {
  if (app.isPackaged) return
  try { if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON_PNG)) app.dock.setIcon(ICON_PNG) } catch (_) {}
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#0a0817',
    title: 'Let Trade Copieur',
    ...(fs.existsSync(ICON_PNG) ? { icon: ICON_PNG } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.loadURL(LOADING_HTML)
  const ok = await waitForDashboard()
  win.loadURL(ok ? DASH_URL : ERROR_HTML)
  if (ok) createPill()
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  applyDevIcon()
  startBacktest()
  if (app.isPackaged) app.setAsDefaultProtocolClient('lettrade')
  try {
    backtestTray = new Tray(nativeImage.createFromPath(ICON_PNG).resize({ width: 18, height: 18 }))
    backtestTray.setToolTip('Let-Trade · Copieur et Backtesting')
    backtestTray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Backtesting · connexion au site', click: showBacktest },
      { label: 'Afficher le Copieur', click: async () => { if (win) win.show(); else { if (!(await dashboardUp())) startCopier(); await createWindow(); watchMaster() } } },
      { type: 'separator' }, { label: 'Quitter Let-Trade', click: () => app.quit() },
    ]))
  } catch { /* Dock/menu remain available when the tray is unavailable. */ }
  if (backtestOnly) showBacktest()
  else {
  // Reuse an already-running copier (e.g. the launchd service); else start one.
  if (!(await dashboardUp())) startCopier()
  await createWindow()
  watchMaster()
  }
  // Check for updates (packaged builds only). On télécharge en fond ET on pousse l'état
  // vers le dashboard → bandeau in-app « Mise à jour prête → Installer et redémarrer »
  // (plutôt que la notif système anglaise + install silencieuse au quit).
  if (app.isPackaged && autoUpdater) {
    autoUpdater.autoDownload = true
    autoUpdater.on('update-available', (info) => sendUpdate({ state: 'available', version: info && info.version }))
    autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round((p && p.percent) || 0), version: lastUpdateStatus.version }))
    autoUpdater.on('update-downloaded', (info) => sendUpdate({ state: 'ready', version: info && info.version }))
    autoUpdater.on('error', (err) => {
      const message = (err && (err.message || String(err))) || 'erreur inconnue'
      console.warn('[update]', message)
      sendUpdate({ state: 'error', version: lastUpdateStatus.version, message })
    })
    autoUpdater.checkForUpdates().catch((err) => console.warn('[update]', err?.message || err))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showBacktest()
  })
})

app.on('window-all-closed', () => {
  if (copier) copier.kill()
  if (process.platform !== 'darwin' && !backtestTray) app.quit()
})
// La mini-fenêtre ne compte pas comme « la » fenêtre : fermer le Copieur = tout fermer.
app.on('browser-window-closed', (_e, w) => {
  if (w === win) { win = null; if (pill && !pill.isDestroyed()) pill.destroy(); if (copier) copier.kill() }
})

app.on('before-quit', () => {
  quitting = true
  if (backtestProcess) backtestProcess.kill()
  if (backtestPower != null) powerSaveBlocker.stop(backtestPower)
  if (copier) {
    copier.kill()
    copier = null
  }
})
