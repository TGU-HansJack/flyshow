// Flyshow 发布插件：将 flyMD 笔记按目录结构发布为数字花园
const SETTINGS_KEY = 'flyshow:settings'
const STATUS_KEY = 'flyshow:statuses'
const PANEL_ID = 'flyshow-panel'
const LOCAL_CONFIG_FILE = 'config.mjs'

const DEFAULT_SETTINGS = {
  serverUrl: '',
  username: '',
  password: '',
  publishDrafts: false,
  accessToken: '',
  deviceName: 'flymd-plugin'
}

const DEFAULT_CONFIG_TEXT = `export default {
  siteTitle: '我的数字花园',
  author: 'flyshow',
  description: '用 flyMD 构建的数字花园',
  nav: [
    { label: '首页', href: '/' },
    { label: '全部笔记', href: '/index' }
  ],
  footer: 'Powered by flyMD + flyshow'
}
`

let ctxRef = null
let settingsCache = { ...DEFAULT_SETTINGS }
let statusCache = {}
let panelEl = null
let settingsEl = null
let activeFilter = 'all'
let cachedItems = []
let cachedStats = { published: 0, pending: 0, unpublished: 0, total: 0 }

function resolveUrlPath(raw) {
  const base = (settingsCache.serverUrl || '').replace(/\/+$/, '')
  const url = String(raw || '').trim()
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  if (!base) return url
  return base + (url.startsWith('/') ? url : `/${url}`)
}

function profileKey() {
  return `${settingsCache.serverUrl || ''}::${settingsCache.username || ''}`
}

function isHiddenPath(rel) {
  const parts = String(rel || '').split(/[\\/]/).filter(Boolean)
  return parts.some((p) => p.startsWith('.'))
}

function pathSep(p) {
  return p && p.includes('\\') ? '\\' : '/'
}
function joinPath(a, b) {
  const s = pathSep(a || '')
  return (a.endsWith(s) ? a : a + s) + b
}
function relPath(root, abs) {
  const base = String(root || '').replace(/[\\/]+$/, '')
  let t = String(abs || '')
  const low = t.toLowerCase()
  const lowBase = base.toLowerCase()
  if (low.startsWith(lowBase)) t = t.slice(base.length)
  const s = pathSep(base)
  if (t.startsWith(s)) t = t.slice(1)
  return t.replace(/\\/g, '/')
}

function ensureStyles() {
  if (document.getElementById('flyshow-styles')) return
  const style = document.createElement('style')
  style.id = 'flyshow-styles'
  style.textContent = `
    :root { --fly-font: 'Inter','Plus Jakarta Sans','Segoe UI',system-ui,-apple-system,sans-serif; --fly-border:#e5e7eb; --fly-bg:#f8fafc; --fly-card:#ffffff; --fly-muted:#6b7280; --fly-strong:#0f172a; --fly-shadow:0 18px 40px rgba(15,23,42,0.14); }
    .flyshow-mask { position: fixed; inset: 0; background: rgba(0,0,0,.18); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .flyshow-panel { width: min(1180px, 94vw); max-height: 88vh; background: var(--fly-card); color: var(--fly-strong); border: 1px solid var(--fly-border); border-radius: 14px; box-shadow: var(--fly-shadow); display: flex; flex-direction: column; font-family: var(--fly-font); overflow: hidden; }
    .flyshow-header { padding: 16px 20px; display: flex; justify-content: space-between; gap: 12px; align-items: center; border-bottom: 1px solid var(--fly-border); background: #fff; }
    .flyshow-title { font-size: 20px; font-weight: 700; letter-spacing: 0.2px; }
    .flyshow-sub { color: var(--fly-muted); font-size: 12px; margin-top: 4px; white-space: nowrap; }
    .flyshow-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .flyshow-btn { padding: 8px 12px; border-radius: 10px; border: 1px solid var(--fly-border); background: transparent; color: var(--fly-strong); cursor: pointer; font-weight: 600; white-space: nowrap; transition: background .15s ease, box-shadow .15s ease, border-color .15s ease, transform .15s ease; }
    .flyshow-btn:hover { background: #fff; border-color: #d1d5db; box-shadow: 0 8px 20px rgba(0,0,0,0.06); transform: translateY(-1px); }
    .flyshow-btn.primary { background: #0f172a; border-color: #0f172a; color: #fff; }
    .flyshow-btn.primary:hover { box-shadow: 0 10px 24px rgba(15,23,42,0.22); }
    .flyshow-btn:disabled { opacity: 0.6; cursor: not-allowed; box-shadow: none; transform: none; }
    .flyshow-body { padding: 16px 18px 20px; overflow: auto; flex: 1; background: var(--fly-bg); }
    .flyshow-summary { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .flyshow-chip { padding: 8px 10px; border-radius: 10px; background: #fff; border: 1px solid var(--fly-border); font-size: 12px; color: var(--fly-muted); white-space: nowrap; transition: box-shadow .15s ease, border-color .15s ease, background .15s ease; }
    .flyshow-chip:hover { border-color: #d1d5db; box-shadow: 0 6px 16px rgba(0,0,0,0.06); }
    .flyshow-chip strong { color: var(--fly-strong); margin-right: 4px; }
    .flyshow-chip[data-filter] { cursor: pointer; user-select: none; }
    .flyshow-chip[data-filter].is-active { background: #0f172a; color: #fff; border-color: #0f172a; box-shadow: 0 10px 24px rgba(15,23,42,0.22); }
    .flyshow-chip[data-filter].is-active strong { color: #fff; }
    .flyshow-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid var(--fly-border); border-radius: 10px; overflow: hidden; }
    .flyshow-table th, .flyshow-table td { padding: 10px 8px; border-bottom: 1px solid var(--fly-border); text-align: left; vertical-align: middle; line-height: 1.5; }
    .flyshow-table th { background: #f9fafb; color: var(--fly-strong); font-weight: 600; white-space: nowrap; }
    .flyshow-table td:first-child, .flyshow-table td:last-child { white-space: nowrap; }
    .flyshow-table td:nth-child(2) { white-space: normal; }
    .flyshow-table td:nth-child(3), .flyshow-table td:nth-child(4) { white-space: normal; word-break: break-word; }
    .flyshow-table tr:last-child td { border-bottom: none; }
    .flyshow-status-tag { padding: 4px 8px; border-radius: 8px; font-weight: 600; font-size: 12px; display: inline-block; border:1px solid var(--fly-border); background: #fff; white-space: nowrap; }
    .flyshow-status-published { background: #f0fdf4; color: #166534; border-color: #bbf7d0; }
    .flyshow-status-pending { background: #fff7ed; color: #b45309; border-color: #fed7aa; }
    .flyshow-status-unpublished { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
    .flyshow-empty { text-align: center; color: var(--fly-muted); padding: 20px 0; }
    .flyshow-settings { width: 520px; max-width: 92vw; background: var(--fly-card); border: 1px solid var(--fly-border); border-radius: 12px; padding: 18px; box-shadow: var(--fly-shadow); color: var(--fly-strong); font-family: var(--fly-font); box-sizing: border-box; }
    .flyshow-settings * { box-sizing: border-box; }
    .flyshow-field { margin-bottom: 12px; }
    .flyshow-field label { display: block; margin-bottom: 6px; color: var(--fly-strong); font-size: 13px; font-weight: 600; }
    .flyshow-field input, .flyshow-field select { width: 100%; max-width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--fly-border); background: #fff; color: var(--fly-strong); transition: border-color .15s ease, box-shadow .15s ease; }
    .flyshow-field input:focus, .flyshow-field select:focus { outline: none; border-color: #94a3b8; box-shadow: 0 6px 18px rgba(0,0,0,0.06); }
    .flyshow-field small { color: var(--fly-muted); display: block; margin-top: 4px; }
    .flyshow-btn.danger { border-color: #fecaca; background: #fff7f7; color: #b91c1c; }
    .flyshow-btn.danger:hover { background: #fee2e2; border-color: #fca5a5; box-shadow: 0 8px 20px rgba(248,113,113,0.2); color: #7f1d1d; }
    .flyshow-modal { width: min(760px, 94vw); max-height: 90vh; background: var(--fly-card); border: 1px solid var(--fly-border); border-radius: 12px; padding: 16px; box-shadow: var(--fly-shadow); overflow-y: auto; overflow-x: hidden; box-sizing: border-box; }
    .flyshow-modal * { box-sizing: border-box; }
    .flyshow-modal h3 { margin: 0 0 8px; font-size: 16px; }
    .flyshow-textarea { width: 100%; min-height: 160px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; border-radius: 8px; border: 1px solid var(--fly-border); padding: 10px 12px; resize: vertical; background: #fff; color: var(--fly-strong); }
    .flyshow-confirm { width: min(380px, 94vw); background: var(--fly-card); border: 1px solid var(--fly-border); border-radius: 12px; padding: 16px; box-shadow: var(--fly-shadow); }
    .flyshow-confirm-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
    .flyshow-hint { color: var(--fly-muted); font-size: 12px; }
    .flyshow-modal input, .flyshow-modal select { width: 100%; max-width: 100%; box-sizing: border-box; }
  `
  document.head.appendChild(style)
}

