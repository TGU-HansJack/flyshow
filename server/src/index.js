import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'fs-extra'
import matter from 'gray-matter'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import mysql from 'mysql2/promise'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 8787)
const DATA_DIR = process.env.FLYSHOW_DATA_DIR || path.join(__dirname, '..', 'data')
const OUTPUT_DIR = process.env.FLYSHOW_OUT_DIR || path.join(__dirname, '..', 'site')
let MULTI_MODE = String(process.env.FLYSHOW_MULTI || '').toLowerCase() === 'true'
const STATUS_PATH = path.join(DATA_DIR, 'status.json')
const RAW_DIR = path.join(DATA_DIR, 'notes')
const CONFIG_PATH = path.join(DATA_DIR, 'config.mjs')
let DEFAULT_CONFIG_TEXT = `export default { siteTitle: 'flyshow', nav: [], footer: '' }\n`
let AUTH_USER = process.env.FLYSHOW_USER || 'flyshow'
let AUTH_PASS = process.env.FLYSHOW_PASS || 'changeme'
const AUTH_TOKEN = process.env.FLYSHOW_TOKEN || ''
let ADMIN_USER = process.env.FLYSHOW_ADMIN_USER || AUTH_USER
let ADMIN_PASS = process.env.FLYSHOW_ADMIN_PASS || AUTH_PASS
const DB_HOST = process.env.FLYSHOW_DB_HOST || process.env.MYSQL_HOST || 'localhost'
const DB_PORT = Number(process.env.FLYSHOW_DB_PORT || process.env.MYSQL_PORT || 3306)
const DB_USER = process.env.FLYSHOW_DB_USER || process.env.MYSQL_USER || 'root'
const DB_PASS = process.env.FLYSHOW_DB_PASS || process.env.MYSQL_PASSWORD || ''
const DB_NAME = process.env.FLYSHOW_DB_NAME || process.env.MYSQL_DATABASE || 'flyshow'
const DB_PREFIX = process.env.FLYSHOW_DB_PREFIX || 'flyshow_'
const SINGLE_TOKENS = new Set()
let INSTALLED = false
const THEME_PRESETS = {
  default: { name: '榛樿', css: '' },
  glass: {
    name: '鍗婇€忔槑',
    css: `
      body { background: radial-gradient(circle at 10% 20%, rgba(96,165,250,0.12), transparent 40%), radial-gradient(circle at 80% 0, rgba(16,185,129,0.12), transparent 32%), linear-gradient(180deg, rgba(255,255,255,0.82), rgba(248,250,252,0.86)); }
      [data-theme="dark"] body { background: radial-gradient(circle at 10% 20%, rgba(96,165,250,0.08), transparent 40%), radial-gradient(circle at 80% 0, rgba(16,185,129,0.08), transparent 32%), #0c0f17; }
      .card, article, .toc { backdrop-filter: blur(12px); background: rgba(255,255,255,0.82); border-color: rgba(148,163,184,0.5); }
      [data-theme="dark"] .card, [data-theme="dark"] article, [data-theme="dark"] .toc { background: rgba(15,23,42,0.7); border-color: rgba(30,41,59,0.7); }
      header.site-header, footer { backdrop-filter: blur(10px); background: rgba(255,255,255,0.85); }
      [data-theme="dark"] header.site-header, [data-theme="dark"] footer { background: rgba(12,15,23,0.75); }
    `,
  },
}

await fs.ensureDir(DATA_DIR)
await fs.ensureDir(OUTPUT_DIR)
if (!MULTI_MODE) {
  await fs.ensureDir(RAW_DIR)
}
const db = await mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  charset: 'utf8mb4',
})

async function initDb() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS \`${DB_PREFIX}settings\` (
      id TINYINT PRIMARY KEY DEFAULT 1,
      mode VARCHAR(10) NOT NULL,
      site_title VARCHAR(255) DEFAULT '',
      installed TINYINT DEFAULT 0,
      created_at BIGINT DEFAULT 0
    )`,
  )
  await db.query(
    `CREATE TABLE IF NOT EXISTS \`${DB_PREFIX}users\` (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(191) UNIQUE NOT NULL,
      salt VARCHAR(128) NOT NULL,
      hash VARCHAR(256) NOT NULL,
      role VARCHAR(20) DEFAULT 'user',
      created_at BIGINT DEFAULT 0
    )`,
  )
  await db.query(
    `CREATE TABLE IF NOT EXISTS \`${DB_PREFIX}tokens\` (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      token VARCHAR(256) UNIQUE NOT NULL,
      username VARCHAR(191) NOT NULL,
      device VARCHAR(128) DEFAULT '',
      created_at BIGINT DEFAULT 0
    )`,
  )
  await db.query(
    `CREATE TABLE IF NOT EXISTS \`${DB_PREFIX}invites\` (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(128) UNIQUE NOT NULL,
      created_by VARCHAR(191) DEFAULT '',
      note VARCHAR(255) DEFAULT '',
      used TINYINT DEFAULT 0,
      used_by VARCHAR(191) DEFAULT '',
      created_at BIGINT DEFAULT 0,
      used_at BIGINT DEFAULT 0
    )`,
  )
}

