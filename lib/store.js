// lib/store.js — 卡名解析 + 工作区注册表（一卡一目录）
//
// 卡名权威顺序与 soul-md 一致：会话显式选择 > 工作区映射 > active 默认卡。
// 数据优先从 settings 服务读（与设置界面同源），读不到再回退解析 profile 的 cordis.patch.yml。
// 注册表落在工作区根目录，卡名 → 目录名 一旦分配就不再变，卡改名也不搬目录。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export let ROOT_DIR = process.env.CARD_WORKSPACE_ROOT || join(DSH_HOME, 'card-workspaces')
export let REGISTRY_PATH = join(ROOT_DIR, 'registry.json')
export const NS = 'soul-md'

export function diag(msg) {
  try {
    if (!existsSync(ROOT_DIR)) mkdirSync(ROOT_DIR, { recursive: true })
    appendFileSync(join(ROOT_DIR, 'diag.log'), new Date().toISOString() + ' ' + msg + '\n', 'utf8')
  } catch { /* 日志失败不阻塞 */ }
}

// ---------- 卡名解析 ----------

let cache = { at: 0, cfg: null }
const TTL = 800

export function invalidate() { cache = { at: 0, cfg: null } }

/** 换工作区根目录（插件 config.root 或环境变量）。ESM live binding，import 方会跟着变。 */
export function setRoot(dir) {
  if (!dir) return
  ROOT_DIR = dir
  REGISTRY_PATH = join(dir, 'registry.json')
  cache = { at: 0, cfg: null }
}

export function sidOf(agent) {
  try {
    const s = agent && agent.session
    if (s) return String(s.id || s.sessionId || s.key || '')
  } catch { /* ignore */ }
  return ''
}

export function cwdOf(agent) {
  try {
    const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
    return typeof cwd === 'string' && cwd ? cwd : ''
  } catch { /* ignore */ }
  return ''
}

function fromSettings(ctx) {
  try {
    const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
    if (!settings || typeof settings.describe !== 'function') return null
    const raw = settings.describe()
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : [])
    const d = list.find((x) => x && x.ns === NS)
    const v = d && d.value
    if (!v || typeof v !== 'object') return null
    if (!v.cards || typeof v.cards !== 'object') return null
    return {
      active: typeof v.active === 'string' ? v.active : '',
      sessions: v.sessions && typeof v.sessions === 'object' ? v.sessions : {},
      workspaces: v.workspaces && typeof v.workspaces === 'object' ? v.workspaces : {},
      cards: Object.keys(v.cards),
      source: 'settings'
    }
  } catch { return null }
}

