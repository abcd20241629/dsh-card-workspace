// 离线冒烟测试：不依赖 DSH，直接跑 store / workspace / rules。
// 用临时目录当 DSH_HOME，跑完删掉。
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'cw-test-'))
process.env.DSH_HOME = home

const store = await import('../lib/store.js')
const ws = await import('../lib/workspace.js')
const rules = await import('../lib/rules.js')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}
function section(t) { console.log('\n[' + t + ']') }

try {
  section('目录分配')
  const d1 = store.ensureDir('大肥鱼')
  ok('首张卡拿到目录', existsSync(d1), d1)
  ok('目录名保留中文', d1.endsWith('大肥鱼'), d1)
  const d1b = store.ensureDir('大肥鱼')
  ok('幂等：同一张卡同目录', d1 === d1b)
  const d2 = store.ensureDir('a/b')
  const d3 = store.ensureDir('a:b')
  ok('非法字符被替换', d2.endsWith('a_b'), d2)
  ok('冲突自动加后缀', d3.endsWith('a_b-2'), d3)
  const d4 = store.ensureDir('  ..隐藏  ')
  ok('首尾点被剥掉', !/\\.\\.隐藏|^\\./.test(d4), d4)
  ok('空白卡名给默认名', store.slugOf('   ') === 'card', store.slugOf('   '))
  ok('超长卡名截断', store.slugOf('长'.repeat(100)).length <= 40)

  section('路径防护')
  ok('正常子路径放行', ws.resolveInside(d1, 'a/b.md').startsWith(d1))
  let threw = false
  try { ws.resolveInside(d1, '../外面.txt') } catch { threw = true }
  ok('.. 越界被拒', threw)
  threw = false
  try { ws.resolveInside(d1, 'C:\\Windows\\x.txt') } catch { threw = true }
  ok('绝对路径被拒', threw)

  section('文件读写')
  const w = ws.write(d1, '日历/2026-11.md', '# 十一月\n11-05 主人 21:30 开会\n11-11 交表\n')
  ok('写入自动建父目录', existsSync(join(d1, '日历', '2026-11.md')))
  ok('字节数正确', w.bytes > 0, String(w.bytes))
  ws.write(d1, '项目/晚睡改造.md', '- 目标 23:30\n- 卡在刷手机\n')
  const r = ws.read(d1, '日历/2026-11.md')
  ok('读回内容', r.text.includes('11-11 交表'), r.text.slice(0, 40))
  ok('行数统计', r.total === 4, String(r.total))
  const part = ws.read(d1, '日历/2026-11.md', 2, 1)
  ok('offset/limit 生效', part.text.startsWith('11-05') && part.total === 4, part.text)
  threw = false
  try { ws.write(d1, 'AGENTS.md', '改规则') } catch { threw = true }
  ok('AGENTS.md 写保护', threw)
  ws.write(d1, '杂项.txt', 'x')
  const wr = ws.write(d1, '杂项2.txt', 'y')
  ok('根目录卫生提示', wr.hints.some((h) => h.includes('根目录')), JSON.stringify(wr.hints))

  section('搜索')
  const s1 = ws.search(d1, '主人 开会')
  ok('多词 AND 命中', s1.hits.length === 1 && s1.hits[0].line === 2, JSON.stringify(s1.hits))
  const s2 = ws.search(d1, '不存在的词xyz')
  ok('无命中返回空', s2.hits.length === 0)
  const s3 = ws.search(d1, '刷手机', '项目')
  ok('限定子目录', s3.hits.length === 1 && s3.hits[0].file.startsWith('项目/'), JSON.stringify(s3.hits))

  section('列目录 / 状态')
  const ls = ws.list(d1)
  ok('列出子目录与文件', ls.text.includes('日历/') && ls.text.includes('晚睡改造.md'), ls.text.slice(0, 80))
  const st = ws.status(d1, '大肥鱼')
  ok('统计文件数', st.files === 4, String(st.files))
  ok('缺 INDEX 会报', st.hasIndex === false)
  ok('根目录脏会报', st.rootFiles.length === 2, JSON.stringify(st.rootFiles))

  section('移动 / 删除')
  ws.write(d1, 'INDEX.md', '# 索引\n- 日历/2026-11.md — 日程\n')
  const mv = ws.move(d1, '杂项.txt', '_archive/杂项.txt')
  ok('移动成功', existsSync(join(d1, '_archive', '杂项.txt')))
  ok('移动返回相对路径', mv.to === '_archive/杂项.txt', mv.to)
  ws.remove(d1, '杂项2.txt')
  ok('删除成功', !existsSync(join(d1, '杂项2.txt')))
  threw = false
  try { ws.remove(d1, 'AGENTS.md') } catch { threw = true }
  ok('AGENTS.md 不能删', threw)

  section('规则文本')
  const md = rules.agentsMd('大肥鱼', d1)
  ok('AGENTS.md 含路径', md.includes(d1))
  ok('AGENTS.md 强调不是记忆库', md.includes('不是记忆库'))
  ok('AGENTS.md 含检索顺序', md.includes('workspace_search'))
  ok('AGENTS.md 含不放什么', md.includes('不放什么'))
  const b1 = rules.brief('大肥鱼', d1, '# 索引\n- 日历/2026-11.md — 日程\n', ['日历'], 0)
  ok('摘要带 INDEX', b1.includes('日历/2026-11.md'))
  ok('摘要短', b1.length < 2000, String(b1.length))
  const b2 = rules.brief('大肥鱼', d1, '（还没有文件）', ['日历'], 5)
  ok('无索引但已有文件时提醒补', b2.includes('5 个文件'))
  const b3 = rules.brief('大肥鱼', d1, '', [], 0)
  ok('空工作区不催填满', b3.includes('不要为了填满'))

  section('注册表')
  const reg = store.readRegistry()
  ok('注册表记录了卡', Object.keys(reg.cards).length === 4, JSON.stringify(Object.keys(reg.cards)))
  ok('dirOf 只读', store.dirOf('大肥鱼') === d1)
  ok('未注册卡 dirOf 为空', store.dirOf('没有这张卡') === '')
} catch (e) {
  fail += 1
  console.error('\n测试脚本异常：', e && e.stack)
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