async function loadSettings(context) {
  let stored = null
  try { stored = await context?.storage?.get('settings') } catch {}
  if (!stored) {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) stored = JSON.parse(raw)
    } catch {}
  }
  if (stored && typeof stored === 'object') {
    delete stored.theme
    delete stored.configPath
  }
  return Object.assign({}, DEFAULT_SETTINGS, stored || {})
}

async function saveSettings(context, next) {
  const cleanNext = Object.assign({}, next || {})
  delete cleanNext.theme
  delete cleanNext.configPath
  const payload = Object.assign({}, DEFAULT_SETTINGS, cleanNext)
  settingsCache = payload
  try { await context?.storage?.set('settings', payload) } catch {}
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload)) } catch {}
  return payload
}

async function loadStatuses(context) {
  let stored = null
  try { stored = await context?.storage?.get('statuses') } catch {}
  if (!stored) {
    try {
      const raw = localStorage.getItem(STATUS_KEY)
      if (raw) stored = JSON.parse(raw)
    } catch {}
  }
  const key = profileKey()
  const all = stored && typeof stored === 'object' ? stored : {}
  const maybeFlat = Object.keys(all).some((k) => k.includes('/'))
  statusCache = all[key] || (maybeFlat ? all : {})
  return statusCache
}

async function saveStatuses(context) {
  const key = profileKey()
  let all = {}
  try { all = (await context?.storage?.get('statuses')) || {} } catch {}
  all[key] = statusCache
  try { await context?.storage?.set('statuses', all) } catch {}
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(all)) } catch {}
}

async function readText(context, path) {
  const p = String(path || '').trim()
  if (!p) throw new Error('路径为空')
  if (context?.readTextFile) return await context.readTextFile(p)
  return await context.invoke('read_text_file_any', { path: p })
}

async function writeText(context, path, content) {
  const p = String(path || '').trim()
  if (!p) throw new Error('路径为空')
  if (context?.writeTextFile) return await context.writeTextFile(p, String(content ?? ''))
  return await context.invoke('write_text_file_any', { path: p, content: String(content ?? '') })
}

async function ensureConfigFile(context, root) {
  const cfgRel = LOCAL_CONFIG_FILE
  const cfgPath = joinPath(root.replace(/[\\/]+$/, ''), cfgRel)
  try {
    const text = await readText(context, cfgPath)
    if (text && text.trim()) return text
  } catch {}
  await writeText(context, cfgPath, DEFAULT_CONFIG_TEXT)
  return DEFAULT_CONFIG_TEXT
}

async function computeHash(content) {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
      const buf = new TextEncoder().encode(String(content || ''))
      const hash = await crypto.subtle.digest('SHA-256', buf)
      return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {}
  return String(content || '').length + ':' + (String(content || '').slice(0, 16) || '')
}

function bufToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || [])
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  if (typeof btoa === 'function') return btoa(binary)
  return Buffer.from(binary, 'binary').toString('base64')
}