// 回退：直接读 profile 的 cordis.patch.yml（memory-core 同款解析）。
function parseYamlBlock(text) {
  const lines = String(text || '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^- id:\s*soul-md\s*$/.test(lines[i])) { start = i; break }
  }
  if (start < 0) return null
  const active = []
  const sessions = {}
  const cards = []
  let mode = ''
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^- id:/.test(line)) break
    let m = line.match(/^\s{2,}active:\s*(.+)$/)
    if (m) { active.push(m[1].trim().replace(/^["']|["']$/g, '')); continue }
    if (/^\s{2,}sessions:\s*$/.test(line)) { mode = 'sessions'; continue }
    if (/^\s{2,}cards:\s*$/.test(line)) { mode = 'cards'; continue }
    if (/^\s{2,}[A-Za-z]/.test(line) && !/^\s{4,}/.test(line)) { mode = ''; continue }
    if (mode === 'sessions') {
      m = line.match(/^\s{6}([^:]+):\s*(.*)$/)
      if (m && /^session-[A-Za-z0-9_-]+$/.test(m[1].trim())) {
        sessions[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    } else if (mode === 'cards') {
      m = line.match(/^\s{6}(\S.*?):\s*\|?\s*$/)
      if (m) cards.push(m[1].trim())
    }
  }
  return { active: active[0] || '', sessions, cards }
}

function fromYaml() {
  const out = { active: '', sessions: {}, workspaces: {}, cards: [], source: 'yaml' }
  const profilesDir = join(DSH_HOME, 'profiles')
  try {
    for (const p of readdirSync(profilesDir)) {
      const file = join(profilesDir, p, 'cordis.patch.yml')
      if (!existsSync(file)) continue
      const block = parseYamlBlock(readFileSync(file, 'utf8'))
      if (!block) continue
      if (!out.active && block.active) out.active = block.active
      Object.assign(out.sessions, block.sessions)
      for (const c of block.cards) if (!out.cards.includes(c)) out.cards.push(c)
    }
  } catch { /* 没有 profile 目录就算了 */ }
  return out
}

export function readCfg(ctx) {
  const now = Date.now()
  if (cache.cfg && now - cache.at < TTL) return cache.cfg
  let cfg = fromSettings(ctx)
  const y = fromYaml()
  if (cfg) {
    // settings 与磁盘可能短暂不同步：卡集合取并集，别漏掉刚建的卡
    for (const c of y.cards) if (!cfg.cards.includes(c)) cfg.cards.push(c)
  } else {
    cfg = y
  }
  cfg.cardSet = new Set(cfg.cards.filter((c) => c && c !== 'none'))
  cache = { at: now, cfg }
  return cfg
}

function pickSession(sessions, sid) {
  if (!sid) return undefined
  const key = String(sid).replace(/^session-/, '')
  for (const [k, v] of Object.entries(sessions || {})) {
    if (k === sid || String(k).replace(/^session-/, '') === key) return v
  }
  return undefined
}

/** 这一轮在扮演哪张卡；空字符串 = 没有卡。 */
export function cardOf(ctx, agent) {
  const cfg = readCfg(ctx)
  const choice = pickSession(cfg.sessions, sidOf(agent))
  if (choice === 'none') return ''
  if (typeof choice === 'string' && choice && cfg.cardSet.has(choice)) return choice
  const cwd = cwdOf(agent)
  if (cwd) {
    const lc = String(cwd).toLowerCase()
    for (const [k, v] of Object.entries(cfg.workspaces || {})) {
      if (String(k).toLowerCase() !== lc) continue
      if (v === 'none') return ''
      if (typeof v === 'string' && cfg.cardSet.has(v)) return v
      break
    }
  }
  if (cfg.active && cfg.cardSet.has(cfg.active)) return cfg.active
  return ''
}

/** 所有已知卡（不含 none）。 */
export function allCards(ctx) {
  return [...readCfg(ctx).cardSet]
}

// ---------- 注册表 ----------

export function readRegistry() {
  try {
    const r = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    if (r && typeof r === 'object' && r.cards && typeof r.cards === 'object') return r
  } catch { /* 没有注册表就是空的 */ }
  return { version: 1, cards: {} }
}

function saveRegistry(r) {
  if (!existsSync(ROOT_DIR)) mkdirSync(ROOT_DIR, { recursive: true })
  const tmp = REGISTRY_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(r, null, 2), 'utf8')
  renameSync(tmp, REGISTRY_PATH)
}

/** 卡名 → 目录名：去掉 Windows 非法字符，保留中文可读性。 */
export function slugOf(card) {
  const s = String(card || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 40)
  return s || 'card'
}

function dirTaken(name, exceptCard) {
  const reg = readRegistry()
  for (const [c, v] of Object.entries(reg.cards)) {
    if (c !== exceptCard && v && v.dir === name) return true
  }
  return existsSync(join(ROOT_DIR, name))
}

/** 分配（必要时新建）一张卡的工作区目录。幂等。 */
export function ensureDir(card) {
  if (!card) return ''
  const reg = readRegistry()
  const hit = reg.cards[card]
  if (hit && hit.dir) {
    const p = join(ROOT_DIR, hit.dir)
    if (!existsSync(p)) mkdirSync(p, { recursive: true })
    return p
  }
  const base = slugOf(card)
  let name = base
  for (let i = 2; dirTaken(name, card) && i < 100; i++) name = base + '-' + i
  if (!existsSync(ROOT_DIR)) mkdirSync(ROOT_DIR, { recursive: true })
  const p = join(ROOT_DIR, name)
  mkdirSync(p, { recursive: true })
  reg.cards[card] = { dir: name, createdAt: new Date().toISOString() }
  saveRegistry(reg)
  diag('新建工作区：' + card + ' → ' + p)
  return p
}

/** 只读：卡已注册的目录（不建）。 */
export function dirOf(card) {
  if (!card) return ''
  const hit = readRegistry().cards[card]
  return hit && hit.dir ? join(ROOT_DIR, hit.dir) : ''
}