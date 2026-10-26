# scout-agent-prompt

OpenCode「scout」子代理的**定义文件**：提示词正文 + 权限白名单（就是 `~/.config/opencode/agents/scout.md` 的副本）。

## 安装

```sh
cp scout-agent-prompt/scout.md ~/.config/opencode/agents/scout.md
```

（OpenChamber 的「智能体」页面也能查看/逐条修改这份文件的权限块。）

## 内容

- **frontmatter**：模型 `opencode/deepseek-v4.1-flash-free#high`、`mode: subagent`、24 步预算、权限表
  - shell 白名单：`*` 拒 → `ls` / `stat` / `pwd` / `wc` / `file` / `which` / `date` / `git status` / `git log --oneline` + `rg` / `jq` / `dbq` / `dust` / `procs` / `head` / `tail` / `ss` / `lsof` / `strings` / `xxd` 允许 → `*>*`（重定向）与 `*--pre*`（`rg --pre` 起子进程后门）拒
  - 禁：`edit` / `patch` / `subagent` / `skill` / `chrome-devtools` / `openchamber_web` / `openchamber_memory` / `openchamber_notify` / `openchamber_render`
  - 允：`read` / `glob` / `grep` / `webfetch` / `websearch` / `external_directory` / `question` / `openchamber` / `openchamber_knowledge`
- **正文**：自我介绍 → 最高原则（回传必须精简）→ 工具调用（禁用清单 / 工具分工 / shell 纪律 / execute 只写笔记 / 输出量纪律）→ 命令速查 → 怎么查 → 写笔记 → 提问 → 怎么回（两种回复模板）

## 依赖

- 提示词里的 `dbq` 是本目录自带的只读 SQLite 助手（`dbq`，node 脚本，用 `node:sqlite` 以 `readOnly` 打开、只收一条 SELECT；`--tables` 看表、`--limit N` 限量）。安装：`install -m 0755 scout-agent-prompt/dbq ~/.local/bin/`（需要 node ≥ 22，本机 v24）。没装它时只有那条速查项不可用，其余不受影响。
- 白名单里的命令需本机存在：`rg` / `jq` / `dust` / `procs` / `ss` / `lsof` / `strings` / `xxd`。多数发行版自带 `ss` / `lsof` / `strings` / `xxd`；`dust`、`procs` 可从 GitHub release 下载预编译二进制放进 `~/.local/bin`。

## 设计意图

- **只读查证代理**：能读、能检索、能跑只读命令、能搜抓网页；不改代码、不写文件（重定向被 `*>*` 锁死）。
- **两道闸分工**：硬卡在 `plugin/`（plan 场次分类 + 额度，被拦会收到"派 scout"的引导文案）；提示词这一层负责"怎么查、别把噪音带回来"。
- **兜底是回主代理**：白名单外没有万能壳（不给解释器），拿不到的命令就写进结论交给主代理跑。