async function encryptNoteContent(note, password) {
  if (!password) throw new Error('需要密钥')
  if (!note || !note.content) throw new Error('缺少内容')
  if (!crypto?.subtle) throw new Error('当前环境不支持加密')
  const encoder = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(String(password)), { name: 'PBKDF2' }, false, ['deriveKey'])
  const aesKey = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoder.encode(String(note.content)))
  const ciphertext = bufToB64(new Uint8Array(cipherBuf))
  const payload = {
    encrypted: true,
    ciphertext,
    iv: bufToB64(iv),
    salt: bufToB64(salt),
    meta: {
      author: settingsCache.username || settingsCache.deviceName || 'user',
      category: '',
      date: new Date().toISOString()
    },
    // 保持明文 hash，避免本地笔记 hash 与远端记录不一致被判定为“待更新”
    hash: note.hash || (await computeHash(note.content)),
    mtime: Date.now()
  }
  // 保留本地明文内容用于写回 front matter 与状态比对；发送时会在 publishNotes 里清空 content
  return Object.assign({}, note, payload)
}

function splitFrontMatter(content) {
  const text = String(content || '')
  if (!text.startsWith('---')) return { frontMatter: '', body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { frontMatter: '', body: text }
  const frontMatter = text.slice(3, end).trim()
  const body = text.slice(end + 4).replace(/^\s*\n/, '')
  return { frontMatter, body }
}

function frontMatterValue(frontMatter, key) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi')
  const m = String(frontMatter || '').match(re)
  return m && m[1] ? m[1].trim() : ''
}

