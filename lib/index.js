// dsh-card-workspace — 一张人设卡一个本地工作区
//
// 做三件事：
//   1. 卡 → 目录：跟着 soul-md 的卡自动注册 DSH_HOME/card-workspaces/<卡>，新卡随时补建
//   2. 告诉卡：把「工作区在哪、能放什么、怎么找文件」注入到该卡的提示词里
//   3. 给工具：workspace_status / list / read / write / search / move / remove
//
// 设计边界：工作区是工作台，不是记忆库。记忆仍归 memory-core。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ROOT_DIR, NS, cardOf, allCards, ensureDir, diag, invalidate, sidOf, setRoot
} from './store.js'
import { agentsMd, indexMd, brief } from './rules.js'
import * as ws from './workspace.js'

export const name = 'card-workspace'
export const inject = ['systemPrompt', 'tools']

const SECTION = 'card-workspace'
const ORDER = 0.62

// ── 卡 → 目录（带缓存；settings 变化时清空）──────────────────────────────
const dirCache = new Map()

function seed(dir, card) {
  if (!existsSync(dir)) return
  const a = join(dir, 'AGENTS.md')
  const i = join(dir, 'INDEX.md')
  try {
    if (!existsSync(a)) {
      writeFileSync(a, agentsMd(card, dir), 'utf8')
      diag('初始化规则文件：' + a)
    }
    if (!existsSync(i)) writeFileSync(i, indexMd(card), 'utf8')
  } catch (e) {
    diag('初始化工作区失败：' + (e && e.message))
  }
}

function dirFor(card) {
  if (!card) return ''
  const hit = dirCache.get(card)
  if (hit && existsSync(hit)) return hit
  const d = ensureDir(card)
  if (d) {
    seed(d, card)
    dirCache.set(card, d)
  }
  return d
}

function topDirsOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch { return [] }
}

function quickFileCount(dir, cap = 60) {
  let n = 0
  const walk = (d, depth) => {
    if (n >= cap) return
    let list
    try { list = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      if (n >= cap) return
      if (e.isDirectory()) {
        if (depth < 4 && e.name !== '.git' && e.name !== 'node_modules') walk(join(d, e.name), depth + 1)
      } else {
        n += 1
      }
    }
  }
  walk(dir, 0)
  return n
}

function readIndex(dir) {
  try {
    const p = join(dir, 'INDEX.md')
    if (!existsSync(p)) return ''
    const st = statSync(p)
    if (st.size > 64 * 1024) return readFileSync(p, 'utf8').slice(0, 4096)
    return readFileSync(p, 'utf8')
  } catch { return '' }
}

/** 渲染注入文本。任何异常都不能让提示词组装炸掉。 */
function render(assembly) {
  try {
    const agent = assembly && assembly.agent
    const card = cardOf(agentCtx, agent)
    if (!card) return ''
    const dir = dirFor(card)
    if (!dir) return ''
    const indexText = readIndex(dir)
    const hasIndex = indexText.trim().length > 0
    const fileCount = hasIndex ? 0 : quickFileCount(dir)
    return brief(card, dir, indexText, topDirsOf(dir), fileCount)
  } catch (e) {
    diag('渲染工作区摘要失败：' + (e && e.message))
    return ''
  }
}

let agentCtx = null

// ── 工具 ─────────────────────────────────────────────────────────────────

function defineTool(def) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(def.parameters || {})) {
    const p = { type: v.type, description: v.description }
    if (v.items) p.items = v.items
    properties[k] = p
    if (v.required) required.push(k)
  }
  return {
    name: def.name,
    description: def.description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: def.schema || { type: 'object' },
      render: (_a, v) => [{ type: 'text', text: (v && v.text) || JSON.stringify(v) }]
    },
    execute: def.execute
  }
}

