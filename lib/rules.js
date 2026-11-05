// lib/rules.js — 工作区规则文本：AGENTS.md（完整版，落到卡的工作区里）
//                    与注入摘要（每回合渲染，必须短，且不要列实时文件树）

export const TEMPLATE_VERSION = 1

export function agentsMd(card, dir) {
  const today = new Date().toISOString().slice(0, 10)
  return `# ${card} 的工作区

路径：\`${dir}\`
建立：${today}

这是「${card}」自己的工作台。不是记忆库，也不是备份盘。

## 记忆在别处

发生过什么、谁是谁、喜欢什么、讨厌什么——那是记忆库的事（\`memory_remember\` / \`memory_recall\` / \`memory_search\`）。
这里只放**做事要用的东西**：让下一次的自己少想一步的、稳定的、可复用的文件。

## 放什么

- 固定不变的资料：主人的日程、常用地址、固定流程、模板、对接口令
- 进行中的事：做到哪一步、下一步做什么、在等谁回话
- 自己产出的文件：清单、表格、脚本、草稿、抓下来的素材（用完归档）
- 需要精确记住、不能靠印象复述的东西：数字、日期、路径、账号名（不要密码值）

## 不放什么

- 对话原文、情绪、关系、回忆 → 那是记忆库
- 一次性的问答结果、随手贴的网页 → 用完就删
- 安装包、大视频、下载堆 → 系统临时目录，别往这搬
- 密码、密钥明文 → 真要记，只记位置和用途

## 结构

- 根目录只放两样：\`AGENTS.md\`（本规则，不要改）、\`INDEX.md\`（索引，必须维护）
- 子目录不超过 7 个，名字直白：\`日历/\`、\`项目/\`、\`资料/\`、\`脚本/\`、\`产出/\`、\`_inbox/\`、\`_archive/\`
- 每层再分时按主题，不按时间堆
- 文件名要带信息：\`2026-11-05_主人行程.md\`，不要 \`新建文档1.md\`
- 一张纸能说清的事不建目录；超过 5 个文件再分目录

## INDEX.md 是索引，不是目录树

每个目录一节，一行一个文件，写「它解决什么问题」：

\`\`\`
## 日历/
- 2026-11.md — 主人这个月的固定安排与临时变动
## 项目/
- 晚睡改造.md — 进行中：目标 23:30 前睡，卡在刷手机
\`\`\`

新增、改名、删除文件后，顺手改 INDEX.md 对应那行。这一步不能省——「以后快速找到文件」全靠它。

## 找东西的顺序（省上下文）

1. 读 \`INDEX.md\`
2. 没找到 → \`workspace_search "关键词"\`，它只回命中的文件和行
3. 命中了 → \`workspace_read 那个文件\`（可带 offset/limit 只读一段）
4. 还找不到 → \`workspace_list\` 看结构

**不要**每次对话先把整个工作区读一遍，也不要一上来就全量列目录。

## 维护

- 每个月（或主人提起来时）：过时的移进 \`_archive/\`，不要删；INDEX.md 同步
- \`workspace_status\` 会告诉你：文件总数、根目录乱不乱、INDEX 是否比文件旧
- 文件超过 30 个之后，INDEX + search 是唯一可行的找法

## 边界

- 只改自己的工作区。要动工作区以外的东西，先问主人
- 主人说「记下来」时先判断：是记忆还是文件？发生过的事进记忆，要反复查的资料进工作区
- 不确定该不该留的东西，先别留；留了就要能说清它在 INDEX 的哪一行
`
}

export function indexMd(card) {
  return `# 索引

> ${card} 的工作区索引。每个文件一行，写它解决什么问题。新增、改名、删除后同步这里。

（还没有文件）
`
}

/**
 * 每回合注入的摘要。
 * 刻意不列文件树：文件一变就会改动提示前缀，破坏缓存；且刷屏。
 * 只给「在哪 / 怎么用 / 索引现状」。
 */
export function brief(card, dir, indexText, topDirs, fileCount) {
  const rules = [
    '工作台，不是记忆库。记忆（人/事/情绪）仍走 memory_*；这里放做事要用的文件：日程、清单、项目状态、资料、脚本。',
    '- 根目录只放 AGENTS.md 和 INDEX.md，子目录 ≤7 个，文件名写清是什么',
    '- 放：固定资料、进行中状态、自己产出的文件；不放：对话原文、情绪、一次性内容、安装包、密钥',
    '- 找文件：读 INDEX.md → workspace_search → 只读命中的那一段；不要全量读、不要一上来全量列',
    '- 增删改文件后同步 INDEX.md；过时的移进 _archive/，不删',
    '- 工具：workspace_status / workspace_list / workspace_read / workspace_write / workspace_search'
  ].join('\n')

  const lines = [
    `## 工作区（${card}）`,
    `路径：\`${dir}\``,
    rules,
    `完整规则：\`${dir}\\AGENTS.md\``
  ]

  const idx = String(indexText || '').trim()
  if (idx && !/^（还没有文件）$/m.test(idx)) {
    const clip = idx.length > 1200 ? idx.slice(0, 1200) + '\n…（索引更长，需要时直接 workspace_read INDEX.md）' : idx
    lines.push('', 'INDEX.md 现状：', '```', clip, '```')
  } else if (fileCount > 0) {
    lines.push('', `还没有 INDEX.md，但工作区已有 ${fileCount} 个文件——尽快补上索引，顶层：${topDirs.join('、') || '（无子目录）'}`)
  } else {
    lines.push('', '工作区刚建好，还是空的。等第一件真要用文件记住的事出现再往里放，不要为了填满它而写东西。')
  }

  return lines.join('\n')
}