await initDb()
await loadSetup()
if (!INSTALLED) {
  if (!MULTI_MODE && AUTH_USER) {
    INSTALLED = true
  } else if (MULTI_MODE) {
    const [rows] = await db.query(`SELECT COUNT(*) AS c FROM \`${DB_PREFIX}users\``)
    if (rows?.[0]?.c > 0) INSTALLED = true
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

function unauthorized(res) {
  return res.status(401).json({ ok: false, message: 'Unauthorized' })
}

function badRequest(res, message) {
  return res.status(400).json({ ok: false, message })
}

function randomId(len = 32) {
  return crypto.randomBytes(len).toString('hex')
}

function hashPassword(password, salt) {
  const s = salt || randomId(8)
  const hash = crypto.pbkdf2Sync(String(password), s, 12000, 32, 'sha256').toString('hex')
  return { salt: s, hash }
}

function requireInstalled(req, res, next) {
  if (INSTALLED) return next()
  return res.status(503).json({ ok: false, message: '闇€瑕佸厛瀹屾垚瀹夎', needSetup: true })
}

async function upsertSettings({ mode, siteTitle, installed }) {
  const now = Date.now()
  await db.query(
    `INSERT INTO \`${DB_PREFIX}settings\` (id, mode, site_title, installed, created_at) VALUES (1,?,?,?,?)
     ON DUPLICATE KEY UPDATE mode=VALUES(mode), site_title=VALUES(site_title), installed=VALUES(installed)`,
    [mode, siteTitle || '', installed ? 1 : 0, now],
  )
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex')
}

async function loadSetup() {
  try {
    const [rows] = await db.query(`SELECT * FROM \`${DB_PREFIX}settings\` WHERE id=1`)
    if (!rows || rows.length === 0) return null
    const data = rows[0]
    if (data.site_title) {
      DEFAULT_CONFIG_TEXT = `export default { siteTitle: '${data.site_title}', nav: [], footer: '' }\n`
    }
    if (data.mode === 'multi') {
      MULTI_MODE = true
    } else if (data.mode === 'single') {
      MULTI_MODE = false
    }
    INSTALLED = Boolean(data.installed)
    return data
  } catch (e) {
    console.warn('[flyshow-server] load setup failed', e)
    return null
  }
}

async function getUser(username) {
  const [rows] = await db.query(`SELECT * FROM \`${DB_PREFIX}users\` WHERE username=? LIMIT 1`, [username])
  return rows?.[0] || null
}

async function createUser({ username, salt, hash, role }) {
  await db.query(
    `INSERT INTO \`${DB_PREFIX}users\` (username, salt, hash, role, created_at) VALUES (?,?,?,?,?)`,
    [username, salt, hash, role || 'user', Date.now()],
  )
}

async function listUsers() {
  const [rows] = await db.query(`SELECT username, role, created_at FROM \`${DB_PREFIX}users\` ORDER BY created_at ASC`)
  return rows || []
}

async function findToken(tokenVal) {
  const [rows] = await db.query(`SELECT * FROM \`${DB_PREFIX}tokens\` WHERE token=? LIMIT 1`, [tokenVal])
  return rows?.[0] || null
}

async function createTokenRow({ token, username, device }) {
  await db.query(
    `INSERT INTO \`${DB_PREFIX}tokens\` (token, username, device, created_at) VALUES (?,?,?,?)`,
    [token, username, device || 'unknown', Date.now()],
  )
}

async function revokeTokenRow(tokenVal) {
  await db.query(`DELETE FROM \`${DB_PREFIX}tokens\` WHERE token=?`, [tokenVal])
}

async function createInviteRow({ code, note, createdBy }) {
  await db.query(
    `INSERT INTO \`${DB_PREFIX}invites\` (code, created_by, note, created_at) VALUES (?,?,?,?)`,
    [code, createdBy || '', note || '', Date.now()],
  )
}

async function getInvite(code) {
  const [rows] = await db.query(`SELECT * FROM \`${DB_PREFIX}invites\` WHERE code=? LIMIT 1`, [code])
  return rows?.[0] || null
}

async function markInviteUsed(code, username) {
  await db.query(`UPDATE \`${DB_PREFIX}invites\` SET used=1, used_by=?, used_at=? WHERE code=?`, [username, Date.now(), code])
}

async function ensureAdminUser() {
  if (!MULTI_MODE || !INSTALLED) return
  const exists = await getUser(ADMIN_USER)
  if (!exists) {
    const { salt, hash } = hashPassword(ADMIN_PASS)
    await createUser({ username: ADMIN_USER, salt, hash, role: 'admin' })
    console.log(`[flyshow-server] created admin user: ${ADMIN_USER}`)
  }
}

function sanitizeUsername(name) {
  const cleaned = String(name || '').trim().toLowerCase()
  if (!cleaned || !/^[a-z0-9._-]{3,64}$/.test(cleaned)) {
    throw new Error('username must be 3-64 chars (a-z0-9._-)')
  }
  return cleaned
}

function pathsForUser(username) {
  if (!MULTI_MODE) {
    return { rawDir: RAW_DIR, outDir: OUTPUT_DIR, statusPath: STATUS_PATH, configPath: CONFIG_PATH, themePath: path.join(DATA_DIR, 'theme.json'), basePath: '', username: username || AUTH_USER }
  }
  const user = sanitizeUsername(username)
  const baseDir = path.join(DATA_DIR, 'users', user)
  return {
    rawDir: path.join(baseDir, 'notes'),
    outDir: path.join(OUTPUT_DIR, user),
    statusPath: path.join(baseDir, 'status.json'),
    configPath: path.join(baseDir, 'config.mjs'),
    themePath: path.join(baseDir, 'theme.json'),
    basePath: `/${user}`,
    username: user,
  }
}

async function ensureUserDirs(username) {
  const { rawDir, outDir, statusPath, configPath, themePath } = pathsForUser(username)
  await fs.ensureDir(path.dirname(statusPath))
  await fs.ensureDir(rawDir)
  await fs.ensureDir(outDir)
  if (!(await fs.pathExists(configPath))) {
    await fs.outputFile(configPath, DEFAULT_CONFIG_TEXT, 'utf8')
  }
  if (!(await fs.pathExists(themePath))) {
    await fs.outputJson(themePath, { theme: 'default' }, { spaces: 2 })
  }
}

async function authenticate(req, requireAdmin = false) {
  if (!INSTALLED) return null
  // Single-user legacy path
  if (!MULTI_MODE) {
    const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)
    if (bearer && SINGLE_TOKENS.has(bearer[1])) return { username: AUTH_USER, role: 'admin' }
    if (AUTH_TOKEN) {
      const token = req.headers['x-flyshow-token'] || req.headers['x-api-key']
      if (token && token === AUTH_TOKEN) return { username: AUTH_USER, role: 'admin' }
    }
    const auth = req.headers.authorization || ''
    if (auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8')
      const [user, pass] = decoded.split(':')
      const row = await getUser(user)
      if (row) {
        const { hash } = hashPassword(pass || '', row.salt)
        if (hash === row.hash) return { username: row.username, role: row.role || 'admin' }
      } else if (AUTH_USER && AUTH_PASS && user === AUTH_USER && pass === AUTH_PASS) {
        // fallback to env for棣栨瀹夎鍓嶇殑鍏滃簳
        return { username: AUTH_USER, role: 'admin' }
      }
    }
    return null
  }

  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)
  if (bearer && bearer[1]) {
    const tokenVal = bearer[1]
    const tokenRow = await findToken(tokenVal)
    if (tokenRow) {
      const user = await getUser(tokenRow.username)
      if (user) {
        if (requireAdmin && user.role !== 'admin') return null
        return { username: user.username, role: user.role || 'user' }
      }
    }
  }

  const auth = req.headers.authorization || ''
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8')
    const [user, pass] = decoded.split(':')
    const row = await getUser(user)
    if (row) {
      const { hash } = hashPassword(pass || '', row.salt)
      if (hash === row.hash) {
        if (requireAdmin && row.role !== 'admin') return null
        return { username: row.username, role: row.role || 'user' }
      }
    }
  }
  return null
}

async function requireAuth(req, res, next) {
  if (!INSTALLED) return res.status(503).json({ ok: false, message: '闇€瑕佸厛瀹夎', needSetup: true })
  const user = await authenticate(req, false)
  if (!user) return unauthorized(res)
  req.user = user
  if (MULTI_MODE) await ensureUserDirs(user.username)
  next()
}

async function requireAdmin(req, res, next) {
  if (!INSTALLED) return res.status(503).json({ ok: false, message: '闇€瑕佸厛瀹夎', needSetup: true })
  const user = await authenticate(req, true)
  if (!user) return unauthorized(res)
  req.user = user
  if (MULTI_MODE) await ensureUserDirs(user.username)
  next()
}

await ensureAdminUser()

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(str, { language: lang }).value
        return `<pre class="hljs"><code class="language-${lang}">${out}</code></pre>`
      } catch {}
    }
    const escaped = md.utils.escapeHtml(str)
    return `<pre class="hljs"><code>${escaped}</code></pre>`
  },
})

function slugify(text, used = new Set()) {
  const base = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
  let slug = base || 'section'
  let i = 1
  while (used.has(slug)) {
    slug = `${base || 'section'}-${i++}`
  }
  used.add(slug)
  return slug
}

md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const level = Number(token.tag.slice(1))
  if (!env.headingsSet) {
    env.headingsSet = new Set()
    env.headings = []
  }
  if (level >= 1 && level <= 3) {
    // find text content
    let next = idx + 1
    let text = ''
    while (next < tokens.length && tokens[next].type !== 'heading_close') {
      if (tokens[next].type === 'inline') text += tokens[next].content
      next++
    }
    const id = slugify(text, env.headingsSet)
    token.attrSet('id', id)
    env.headings.push({ id, text, level })
  }
  return self.renderToken(tokens, idx, options)
}

function normalizeRel(rel) {
  const cleaned = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = cleaned.split('/').filter(Boolean)
  for (const p of parts) {
    if (p === '.' || p === '..') {
      throw new Error('invalid relativePath')
    }
  }
  if (parts.length === 0) throw new Error('invalid relativePath')
  return parts.join('/')
}

function isHiddenRel(rel) {
  const parts = String(rel || '').split('/').filter(Boolean)
  return parts.some((p) => p.startsWith('.'))
}

function urlForNote(rel, basePath = '') {
  const clean = normalizeRel(rel).replace(/\.(md|markdown|txt)$/i, '')
  const prefix = basePath || ''
  if (clean === 'index') return { url: prefix || '/', outDir: prefix ? path.join(OUTPUT_DIR, prefix) : OUTPUT_DIR }
  if (clean.endsWith('/index')) {
    const base = clean.replace(/\/index$/, '')
    const url = prefix ? `${prefix}/${base}` : '/' + base
    const outDir = prefix ? path.join(OUTPUT_DIR, prefix, base) : path.join(OUTPUT_DIR, base)
    return { url, outDir }
  }
  const url = prefix ? `${prefix}/${clean}` : '/' + clean
  const outDir = prefix ? path.join(OUTPUT_DIR, prefix, clean) : path.join(OUTPUT_DIR, clean)
  return { url, outDir }
}

async function persistConfig(text, configPath) {
  if (text && String(text).trim()) {
    await fs.outputFile(configPath, text, 'utf8')
    return
  }
  if (!(await fs.pathExists(configPath))) {
    await fs.outputFile(configPath, DEFAULT_CONFIG_TEXT, 'utf8')
  }
}

