# dsh-card-workspace

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的人设卡配一个**自己的本地工作区**。

一张卡 = 一个文件夹。卡能知道自己工作区在哪、该往里放什么、怎么在文件变多以后快速找到东西。
记忆仍然归 `dsh-memory-core`：工作区是**工作台**，不是记忆库。

---

## 它解决什么问题

`soul-md` 给了每张卡一套人设和一段「模拟真人」的记忆：会遗忘、会淡忘、只留改变过自己反应的事。
这适合做人，不适合做事——管家要存的固定日程、项目要记的进度、脚本要放的产出，都不该被"遗忘机制"处理掉。

但直接给卡一个文件夹也不行，会变成两个坑：

- 它把工作区当记忆库，什么都往里丢；
- 每次对话把整个文件夹塞进上下文，或者反过来什么都找不到。

这个插件的全部工作，就是把「一个文件夹」变成「一个会用文件夹的人」：

| 问题 | 做法 |
| --- | --- |
| 工作区在哪 | 卡被激活时自动注册 `DSH_HOME/card-workspaces/<卡名>/` |
| 怎么用 | 每张卡一份 `AGENTS.md` 完整规则 + 每回合一段短摘要注入提示词 |
| 文件多了怎么找 | `INDEX.md` 索引 + `workspace_search` 只回命中行，禁止全量读/列 |
| 别当存储中心 | 规则里写死「放什么/不放什么」，工具在写文件时给结构提醒 |
| 谁管 | 每张卡只读写自己的目录，路径逃逸在工具层被拒绝 |

## 安装

```bash
# 从源码目录装配（开发时）
dev_inject_plugin("D:\\dsh\\plugins\\dsh-card-workspace")

# 或作为 bundle 装进 profile
dev_install_package("D:\\dsh\\plugins\\dsh-card-workspace")
```

插件没有构建步骤、没有运行时依赖，`lib/index.js` 就是入口。

## 工作区长什么样

首次启用时自动生成：

```
D:\dsh\.dsh\card-workspaces\
├─ registry.json          # 卡名 → 目录名（分配后不再变）
├─ diag.log               # 出问题看这里
├─ 大肥鱼\
│  ├─ AGENTS.md           # 规则（插件维护，卡不可改写）
│  ├─ INDEX.md            # 索引（卡自己维护）
│  ├─ 日历\
│  └─ 项目\
└─ 薇斯纳\
   ├─ AGENTS.md
   └─ INDEX.md
```

新建卡（soul-md 里加一张）→ 几秒内自动补目录、写规则，不需要重启。

## 规则是怎么定的

四条例题（来自实际需求）：

1. **放要牢牢记住的工作文件**——但不是记忆。发生过的事进 `memory_*`；要反复查的资料、进行中的状态、自己产出的文件进工作区。
2. **结构有条理**——根目录只放 `AGENTS.md` + `INDEX.md`，子目录 ≤ 7 个，文件名带信息。
3. **文件多了要能快速定位**——先读 `INDEX.md`，再 `workspace_search`，只读命中的那一段。工具层不做全量注入。
4. **不是数据存储中心**——不放对话原文、情绪、一次性内容、安装包、密钥；不确定的先别留。

完整规则写在每张卡的 `AGENTS.md` 里（模板见 `lib/rules.js`），每回合注入的是它的短摘要 + `INDEX.md` 现状，
**不注入文件树**：文件一变就改提示前缀，既刷屏又破坏缓存。

## 工具

| 工具 | 用途 |
| --- | --- |
| `workspace_status` | 路径、文件数、顶层目录、INDEX 是否过期、根目录是否脏 |
| `workspace_list` | 列目录（默认 3 层，≤200 项），找不到东西时才用 |
| `workspace_read` | 读文件，默认 200 行，大文件用 `offset`/`limit` |
| `workspace_write` | 写/追加，自动建父目录，返回结构提醒 |
| `workspace_search` | 多关键词 AND 检索，只回 `文件:行` 与命中行 |
| `workspace_move` | 移动/改名，归档到 `_archive/` 用 |
| `workspace_remove` | 删文件（`AGENTS.md` 不可删） |

所有路径都锁在卡自己的工作区内：`..`、绝对路径、跨卡访问会被拒绝。

## 配置

工作在默认位置 `DSH_HOME/card-workspaces`。换根目录：

```yaml
- id: card-workspace
  name: dsh-card-workspace
  config:
    root: 'D:\somewhere\else'
```

## 与其它插件的关系

- `soul-md`：卡的来源。插件读它的 settings 命名空间（`cards`/`active`/`sessions`/`workspaces`），
  卡名解析顺序与它一致：会话显式选择 > 工作区映射 > `active`。
- `memory-core`：记忆的归属。本插件不碰记忆库，也不复用它的存储。
- `bili-life` 等后台会话：只要 session 绑了卡，就有工作区，不受前台会话限制。

## 开发

```bash
node tests/smoke.mjs   # 40 项离线断言，用临时 DSH_HOME，不碰真实数据
```

## License

MIT
