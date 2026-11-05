// lib/workspace.js — 工作区文件操作：所有路径都锁在卡自己的目录里。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { resolve, sep, join, dirname, extname } from 'node:path'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '__pycache__', '.venv'])
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.py', '.csv', '.tsv', '.html', '.htm', '.css', '.sh', '.ps1', '.bat', '.log', '.ini', '.toml', '.xml', '.sql', '.env', '.gitignore'])
const MAX_READ = 512 * 1024
const MAX_SEARCH_FILE = 1024 * 1024
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export class WorkspaceError extends Error {
  constructor(message) { super(message); this.name = 'WorkspaceError' }
}

/** 把模型给的相对路径钉死在工作区内。 */
export function resolveInside(root, rel) {
  if (!root) throw new WorkspaceError('这张卡还没有工作区')
  const base = resolve(root)
  const want = String(rel == null ? '' : rel).trim()
  if (want.includes('\u0000')) throw new WorkspaceError('路径含非法字符')
  const p = want ? resolve(base, want) : base
  const lowBase = base.toLowerCase()
  const lowP = p.toLowerCase()
  const ok = lowP === lowBase || lowP.startsWith(lowBase + sep) || lowP.startsWith(lowBase + '/')
  if (!ok) throw new WorkspaceError('路径越界：只能访问自己的工作区，不能用 .. 或绝对路径')
  return p
}

export function relOf(root, p) {
  const base = resolve(root)
  const r = p.slice(base.length).replace(/^[\\/]+/, '')
  return r.split(/[\\/]+/).join('/') || '.'
}

function isText(file) {
  const ext = extname(file).toLowerCase()
  if (TEXT_EXT.has(ext)) return true
  if (!ext) return true
  return false
}

function entriesOf(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => {
      if (e.name === 'registry.json' || e.name === 'diag.log') return false
      if (e.isDirectory()) return !SKIP_DIRS.has(e.name.toLowerCase())
      return true
    })
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, 'zh') : a.isDirectory() ? -1 : 1))
}

/** 结构快照：文件、目录、最大 mtime，供 status 与 brief 复用。 */
export function scan(root) {
  const out = { files: [], dirs: [], bytes: 0, maxMtime: 0, topDirs: [] }
  if (!root || !existsSync(root)) return out
  let count = 0
  const walk = (dir, depth) => {
    let list
    try { list = entriesOf(dir) } catch { return }
    for (const e of list) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth === 0) out.topDirs.push(e.name)
        out.dirs.push(relOf(root, p))
        if (depth < 8 && out.dirs.length < 500) walk(p, depth + 1)
      } else {
        count += 1
        if (count > 5000) return
        try {
          const st = statSync(p)
          out.bytes += st.size
          if (st.mtimeMs > out.maxMtime) out.maxMtime = st.mtimeMs
        } catch { /* ignore */ }
        out.files.push(relOf(root, p))
      }
    }
  }
  walk(root, 0)
  return out
}

export function list(root, rel = '', depth = 3) {
  const start = resolveInside(root, rel)
  if (!existsSync(start)) throw new WorkspaceError('没有这个路径：' + (rel || '.'))
  const st = statSync(start)
  if (st.isFile()) return { text: relOf(root, start) + ' 是文件，用 workspace_read 打开', count: 0 }

  const lines = []
  let count = 0
  const walk = (dir, prefix, level) => {
    if (level > depth) { lines.push(prefix + '…（更深，用 workspace_list 指定子目录）'); return }
    let list
    try { list = entriesOf(dir) } catch { return }
    for (const e of list) {
      if (count >= 200) { lines.push('…（还有更多，用 workspace_list 指定子目录）'); return }
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        lines.push(prefix + e.name + '/')
        count += 1
        walk(p, prefix + '  ', level + 1)
      } else {
        let size = 0
        try { size = statSync(p).size } catch { /* ignore */ }
        lines.push(prefix + e.name + (size ? '  (' + Math.max(1, Math.round(size / 1024)) + 'KB)' : ''))
        count += 1
      }
    }
  }
  walk(start, '', 1)
  return { text: lines.join('\n') || '（空）', count }
}

export function read(root, rel, offset = 1, limit = 200) {
  const p = resolveInside(root, rel)
  if (!existsSync(p)) throw new WorkspaceError('文件不存在：' + rel)
  const st = statSync(p)
  if (st.isDirectory()) throw new WorkspaceError(rel + ' 是目录，用 workspace_list')
  if (st.size > MAX_READ) throw new WorkspaceError(`文件 ${Math.round(st.size / 1024)}KB，超过单次读取上限；用 offset/limit 分段读，或先 workspace_search 定位`)
  const raw = readFileSync(p, 'utf8')
  const all = raw.split(/\r?\n/)
  const from = Math.max(1, Number(offset) || 1)
  const take = Math.min(Math.max(1, Number(limit) || 200), 400)
  const slice = all.slice(from - 1, from - 1 + take)
  const tail = from - 1 + take < all.length ? `\n…（共 ${all.length} 行，这里到第 ${from - 1 + take} 行；继续读用 offset=${from + take}）` : ''
  return { text: slice.join('\n') + tail, total: all.length, from, to: from - 1 + slice.length, path: relOf(root, p) }
}