async function loadConfig(configPath) {
  const fallback = { siteTitle: 'flyshow', nav: [], description: '', author: '', footer: 'Powered by flyshow' }
  if (!(await fs.pathExists(configPath))) return fallback
  try {
    const mod = await import(pathToFileURL(configPath).href + `?t=${Date.now()}`)
    return Object.assign({}, fallback, mod?.default || mod || {})
  } catch (e) {
    console.warn('[flyshow-server] config import failed, using fallback', e)
    return fallback
  }
}

function normalizeThemeKey(key) {
  return THEME_PRESETS[key] ? key : 'default'
}

async function persistTheme(themeKey, themePath) {
  const safeKey = normalizeThemeKey(themeKey || 'default')
  await fs.outputJson(themePath, { theme: safeKey }, { spaces: 2 })
  return safeKey
}

async function loadTheme(themePath) {
  try {
    const json = await fs.readJson(themePath)
    return normalizeThemeKey(json?.theme || 'default')
  } catch {
    return 'default'
  }
}

async function saveNotes(notes, rawDir) {
  for (const note of notes) {
    const rel = normalizeRel(note.relativePath)
    if (note.encrypted) {
      const dest = path.join(rawDir, rel).replace(/\.(md|markdown|txt)$/i, '.enc.json')
      const plain = path.join(rawDir, rel)
      await fs.remove(plain).catch(() => {})
      const payload = {
        relativePath: rel,
        encrypted: true,
        iv: note.iv,
        salt: note.salt,
        ciphertext: note.ciphertext,
        meta: note.meta || {},
        hash: note.hash,
        mtime: note.mtime || Date.now(),
      }
      await fs.outputJson(dest, payload, { spaces: 0 })
    } else {
      const dest = path.join(rawDir, rel)
      await fs.outputFile(dest, note.content || '', 'utf8')
    }
  }
}

function plainText(markdown) {
  const stripped = String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[*_>#-]/g, ' ')
  return stripped.replace(/\s+/g, ' ').trim()
}

function preprocessLinks(content, slugMap, currentRel) {
  const links = []
  const currentDir = normalizeRel(currentRel).split('/').slice(0, -1).join('/')
  const replacer = (match, inner) => {
    const [targetRaw, aliasRaw] = inner.split('|')
    const target = String(targetRaw || '').trim()
    const alias = (aliasRaw || '').trim() || target
    if (!target) return match
    const normalizedTarget = target.replace(/\\/g, '/').replace(/\.md$/i, '')
    const slug = slugMap.get(normalizedTarget) || slugMap.get(normalizedTarget.replace(/\s+/g, '-')) || normalizedTarget
    const href = slugMap.get(normalizedTarget) ? slug : slug.includes('/') ? slug : (currentDir ? currentDir + '/' + slug : slug)
    links.push(href)
    return `[${alias}](${href.replace(/^\/+/, '')})`
  }
  const replaced = String(content || '').replace(/\[\[([^[\]]+)\]\]/g, replacer)
  const withCallout = replaced.replace(/:::\s*(tip|info|warning|danger)\s*\n([\s\S]*?):::/g, (_m, type, body) => {
    const title = type.toUpperCase()
    const cleaned = body.trim().split('\n').map((l) => '> ' + l).join('\n')
    return `> **${title}**\n${cleaned}`
  })
  return { content: withCallout, links }
}

function themeOverrides(themeKey) {
  const preset = THEME_PRESETS[normalizeThemeKey(themeKey)] || THEME_PRESETS.default
  return preset.css || ''
}

function baseStyles(themeKey = 'default') {
  return `
  :root {
    --bg: #fdfdfd;
    --fg: #0f172a;
    --muted: #6b7280;
    --card: #ffffff;
    --border: #e5e7eb;
    --accent: #111827;
    --accent-strong: #0f172a;
  }
  [data-theme="dark"] {
    --bg: #0c0f17;
    --fg: #e5e7eb;
    --muted: #9ca3af;
    --card: #0f172a;
    --border: #1f2937;
    --accent: #60a5fa;
    --accent-strong: #7dd3fc;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Inter','Plus Jakarta Sans','Segoe UI',system-ui,-apple-system,sans-serif; margin: 0; background: var(--bg); color: var(--fg); }
  a { color: inherit; }
  header.site-header { max-width: 1200px; margin: 0 auto; padding: 22px 18px 10px; display:flex; align-items:center; gap:14px; position: sticky; top:0; background: var(--bg); z-index: 10; }
  header.site-header .title { font-weight: 700; font-size: 18px; letter-spacing: 0.2px; }
  nav { display:flex; gap:12px; flex-wrap: wrap; }
  nav a { text-decoration: none; color: var(--muted); padding: 6px 0; border-bottom: 1px solid transparent; }
  nav a:hover { color: var(--fg); border-color: var(--fg); }
  .btn { padding: 8px 10px; border-radius: 20px; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor:pointer; font-weight: 600; }
  .btn.ghost { background: transparent; }
  .hero { max-width: 1200px; margin: 0 auto; padding: 8px 18px 12px; display:flex; align-items:flex-end; justify-content: space-between; gap: 20px; }
  .hero .eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; color: var(--muted); margin: 0 0 6px; }
  .hero h1 { margin: 0; font-size: 34px; line-height: 1.1; }
  .hero .lead { margin: 8px 0 0; color: var(--muted); max-width: 680px; line-height: 1.6; }
  .home-grid { max-width: 1200px; margin: 0 auto; padding: 6px 18px 64px; display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); column-gap: 46px; row-gap: 36px; position: relative; }
  .card { display:grid; gap: 10px; padding-bottom: 22px; border-bottom: 1px solid var(--border); min-height: 200px; }
  .card .meta-line { display:flex; justify-content: space-between; align-items:center; font-size: 12px; color: var(--muted); letter-spacing: 0.06em; text-transform: uppercase; }
  .card h3 { margin: 0; font-size: 20px; line-height: 1.3; }
  .card h3 a { color: var(--fg); text-decoration: none; }
  .card h3 a:hover { color: var(--accent); }
  .card .excerpt { margin: 0; color: var(--muted); line-height: 1.6; font-size: 14px; }
  .card .author { font-size: 13px; color: var(--fg); font-weight: 600; }
  .card .time { font-size: 12px; color: var(--muted); }
  main.article-layout { max-width: 1200px; width: min(1200px, 100%); margin: 0 auto; padding: 6px 18px 64px; display: grid; grid-template-columns: minmax(0, 3fr) 300px; gap: 42px; align-items: start; }
  main.article-layout > * { min-width: 0; }
  @media (max-width: 960px) { main.article-layout { grid-template-columns: 1fr; } .toc { position: relative; top: 0; border-left: none; padding-left: 0; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 8px; } }
  article { padding: 0; min-width: 0; overflow-wrap: break-word; word-break: break-word; }
  article h1 { font-size: 32px; margin: 0 0 12px; line-height: 1.2; }
  article h2 { margin-top: 32px; margin-bottom: 12px; font-size: 24px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  article h3 { margin-top: 26px; margin-bottom: 10px; font-size: 20px; }
  article p { line-height: 1.75; margin: 0 0 16px; }
  article pre { background: #0f172a; color: #e5e7eb; padding: 14px; border-radius: 10px; overflow: auto; border: 1px solid #1f2937; }
  [data-theme="light"] article pre { background: #0f172a; color: #e5e7eb; border-color: #111827; }
  article code { font-family: 'JetBrains Mono','SFMono-Regular',Consolas,monospace; background: rgba(15,23,42,0.06); padding: 2px 4px; border-radius: 4px; }
  article pre code { background: transparent; padding: 0; }
  article img { max-width: min(100%, 760px); height: auto; border-radius: 10px; display: block; margin: 18px auto; }
  article blockquote { margin: 16px 0; padding: 12px 16px; border-left: 3px solid var(--accent); background: rgba(15,23,42,0.04); color: var(--fg); }
  [data-theme="dark"] article blockquote { background: rgba(255,255,255,0.04); }
  article ul, article ol { padding-left: 20px; }
  article table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
  article th, article td { padding: 10px 12px; border: 1px solid var(--border); text-align: left; }
  .article-meta { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 13px; margin-bottom: 14px; }
  .tag-pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: rgba(15,23,42,0.05); color: var(--fg); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
  .toc { position: sticky; top: 80px; border-left: 1px solid var(--border); padding-left: 16px; }
  .toc h4 { margin: 0 0 8px; font-size: 14px; color: var(--muted); letter-spacing: 0.04em; text-transform: uppercase; }
  .toc ul { list-style: none; padding-left: 0; margin: 0; display: grid; gap: 6px; }
  .toc a { text-decoration: none; color: var(--muted); font-size: 13px; }
  .toc a:hover { color: var(--accent); }
  footer { max-width: 1200px; margin: 0 auto; padding: 0 18px 32px; color: var(--muted); line-height: 1.5; }
  .card.encrypted { border: 1px dashed var(--border); border-radius: 12px; padding: 16px 14px; background: linear-gradient(180deg, rgba(148,163,184,0.08), rgba(148,163,184,0.04)); border-bottom: none; }
  .card.encrypted .meta-line { margin-bottom: 4px; }
  .card.encrypted .author { color: var(--muted); }
  .encrypted-placeholder { border: 1px dashed var(--border); border-radius: 12px; background: rgba(148,163,184,0.12); padding: 16px; color: var(--muted); }
  .encrypted-bars { display:grid; gap:10px; margin-top:12px; }
  .encrypted-bar { height: 12px; border-radius: 8px; background: linear-gradient(90deg, rgba(148,163,184,0.22), rgba(148,163,184,0.06)); }
  .encrypted-bar.short { width: 60%; }
  .placeholder-link { text-decoration: none; color: inherit; display: block; }
  .placeholder-bars { display:grid; gap:10px; margin: 10px 0 6px; }
  .placeholder-bar { height: 14px; border-radius: 10px; background: rgba(148,163,184,0.22); }
  .placeholder-bar.wide { height: 18px; }
  .placeholder-bar.short { width: 60%; }
  .encrypted-actions { display:flex; gap:10px; align-items:center; margin-top:12px; flex-wrap: wrap; }
  .encrypted-actions input { padding: 10px 12px; border-radius: 10px; border:1px solid var(--border); min-width: 220px; }
  .encrypted-actions button { padding: 10px 14px; border-radius: 10px; border:1px solid var(--border); background: var(--card); cursor:pointer; font-weight:600; }
  .encrypted-msg { color: #ef4444; margin-top: 6px; }
  .encrypted-content { margin-top: 12px; }
  `
    + themeOverrides(themeKey)
}

function themeScript() {
  return `
    (() => {
      const key = 'flyshow-theme'
      const saved = localStorage.getItem(key)
      if (saved) document.body.setAttribute('data-theme', saved)
      const btn = document.getElementById('toggle-theme')
      if (btn) {
        btn.addEventListener('click', () => {
          const next = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
          document.body.setAttribute('data-theme', next)
          localStorage.setItem(key, next)
        })
      }
    })();
  `
}

function formatDateLabel(value) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(d)
}

