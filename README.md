# opencode-assistant-agent

OpenCode「assistant 子代理」三件套：让主代理把查证类工作稳定交给 `assistant` 子代理的机械约束与联动。

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| `plugin/` | OpenCode 插件（守卫）：分类拦截 + 额度 + 豁免 + 计数 | ✅ v0.1（已实测） |
| `SKILL/` | OpenCode skill：「assistant 派单工作流」 | ✅ 已落地（2026-10-16） |
| `openchamber-extension/` | OpenChamber 扩展：派单联动（自动弹子会话）+ 设置面板 | ✅ 已落地（2026-10-16） |

## plugin/assistant.ts

按会话模式生效（每次工具调用先读事件里的 `agent`）：

- **plan 场次**：全类别守卫
  - 放行池（每轮 3 次）：`read`（≤30KB 或段读）、`glob`、`webfetch`（明确 URL）、轻量只读 shell（`ls` / `stat` / `pwd` / `wc` / `file` / `which` / `date` / `git status` / 限长 `git log --oneline`）
  - 直接拒（不占额度）：`grep`、`websearch`、日志类读取、大文件整读、含管道 / 重定向 / 解释器 / 命令替换的 shell、`curl`/`wget`
  - 施工类（npm / make / git push…）：拒绝并提示切 build
- **build 场次**：只守「网」（`websearch` / `webfetch` / 浏览器工具），额度内放行、超限拒绝；其余工具完全不拦、不计数
- **子会话**（`assistant` / `general` 等）：永不拦截
- 被拦时返回引导文案「派 assistant 子代理」；同类连续拦截 3 次后文案收敛为「勿重试」

计数与豁免：

- 会话总额：读 30 / 网 10 / 命令 12；豁免词 `#nocap`（整轮豁免，上限 5 轮）
- 计数落在 OpenCode plugin storage（按 sessionID，write-through，先自增占坑）
- 审计事件：`~/.config/opencode/assistant-events.jsonl`
- 面板快照：`~/.config/opencode/assistant-counts.json`
- 配置：`~/.config/opencode/assistant.json`（示例见 `plugin/assistant.json.example`）

安装：

```sh
cp plugin/assistant.ts ~/.config/opencode/plugins/
cp plugin/assistant.json.example ~/.config/opencode/assistant.json   # 可选
cp -r SKILL/assistant ~/.config/opencode/skills/                     # skill，id: assistant
```

## openchamber-extension/

OpenChamber 扩展「assistant 守卫」（panel + service）：

- **panel**：守卫统计一行（拦截 / 派单 / 豁免 + 最近一次拦截）、本会话子代理列表（点按跳转）、设置（总开关 / 联动开关 / 豁免词 / 每轮池 / 会话总额 / 豁免轮次上限 + 整场放行按钮）
- **service**：读 OpenCode 库（`session_v2` 按 `parent_id`）秒级发现本会话新建子会话 → panel 自动 `openSession` 跳转（只跳第一个新鲜子会话；节流 20s；联动开关可关；`NO_SESSION` 静默跳过）
- **statusSection**：「一键跳最新子代理」兜底入口
- 已实测（2026-10-16）：子代理创建后约 0.4s 自动弹出并成功跳转（`auto.open` → `open.ok` → `session.changed`）

安装：OpenChamber → 设置 → 扩展 →「添加」，粘贴本仓库 `openchamber-extension` 目录的本地路径，批准 `sessions` + `service` 两项能力。

构建（产物已随仓库提交，重建才需要）：`node build.mjs`，依赖 esbuild（见目录内 README）。

设计文档在本地：`assistant-suite-plan.md`。
