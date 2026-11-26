#!/usr/bin/env node
import express from 'express'
import http from 'node:http'
import Hyperswarm from 'hyperswarm'
import clipboardy from 'clipboardy'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORDS } from './words.js'
import { EventEmitter } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HOST = '127.0.0.1'
const PORT = 3000
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])

const WORD_COUNT = 6
const MIN_SECRET = 12
// Windows: %APPDATA%/Clipeer; macOS/Linux: ~/.clipeer
const DEFAULT_CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Clipeer')
  : path.join(os.homedir(), '.clipeer')
const CONFIG_DIR = process.env.CLIPEER_DIR || process.env.CLIPSYNC_DIR || DEFAULT_CONFIG_DIR
const SECRET_FILE = path.join(CONFIG_DIR, 'secret')
// Paths used by earlier versions (including when the app was called ClipSync).
// A secret found there is moved to SECRET_FILE.
const LEGACY_SECRET_FILES = [
  path.join(os.homedir(), '.clipeer', 'secret'),
  path.join(os.homedir(), '.clipsync', 'secret')
].filter((f) => f !== SECRET_FILE)

const app = express()
const server = http.createServer(app)

// Per-launch access token. It only exists in memory: the app window receives it through
// getAppUrl() and the server turns it into a cookie. Without it, any other program (or
// user) on this computer could query the local server, including /api/status which
// returns the session code.
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex')
const AUTH_COOKIE = 'clipeer_auth'