function timeValue(value, fallback = 0) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return fallback
  return d.getTime()
}

function trimText(text, limit = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return clean
  return clean.slice(0, limit - 1) + '鈥?
}

function renderPage({ title, body, config, meta, urlPath, basePath, toc, commentHtml }) {
  const nav = Array.isArray(config.nav) ? config.nav : []
  const metaDesc = meta?.description || config.description || ''
  const navHtml = nav
    .map((item) => {
      const href = item.href && item.href.startsWith('/') && basePath ? basePath + item.href : item.href
      return `<a href="${href}">${md.utils.escapeHtml(item.label || item.href)}</a>`
    })
    .join('')
  const category = meta?.category || (Array.isArray(meta?.tags) ? meta.tags[0] : '') || ''
  const dateLabel = formatDateLabel(meta?.publishedAt || meta?.date)
  const author = meta?.author || config.author || ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${md.utils.escapeHtml(title)} | ${md.utils.escapeHtml(config.siteTitle || 'flyshow')}</title>
  <meta name="description" content="${md.utils.escapeHtml(metaDesc || '')}" />
  <meta name="theme-color" content="#fdfdfd" />
  <link rel="canonical" href="${md.utils.escapeHtml(urlPath)}" />
  <style>${baseStyles(config.theme || 'default')}</style>
</head>
<body data-theme="light">
  <header class="site-header">
    <div class="title">${md.utils.escapeHtml(config.siteTitle || 'flyshow')}</div>
    <nav>${navHtml}</nav>
    <div style="margin-left:auto;">
      <button class="btn ghost" id="toggle-theme">Toggle theme</button>
    </div>
  </header>
  <main class="article-layout">
    <article>
      <div class="article-meta">
        ${category ? `<span class="tag-pill">${md.utils.escapeHtml(category)}</span>` : ''}
        ${dateLabel ? `<span>${md.utils.escapeHtml(dateLabel)}</span>` : ''}
        ${author ? `<span>By ${md.utils.escapeHtml(author)}</span>` : ''}
      </div>
      ${meta?.encrypted ? '' : `<h1>${md.utils.escapeHtml(title)}</h1>`}
      ${body}
      ${meta?.encrypted ? '' : (commentHtml || '')}
    </article>
    ${meta?.encrypted ? '' : toc && toc.length ? `<aside class="toc">
      <h4>Contents</h4>
      <ul>
        ${toc
          .map((h) => `<li style="margin-left:${(h.level - 1) * 8}px;"><a href="#${h.id}">${md.utils.escapeHtml(h.text || '')}</a></li>`)
          .join('')}
      </ul>
    </aside>` : ''}
  </main>
  <footer>
    <div>${md.utils.escapeHtml(config.footer || '')}</div>
    <div style="font-size:12px;">${md.utils.escapeHtml(urlPath)}</div>
  </footer>
  <script>${themeScript()}</script>
  ${
    meta?.encrypted && meta?.encryptedData
      ? `<script>
    (() => {
      const enc = ${JSON.stringify(meta.encryptedData)};
      const input = document.getElementById('flyshow-pass');
      const btn = document.getElementById('flyshow-decrypt');
      const msg = document.getElementById('flyshow-msg');
      const out = document.getElementById('flyshow-content');
      if (!input || !btn || !enc?.ciphertext) return;
      const b64ToBuf = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      async function decryptText(secret) {
        const encBytes = b64ToBuf(enc.ciphertext);
        const iv = b64ToBuf(enc.iv);
        const salt = b64ToBuf(enc.salt);
        const encKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']);
        const aesKey = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, encKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, encBytes);
        return new TextDecoder().decode(plainBuf);
      }
      async function ensureMd() {
        if (window.markdownit) return window.markdownit;
        await import('https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js');
        return window.markdownit;
      }
      function stripFrontMatter(text) {
        if (!text.startsWith('---')) return text;
        const end = text.indexOf('\\n---', 3);
        if (end === -1) return text;
        return text.slice(end + 4);
      }
      btn.addEventListener('click', async () => {
        msg.textContent = '';
        out.innerHTML = '';
        const pwd = input.value || '';
        if (!pwd) { msg.textContent = 'Enter the key first'; return; }
        try {
          const text = await decryptText(pwd);
          const md = await ensureMd();
          const content = stripFrontMatter(text || '');
          out.innerHTML = md({ breaks: true }).render(content);
        } catch (e) {
          console.error(e);
          msg.textContent = 'Decrypt failed or wrong key';
        }
      });
    })();
  </script>`
      : ''
  }
</body>
</html>`
}

function renderIndexPage(notes, config, basePath) {
  const nav = Array.isArray(config.nav) ? config.nav : []
  const navHtml = nav
    .map((item) => {
      const href = item.href && item.href.startsWith('/') && basePath ? basePath + item.href : item.href
      return `<a href="${href}">${md.utils.escapeHtml(item.label || item.href)}</a>`
    })
    .join('')
  const sorted = [...notes].sort((a, b) => {
    const diff = timeValue(b.date || b.publishedAt || b.updatedAt || 0) - timeValue(a.date || a.publishedAt || a.updatedAt || 0)
    if (diff !== 0) return diff
    return (a.title || '').localeCompare(b.title || '')
  })
  const cards = sorted
    .map((n) => {
      const category = n.category || (Array.isArray(n.tags) ? n.tags[0] : '') || 'Update'
      const dateLabel = formatDateLabel(n.date || n.publishedAt || n.updatedAt)
      const author = n.author || config.author || ''
      const summary = n.encrypted ? '' : trimText(n.summary || '', 180)
      const title = md.utils.escapeHtml(n.title || n.relativePath || '')
      const slug = String(n.relativePath || '').replace(/\\/g, '/').replace(/\.(md|markdown|txt)$/i, '')
      const url = n.url || (basePath ? `${basePath}/${slug}` : '/' + slug)
      const titleHtml = n.encrypted
        ? `<a class="placeholder-link" href="${url}" aria-label="鎵撳紑鍔犲瘑鏂囩珷">
            <div class="placeholder-bars">
              <div class="placeholder-bar wide"></div>
              <div class="placeholder-bar"></div>
              <div class="placeholder-bar short"></div>
            </div>
          </a>`
        : `<h3><a href="${url}">${title}</a></h3>`
      const descHtml = n.encrypted ? '' : `<p class="excerpt">${md.utils.escapeHtml(summary)}</p>`
      const cardClass = n.encrypted ? 'card encrypted' : 'card'
      return `<article class="${cardClass}">`
        + `<div class="meta-line"><span>${md.utils.escapeHtml(category)}</span><span>${md.utils.escapeHtml(dateLabel || '')}</span></div>`
        + titleHtml
        + descHtml
        + `<div class="author">${md.utils.escapeHtml(author)}</div>`
        + `</article>`
    })
    .join('')
  const cardsHtml = cards || '<article class="card"><p class="excerpt">No posts yet</p></article>'
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${md.utils.escapeHtml(config.siteTitle || 'flyshow')}</title>
  <style>${baseStyles(config.theme || 'default')}</style>
</head>
<body data-theme="light">
  <header class="site-header">
    <div class="title">${md.utils.escapeHtml(config.siteTitle || 'flyshow')}</div>
    <nav>${navHtml}</nav>
    <div style="margin-left:auto;">
      <button class="btn ghost" id="toggle-theme">Toggle theme</button>
    </div>
  </header>
  <section class="hero">
    <div>
      <p class="eyebrow">Latest</p>
      <h1>${md.utils.escapeHtml(config.siteTitle || 'flyshow')}</h1>
      <p class="lead">${md.utils.escapeHtml(config.description || '')}</p>
    </div>
  </section>
  <section class="home-grid">${cardsHtml}</section>
  <footer>
    <div>${md.utils.escapeHtml(config.footer || '')}</div>
  </footer>
  <script>${themeScript()}</script>
</body>
</html>`
}

