// Electron shell for the Tradovate copier. Double-click → launches the copier
// (if it isn't already running) and shows the local dashboard as the app window.
// No terminal, no browser. Closing the app stops the copier it started.
const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.join(__dirname, '..')
const PORT = Number(process.env.DASHBOARD_PORT) || 7879
const DASH_URL = `http://127.0.0.1:${PORT}`

let copier = null
let win = null

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
  const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
  copier = spawn(bin, ['src/index.ts'], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  copier.on('exit', (code) => {
    copier = null
    console.log(`[electron] copier exited (${code})`)
  })
  copier.on('error', (err) => console.error('[electron] failed to start copier:', err))
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
       <div style="text-align:center;max-width:420px">
         <div style="font-size:18px;font-weight:700">Le copieur n'a pas démarré</div>
         <div style="margin-top:8px;font-size:13px;color:#9090aa">Réessaie, ou lance-le à la main (npm start) pour voir l'erreur.</div>
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
    title: 'Copieur Tradovate',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  // External links open in the real browser; localhost stays in the app.
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (copier) copier.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (copier) {
    copier.kill()
    copier = null
  }
})