function contextOf(exec) {
  const agent = exec && (exec.agent || exec.caller)
  const card = cardOf(agentCtx, agent)
  if (!card) return { card: '', dir: '', error: '这个会话没有绑定人设卡，所以没有工作区。先用 /soul 选一张卡。' }
  const dir = dirFor(card)
  if (!dir) return { card, dir: '', error: '工作区目录创建失败，看 ' + join(ROOT_DIR, 'diag.log') }
  return { card, dir }
}

const tools = [
  defineTool({
    name: 'workspace_status',
    description: '看这张卡自己的工作区：路径、文件数、顶层目录、INDEX.md 是否过期、结构是否乱。开工前或定期体检用。',
    parameters: {},
    async execute(_args, exec) {
      const { card, dir, error } = contextOf(exec)
      if (error) return { text: '✗ ' + error }
      const st = ws.status(dir, card)
      let text = '📁 ' + card + ' 的工作区\n' + st.text
      if (st.hasIndex && !st.indexStale) {
        try { text += '\n\nINDEX.md 前几行：\n' + readFileSync(join(dir, 'INDEX.md'), 'utf8').slice(0, 400) } catch { /* ignore */ }
      }
      return { text }
    }
  }),
  defineTool({
    name: 'workspace_list',
    description: '列工作区目录结构（最多 200 项，默认 3 层）。只在 INDEX.md 和 workspace_search 都没找到时才用，别一上来就全量列。',
    parameters: {
      path: { type: 'string', description: '子目录或文件，留空 = 工作区根。' },
      depth: { type: 'number', description: '展开层数，默认 3，最大 6。' }
    },
    async execute(args, exec) {
      const { dir, error } = contextOf(exec)
      if (error) return { text: '✗ ' + error }
      try {
        const d = Math.min(Math.max(1, Number(args.depth) || 3), 6)
        const r = ws.list(dir, args.path || '', d)
        return { text: r.text }
      } catch (e) { return { text: '✗ ' + e.message } }
    }
  }),
  defineTool({
    name: 'workspace_read',
    description: '读工作区里的一个文件。默认前 200 行；大文件用 offset/limit 分段读，不要一次读完。',
    parameters: {
      path: { type: 'string', required: true, description: '相对工作区的路径，如 日历/2026-11.md' },
      offset: { type: 'number', description: '起始行（1 起），默认 1。' },
      limit: { type: 'number', description: '最多读多少行，默认 200，上限 400。' }
    },
    async execute(args, exec) {
      const { dir, error } = contextOf(exec)
      if (error) return { text: '✗ ' + error }
      try {
        const r = ws.read(dir, args.path, args.offset, args.limit)
        return { text: r.text + (r.total > 1 ? `\n\n（文件：${r.path}）` : '') }
      } catch (e) { return { text: '✗ ' + e.message } }
    }
  }),
  defineTool({
    name: 'workspace_write',
    description: '写/追加工作区文件（自动建父目录）。写的是工作文件：日程、清单、项目状态、资料、脚本。对话原文和情绪别往这写，那些走 memory_*。写完记得同步 INDEX.md。',
    parameters: {
      path: { type: 'string', required: true, description: '相对工作区的路径，如 项目/晚睡改造.md' },
      content: { type: 'string', required: true, description: '完整内容（mode=write 时是覆盖，append 时是追加）。' },
      mode: { type: 'string', description: 'write（默认，覆盖）或 append（追加）。' }
    },
    async execute(args, exec) {
      const { dir, error } = contextOf(exec)
      if (error) return { text: '✗ ' + error }
      try {
        if (typeof args.content !== 'string') return { text: '✗ 缺 content' }
        const mode = args.mode === 'append' ? 'append' : 'write'
        const r = ws.write(dir, args.path, args.content, mode)
        let text = `✓ ${mode === 'append' ? '追加' : '写入'} ${r.path}（${r.bytes} 字节）`
        if (r.hints.length) text += '\n' + r.hints.map((h) => '· ' + h).join('\n')
        return { text }
      } catch (e) { return { text: '✗ ' + e.message } }
    }
  }),
  defineTool({
    name: 'workspace_search',
    description: '在工作区里按关键词找文件内容：多个词用空格分隔（全部命中才算）。只回命中的文件和行，不把整个工作区塞进上下文。找不到再考虑 workspace_list。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词，空格分隔' },
      path: { type: 'string', description: '限定在某个子目录里搜，留空 = 全工作区' },
      maxHits: { type: 'number', description: '最多返回多少条命中，默认 30，上限 60' }
    },
    async execute(args, exec) {
      const { dir, error } = contextOf(exec)
      if (error) return { text: '✗ ' + error }
      try {
        const max = Math.min(Math.max(1, Number(args.maxHits) || 30), 60)
        const r = ws.search(dir, args.query, args.path || '', max)
        if (!r.hits.length) {
          return { text: `没有命中「${args.query}」（扫描 ${r.scanned}/${r.files} 个文本文件）。换个词，或 workspace_list 看结构。` }
        }
        const lines = r.hits.map((h) => `${h.file}:${h.line}  ${h.text}`)
        return { text: `命中 ${r.hits.length} 条（扫描 ${r.scanned}/${r.files} 个文本文件）：\n` + lines.join('\n') }
      } catch (e) { return { text: '✗ ' + e.message } }
    }
  }),
  defineTool({
    name: 'workspace_move',
    description: '移动或改名工作区里的文件/目录。归档用：把过时的移进 _archive/。',
    parameters: {
      from: { type: 'string', required: true, description: '源路径' },
      to: { type: 'string', required: true, description: '目标路径' }
    },
    async execute(args, exec) {
      const { dir, error } = contextOf(exec)
      if (error) return { text: '✗ ' + error }
      try {
        const r = ws.move(dir, args.from, args.to)
        return { text: `✓ ${r.from} → ${r.to}\n记得同步 INDEX.md` }
      } catch (e) { return { text: '✗ ' + e.message } }
    }
  }),
  defineTool({
    name: 'workspace_remove',
    description: '删工作区里的一个文件（AGENTS.md 不能删）。删之前想清楚：能归档就先 workspace_move 到 _archive/。删完同步 INDEX.md。',
    parameters: {
      path: { type: 'string', required: true, description: '相对工作区的路径' }
    },
    async execute(args, exec) {
      const { dir, error } = contextOf(exec)
      if (error) return { text: '✗ ' + error }
      try {
        const r = ws.remove(dir, args.path)
        return { text: `✓ 已删除 ${r.path}\n记得同步 INDEX.md` }
      } catch (e) { return { text: '✗ ' + e.message } }
    }
  })
]