function renderRootIndex(allNotes) {
  const config = { siteTitle: 'flyshow', nav: [], description: 'All articles', footer: '' }
  return renderIndexPage(allNotes, config, '')
}

async function buildSite(notes, config, userCtx) {
  const slugMap = new Map()
  const normalizedNotes = notes.map((n) => {
    const rel = normalizeRel(n.relativePath)
    const slug = rel.replace(/\.(md|markdown|txt)$/i, '')
    slugMap.set(slug, slug)
    return Object.assign({}, n, { relativePath: rel })
  })
  const { outDir, basePath, username } = userCtx
  const rendered = []

  for (const note of normalizedNotes) {
    const isEncrypted = note.encrypted === true
    const { url, outDir: targetDir } = urlForNote(note.relativePath, basePath)

    if (isEncrypted) {
      const publishedDate = new Date(note.mtime || Date.now())
      const safeDate = Number.isNaN(publishedDate.getTime()) ? new Date() : publishedDate
      const meta = Object.assign({}, note.meta || {}, {
        encrypted: true,
        publishedAt: safeDate.toISOString(),
        date: safeDate.toISOString(),
        encryptedData: {
          ciphertext: note.ciphertext,
          iv: note.iv,
          salt: note.salt,
        },
      })
      const placeholder = `<div class="encrypted-placeholder">
        <div>This post is encrypted. Only author/category/time are visible. Enter the key to decrypt the content.</div>
        <div class="encrypted-actions">
          <input id="flyshow-pass" type="password" placeholder="Enter key to decrypt">
          <button id="flyshow-decrypt">Decrypt</button>
        </div>
        <div id="flyshow-msg" class="encrypted-msg"></div>
        <div class="encrypted-bars">
          <div class="encrypted-bar"></div>
          <div class="encrypted-bar"></div>
          <div class="encrypted-bar short"></div>
        </div>
        <div id="flyshow-content" class="encrypted-content"></div>
      </div>`
      const html = renderPage({ title: 'Encrypted', body: placeholder, config, meta, urlPath: url, basePath, toc: [], commentHtml: '' })
      await fs.ensureDir(targetDir)
      await fs.outputFile(path.join(targetDir, 'index.html'), html, 'utf8')
      rendered.push({
        relativePath: note.relativePath,
        url,
        hash: note.hash,
        title: '鍔犲瘑鍐呭',
        summary: '璇ユ枃绔犲凡鍔犲瘑',
        tags: [],
        author: meta.author || userCtx.username || '',
        category: meta.category || '',
        date: meta.date,
        publishedAt: meta.publishedAt,
        encrypted: true,
      })
      continue
    }

    const { content: linkReplaced } = preprocessLinks(note.content || '', slugMap, note.relativePath)
    const parsed = matter(linkReplaced || '')
    const fm = parsed.data || {}
    const title = fm.title || note.title || note.relativePath
    const env = {}
    const body = md.render(parsed.content || '', env)
    const toc = env.headings || []
    const commentHtml = fm.comments || config.commentHtml || ''
    const publishedDate = fm.date ? new Date(fm.date) : new Date(note.mtime || Date.now())
    const safeDate = Number.isNaN(publishedDate.getTime()) ? new Date(note.mtime || Date.now()) : publishedDate
    // Prefer explicit frontmatter author, then current user, then site-level default
    const author = fm.author || username || config.author || ''
    const category = fm.category || (Array.isArray(fm.categories) ? fm.categories[0] : '') || (Array.isArray(fm.tags) ? fm.tags[0] : '') || ''
    const meta = Object.assign({}, fm, { author, category, publishedAt: safeDate.toISOString(), date: safeDate.toISOString() })
    const html = renderPage({ title, body, config, meta, urlPath: url, basePath, toc, commentHtml })
    await fs.ensureDir(targetDir)
    await fs.outputFile(path.join(targetDir, 'index.html'), html, 'utf8')
    const summary = trimText(plainText(parsed.content || ''), 220)
    rendered.push({ relativePath: note.relativePath, url, hash: note.hash, title, summary, tags: fm.tags || [], author, category, date: safeDate.toISOString(), publishedAt: safeDate.toISOString() })
  }

  const indexHtml = renderIndexPage(rendered, config, basePath)
  await fs.outputFile(path.join(outDir, 'index.html'), indexHtml, 'utf8')
  await fs.outputJson(path.join(outDir, 'manifest.json'), { generatedAt: new Date().toISOString(), notes: rendered }, { spaces: 2 })
  return rendered
}

async function readStatusMap(statusPath) {
  try {
    const json = await fs.readJson(statusPath)
    return json && typeof json === 'object' ? json : {}
  } catch {
    return {}
  }
}

async function updateStatus(rendered, statusPath, removed = []) {
  const now = Date.now()
  const nextMap = {}
  for (const item of rendered) {
    const rel = normalizeRel(item.relativePath)
    nextMap[rel] = {
      hash: item.hash,
      url: item.url,
      updatedAt: now,
    }
  }
  const removedSet = new Set(
    (removed || [])
      .map((r) => {
        try {
          return normalizeRel(r)
        } catch {
          return null
        }
      })
      .filter((r) => r && !isHiddenRel(r)),
  )
  if (removedSet.size > 0) {
    const existing = await readStatusMap(statusPath)
    for (const rel of Object.keys(existing)) {
      if (removedSet.has(rel)) continue
      if (!nextMap[rel]) {
        nextMap[rel] = existing[rel]
      }
    }
  }
  await fs.outputJson(statusPath, nextMap, { spaces: 2 })
  return nextMap
}