function upsertFrontMatterField(frontMatter, key, value) {
  if (value === undefined || value === null || value === '') return String(frontMatter || '').trim()
  const lines = String(frontMatter || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
  let found = false
  const next = lines.map((line) => {
    const m = line.match(/^([^:]+):\s*(.*)$/)
    if (m && m[1].trim() === key) {
      found = true
      return `${key}: ${value}`
    }
    return line
  })
  if (!found) next.push(`${key}: ${value}`)
  return next.join('\n')
}

function removeFrontMatterField(frontMatter, key) {
  const lines = String(frontMatter || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
  const out = []
  let skipping = false
  const keyRe = new RegExp(`^\\s*${key}\\s*:`)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isKey = keyRe.test(line)
    const isNewKey = /^\s*[A-Za-z0-9_-]+\s*:/.test(line)
    if (!skipping && isKey) {
      skipping = true
      continue
    }
    if (skipping) {
      if (isNewKey) {
        skipping = false
      } else if (/^\s*-\s+/.test(line) || /^\s*$/.test(line)) {
        continue
      } else {
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n').trim()
}

function upsertFrontMatterList(frontMatter, key, items) {
  const list = (items || []).map((i) => String(i || '').trim()).filter(Boolean)
  let next = removeFrontMatterField(frontMatter, key)
  if (!list.length) return next
  const block = `${key}:\n${list.map((v) => `  - ${v}`).join('\n')}`
  if (!next) return block
  return `${next}\n${block}`
}

function parseFrontMatterList(frontMatter, key) {
  const lines = String(frontMatter || '').split(/\r?\n/)
  const keyRe = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`)
  const out = []
  let collecting = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!collecting) {
      const m = line.match(keyRe)
      if (m) {
        const inline = (m[1] || '').trim()
        if (inline) {
          if (/^\[.*\]$/.test(inline)) {
            inline
              .replace(/^\[/, '')
              .replace(/\]$/, '')
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
              .forEach((t) => out.push(t))
          } else {
            out.push(inline.replace(/^['"]|['"]$/g, ''))
          }
          break
        }
        collecting = true
      }
    } else {
      if (/^\s*[A-Za-z0-9_-]+\s*:/.test(line)) break
      const m = line.match(/^\s*-\s+(.+)$/)
      if (m && m[1]) out.push(m[1].trim())
    }
  }
  return out
}

function datetimeLocalFromIso(val) {
  if (!val) return ''
  const d = new Date(val)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function mergeFrontMatterAndBody(frontMatter, body) {
  const fm = String(frontMatter || '').trim()
  const cleanBody = String(body || '')
  if (!fm) return cleanBody
  const bodyText = cleanBody.startsWith('\n') ? cleanBody.replace(/^\n+/, '') : cleanBody
  return `---\n${fm}\n---\n${bodyText}`
}

function openFrontMatterEditor(note) {
  if (!note || !note.content || typeof document === 'undefined') return Promise.resolve(note)
  return new Promise((resolve) => {
    ensureStyles()
    const parts = splitFrontMatter(note.content)
    const initialDate = frontMatterValue(parts.frontMatter, 'date') || frontMatterValue(parts.frontMatter, 'publishedAt') || new Date(note.mtime || Date.now()).toISOString()
    const initialTitle = frontMatterValue(parts.frontMatter, 'title') || note.title || guessTitle(note.content, note.relativePath)
    const initialCategory = parseFrontMatterList(parts.frontMatter, 'categories')[0] || frontMatterValue(parts.frontMatter, 'category') || ''
    const tagsList = parseFrontMatterList(parts.frontMatter, 'tags')
    const initialTagsRaw = tagsList.length ? tagsList.join(', ') : frontMatterValue(parts.frontMatter, 'tags') || ''
    const mask = document.createElement('div')
    mask.className = 'flyshow-mask'
    mask.style.zIndex = 10001
    const box = document.createElement('div')
    box.className = 'flyshow-modal'
    box.innerHTML = `
      <h3 style="margin:0 0 8px;">发布设置</h3>
      <div class="flyshow-hint" style="margin-bottom:6px;">${note.relativePath || ''}</div>
      <div class="flyshow-field">
        <label>标题</label>
        <input type="text" name="fmTitle" value="${(initialTitle || '').replace(/"/g, '&quot;')}" placeholder="请输入标题">
      </div>
      <div class="flyshow-field">
        <label>分类</label>
        <input type="text" name="fmCategory" value="${(initialCategory || '').replace(/"/g, '&quot;')}" placeholder="可选，单个分类">
      </div>
      <div class="flyshow-field">
        <label>标签</label>
        <input type="text" name="fmTags" value="${(initialTagsRaw || '').replace(/"/g, '&quot;')}" placeholder="多个以逗号分隔，例如: life, note">
      </div>
      <div class="flyshow-field">
        <label>发布时间</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input type="datetime-local" name="publishDate" style="flex:1;min-width:220px;">
          <button class="flyshow-btn" data-action="now">使用当前时间</button>
        </div>
        <small>保存后写入 front matter 的 date / publishedAt 字段</small>
      </div>
      <div class="flyshow-field">
        <label>加密密钥（可选）</label>
        <input type="password" name="encryptKey" placeholder="留空则不加密，密钥仅本地使用">
        <small>加密后文章内容会在站点中隐藏，需输入密钥解锁。</small>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
        <button class="flyshow-btn" data-action="skip">直接发布</button>
        <button class="flyshow-btn" data-action="cancel">取消</button>
        <button class="flyshow-btn primary" data-action="confirm">保存并发布</button>
      </div>
    `
    mask.appendChild(box)
    document.body.appendChild(mask)
    const dateInput = box.querySelector('input[name="publishDate"]')
    const titleInput = box.querySelector('input[name="fmTitle"]')
    const categoryInput = box.querySelector('input[name="fmCategory"]')
    const tagsInput = box.querySelector('input[name="fmTags"]')
    const encryptInput = box.querySelector('input[name="encryptKey"]')
    const localVal = datetimeLocalFromIso(initialDate)
    if (dateInput && localVal) dateInput.value = localVal
    box.querySelector('[data-action="now"]')?.addEventListener('click', () => {
      if (dateInput) dateInput.value = datetimeLocalFromIso(new Date().toISOString())
    })
    box.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      mask.remove()
      resolve(null)
    })
    box.querySelector('[data-action="skip"]')?.addEventListener('click', () => {
      mask.remove()
      resolve(note)
    })
    box.querySelector('[data-action="confirm"]')?.addEventListener('click', async () => {
      const titleVal = titleInput?.value?.trim() || initialTitle
      const catVal = categoryInput?.value?.trim() || ''
      const tagsVal = tagsInput?.value?.trim() || ''
      const encryptVal = encryptInput?.value || ''
      const dateVal = dateInput?.value || ''
      let iso = ''
      if (dateVal) {
        const d = new Date(dateVal)
        if (!Number.isNaN(d.getTime())) iso = d.toISOString()
      }
      let nextFm = parts.frontMatter || ''
      if (titleVal) nextFm = upsertFrontMatterField(nextFm, 'title', titleVal)
      if (catVal) nextFm = upsertFrontMatterList(nextFm, 'categories', [catVal])
      else nextFm = removeFrontMatterField(nextFm, 'categories')
      if (tagsVal) {
        const tagList = tagsVal.split(',').map((t) => t.trim()).filter(Boolean)
        nextFm = upsertFrontMatterList(nextFm, 'tags', tagList)
      } else {
        nextFm = removeFrontMatterField(nextFm, 'tags')
      }
      if (iso) {
        nextFm = upsertFrontMatterField(nextFm, 'date', iso)
        nextFm = upsertFrontMatterField(nextFm, 'publishedAt', iso)
      }
      const nextContent = mergeFrontMatterAndBody(nextFm, parts.body)
      let nextNote = Object.assign({}, note, {
        content: nextContent,
        title: titleVal || guessTitle(nextContent, note.relativePath),
        hash: await computeHash(nextContent),
        mtime: Date.now()
      })
      if (encryptVal) {
        try {
          nextNote = await encryptNoteContent(nextNote, encryptVal)
        } catch (e) {
          console.warn('[flyshow] encrypt in modal failed', e)
          context?.ui?.notice?.('加密失败：' + (e?.message || String(e)), 'err', 2400)
          return
        }
      }
      mask.remove()
      resolve(nextNote)
    })
  })
}

async function fetchWithContext(context, url, init) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, buildAuthHeaders(), init?.headers || {})
  if (context?.http?.fetch) {
    const res = await context.http.fetch(url, Object.assign({}, init, { headers }))
    const ok = res && (res.ok !== false) && (res.status ? res.status < 400 : true)
    const parseJson = async () => {
      if (typeof res.json === 'function') return await res.json()
      if (res.data !== undefined) {
        if (typeof res.data === 'string') {
          try { return JSON.parse(res.data) } catch { return res.data }
        }
        return res.data
      }
      return null
    }
    return { ok, status: res.status || 200, json: parseJson }
  }
  const res = await fetch(url, Object.assign({}, init, { headers }))
  return {
    ok: res.ok,
    status: res.status,
    json: async () => {
      try { return await res.json() } catch { return null }
    }
  }
}

async function fetchRemoteStatus(context) {
  if (!settingsCache.serverUrl) return null
  const url = settingsCache.serverUrl.replace(/\/+$/, '') + '/api/status'
  try {
    const res = await fetchWithContext(context, url, { method: 'GET' })
    if (!res.ok) return null
    const data = await res.json()
    if (data && data.statuses && typeof data.statuses === 'object') return data.statuses
  } catch (e) {
    console.warn('[flyshow] 远程状态获取失败', e)
  }
  return null
}

function confirmDeleteDialog(relativePath) {
  if (typeof document === 'undefined') return Promise.resolve(true)
  return new Promise((resolve) => {
    ensureStyles()
    const mask = document.createElement('div')
    mask.className = 'flyshow-mask'
    mask.style.zIndex = 10001
    const box = document.createElement('div')
    box.className = 'flyshow-confirm'
    box.innerHTML = `
      <h3 style="margin:0 0 6px;">删除已发布文章</h3>
      <div class="flyshow-hint" style="margin-top:4px;">确定删除 <code>${relativePath}</code> 吗？</div>
      <div class="flyshow-confirm-actions">
        <button class="flyshow-btn" data-action="cancel">取消</button>
        <button class="flyshow-btn danger" data-action="confirm">删除</button>
      </div>
    `
    mask.appendChild(box)
    document.body.appendChild(mask)
    box.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      mask.remove()
      resolve(false)
    })
    box.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
      mask.remove()
      resolve(true)
    })
  })
}

function buildAuthHeaders() {
  const headers = {}
  if (settingsCache.accessToken) {
    headers.Authorization = `Bearer ${settingsCache.accessToken}`
  } else if (settingsCache.username || settingsCache.password) {
    const token = btoa(`${settingsCache.username || ''}:${settingsCache.password || ''}`)
    headers.Authorization = `Basic ${token}`
  }
  return headers
}

async function fetchBinary(url) {
  const res = await fetch(url, { method: 'GET', headers: buildAuthHeaders() })
  if (!res.ok) {
    let reason = ''
    try {
      reason = await res.text()
    } catch {}
    throw new Error(`failed to fetch file: ${res.status} ${reason || ''}`.trim())
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}
async function downloadThemeTemplate(context) {
  if (!settingsCache.serverUrl) {
    context?.ui?.notice?.('请先配置服务器地址', 'err', 2000)
    return
  }
  if (!settingsCache.accessToken && !(settingsCache.username && settingsCache.password)) {
    context?.ui?.notice?.('请先登录或填写账号密码再下载主题', 'err', 2200)
    return
  }
  const url = settingsCache.serverUrl.replace(/\/+$/, '') + '/api/theme/template'
  try {
    const data = await fetchBinary(url)
    const saved = await context.saveFileWithDialog?.({
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
      data,
      defaultName: 'flyshow-theme-template.zip'
    })
    if (saved) {
      context?.ui?.notice?.('主题样板已保存', 'ok', 1800)
    } else {
      context?.ui?.notice?.('已取消保存', 'info', 1600)
    }
  } catch (e) {
    context?.ui?.notice?.('下载主题样板失败：' + (e?.message || String(e)), 'err', 2200)
  }
}

async function importCustomTheme(context) {
  if (!settingsCache.serverUrl) {
    context?.ui?.notice?.('请先配置服务器地址', 'err', 2000)
    return
  }
  if (!settingsCache.accessToken && !(settingsCache.username && settingsCache.password)) {
    context?.ui?.notice?.('请先登录或填写账号密码再导入主题', 'err', 2200)
    return
  }
  const pickResult = await pickZipFile(context)
  if (!pickResult) {
    context?.ui?.notice?.('未选择文件，已取消导入', 'info', 1600)
    return
  }
  let bytes = null
  let displayName = pickResult.name || 'theme.zip'
  try {
    if (pickResult.data) {
      bytes = pickResult.data
    } else if (pickResult.path) {
      bytes = await context.readFileBinary(pickResult.path)
      displayName = pickResult.name || pickResult.path.split(/[\\/]/).pop() || displayName
    }
  } catch (e) {
    context?.ui?.notice?.('读取主题文件失败：' + (e?.message || String(e)), 'err', 2200)
    return
  }
  if (!bytes) {
    context?.ui?.notice?.('未能读取主题文件', 'err', 2000)
    return
  }
  const archive = bufToB64(bytes)
  const url = settingsCache.serverUrl.replace(/\/+$/, '') + '/api/theme/import'
  try {
    const res = await fetchWithContext(context, url, {
      method: 'POST',
      body: JSON.stringify({ archive, name: displayName })
    })
    const data = await res.json()
    if (!res.ok || data?.ok === false) {
      context?.ui?.notice?.('导入失败：' + (data?.message || '服务器未响应'), 'err', 2200)
      return
    }
    context?.ui?.notice?.('前端主题已导入，重新发布后生效', 'ok', 2000)
  } catch (e) {
    context?.ui?.notice?.('导入主题失败：' + (e?.message || String(e)), 'err', 2200)
  }
}

async function pickZipFile(context) {
  if (context?.pickFile) {
    const picked = await context.pickFile({ filters: [{ name: 'ZIP', extensions: ['zip'] }] })
    if (!picked) return null
    return { path: picked, name: picked.split(/[\\/]/).pop() || 'theme.zip' }
  }
  if (typeof document === 'undefined') return null
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip,application/zip'
    input.style.display = 'none'
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0]
      if (!file) {
        resolve(null)
        return
      }
      try {
        const buf = await file.arrayBuffer()
        resolve({ data: new Uint8Array(buf), name: file.name || 'theme.zip' })
      } catch {
        resolve(null)
      } finally {
        input.remove()
      }
    })
    document.body.appendChild(input)
    input.click()
  })
}

async function deleteRemoteNote(context, relativePath) {
  if (!settingsCache.serverUrl) {
    context?.ui?.notice?.('璇峰厛閰嶇疆鏈嶅姟鍣ㄥ湴鍧€', 'err', 2000)
    return false
  }
  const rel = String(relativePath || '').trim()
  if (!rel) return false
  try {
    await ensureToken(context)
  } catch {}
  const url = settingsCache.serverUrl.replace(/\/+$/, '') + '/api/delete'
  try {
    const res = await fetchWithContext(context, url, {
      method: 'POST',
      body: JSON.stringify({ relativePaths: [rel] })
    })
    const data = await res.json()
    if (!res.ok || data?.ok === false) {
      context?.ui?.notice?.('删除失败：' + (data?.message || '未知错误'), 'err', 2600)
      return false
    }
    if (data?.statuses && typeof data.statuses === 'object') {
      statusCache = data.statuses
    } else {
      delete statusCache[rel]
    }
    await saveStatuses(context)
    context?.ui?.notice?.('已删除发布内容', 'ok', 1800)
    return true
  } catch (e) {
    console.warn('[flyshow] delete failed', e)
    context?.ui?.notice?.('删除失败：' + (e?.message || String(e)), 'err', 2600)
    return false
  }
}

async function loginAndSaveToken(context) {
  if (!settingsCache.serverUrl || !settingsCache.username || !settingsCache.password) {
    context?.ui?.notice?.('请先填写服务器地址、用户名和密码', 'err', 2400)
    return null
  }
  const url = settingsCache.serverUrl.replace(/\/+$/, '') + '/api/login'
  const res = await fetchWithContext(context, url, {
    method: 'POST',
    body: JSON.stringify({
      username: settingsCache.username,
      password: settingsCache.password,
      device: settingsCache.deviceName || 'flymd-plugin'
    })
  })
  const data = await res.json()
  if (!res.ok || data?.ok === false || !data?.token) {
    context?.ui?.notice?.('登录失败：' + (data?.message || ''), 'err', 2600)
    return null
  }
  settingsCache.accessToken = data.token
  await saveSettings(context, settingsCache)
  context?.ui?.notice?.('登录成功，token 已保存', 'ok', 2000)
  return data.token
}

async function ensureToken(context) {
  if (settingsCache.accessToken) return settingsCache.accessToken
  return await loginAndSaveToken(context)
}

async function collectAllNotes(context) {
  if (!context?.listLibraryFiles) {
    context?.ui?.notice?.('需要 flyMD 0.6.6-beta+ 才能列出库文件', 'err', 2400)
    return []
  }
  const root = await context.getLibraryRoot()
  if (!root) {
    context?.ui?.notice?.('请先打开一个库，再执行发布', 'err', 2400)
    return []
  }
  const files = await context.listLibraryFiles({ extensions: ['md', 'markdown', 'txt'], recursive: true, includeHidden: false })
  const seen = new Set()
  const notes = []
  for (const f of files) {
    if (isHiddenPath(f.relative)) continue
    if (seen.has(f.relative)) continue
    seen.add(f.relative)
    try {
      const content = await readText(context, f.path)
      const hash = await computeHash(content)
      const title = guessTitle(content, f.relative)
      notes.push({
        path: f.path,
        relativePath: f.relative,
        title,
        hash,
        mtime: f.mtime || Date.now(),
        content
      })
    } catch (e) {
      console.warn('[flyshow] 读取文件失败', f, e)
    }
  }
  return notes
}

async function collectCurrentNote(context) {
  const root = await context.getLibraryRoot()
  const current = context.getCurrentFilePath?.()
  if (!root || !current || !current.startsWith(root)) {
    context?.ui?.notice?.('当前文档未保存或不在库中', 'err', 2200)
    return null
  }
  const rel = relPath(root, current)
  if (isHiddenPath(rel)) {
    context?.ui?.notice?.('当前文档位于隐藏目录，已忽略', 'err', 2200)
    return null
  }
  const content = await readText(context, current)
  return {
    path: current,
    relativePath: rel,
    title: guessTitle(content, rel),
    hash: await computeHash(content),
    mtime: Date.now(),
    content
  }
}

function guessTitle(content, rel) {
  try {
    const m = String(content || '').match(/^#\s+(.+)$/m)
    if (m && m[1]) return m[1].trim()
  } catch {}
  const name = (rel || '').split('/').pop() || ''
  return name.replace(/\.(md|markdown|txt)$/i, '') || '未命名'
}

function calcStatus(note, remoteMap) {
  const rec = statusCache[note.relativePath]
  const remote = remoteMap && remoteMap[note.relativePath]
  let status = 'unpublished'
  if (rec && rec.hash === note.hash) status = 'published'
  else if (!rec && remote && remote.hash === note.hash) status = 'published'
  else if (rec || remote) status = 'pending'
  const url = remote?.url || rec?.url || ''
  return { status, url }
}

async function publishSingleWithFrontMatter(context, note, mode) {
  if (!note) return
  const prepared = await openFrontMatterEditor(note)
  if (!prepared) return
  if (prepared.path && prepared.content) {
    try {
      await writeText(context, prepared.path, prepared.content)
    } catch (e) {
      console.warn('[flyshow] save front matter failed', e)
      context?.ui?.notice?.('保存 Front Matter 失败：' + (e?.message || String(e)), 'err', 2200)
    }
  }
  await publishNotes(context, [prepared], mode)
}

async function publishNotes(context, notes, mode) {
  if (!settingsCache.serverUrl) {
    context?.ui?.notice?.('请先配置服务器地址', 'err', 2400)
    showSettings(context)
    return
  }
  if (!notes || notes.length === 0) {
    context?.ui?.notice?.('没有需要发布的笔记', 'err', 1800)
    return
  }
  const root = await context.getLibraryRoot()
  const configText = root ? await ensureConfigFile(context, root) : DEFAULT_CONFIG_TEXT
  // 优先尝试登录获取 token，失败时继续尝试基础认证以兼容单用户模式
  if (!settingsCache.accessToken) {
    await ensureToken(context)
  }
  let notesToSend = notes.map((n) => {
    const base = {
      relativePath: n.relativePath,
      hash: n.hash,
      mtime: n.mtime,
      title: n.title
    }
    if (n.encrypted) {
      base.encrypted = true
      base.ciphertext = n.ciphertext
      base.iv = n.iv
      base.salt = n.salt
      base.meta = n.meta
      base.content = ''
    } else {
      base.content = n.content
    }
    return base
  })
  const payload = {
    notes: notesToSend,
    configText,
    mode: mode || 'manual',
    client: 'flyshow',
    version: '0.1.0'
  }
  const url = settingsCache.serverUrl.replace(/\/+$/, '') + '/api/publish'
  try {
    const res = await fetchWithContext(context, url, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      context?.ui?.notice?.('发布失败，服务器无响应', 'err', 2600)
      return
    }
    const data = await res.json()
    if (data?.ok === false) {
      context?.ui?.notice?.('发布失败：' + (data?.message || '未知错误'), 'err', 2600)
      return
    }
    const publishedAt = Date.now()
    for (const n of notes) {
      const remoteInfo = data?.statuses?.[n.relativePath] || {}
      statusCache[n.relativePath] = {
        hash: n.hash,
        publishedAt,
        url: resolveUrlPath(remoteInfo.url || statusCache[n.relativePath]?.url || '')
      }
    }
    await saveStatuses(context)
    context?.ui?.notice?.(`已发布 ${notes.length} 篇笔记`, 'ok', 2000)
  } catch (e) {
    console.error('[flyshow] 发布失败', e)
    context?.ui?.notice?.('发布失败：' + (e?.message || String(e)), 'err', 2600)
  }
}

function renderStatusTag(status) {
  if (status === 'published') return '<span class="flyshow-status-tag flyshow-status-published">已发布</span>'
  if (status === 'pending') return '<span class="flyshow-status-tag flyshow-status-pending">待更新</span>'
  return '<span class="flyshow-status-tag flyshow-status-unpublished">未发布</span>'
}

function buildRows(notes, items) {
  const rows = []
  for (const item of items) {
    if (activeFilter !== 'all' && item.status !== activeFilter) continue
    const actions = [`<button class="flyshow-btn" data-action="publish" data-path="${encodeURIComponent(item.relativePath)}">发布</button>`]
    if (item.status === 'published') {
      actions.push(`<button class="flyshow-btn danger" data-action="delete" data-path="${encodeURIComponent(item.relativePath)}">删除</button>`)
    }
    const btn = actions.join(' ')
    const urlHtml = item.displayUrl ? `<a href="${item.displayUrl}" target="_blank">${item.displayUrl}</a>` : ''
    rows.push(
      `<tr>
        <td>${renderStatusTag(item.status)}</td>
        <td>${item.title}</td>
        <td>${item.relativePath}</td>
        <td>${urlHtml}</td>
        <td>${btn}</td>
      </tr>`
    )
  }
  return rows
}

async function refreshPanel(context, opts = {}) {
  if (!panelEl) return
  const useCacheOnly = opts.useCacheOnly === true
  const listEl = panelEl.querySelector('.flyshow-list')
  const summaryEl = panelEl.querySelector('.flyshow-summary')
  if (!useCacheOnly && listEl) listEl.innerHTML = '<div class="flyshow-empty">正在扫描库内笔记…</div>'

  let notes = []
  let remote = null
  let changed = false

  if (useCacheOnly && cachedItems.length) {
    notes = cachedItems.map((i) => i.noteRef)
  } else {
    if (settingsCache.serverUrl) {
      await ensureToken(context)
    }
    notes = await collectAllNotes(context)
    remote = await fetchRemoteStatus(context)
    const stats = { published: 0, pending: 0, unpublished: 0 }
    const items = []
    for (const n of notes) {
      const remoteItem = remote && remote[n.relativePath]
      if (remoteItem && !statusCache[n.relativePath] && remoteItem.hash) {
        statusCache[n.relativePath] = {
          hash: remoteItem.hash,
          publishedAt: remoteItem.updatedAt || Date.now(),
          url: resolveUrlPath(remoteItem.url || '')
        }
        changed = true
      }
      const { status, url } = calcStatus(n, remote)
      stats[status] = (stats[status] || 0) + 1
      items.push({
        status,
        title: n.title,
        relativePath: n.relativePath,
        displayUrl: resolveUrlPath(url),
        noteRef: n
      })
    }
    cachedItems = items
    cachedStats = Object.assign({ total: notes.length }, stats, { total: notes.length })
  }

  const statsToUse = cachedStats
  const rows = buildRows(notes, cachedItems)

  if (summaryEl) {
    summaryEl.innerHTML = `
      <span class="flyshow-chip" data-filter="published"><strong>已发布</strong>${statsToUse.published || 0}</span>
      <span class="flyshow-chip" data-filter="pending"><strong>待更新</strong>${statsToUse.pending || 0}</span>
      <span class="flyshow-chip" data-filter="unpublished"><strong>未发布</strong>${statsToUse.unpublished || 0}</span>
      <span class="flyshow-chip" data-filter="all"><strong>总计</strong>${statsToUse.total || 0}</span>
    `
    summaryEl.querySelectorAll('[data-filter]').forEach((chip) => {
      const key = chip.getAttribute('data-filter')
      chip.classList.toggle('is-active', key === activeFilter)
      chip.addEventListener('click', () => {
        activeFilter = key || 'all'
        refreshPanel(context, { useCacheOnly: true })
      })
    })
  }
  if (listEl) {
    if (rows.length === 0) {
      listEl.innerHTML = '<div class="flyshow-empty">当前库中没有 Markdown 文档</div>'
    } else {
      listEl.innerHTML = `
        <table class="flyshow-table">
          <thead><tr><th>状态</th><th>标题</th><th>相对路径</th><th>URL</th><th>操作</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      `
    }
    listEl.querySelectorAll('button[data-action="publish"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rel = decodeURIComponent(btn.getAttribute('data-path') || '')
        const noteItem = cachedItems.find((i) => i.relativePath === rel)
        const note = noteItem?.noteRef
        if (note) {
          await publishSingleWithFrontMatter(context, note, 'panel-single')
          cachedItems = []
          await refreshPanel(context)
        }
      })
    })
    listEl.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rel = decodeURIComponent(btn.getAttribute('data-path') || '')
        const confirmed = await confirmDeleteDialog(rel)
        if (!confirmed) return
        const ok = await deleteRemoteNote(context, rel)
        if (ok) {
          cachedItems = []
          await refreshPanel(context)
        }
      })
    })
  }
  if (changed) {
    await saveStatuses(context)
  }
}

function openPanel(context) {
  ensureStyles()
  if (panelEl) {
    panelEl.parentElement?.classList.add('flyshow-mask')
    panelEl.parentElement.style.display = 'flex'
    refreshPanel(context)
    return
  }
  const mask = document.createElement('div')
  mask.className = 'flyshow-mask'
  const panel = document.createElement('div')
  panel.className = 'flyshow-panel'
  panel.innerHTML = `
    <div class="flyshow-header">
      <div>
        <div class="flyshow-title">Flyshow 发布面板</div>
        <div class="flyshow-sub">服务器：<span class="flyshow-server"></span></div>
      </div>
      <div class="flyshow-actions">
        <button class="flyshow-btn primary" data-action="publish-pending">发布待更新</button>
        <button class="flyshow-btn" data-action="publish-all">发布全部</button>
        <button class="flyshow-btn" data-action="refresh">刷新</button>
        <button class="flyshow-btn" data-action="settings">设置</button>
        <button class="flyshow-btn" data-action="close">关闭</button>
      </div>
    </div>
    <div class="flyshow-body">
      <div class="flyshow-summary"></div>
      <div class="flyshow-list"></div>
    </div>
  `
  mask.appendChild(panel)
  document.body.appendChild(mask)
  panelEl = panel
  const serverEl = panel.querySelector('.flyshow-server')
  if (serverEl) serverEl.textContent = settingsCache.serverUrl || '未配置'
  panel.querySelector('[data-action="close"]')?.addEventListener('click', () => {
    mask.style.display = 'none'
  })
  panel.querySelector('[data-action="refresh"]')?.addEventListener('click', () => refreshPanel(context))
  panel.querySelector('[data-action="settings"]')?.addEventListener('click', () => showSettings(context))
  panel.querySelector('[data-action="publish-all"]')?.addEventListener('click', async () => {
    const notes = await collectAllNotes(context)
    await publishNotes(context, notes, 'panel-all')
    await refreshPanel(context)
  })
  panel.querySelector('[data-action="publish-pending"]')?.addEventListener('click', async () => {
    const notes = await collectAllNotes(context)
    const targets = notes.filter((n) => {
      const rec = statusCache[n.relativePath]
      return !rec || rec.hash !== n.hash
    })
    await publishNotes(context, targets, 'panel-pending')
    await refreshPanel(context)
  })
  refreshPanel(context)
}

function showSettings(context) {
  ensureStyles()
  const mask = document.createElement('div')
  mask.className = 'flyshow-mask'
  const box = document.createElement('div')
  box.className = 'flyshow-settings'
  box.innerHTML = `
    <h3 style="margin:0 0 8px;">Flyshow 设置</h3>
    <div class="flyshow-field">
      <label>服务器地址</label>
      <input type="text" name="serverUrl" placeholder="例如：https://flyshow.example.com">
      <small>插件会调用 /api/publish 与 /api/status</small>
    </div>
    <div class="flyshow-field">
      <label>账号</label>
      <input type="text" name="username" placeholder="服务器账号">
    </div>
    <div class="flyshow-field">
      <label>密码</label>
      <input type="password" name="password" placeholder="服务器密码">
    </div>
    <div class="flyshow-field">
      <label>设备名</label>
      <input type="text" name="deviceName" placeholder="flymd-plugin">
    </div>
    <div class="flyshow-field">
      <label>前端主题</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="flyshow-btn" data-action="download-template">导出默认主题样板</button>
        <button class="flyshow-btn" data-action="import-theme">导入自定义主题</button>
      </div>
      <small>主题包需包含 index.html/post.html/list-item.html 及 assets 资源。</small>
    </div>
    <div class="flyshow-field">
      <label>当前 token</label>
      <div id="token-view" style="word-break:break-all;color:#a5b4d8;min-height:20px;">${settingsCache.accessToken || '未登录'}</div>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <button class="flyshow-btn" data-action="login-token">获取/刷新 token</button>
        <button class="flyshow-btn" data-action="clear-token">清除 token</button>
      </div>
    </div>
    <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;">
      <button class="flyshow-btn" data-action="cancel">取消</button>
      <button class="flyshow-btn primary" data-action="save">保存</button>
    </div>
  `
  mask.appendChild(box)
  document.body.appendChild(mask)
  settingsEl = mask
  const setVal = (name, val) => {
    const el = box.querySelector(`input[name="${name}"]`)
    if (el) el.value = val || ''
  }
  setVal('serverUrl', settingsCache.serverUrl)
  setVal('username', settingsCache.username)
  setVal('password', settingsCache.password)
  setVal('deviceName', settingsCache.deviceName)
  box.querySelector('[data-action="cancel"]')?.addEventListener('click', () => mask.remove())
  box.querySelector('[data-action="download-template"]')?.addEventListener('click', async () => {
    await downloadThemeTemplate(context)
  })
  box.querySelector('[data-action="import-theme"]')?.addEventListener('click', async () => {
    await importCustomTheme(context)
  })
  box.querySelector('[data-action="login-token"]')?.addEventListener('click', async () => {
    await loginAndSaveToken(context)
    const tokenView = box.querySelector('#token-view')
    if (tokenView) tokenView.textContent = settingsCache.accessToken || '未登录'
  })
  box.querySelector('[data-action="clear-token"]')?.addEventListener('click', async () => {
    settingsCache.accessToken = ''
    await saveSettings(context, settingsCache)
    const tokenView = box.querySelector('#token-view')
    if (tokenView) tokenView.textContent = '未登录'
    context?.ui?.notice?.('token 已清除', 'ok', 1600)
  })
  box.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
    const next = {
      serverUrl: box.querySelector('input[name="serverUrl"]')?.value?.trim() || '',
      username: box.querySelector('input[name="username"]')?.value || '',
      password: box.querySelector('input[name="password"]')?.value || '',
      deviceName: box.querySelector('input[name="deviceName"]')?.value?.trim() || 'flymd-plugin',
      accessToken: settingsCache.accessToken || ''
    }
    await saveSettings(context, next)
    context?.ui?.notice?.('设置已保存', 'ok', 1800)
    mask.remove()
    if (panelEl) {
      const serverEl = panelEl.querySelector('.flyshow-server')
      if (serverEl) serverEl.textContent = settingsCache.serverUrl || '未配置'
    }
  })
}
export async function activate(context) {
  ctxRef = context
  ensureStyles()
  settingsCache = await loadSettings(context)
  await loadStatuses(context)
  context.addMenuItem({
    label: '发布',
    title: '发布到 flyshow',
    children: [
      { label: '发布当前笔记', onClick: async () => {
        const note = await collectCurrentNote(context)
        if (!note) return
        await publishSingleWithFrontMatter(context, note, 'menu-single')
      } },
      { label: '发布全部笔记', onClick: () => collectAllNotes(context).then((notes) => publishNotes(context, notes, 'menu-all')) },
      { type: 'divider' },
      { label: '发布状态面板', onClick: () => openPanel(context) },
      { label: '设置', onClick: () => showSettings(context) }
    ]
  })
}

export function deactivate() {
  try { panelEl?.parentElement?.remove() } catch {}
  try { settingsEl?.remove() } catch {}
}

export function openSettings(context) {
  showSettings(context)
}