// ── 入口 ─────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  if (config && typeof config.root === 'string' && config.root.trim()) setRoot(config.root.trim())
  agentCtx = ctx

  ctx.effect(() => {
    const off = ctx.systemPrompt.section({
      name: SECTION,
      order: ORDER,
      interpolate: false,
      text: render
    })
    return () => { if (typeof off === 'function') off() }
  }, 'card-workspace.section()')

  // 卡集合变化（新建卡 / 改名 / 删卡）→ 清缓存，给新卡补目录
  const reconcile = () => {
    dirCache.clear()
    invalidate()
    try {
      for (const card of allCards(ctx)) {
        const d = dirFor(card)
        if (d) seed(d, card)
      }
    } catch (e) { diag('对账失败：' + (e && e.message)) }
  }

  try {
    ctx.on('settings/document-updated', (id) => {
      if (id === NS) reconcile()
    })
  } catch (e) { diag('挂 settings 监听失败：' + (e && e.message)) }

  try {
    ctx.on('agent/created', () => { try { reconcile() } catch { /* ignore */ } })
  } catch { /* 没有这个事件也能靠 settings 监听 */ }

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const t of tools) {
      try { ctx.tools.register(t) } catch (e) { diag('注册工具失败 ' + t.name + '：' + (e && e.message)) }
    }
  }

  // 启动即对账一次（等 settings 服务就绪）
  queueMicrotask(() => { try { reconcile() } catch { /* ignore */ } })
}