async function rebuildRootIndex() {
  if (!MULTI_MODE) return
  const users = await listUsers()
  const notes = []
  for (const u of users) {
    const manifestPath = path.join(OUTPUT_DIR, u.username, 'manifest.json')
    const data = await fs.readJson(manifestPath).catch(() => null)
    const list = Array.isArray(data?.notes) ? data.notes : []
    for (const n of list) {
      const url = n.url || `/${u.username}/${String(n.relativePath || '').replace(/\\/g, '/').replace(/\.(md|markdown|txt)$/i, '')}`
      const category = n.category || (Array.isArray(n.tags) ? n.tags[0] : '') || ''
      const author = n.author || u.username
      const date = n.date || n.publishedAt || n.updatedAt || ''
      notes.push(Object.assign({}, n, { url, category, author, date }))
    }
  }
  const html = renderRootIndex(notes)
  await fs.outputFile(path.join(OUTPUT_DIR, 'index.html'), html, 'utf8')
}

async function readStoredNotes(rawDir) {
  const list = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
      } else if (ent.isFile() && /\.(md|markdown|txt)$/i.test(ent.name)) {
        const rel = path.relative(rawDir, full).replace(/\\/g, '/')
        if (isHiddenRel(rel)) continue
        const content = await fs.readFile(full, 'utf8').catch(() => '')
        const parsed = matter(content || '')
        const fm = parsed.data || {}
        list.push({
          relativePath: rel,
          content,
          title: fm.title || rel,
          hash: hashContent(content),
          mtime: 0,
        })
      } else if (ent.isFile() && /\.enc\.json$/i.test(ent.name)) {
        const payload = await fs.readJson(full).catch(() => null)
        if (!payload || !payload.relativePath) continue
        list.push({
          relativePath: payload.relativePath,
          encrypted: true,
          meta: payload.meta || {},
          iv: payload.iv,
          salt: payload.salt,
          ciphertext: payload.ciphertext,
          hash: payload.hash || hashContent(JSON.stringify(payload)),
          mtime: payload.mtime || 0,
        })
      }
    }
  }
  await walk(rawDir)
  return list
}

