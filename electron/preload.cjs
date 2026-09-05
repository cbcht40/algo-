// Preload : expose une petite API au dashboard (mise à jour) et à la mini-fenêtre « avis IA ».
// Le dashboard est servi en HTTP par le moteur (127.0.0.1:7879) et chargé dans la fenêtre
// Electron — sans preload il n'aurait aucun accès à Electron. contextIsolation ON → on passe
// par contextBridge (pas de nodeIntegration). La page fait `if (window.electronUpdate)` pour
// savoir qu'elle tourne DANS l'app (et pas dans un navigateur classique).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronUpdate', {
  // cb reçoit { state:'none'|'available'|'downloading'|'ready', version?, percent? }
  onStatus: (cb) => {
    ipcRenderer.on('update:status', (_e, status) => { try { cb(status) } catch (_) { /* ignore */ } })
    ipcRenderer.send('update:ready') // redemande le statut courant (au cas où déjà émis avant le chargement)
  },
  // Applique la mise à jour : quitte + réinstalle + relance en la nouvelle version.
  install: () => ipcRenderer.send('update:install'),
})

// Mini-fenêtre flottante « avis IA » (pill.html) : toujours au premier plan, par-dessus le
// navigateur. La page décide quand se montrer / se cacher / se redimensionner.
contextBridge.exposeInMainWorld('electronPill', {
  show: (focus) => ipcRenderer.send('pill:show', !!focus),
  hide: () => ipcRenderer.send('pill:hide'),
  resize: (w, h) => ipcRenderer.send('pill:resize', { w, h }),
  focusMain: () => ipcRenderer.send('pill:focus-main'),
  notify: (title, body) => ipcRenderer.send('pill:notify', { title, body }),
  onOpen: (cb) => ipcRenderer.on('pill:open', () => { try { cb() } catch (_) { /* ignore */ } }),
})
