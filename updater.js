// Update checks for Clipeer.
//
// Two modes, chosen by platform:
// - 'auto'   Windows installer and Linux AppImage: the update is downloaded in the background
//            with electron-updater and installed when the app quits (or on "Restart to install").
// - 'notify' macOS and everything else: macOS only installs updates by itself when the app is
//            signed with an Apple Developer ID, and Clipeer is ad-hoc signed. So we only check
//            GitHub for a newer release and offer the download link.
// - 'off'    development (npm start): no checks.
//
// Both modes only talk to GitHub (the public releases of the repository).

const OWNER = 'OmikroN-TNS'
const REPO = 'clipeer'
const CHECK_FIRST_MS = 15 * 1000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

// "v1.2.3" / "1.2.3" -> [1, 2, 3], or null
export function parseVersion (v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

// > 0 when a is newer than b, < 0 when older, 0 when equal (null if one is not a version)
export function compareVersions (a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

export function downloadUrl (platform = process.platform, arch = process.arch) {
  const base = `https://github.com/${OWNER}/${REPO}/releases/latest`
  if (platform === 'darwin') return `${base}/download/Clipeer-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
  return base
}

/**
 * @param {object} o
 * @param {import('electron').App} o.app
 * @param {import('electron').Shell} o.shell
 * @param {(state: object) => void} [o.onChange]   called whenever the state changes
 * Options below are for tests only:
 * @param {'auto'|'notify'|'off'} [o.mode]         force a mode
 * @param {string} [o.feedUrl]                     generic update feed (instead of GitHub), auto mode
 * @param {string} [o.apiBase]                     GitHub API base URL, notify mode
 */
export function createUpdater ({ app, shell, onChange = () => {}, mode, feedUrl, apiBase }) {
  const api = apiBase || process.env.CLIPEER_API_URL || 'https://api.github.com'
  const isAppImage = process.platform === 'linux' && !!process.env.APPIMAGE
  const canAutoUpdate = app.isPackaged && (process.platform === 'win32' || isAppImage)

  const state = {
    // status: idle | checking | available | downloading | ready | error
    status: 'idle',
    version: null,
    percent: 0,
    mode: mode || (canAutoUpdate ? 'auto' : (app.isPackaged ? 'notify' : 'off'))
  }

  let autoUpdater = null
  let timers = []

  function set (patch) {
    const next = { ...state, ...patch }
    if (JSON.stringify(next) === JSON.stringify(state)) return
    Object.assign(state, next)
    onChange({ ...state })
  }

  // ---------- auto mode (electron-updater) ----------

  async function getAutoUpdater () {
    if (autoUpdater) return autoUpdater
    const mod = await import('electron-updater') // CommonJS package: the API is on the default export
    autoUpdater = (mod.default ?? mod).autoUpdater
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    if (feedUrl) {
      autoUpdater.forceDevUpdateConfig = true
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
    }
    autoUpdater.on('checking-for-update', () => set({ status: 'checking' }))
    autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('update-not-available', () => set({ status: 'idle', version: null, percent: 0 }))
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }))
    autoUpdater.on('error', (err) => {
      console.warn('[updater]', err?.message || err)
      set({ status: 'error' })
    })
    return autoUpdater
  }

  async function checkAuto () {
    try {
      await (await getAutoUpdater()).checkForUpdates()
    } catch (err) {
      console.warn('[updater]', err?.message || err)
      set({ status: 'error' })
    }
  }

  // ---------- notify mode (GitHub API) ----------

  async function checkNotify () {
    // keep showing an update that was already found while the periodic check runs again
    if (state.status !== 'available') set({ status: 'checking' })
    try {
      const res = await fetch(`${api}/repos/${OWNER}/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Clipeer' },
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      const tag = (await res.json()).tag_name
      const newer = compareVersions(tag, app.getVersion())
      if (newer !== null && newer > 0) set({ status: 'available', version: String(tag).replace(/^v/, '') })
      else set({ status: 'idle', version: null })
    } catch (err) {
      console.warn('[updater]', err?.message || err)
      if (state.status !== 'available') set({ status: 'error' }) // do not hide an update already found
    }
  }

  // ---------- public API ----------

  async function checkNow () {
    if (state.mode === 'off') return
    // do not interrupt a check, a download or an update that is ready to install
    if (['checking', 'downloading', 'ready'].includes(state.status)) return
    if (state.mode === 'auto') await checkAuto()
    else await checkNotify()
  }

  // Click on the update entry of the menu
  function activate () {
    if (state.status === 'ready' && autoUpdater) autoUpdater.quitAndInstall(true, true)
    else if (state.status === 'available') shell.openExternal(downloadUrl())
  }

  function start () {
    if (state.mode === 'off' || timers.length) return
    const first = setTimeout(checkNow, CHECK_FIRST_MS)
    const every = setInterval(checkNow, CHECK_EVERY_MS)
    first.unref?.()
    every.unref?.()
    timers = [first, every]
  }

  function stop () {
    for (const t of timers) { clearTimeout(t); clearInterval(t) }
    timers = []
  }

  return { start, stop, checkNow, activate, getState: () => ({ ...state }) }
}