function renderPanelPage() {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>flyshow 鎺у埗鍙?/title><style>
    :root { --border:#d0d7de; --fg:#1f2328; --muted:#57606a; --bg:#f6f8fa; --card:#ffffff; --blue:#0969da; }
    *{box-sizing:border-box;}
    body{font-family:'Segoe UI','Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:32px;display:flex;justify-content:center;}
    .wrap{width:min(920px,100%);}
    h1{margin:0 0 18px;font-size:24px;font-weight:700;}
    section{margin-bottom:16px;padding:16px 18px;border:1px solid var(--border);border-radius:10px;background:var(--card);box-shadow:0 1px 0 rgba(27,31,36,0.04);}
    section h3{margin:0 0 12px;font-size:16px;}
    label{display:block;margin-bottom:6px;color:var(--muted);font-size:14px;}
    input,textarea{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:#fff;color:var(--fg);}
    button{padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:#f6f8fa;color:var(--fg);cursor:pointer;font-weight:600;}
    button.primary{background:var(--blue);color:#fff;border-color:var(--blue);}
    button:hover{background:#eef1f4;}
    button.primary:hover{background:#0757b8;}
    .row{display:flex;gap:10px;flex-wrap:wrap;}
    .row .col{flex:1;min-width:200px;}
    table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px;color:var(--fg);}
    th,td{padding:8px;border-bottom:1px solid var(--border);text-align:left;}
    .muted{color:var(--muted);font-size:13px;}
    .admin-only{display:none;}
    .status{margin-top:8px;color:var(--blue);}
  </style></head><body>
  <div class="wrap">
    <h1>flyshow 鎺у埗鍙?/h1>
    <section>
      <h3>鐧诲綍</h3>
      <div class="row">
        <div class="col"><label>鐢ㄦ埛鍚?/label><input id="login-user" placeholder="鐢ㄦ埛鍚?></div>
        <div class="col"><label>瀵嗙爜</label><input id="login-pass" type="password" placeholder="瀵嗙爜"></div>
        <div class="col"><label>璁惧鍚?/label><input id="login-device" placeholder="璁惧鍚? value="web-panel"></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;">
        <button class="primary" onclick="login()">鐧诲綍骞惰幏鍙?token</button>
        <span id="login-result" class="status"></span>
      </div>
    </section>
    <section>
      <h3>娉ㄥ唽</h3>
      <div class="row">
        <div class="col"><label>閭€璇风爜</label><input id="reg-code" placeholder="閭€璇风爜"></div>
        <div class="col"><label>鐢ㄦ埛鍚?/label><input id="reg-user" placeholder="鐢ㄦ埛鍚?></div>
        <div class="col"><label>瀵嗙爜</label><input id="reg-pass" type="password" placeholder="瀵嗙爜"></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;">
        <button onclick="registerUser()">娉ㄥ唽璐﹀彿</button>
        <span id="reg-result" class="status"></span>
      </div>
      <div class="muted" style="margin-top:6px;">娉ㄥ唽闇€閭€璇风爜锛岄€傜敤浜庡鐢ㄦ埛妯″紡銆?/div>
    </section>
    <section class="admin-only">
      <h3>鍒涘缓閭€璇风爜</h3>
      <div class="row">
        <div class="col"><label>鑷畾涔夐個璇风爜锛堝彲鐣欑┖锛?/label><input id="invite-code" placeholder="鐣欑┖鑷姩鐢熸垚"></div>
        <div class="col"><label>澶囨敞</label><input id="invite-note" placeholder="澶囨敞"></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;">
        <button onclick="invite()">鍒涘缓</button>
        <span id="invite-result" class="status"></span>
      </div>
    </section>
    <section class="admin-only">
      <h3>娉ㄩ攢璁惧 Token</h3>
      <div class="row">
        <div class="col"><label>token</label><input id="revoke-token" placeholder="token 鍊?></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;">
        <button onclick="revoke()">娉ㄩ攢</button>
        <span id="revoke-result" class="status"></span>
      </div>
    </section>
    <section class="admin-only">
      <h3>鐢ㄦ埛鍒楄〃</h3>
      <div style="margin-bottom:8px;"><button onclick="loadUsers()">鍒锋柊</button></div>
      <div id="users" class="muted">绠＄悊鍛樼櫥褰曞悗鍙煡鐪嬨€?/div>
    </section>
  </div>
  <script>
    let token = '';
    let role = 'guest';
    function authHeaders(){ return token ? { 'Authorization':'Bearer '+token } : {} }
    function setRole(nextRole){
      role = nextRole || 'guest';
      const adminBlocks = document.querySelectorAll('.admin-only');
      adminBlocks.forEach((el)=>{ el.style.display = role === 'admin' ? 'block' : 'none'; });
      const loginResult = document.getElementById('login-result');
      if(loginResult && token){ loginResult.textContent = '宸茬櫥褰曪紝瑙掕壊锛? + role; }
    }
    async function login(){
      const body = {
        username: document.getElementById('login-user').value,
        password: document.getElementById('login-pass').value,
        device: document.getElementById('login-device').value || 'web'
      };
      const res = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data = await res.json();
      const target = document.getElementById('login-result');
      if(data.ok){
        token=data.token;
        target.textContent='鐧诲綍鎴愬姛';
        await refreshRole();
      } else { target.textContent=data.message||'鐧诲綍澶辫触'; }
    }
    async function refreshRole(){
      try{
        const res = await fetch('/api/me',{headers:authHeaders()});
        const data = await res.json();
        if(data.ok){ setRole(data.user?.role || 'user'); } else { setRole('guest'); }
      }catch(e){ setRole('guest'); }
    }
    async function invite(){
      const body={
        code: document.getElementById('invite-code').value||undefined,
        note: document.getElementById('invite-note').value||''
      };
      const res=await fetch('/api/invite',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},authHeaders()),body:JSON.stringify(body)});
      const data=await res.json(); document.getElementById('invite-result').textContent=data.ok?('閭€璇风爜: '+data.code):data.message;
    }
    async function registerUser(){
      const body={
        code: document.getElementById('reg-code').value,
        username: document.getElementById('reg-user').value,
        password: document.getElementById('reg-pass').value
      };
      const res=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await res.json(); document.getElementById('reg-result').textContent=data.ok?'娉ㄥ唽鎴愬姛':data.message;
    }
    async function revoke(){
      const tokenVal = document.getElementById('revoke-token').value;
      const res=await fetch('/api/devices/revoke',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},authHeaders()),body:JSON.stringify({token: tokenVal})});
      const data=await res.json(); document.getElementById('revoke-result').textContent=data.ok?'宸叉敞閿€':data.message;
    }
    async function loadUsers(){
      const res=await fetch('/api/users',{headers:authHeaders()});
      const data=await res.json();
      const container = document.getElementById('users');
      if(!data.ok){ container.textContent=data.message||'澶辫触';return; }
      container.innerHTML='<table><thead><tr><th>鐢ㄦ埛</th><th>瑙掕壊</th><th>鍒涘缓鏃堕棿</th></tr></thead><tbody>'+data.users.map(u=>'<tr><td>'+u.username+'</td><td>'+u.role+'</td><td>'+new Date(u.createdAt||0).toLocaleString()+'</td></tr>').join('')+'</tbody></table>';
    }
    setRole('guest');
  </script>
  </body></html>`
}

function renderInstallPage() {
  return <!doctype html><html><head><meta charset="utf-8"/><title>flyshow 安装</title><style>
    :root { --border:#d0d7de; --fg:#1f2328; --muted:#57606a; --bg:#f6f8fa; --card:#ffffff; --blue:#0969da; }
    *{box-sizing:border-box;}
    body{font-family:'Segoe UI','Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:32px;display:flex;justify-content:center;}
    .wrap{width:min(900px,100%);} 
    h1{margin:0 0 18px;font-size:24px;font-weight:700;}
    section{margin-bottom:16px;padding:16px 18px;border:1px solid var(--border);border-radius:10px;background:var(--card);box-shadow:0 1px 0 rgba(27,31,36,0.04);} 
    section h3{margin:0 0 12px;font-size:16px;}
    label{display:block;margin-bottom:6px;color:var(--muted);font-size:14px;}
    input,select{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:#fff;color:#1f2328;}
    button{padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:#f6f8fa;color:var(--fg);cursor:pointer;font-weight:600;}
    button.primary{background:var(--blue);color:#fff;border-color:var(--blue);} 
    button:hover{background:#eef1f4;} 
    button.primary:hover{background:#0757b8;}
    .row{display:flex;gap:10px;flex-wrap:wrap;} 
    .row .col{flex:1;min-width:240px;} 
    .muted{color:var(--muted);font-size:13px;} 
    .mode-tabs{display:flex;gap:10px;margin-top:8px;} 
    .mode-tab{padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:#f6f8fa;cursor:pointer;font-weight:600;} 
    .mode-tab.active{background:var(--blue);color:#fff;border-color:var(--blue);} 
    #result{margin-top:10px;color:var(--blue);} 
  </style></head><body>
  <div class="wrap">
    <h1>flyshow 安装向导</h1>
    <section>
      <div class="row">
        <div class="col">
          <label>站点名称</label>
          <input id="siteTitle" placeholder="flyshow">
        </div>
        <div class="col">
          <label>模式</label>
          <div class="mode-tabs">
            <div class="mode-tab active" data-mode="single">单用户</div>
            <div class="mode-tab" data-mode="multi">多用户</div>
          </div>
        </div>
      </div>
      <div class="muted" style="margin-top:8px;">单用户适合个人博客；多用户会启用数据库账号体系。</div>
    </section>
    <section id="single-box">
      <h3>单用户账号</h3>
      <div class="row">
        <div class="col"><label>用户名</label><input id="singleUser" placeholder="flyshow"></div>
        <div class="col"><label>密码</label><input id="singlePass" type="password" placeholder="密码"></div>
      </div>
    </section>
    <section id="multi-box" style="display:none;">
      <h3>多用户管理员</h3>
      <div class="row">
        <div class="col"><label>管理员用户名</label><input id="adminUser" value="admin"></div>
        <div class="col"><label>管理员密码</label><input id="adminPass" type="password" placeholder="密码"></div>
      </div>
      <div class="muted" style="margin-top:6px;">管理员可在 /panel 创建邀请和用户。</div>
    </section>
    <section>
      <div style="display:flex;gap:10px;align-items:center;">
        <button class="primary" onclick="submitInstall()">提交安装</button>
        <div id="result"></div>
      </div>
    </section>
  </div>
  <script>
    const modeTabs = document.querySelectorAll('.mode-tab')
    const singleBox = document.getElementById('single-box')
    const multiBox = document.getElementById('multi-box')
    let modeSel = 'single'
    modeTabs.forEach((tab)=>{
      tab.addEventListener('click',()=>{
        modeTabs.forEach(t=>t.classList.remove('active'))
        tab.classList.add('active')
        modeSel = tab.getAttribute('data-mode') || 'single'
        singleBox.style.display = modeSel === 'single' ? 'block' : 'none'
        multiBox.style.display = modeSel === 'multi' ? 'block' : 'none'
      })
    })
    async function submitInstall(){
      const body = {
        siteTitle: document.getElementById('siteTitle').value,
        mode: modeSel,
        singleUser: document.getElementById('singleUser').value,
        singlePass: document.getElementById('singlePass').value,
        adminUser: document.getElementById('adminUser').value,
        adminPass: document.getElementById('adminPass').value
      }
      const res = await fetch('/api/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      const data = await res.json()
      const el = document.getElementById('result')
      if(data.ok){ el.textContent='安装成功，请刷新访问 /panel 或首页'; el.style.color='#0969da'; }
      else { el.textContent=data.message||'安装失败'; el.style.color='#b91c1c'; }
    }
  </script>
  </body></html>
}
app.get('/api/install/status', (_req, res) => {
  res.json({ ok: true, installed: INSTALLED, mode: MULTI_MODE ? 'multi' : 'single' })
})

app.post('/api/install', async (req, res) => {
  if (INSTALLED) return badRequest(res, '宸插畨瑁咃紝鏃犻渶閲嶅瀹夎')
  try {
    const { mode, adminUser, adminPass, singleUser, singlePass, siteTitle } = req.body || {}
    const cleanMode = mode === 'multi' ? 'multi' : mode === 'single' ? 'single' : null
    if (!cleanMode) return badRequest(res, '妯″紡蹇呴』鏄?single 鎴?multi')
    if (siteTitle) {
      DEFAULT_CONFIG_TEXT = `export default { siteTitle: '${siteTitle}', nav: [], footer: '' }\n`
    }
    if (cleanMode === 'multi') {
      if (!adminUser || !adminPass) return badRequest(res, '绠＄悊鍛樿处鍙锋垨瀵嗙爜涓虹┖')
      MULTI_MODE = true
      ADMIN_USER = String(adminUser).trim()
      ADMIN_PASS = String(adminPass)
      await db.query(`DELETE FROM \`${DB_PREFIX}tokens\``)
      await db.query(`DELETE FROM \`${DB_PREFIX}invites\``)
      await db.query(`DELETE FROM \`${DB_PREFIX}users\``)
      const { salt, hash } = hashPassword(ADMIN_PASS)
      await createUser({ username: ADMIN_USER, salt, hash, role: 'admin' })
      await upsertSettings({ mode: 'multi', siteTitle, installed: true })
      INSTALLED = true
      await ensureAdminUser()
      res.json({ ok: true, mode: 'multi' })
    } else {
      if (!singleUser || !singlePass) return badRequest(res, '鍗曠敤鎴疯处鍙锋垨瀵嗙爜涓虹┖')
      MULTI_MODE = false
      AUTH_USER = String(singleUser).trim()
      AUTH_PASS = String(singlePass)
      await db.query(`DELETE FROM \`${DB_PREFIX}tokens\``)
      await db.query(`DELETE FROM \`${DB_PREFIX}invites\``)
      await db.query(`DELETE FROM \`${DB_PREFIX}users\``)
      const { salt, hash } = hashPassword(AUTH_PASS)
      await createUser({ username: AUTH_USER, salt, hash, role: 'admin' })
      await upsertSettings({ mode: 'single', siteTitle, installed: true })
      INSTALLED = true
      res.json({ ok: true, mode: 'single' })
    }
  } catch (e) {
    console.error('[flyshow-server] install error', e)
    res.status(500).json({ ok: false, message: e?.message || String(e) })
  }
})

app.get('/install', (_req, res) => res.send(renderInstallPage()))

app.get('/health', (req, res) => res.json({ ok: true, multi: MULTI_MODE, installed: INSTALLED }))

app.get('/panel', (_req, res) => {
  if (!INSTALLED) return res.redirect('/install')
  res.send(renderPanelPage())
})