function tokenMatches (candidate) {
  if (typeof candidate !== 'string') return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(AUTH_TOKEN)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function readCookie (req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

// URL that the app window must open (it carries the token once)
export function getAppUrl () { return `http://127.0.0.1:${PORT}/?t=${AUTH_TOKEN}` }

// Protection against DNS rebinding and cross-site requests to the local server
app.use((req, res, next) => {
  const host = req.headers.host
  if (!ALLOWED_HOSTS.has(host)) return res.status(403).end()
  const origin = req.headers.origin
  if (origin && origin !== `http://${host}`) return res.status(403).end()
  next()
})

// Access token: a valid cookie passes; a valid ?t=<token> sets the cookie and redirects
// to the same path without the token; everything else is rejected.
app.use((req, res, next) => {
  if (tokenMatches(readCookie(req, AUTH_COOKIE))) return next()
  if (req.method === 'GET' && tokenMatches(req.query.t)) {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict`)
    return res.redirect(302, req.path)
  }
  res.status(401).type('text/plain').send('Unauthorized')
})

app.use(express.json({ limit: '4kb' }))
app.use(express.static(path.join(__dirname, 'public')))

const run = promisify(execFile)

// --- PATHS AND BINARIES ---

// 1. Force-add the usual Linuxbrew/Homebrew/SteamOS locations
// to the process PATH so child commands (spawn) inherit them too.
function patchPath () {
  const extraPaths = [
    '/home/linuxbrew/.linuxbrew/bin',
    '/home/linuxbrew/.linuxbrew/sbin',
    path.join(os.homedir(), '.linuxbrew/bin'),
    path.join(os.homedir(), '.linuxbrew/sbin'),
    '/opt/homebrew/bin', // Homebrew macOS Apple Silicon
    '/opt/homebrew/sbin',
    '/usr/local/bin',    // Homebrew macOS Intel / Standard
    '/usr/bin',
    '/bin',
    '/app/bin'           // AppImage / Electron
  ]
  const currentPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const newPath = [...new Set([...currentPath, ...extraPaths])].join(path.delimiter)
  process.env.PATH = newPath
}

patchPath() // Run right away, before looking for binaries

// 2. Look for an executable in the known locations
function findBinary (name) {
  const pathEnv = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of pathEnv) {
    const full = path.join(dir, name)
    try {
      fs.accessSync(full, fs.constants.X_OK)
      return full
    } catch {}
  }
  return null
}

const wlPasteBin = process.platform === 'linux' ? findBinary('wl-paste') : null
const wlCopyBin = process.platform === 'linux' ? findBinary('wl-copy') : null
const wayland =
  process.platform === 'linux' &&
  !!process.env.WAYLAND_DISPLAY &&
  !!wlPasteBin &&
  !!wlCopyBin

if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY && !wayland) {
  console.warn('[!] wl-clipboard not found: falling back to clipboardy (may not work on pure Wayland).')
  console.warn('    Install it with: sudo pacman -S wl-clipboard or brew install wl-clipboard')
}

let clipboard = wayland
  ? {
      read: async () =>
        (await run(wlPasteBin, ['--no-newline', '--type', 'text'], { maxBuffer: 2 * 1024 * 1024 })).stdout,
      write: (text) =>
        new Promise((resolve, reject) => {
          const p = spawn(wlCopyBin, [], { stdio: ['pipe', 'ignore', 'ignore'] })
          p.on('error', reject)
          p.on('exit', resolve)
          p.stdin.end(text)
        })
    }
  : clipboardy

// Windows: clipboardy launches an .exe that cannot run reliably from inside app.asar.
// In Electron we therefore use the clipboard module directly.
if (process.platform === 'win32') {
  try {
    const { clipboard: electronClipboard } = await import('electron')
    if (electronClipboard?.readText) {
      clipboard = {
        read: async () => electronClipboard.readText(),
        write: async (text) => electronClipboard.writeText(text)
      }
    }
  } catch {}
}

// --- END PATHS AND BINARIES ---

const MAX_SIZE = 1024 * 1024
const HISTORY_MAX = 10
const POLL_MS = 500
const KEEPALIVE_MS = 20000 // application-level ping to keep the connection alive
const WATCH_SUPPRESS_MS = 250 // window during which we ignore watcher events after a remote write

let swarm = null
let watcher = null
let pollTimer = null
let keepAliveTimer = null
let lastText = ''

// State to avoid clipboard ping-pong on Wayland
let isWritingRemote = false
let remoteWriteGuard = null
let localWriteChain = Promise.resolve()

const clients = new Set()
const peers = new Set()

// ---------- History (in memory only, never written to disk) ----------

// Events: 'history' (history changed), 'peers' (peer count changed)
export const events = new EventEmitter()
const clipHistory = []

export function getHistory () { return clipHistory.slice() }
export function getPeerCount () { return peers.size }
// true when a session code is saved, i.e. this device has already been paired
export function hasSession () { return !!currentSecret }
export function copyToClipboard (text) { return clipboard.write(text) }
export function clearHistory () {
  clipHistory.length = 0
  events.emit('history')
}

function pushHistory (text, source) {
  if (!text || !text.trim()) return
  if (currentSecret && text.trim() === currentSecret) return // never list the session code
  const i = clipHistory.findIndex((e) => e.text === text)
  if (i >= 0) clipHistory.splice(i, 1) // no duplicates: the entry moves to the top
  clipHistory.unshift({ text, source, at: Date.now() })
  if (clipHistory.length > HISTORY_MAX) clipHistory.length = HISTORY_MAX
  events.emit('history')
}

// ---------- Session code ----------

function generateCode () {
  return Array.from({ length: WORD_COUNT }, () => WORDS[crypto.randomInt(WORDS.length)]).join('-')
}

// A word code is normalized (lowercase, separated by "-");
// any other passphrase is left as is.
function normalizeSecret (input) {
  const s = String(input ?? '').trim()
  const parts = s.split(/[\s-]+/)
  if (parts.length === WORD_COUNT && parts.every((p) => /^[a-zA-Z]+$/.test(p))) {
    return parts.join('-').toLowerCase()
  }
  return s
}

function loadSecret () {
  const fromEnv = process.env.CLIPEER_SECRET || process.env.CLIPSYNC_SECRET
  if (fromEnv) return normalizeSecret(fromEnv)
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim() } catch {}
  for (const file of LEGACY_SECRET_FILES) {
    let secret
    try { secret = fs.readFileSync(file, 'utf8').trim() } catch { continue }
    if (!secret) continue
    // Migrate: write to the new location, then remove the old file
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
      fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
      fs.unlinkSync(file)
    } catch {}
    return secret
  }
  return ''
}

function saveSecret (secret) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
  } catch (err) {
    broadcast('log', { msg: `[!] Could not save the code: ${err.message}` })
  }
}

function clearSecret () {
  for (const file of [SECRET_FILE, ...LEGACY_SECRET_FILES]) {
    try { fs.unlinkSync(file) } catch {}
  }
}

let currentSecret = loadSecret()

// ---------- API ----------

function broadcast (type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`
  for (const client of clients) client.write(payload)
}

app.get('/api/status', (req, res) => {
  res.json({ hasSecret: !!currentSecret, code: currentSecret || null, peers: peers.size })
})

app.post('/api/generate', (req, res) => {
  if (swarm) return res.status(409).json({ error: 'Session already active' })
  const code = generateCode()
  startSession(code)
  res.json({ code })
})

app.post('/api/start', (req, res) => {
  if (swarm) return res.status(409).json({ error: 'Session already active' })
  const secret = normalizeSecret(req.body?.secret)
  if (secret.length < MIN_SECRET) {
    return res.status(400).json({ error: `Invalid code (minimum ${MIN_SECRET} characters)` })
  }
  startSession(secret)
  res.json({ code: secret })
})

app.post('/api/reset', async (req, res) => {
  await stopSync()
  clearSecret()
  clearHistory()
  currentSecret = ''
  broadcast('log', { msg: '[*] Session ended.' })
  broadcast('status', { peers: 0 })
  res.json({ success: true })
})

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  clients.add(res)
  // Initial state for clients connecting after sync has already started
  if (swarm) res.write(`data: ${JSON.stringify({ type: 'status', peers: peers.size })}\n\n`)
  req.on('close', () => clients.delete(res))
})

// ---------- Sync ----------

function startSession (secret) {
  currentSecret = secret
  saveSecret(secret)
  initSync(secret)
}

function initSync (secret) {
  if (swarm) return

  // NB: the 'clipsync-*' salts are part of the protocol: do not rename them, otherwise
  // different versions of the app would no longer be able to connect to each other.
  // Slow derivations (scrypt): make guessing a code expensive,
  // even when starting from the topic visible on the DHT.
  const topic = crypto.scryptSync(secret, 'clipsync-topic-v2', 32)
  const key = crypto.scryptSync(secret, 'clipsync-key-v2', 32)

  function encrypt (text) {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), enc])
  }

  function decrypt (buf) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
  }

  function frame (text) {
    const payload = encrypt(text)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    return Buffer.concat([header, payload])
  }

  // Protected remote write: suppresses watcher events for a short window
  // and updates lastText only after a successful write.
  async function writeRemote (text) {
    isWritingRemote = true
    if (remoteWriteGuard) clearTimeout(remoteWriteGuard)
    remoteWriteGuard = setTimeout(() => {
      isWritingRemote = false
      remoteWriteGuard = null
    }, WATCH_SUPPRESS_MS)
    try {
      await clipboard.write(text)
      lastText = text
      pushHistory(text, 'remote')
    } catch (err) {
      broadcast('log', { msg: `[!] Clipboard write error: ${err.message}` })
    }
  }

  swarm = new Hyperswarm()

  swarm.on('connection', (conn) => {
    peers.add(conn)
    broadcast('log', { msg: `[+] Peer connected (${peers.size} total)` })
    events.emit('peers', peers.size)
    broadcast('status', { peers: peers.size })

    conn.on('error', () => {})
    conn.on('close', () => {
      const destroyed = conn.destroyed
      peers.delete(conn)
      broadcast('log', { msg: `[-] Peer disconnected (${peers.size} total)${destroyed ? ' [destroyed]' : ''}` })
      broadcast('status', { peers: peers.size })
      events.emit('peers', peers.size)
    })

    let buf = Buffer.alloc(0)
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0)
        if (len > MAX_SIZE + 64) return conn.destroy()
        if (buf.length < 4 + len) break
        const payload = buf.subarray(4, 4 + len)
        buf = buf.subarray(4 + len)
        try {
          const text = decrypt(payload)
          if (text === '') continue // keep-alive frame: ignore
          if (text !== lastText) {
            // Serialize remote writes to avoid races on the clipboard
            localWriteChain = localWriteChain.then(() => writeRemote(text))
            broadcast('log', { msg: `[<] Received ${text.length} characters` })
          }
        } catch {
          conn.destroy()
        }
      }
    })
  })

  const mySwarm = swarm
  swarm.join(topic, { server: true, client: true })
  swarm.flush().then(() => {
    if (swarm !== mySwarm) return // session ended in the meantime
    broadcast('log', { msg: 'Clipeer active. Waiting for devices...' })
    broadcast('status', { peers: peers.size })
  }).catch(() => {})

  function handleLocal (text) {
    if (isWritingRemote) return // ignore events caused by our own remote write
    if (text && text !== lastText && Buffer.byteLength(text) <= MAX_SIZE) {
      lastText = text
      pushHistory(text, 'local')
      const data = frame(text)
      for (const p of peers) {
        try { p.write(data) } catch {}
      }
      if (peers.size) broadcast('log', { msg: `[>] Sent ${text.length} characters` })
    }
  }

  clipboard.read().then((t) => { lastText = t || '' }).catch(() => {})

  if (wayland) {
    watcher = spawn(wlPasteBin, ['--type', 'text', '--watch', 'sh', '-c', 'base64 -w0; echo'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    watcher.on('error', (err) => {
      broadcast('log', { msg: `[!] Wayland watcher error: ${err.message}` })
    })
    watcher.on('exit', (code) => {
      // code null = stopped by us with a signal (e.g. session end): not an error
      if (code !== 0 && code !== null) broadcast('log', { msg: `[!] Wayland watcher exited (code ${code})` })
    })
    let buf = ''
    watcher.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) {
          try {
            handleLocal(Buffer.from(line, 'base64').toString('utf8'))
          } catch {}
        }
      }
    })
  } else {
    pollTimer = setInterval(async () => {
      try { handleLocal(await clipboard.read()) } catch {}
    }, POLL_MS)
  }

  // Application-level keep-alive: a periodic empty encrypted frame keeps the
  // socket alive, useful on aggressive networks (Steam Deck).
  keepAliveTimer = setInterval(() => {
    for (const p of peers) {
      try {
        if (!p.destroyed) p.write(frame(''))
      } catch {}
    }
  }, KEEPALIVE_MS)
}

async function stopSync () {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null }
  if (remoteWriteGuard) { clearTimeout(remoteWriteGuard); remoteWriteGuard = null }
  isWritingRemote = false
  if (watcher) { try { watcher.kill() } catch {}; watcher = null }
  const s = swarm
  swarm = null
  peers.clear()
  lastText = ''
  events.emit('peers', 0)
  if (s) await s.destroy().catch(() => {})
}

function shutdown () {
  if (pollTimer) clearInterval(pollTimer)
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  if (remoteWriteGuard) clearTimeout(remoteWriteGuard)
  if (watcher) { try { watcher.kill() } catch {} }
  if (swarm) swarm.destroy().catch(() => {})
}

process.on('exit', shutdown)
process.on('SIGINT', () => { shutdown(); process.exit(0) })
process.on('SIGTERM', () => { shutdown(); process.exit(0) })

if (currentSecret.length >= MIN_SECRET) {
  initSync(currentSecret)
}

server.listen(PORT, HOST, () => {
  console.log('Clipeer started!')
  console.log(`Open your browser at: ${getAppUrl()}`)
})