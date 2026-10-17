# assistant 扩展（openchamber-assistant）

assistant 三件套的 OpenChamber 扩展：**设置面板 + 守卫统计**（无后台服务）。

- **设置**分两块：assistant 沙箱（总开关，关掉后 plan / build 直查不再拦截，沙箱仍生效）；直查额度（plan 计读/网/命令，build 只计网；豁免词 / 每轮直查额度（次）/ 会话总额（读·网·命令）/ 豁免轮次上限，外加本会话「整场放行」按钮——按钮下方显示**当前绑定会话**：标题 + id 尾号）
  → 面板直接用宿主的 filesystem 能力读写 `~/.config/opencode/assistant.json`（宿主原子写，无服务、无轮询进程）
- **统计**：三行小字——本会话直查拦截 / 派单 / 豁免、沙箱状态（bwrap 可用性）与沙箱拦截、直查余额；都算**面板绑定的这个会话**（沙箱拦截由插件记到子代理的父会话，fork / 新对话从零起）
  - `本会话：拦截 / 派单 / 豁免 + 最近一条拦截`
  - `余额：读 x/30 · 网 x/10 · 命令 x/12 · 豁免 x/5`（剩余/上限，上限取设置里的值）
  - 数据来自插件写的 `~/.config/opencode/assistant-counts.json`（v2 按会话分片；5s 刷新）

> **联动暂缓（2026-10-16）**：OpenChamber 2.3.3 内部**已有**「子代理会话开在侧栏 chat 标签」的原生实现
> （`openContextPanelTab(dir, { mode: "chat", dedupeKey: "session:<id>", readOnly: true })`，入口是聊天里的子任务卡片和
> Work Status 的子代理行；宽屏布局才走侧栏，窄屏/移动端/pinned/isVSCode 会降级成切主视图），
> 但**没有任何外部触发通道**（控制事件 / 扩展 SDK / 深链都没有）。上游加一个和 `file-open` 同级的控制事件后，本扩展再加回自动联动。

## 结构

- `panel/`：侧栏面板（本会话统计 + 沙箱状态 + 余额三行 + 两块设置表单 + 整场放行）
- `package.json`：manifest 在 `openchamber` 块里（panel id `assistant`，能力 `sessions` + `filesystem`）
- `build.mjs`：esbuild 打包 `panel/main.ts` → `panel/main.js`
- `icon.svg` / `LICENSE` / `tsconfig.json`

## 安装

1. OpenChamber「设置 → 扩展 → 添加」，粘贴本目录路径
2. 批准能力：`sessions`（读当前会话 id，供「整场放行」）+ `filesystem`（读写 `assistant.json`、读 `assistant-counts.json`）
3. 侧栏出现「assistant 守卫」面板

依赖运行中的 OpenCode（插件侧 guard 在 `~/.config/opencode/plugins/assistant.ts`）。

## 构建

```sh
node build.mjs     # 产物已随仓库提交，重建才需要
```

没有本包 `node_modules` 时：

```sh
OPENCHAMBER_SDK_NODE_MODULES=/path/to/node_modules node build.mjs
```

## 已知限制

- 统计 5s 轮询（面板折叠后仍挂载，照跑）；数据文件很小，开销可忽略
- 配置文件只有面板这一个写者（插件只读），无双写者冲突
- 「整场放行」按会话 id 记录，写在同一份 `assistant.json` 的 `exemptSessions` 里；面板绑定宿主当前打开的会话（切会话 / fork 后绑定跟着变，按钮下方有显示）
- 统计**按会话分片**存在 `assistant-counts.json`（v2，保留最近 60 个会话）；插件落盘"先重读再取 max"，多个插件实例并发写也不会把数字盖小