app.post('/api/login', async (req, res) => {
  if (!INSTALLED) return res.status(503).json({ ok: false, message: '闇€瑕佸厛瀹夎', needSetup: true })
  const { username, password, device } = req.body || {}
  if (!username || !password) return badRequest(res, '鐢ㄦ埛鍚嶆垨瀵嗙爜涓虹┖')
  if (!MULTI_MODE) {
    const row = await getUser(username)
    if (!row) return unauthorized(res)
    const { hash } = hashPassword(password, row.salt)
    if (hash !== row.hash) return unauthorized(res)
    const token = AUTH_TOKEN || randomId(24)
    SINGLE_TOKENS.add(token)
    return res.json({ ok: true, token, username: row.username })
  }
  const user = await getUser(sanitizeUsername(username))
  if (!user) return unauthorized(res)
  const { hash } = hashPassword(password, user.salt)
  if (hash !== user.hash) return unauthorized(res)
  const token = randomId(24)
  await createTokenRow({ token, username: user.username, device })
  res.json({ ok: true, token, username: user.username })
})

app.post('/api/register', async (req, res) => {
  if (!MULTI_MODE) return badRequest(res, '鍗曠敤鎴锋ā寮忔棤闇€娉ㄥ唽')
  try {
    const { code, username, password } = req.body || {}
    if (!code || !username || !password) return badRequest(res, '缂哄皯鍙傛暟')
    const invite = await getInvite(code)
    if (!invite || invite.used) return badRequest(res, '閭€璇风爜鏃犳晥鎴栧凡浣跨敤')
    const uname = sanitizeUsername(username)
    const exists = await getUser(uname)
    if (exists) return badRequest(res, '鐢ㄦ埛鍚嶅凡瀛樺湪')
    const { salt, hash } = hashPassword(password)
    await createUser({ username: uname, salt, hash, role: 'user' })
    await markInviteUsed(code, uname)
    await ensureUserDirs(uname)
    await rebuildRootIndex()
    res.json({ ok: true, username: uname })
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || String(e) })
  }
})

app.post('/api/invite', requireAdmin, async (req, res) => {
  if (!MULTI_MODE) return badRequest(res, '鍗曠敤鎴锋ā寮忔棤闇€閭€璇风爜')
  const { code, note } = req.body || {}
  const c = code && String(code).trim() ? code.trim() : randomId(6)
  await createInviteRow({ code: c, note, createdBy: req.user.username })
  res.json({ ok: true, code: c })
})

app.get('/api/users', requireAdmin, async (_req, res) => {
  if (!MULTI_MODE) return badRequest(res, '鍗曠敤鎴锋ā寮忔棤闇€璇ユ帴鍙?)
  const users = await listUsers()
  res.json({ ok: true, users: users.map((u) => ({ username: u.username, role: u.role || 'user', createdAt: u.created_at })) })
})

app.post('/api/devices/revoke', requireAdmin, async (req, res) => {
  if (!MULTI_MODE) return badRequest(res, '鍗曠敤鎴锋ā寮忔棤闇€璇ユ帴鍙?)
  const { token } = req.body || {}
  if (!token) return badRequest(res, 'token 涓虹┖')
  await revokeTokenRow(token)
  res.json({ ok: true })
})

app.get('/api/me', requireAuth, async (req, res) => {
  res.json({ ok: true, user: req.user, multi: MULTI_MODE })
})

app.get('/api/status', requireAuth, async (req, res) => {
  const paths = pathsForUser(req.user.username)
  const statuses = await readStatusMap(paths.statusPath)
  res.json({ ok: true, statuses })
})

app.get('/api/themes', requireAuth, async (_req, res) => {
  const themes = Object.entries(THEME_PRESETS).map(([key, val]) => ({ key, name: val.name || key }))
  res.json({ ok: true, themes })
})

app.post('/api/delete', requireAuth, async (req, res) => {
  try {
    const { relativePaths } = req.body || {}
    const list = Array.isArray(relativePaths) ? relativePaths : relativePaths ? [relativePaths] : []
    const targets = []
    for (const rel of list) {
      try {
        const clean = normalizeRel(rel)
        if (isHiddenRel(clean)) continue
        if (!targets.includes(clean)) targets.push(clean)
      } catch {}
    }
    if (targets.length === 0) return badRequest(res, 'relativePaths 涓虹┖鎴栨棤鏁?)
    const paths = pathsForUser(req.user.username)
    await ensureUserDirs(req.user.username)
    const existing = await readStoredNotes(paths.rawDir)
    const keepNotes = []
    const removedFound = []
    for (const note of existing) {
      const rel = normalizeRel(note.relativePath)
      if (targets.includes(rel)) {
        removedFound.push(rel)
      } else {
        keepNotes.push(note)
      }
    }
    if (removedFound.length === 0) return badRequest(res, '鏈壘鍒拌鍒犻櫎鐨勬枃绔?)
    for (const rel of removedFound) {
      const rawPath = path.join(paths.rawDir, rel)
      const encPath = rawPath.replace(/\.(md|markdown|txt)$/i, '.enc.json')
      await fs.remove(rawPath).catch(() => {})
      await fs.remove(encPath).catch(() => {})
      const { outDir } = urlForNote(rel, paths.basePath)
      if (outDir && outDir !== paths.outDir) {
        await fs.remove(outDir).catch(() => {})
      }
    }
    const themeKey = await loadTheme(paths.themePath)
    const config = Object.assign({}, await loadConfig(paths.configPath), { theme: themeKey })
    const rendered = await buildSite(keepNotes, config, paths)
    const statusMap = await updateStatus(rendered, paths.statusPath, removedFound)
    if (MULTI_MODE) await rebuildRootIndex()
    res.json({ ok: true, removed: removedFound, count: rendered.length, statuses: statusMap })
  } catch (e) {
    console.error('[flyshow-server] delete error', e)
    res.status(500).json({ ok: false, message: e?.message || String(e) })
  }
})

app.post('/api/publish', requireAuth, async (req, res) => {
  try {
    const { notes, configText, theme } = req.body || {}
    if (!Array.isArray(notes)) {
      return badRequest(res, 'notes 闇€瑕佹暟缁?)
    }
    const filteredNotes = notes.filter((n) => !isHiddenRel(n.relativePath))
    if (filteredNotes.length === 0) return badRequest(res, '娌℃湁鍙彂甯冪殑绗旇')
    const paths = pathsForUser(req.user.username)
    await ensureUserDirs(req.user.username)
    await persistConfig(configText, paths.configPath)
    const themeKey = await persistTheme(theme, paths.themePath)
    for (const n of filteredNotes) {
      if (n.encrypted && !n.hash) {
        n.hash = hashContent(JSON.stringify({ iv: n.iv, salt: n.salt, ciphertext: n.ciphertext }))
      }
      if (n.encrypted && !n.meta?.date) {
        n.meta = Object.assign({}, n.meta || {}, { date: new Date().toISOString() })
      }
    }
    // 鍚堝苟宸叉湁绗旇锛岄伩鍏嶅彧鍙戝竷鍗曠瘒鏃惰鐩栨棫鍐呭
    const existing = await readStoredNotes(paths.rawDir)
    const mergedMap = new Map()
    for (const n of existing) mergedMap.set(normalizeRel(n.relativePath), n)
    for (const n of filteredNotes) mergedMap.set(normalizeRel(n.relativePath), n)
    const mergedNotes = Array.from(mergedMap.values())

    await saveNotes(mergedNotes, paths.rawDir)
    const config = Object.assign({}, await loadConfig(paths.configPath), { theme: themeKey })
    const rendered = await buildSite(mergedNotes, config, paths)
    const statusMap = await updateStatus(rendered, paths.statusPath)
    if (MULTI_MODE) await rebuildRootIndex()
    res.json({ ok: true, count: mergedNotes.length, statuses: statusMap, siteDir: paths.outDir })
  } catch (e) {
    console.error('[flyshow-server] publish error', e)
    res.status(500).json({ ok: false, message: e?.message || String(e) })
  }
})

app.use((req, res, next) => {
  if (!INSTALLED && req.path === '/') return res.redirect('/install')
  next()
})
app.use('/', express.static(OUTPUT_DIR, { extensions: ['html'] }))

app.listen(PORT, () => {
  console.log(`[flyshow-server] listening on http://localhost:${PORT}`)
  console.log(`[flyshow-server] data dir: ${DATA_DIR}`)
  console.log(`[flyshow-server] site dir: ${OUTPUT_DIR}`)
})