export function write(root, rel, content, mode = 'write') {
  const p = resolveInside(root, rel)
  const name = relOf(root, p)
  if (name.toLowerCase() === 'agents.md' && dirname(p) === resolve(root)) {
    throw new WorkspaceError('AGENTS.md 是本卡的工作区规则，插件与主人维护；要记自己的约定请写 CONVENTIONS.md')
  }
  if (WINDOWS_RESERVED.test(name.split('/').pop())) throw new WorkspaceError('文件名是 Windows 保留名，换一个')
  mkdirSync(dirname(p), { recursive: true })
  const body = String(content == null ? '' : content)
  if (mode === 'append') appendFileSync(p, body, 'utf8')
  else writeFileSync(p, body, 'utf8')
  const hints = []
  const depth = name.split('/').length
  if (depth > 3) hints.push('路径有点深了（超过 3 层），确认结构还找得回来')
  const sc = scan(root)
  const rootFiles = sc.files.filter((f) => !f.includes('/') && f !== 'AGENTS.md' && f !== 'INDEX.md')
  if (rootFiles.length > 0) hints.push('根目录只该放 AGENTS.md 和 INDEX.md，现在还有：' + rootFiles.slice(0, 5).join('、'))
  if (!existsSync(join(resolve(root), 'INDEX.md'))) hints.push('还没有 INDEX.md，建一个并在里面登记这个文件')
  else hints.push('记得把这次改动同步到 INDEX.md')
  return { path: name, bytes: Buffer.byteLength(body, 'utf8'), hints }
}

export function remove(root, rel) {
  const p = resolveInside(root, rel)
  if (!existsSync(p)) throw new WorkspaceError('文件不存在：' + rel)
  const name = relOf(root, p)
  if (name.toLowerCase() === 'agents.md') throw new WorkspaceError('AGENTS.md 不能删')
  const st = statSync(p)
  if (st.isDirectory()) throw new WorkspaceError('不支持删目录；把文件移进 _archive/ 或自己清空')
  unlinkSync(p)
  return { path: name }
}

export function move(root, from, to) {
  const a = resolveInside(root, from)
  const b = resolveInside(root, to)
  if (!existsSync(a)) throw new WorkspaceError('文件不存在：' + from)
  if (existsSync(b)) throw new WorkspaceError('目标已存在：' + to)
  mkdirSync(dirname(b), { recursive: true })
  renameSync(a, b)
  return { from: relOf(root, a), to: relOf(root, b) }
}

export function search(root, query, rel = '', maxHits = 30) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) throw new WorkspaceError('给个关键词')
  const start = resolveInside(root, rel)
  const sc = scan(root)
  const files = sc.files.filter((f) => (rel ? f.toLowerCase().startsWith(relOf(root, start).toLowerCase()) : true))
  const hits = []
  let scanned = 0
  for (const f of files) {
    if (hits.length >= maxHits) break
    const p = join(resolve(root), f)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.size > MAX_SEARCH_FILE || !isText(f)) continue
    let lines
    try { lines = readFileSync(p, 'utf8').split(/\r?\n/) } catch { continue }
    scanned += 1
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase()
      if (!terms.every((t) => low.includes(t))) continue
      hits.push({ file: f, line: i + 1, text: lines[i].trim().slice(0, 160) })
      if (hits.length >= maxHits) break
    }
  }
  return { hits, scanned, files: files.length }
}

export function status(root, card) {
  if (!root) return { empty: true, text: '这张卡还没有工作区（插件没注册成功，或卡刚建还没对账）' }
  const sc = scan(root)
  const indexPath = join(root, 'INDEX.md')
  const hasIndex = existsSync(indexPath)
  const indexMtime = hasIndex ? statSync(indexPath).mtimeMs : 0
  const rootFiles = sc.files.filter((f) => !f.includes('/') && f !== 'AGENTS.md' && f !== 'INDEX.md')
  const lines = [
    `卡：${card}`,
    `路径：${root}`,
    `文件：${sc.files.length} 个，共 ${(sc.bytes / 1024).toFixed(1)} KB；目录：${sc.dirs.length} 个`,
    `顶层：${sc.topDirs.length ? sc.topDirs.join('、') : '（无子目录）'}`,
    `INDEX.md：${hasIndex ? (sc.maxMtime > indexMtime + 2000 ? '存在，但比最新文件旧——该更新了' : '存在，是新的') : '缺！工作区没有索引就找不到东西'}`,
    sc.files.length > 30 ? '规模：已超过 30 个文件，找东西只能靠 INDEX.md + workspace_search' : ''
  ].filter(Boolean)
  if (rootFiles.length) lines.push(`根目录卫生：只该放 AGENTS.md 和 INDEX.md，现在多了 ${rootFiles.slice(0, 8).join('、')}`)
  return { empty: false, path: root, files: sc.files.length, dirs: sc.dirs.length, bytes: sc.bytes, hasIndex, indexStale: hasIndex && sc.maxMtime > indexMtime + 2000, rootFiles, topDirs: sc.topDirs, text: lines.join('\n') }
}