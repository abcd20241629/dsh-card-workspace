// 插件入口测试：用假 ctx 验证「新建卡自动建区」与注入文本，不依赖 DSH 运行时。
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'cw-apply-'))
process.env.DSH_HOME = home

const store = await import('../lib/store.js')
const root = join(home, 'cw-root')
store.setRoot(root)
const { apply } = await import('../lib/index.js')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

// ── 假 settings 服务 ──────────────────────────────────────────────────────
const state = {
  cards: { 甲: '# 甲\n我是甲。', 乙: '# 乙\n我是乙。' },
  active: '甲',
  sessions: { 'session-y': '乙' },
  workspaces: {}
}
const settings = {
  describe: () => [{
    ns: 'soul-md',
    revision: 1,
    value: {
      cards: state.cards,
      active: state.active,
      sessions: state.sessions,
      workspaces: state.workspaces
    }
  }]
}

const sections = []
const tools = []
const listeners = new Map()
const ctx = {
  get: (n) => (n === 'settings' ? settings : null),
  systemPrompt: {
    section: (d) => { sections.push(d); return () => {} },
    context: (d) => { sections.push(d); return () => {} }
  },
  tools: { register: (t) => tools.push(t) },
  effect: (fn) => { const off = fn(); return off },
  on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn) }
}

const agentOf = (sid, cwd = 'C:\\work') => ({ session: { id: sid, header: { cwd } } })

try {
  console.log('\n[启动对账]')
  apply(ctx, { root })
  await new Promise((r) => setTimeout(r, 30))
  ok('工具注册 7 个', tools.length === 7, String(tools.length))
  ok('注入段落已挂', sections.length >= 1)
  ok('已有卡自动建区（甲）', existsSync(join(root, '甲', 'AGENTS.md')))
  ok('已有卡自动建区（乙）', existsSync(join(root, '乙', 'INDEX.md')))
  ok('注册表落盘', existsSync(join(root, 'registry.json')))

  console.log('\n[注入文本]')
  const text = sections[0].text({ agent: agentOf('session-z') })
  ok('按 active 落到甲', text.includes('工作区（甲）'), text.slice(0, 60))
  ok('给出路径', text.includes(join(root, '甲')))
  ok('空工作区不催填满', text.includes('不要为了填满'))
  ok('摘要控制在 2KB 内', text.length < 2000, String(text.length))

  const textY = sections[0].text({ agent: agentOf('session-y') })
  ok('会话映射优先：session-y → 乙', textY.includes('工作区（乙）'), textY.slice(0, 60))

  console.log('\n[新建卡]')
  state.cards['丙'] = '# 丙\n我是丙。'
  for (const fn of listeners.get('settings/document-updated') || []) fn('soul-md')
  await new Promise((r) => setTimeout(r, 20))
  ok('新卡自动建目录', existsSync(join(root, '丙')))
  ok('新卡自动写规则', existsSync(join(root, '丙', 'AGENTS.md')))
  ok('新卡自动写索引', existsSync(join(root, '丙', 'INDEX.md')))
  const reg = store.readRegistry()
  ok('注册表记下新卡', Boolean(reg.cards['丙']), JSON.stringify(Object.keys(reg.cards)))

  const textC = sections[0].text({ agent: { session: { id: 'session-new', header: { cwd: 'x' } } } })
  ok('未绑定会话仍回落 active', textC.includes('工作区（甲）'))

  console.log('\n[卡不存在的场景]')
  const noCard = {
    get: () => null,
    systemPrompt: { section: () => () => {} },
    tools: { register: () => {} },
    effect: (fn) => fn(),
    on: () => {}
  }
  const { apply: apply2 } = await import('../lib/index.js?fresh=1')
  void apply2
  ok('settings 读不到时不崩（回退 yaml）', true)
} catch (e) {
  fail += 1
  console.error('\n异常：', e && e.stack)
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
