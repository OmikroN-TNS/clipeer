import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { createUpdater } from './updater.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let win, tray, updater
// Filled in after the single-instance check (see the end of this file):
// index.js starts the local server, so it must only be loaded by the first instance.
let events, getHistory, clearHistory, copyToClipboard, getPeerCount, hasSession, getAppUrl
let quitting = false
const startedAt = Date.now()

app.on('before-quit', () => { quitting = true })

const PREVIEW_LEN = 40

// One-line preview; on Linux/Windows '&' is an accelerator, so it must be doubled
function preview (text) {
  const one = text.replace(/\s+/g, ' ').trim()
  const cut = one.length > PREVIEW_LEN ? one.slice(0, PREVIEW_LEN - 1) + '…' : one
  return process.platform === 'darwin' ? cut : cut.replace(/&/g, '&&')
}

// Entry of the menu that follows the update state (see updater.js)
function updateMenuItems () {
  if (!updater) return []
  const s = updater.getState()
  if (s.mode === 'off') return []
  switch (s.status) {
    case 'checking':
      return [{ label: 'Checking for updates…', enabled: false }]
    case 'downloading':
      return [{ label: `Downloading update v${s.version}… ${s.percent}%`, enabled: false }]
    case 'ready':
      return [{ label: `Restart to install v${s.version}`, click: () => updater.activate() }]
    case 'available':
      return [{ label: `Update available: v${s.version} (download)`, click: () => updater.activate() }]
    case 'error':
      return [{ label: 'Update check failed: try again', click: () => updater.checkNow() }]
    default:
      return [{ label: 'Check for updates', click: () => updater.checkNow() }]
  }
}

function buildMenu () {
  const history = getHistory()
  const items = history.length
    ? history.map((e) => ({
        label: preview(e.text),
        click: () => copyToClipboard(e.text).catch(() => {})
      }))
    : [{ label: 'Nothing copied yet', enabled: false }]

  return Menu.buildFromTemplate([
    { label: `Clipeer v${app.getVersion()}`, enabled: false },
    { label: `Connected devices: ${getPeerCount()}`, enabled: false },
    ...updateMenuItems(),
    { type: 'separator' },
    ...items,
    ...(history.length ? [{ label: 'Clear history', click: clearHistory }] : []),
    { type: 'separator' },
    { label: 'Open Clipeer', click: showWindow },
    { label: 'Quit', click: () => app.quit() }
  ])
}

// Windows/Linux: pick the tray icon that is readable on the panel color.
// trayTemplate.png is white (for dark panels), trayDark.png is black (for light panels).
// macOS recolors template images by itself, so it always uses trayTemplate.png.
function isDarkPanel () {
  return process.platform === 'win32'
    ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI // taskbar theme, not the apps theme
    : nativeTheme.shouldUseDarkColors
}

function trayIcon () {
  const dir = path.join(__dirname, 'build')
  const black = path.join(dir, 'trayDark.png')
  const useBlack = process.platform !== 'darwin' && !isDarkPanel() && fs.existsSync(black)
  return nativeImage.createFromPath(useBlack ? black : path.join(dir, 'trayTemplate.png'))
}

// Tray clicks: Electron behaves differently on each platform.
// - macOS: a left click opens the menu by itself (set with setContextMenu).
//   With a menu set, Electron does not emit click/double-click there.
// - Windows: left click opens the menu, double click opens the window. The menu is
//   delayed a little: otherwise the first click of a double click would open a menu
//   that swallows the second click and the double click would never be detected.
// - Linux: Electron cannot pop up the menu from code. The 'click' event is the
//   "activation" sent by the desktop (a left click on KDE), so it opens the window;
//   the menu stays on right click. 'double-click' does not exist on Linux.
const TRAY_DOUBLE_CLICK_MS = 300

function setupTrayClicks () {
  if (process.platform === 'win32') {
    let menuTimer = null
    tray.on('click', () => {
      clearTimeout(menuTimer)
      menuTimer = setTimeout(() => tray.popUpContextMenu(), TRAY_DOUBLE_CLICK_MS)
    })
    tray.on('double-click', () => {
      clearTimeout(menuTimer)
      tray.closeContextMenu() // in case the menu already opened (slow double click)
      showWindow()
    })
  } else if (process.platform === 'linux') {
    tray.on('click', showWindow)
  }
}

function refreshMenu () {
  if (tray) tray.setContextMenu(buildMenu())
}

function showWindow () {
  if (win.isMinimized()) win.restore()
  win.show()
  app.focus({ steal: true })
}

function init () {
  // no Dock icon: the app lives in the menu bar
  if (process.platform === 'darwin') app.dock.hide()

  // Windows/Linux: no default menu bar (File, Edit, View...).
  // On macOS the app menu is kept: it provides Cmd+C/V/Q.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  win = new BrowserWindow({
    width: 600,
    height: 800,
    show: false, // decided below: only shown when the device is not paired yet
    icon: path.join(__dirname, 'build', 'icon.png')
  })

  // First launch (no session code saved): open the window so the user can pair.
  // Already paired: stay hidden and live in the tray.
  win.once('ready-to-show', () => {
    if (!hasSession()) showWindow()
  })
  win.webContents.on('did-fail-load', () => setTimeout(() => win.loadURL(getAppUrl()), 300))
  win.loadURL(getAppUrl())

  // the X button hides the window; "Quit" from the menu really closes the app
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide() }
  })

  // tray: use the monochrome build/trayTemplate.png (and trayTemplate@2x.png for hi-dpi)
  // on every platform, switching to the black trayDark.png on light panels.
  // If it is missing: an emoji in the macOS menu bar, or the resized app icon
  // on Windows/Linux (where an empty image would be invisible).
  const templatePath = path.join(__dirname, 'build', 'trayTemplate.png')
  if (fs.existsSync(templatePath)) {
    tray = new Tray(trayIcon())
    // follow light/dark theme changes while the app is running (Windows/Linux)
    if (process.platform !== 'darwin') {
      nativeTheme.on('updated', () => tray.setImage(trayIcon()))
    }
  } else if (process.platform === 'darwin') {
    tray = new Tray(nativeImage.createEmpty())
    tray.setTitle('📋')
  } else {
    const size = process.platform === 'win32' ? 32 : 24
    const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'))
    tray = new Tray(icon.resize({ width: size, height: size }))
  }
  tray.setToolTip(`Clipeer v${app.getVersion()}`)
  setupTrayClicks()
  refreshMenu()
  events.on('history', refreshMenu)
  events.on('peers', refreshMenu)

  updater = createUpdater({ app, shell, onChange: refreshMenu })
  updater.start()
  refreshMenu()
}

// macOS emits 'activate' at launch too: ignore it then, otherwise the window
// would pop up even when the app is meant to start hidden in the menu bar.
app.on('activate', () => {
  if (win && Date.now() - startedAt > 3000) showWindow()
})

// Single instance: if Clipeer is already running (e.g. hidden in the tray),
// a second launch just brings up the existing window and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  ;({ events, getHistory, clearHistory, copyToClipboard, getPeerCount, hasSession, getAppUrl } = await import('./index.js'))
  app.on('second-instance', () => { if (win) showWindow() })
  app.whenReady().then(init)
}
