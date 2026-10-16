# assistant 扩展（openchamber-assistant）

assistant 三件套的 OpenChamber 扩展：**派单联动 + 设置 + 守卫统计**。

- **联动（核心）**：轮询本地服务发现当前会话的新子代理子会话 → 自动 `openSession` 弹出（可关；20s 内只跳第一个，其余不抢跳；会话不存在则静默跳过）
- **设置**：6 个可调项（总开关 / 联动 / 豁免词 / 每轮池 / 会话总额 / 豁免轮次上限）+ 本会话「整场放行」按钮，写 `~/.config/opencode/assistant.json`
- **统计**：拦截 / 派单 / 豁免 + 最近一条拦截（数据来自插件的 `assistant-counts.json`，1.5s 轮询）
- **Work Status 区块**：子代理数量 + 「打开最新」一键跳（兜底通道）

## 结构

- `panel/`：侧栏面板（联动监听 + 设置表单 + 统计 + 子代理列表）
- `status/`：Work Status 区块（一键跳）
- `service/`：本地服务（全部文件 IO 都在这里）——
  - 读 `~/.local/share/opencode/opencode.db`（`session_v2`，按 `parent_id` 找子会话；default chat 也可见）
  - 读 `~/.config/opencode/assistant-counts.json`、写 `~/.config/opencode/assistant.json`（原子写）
  - 写 `~/.config/opencode/assistant-panel.jsonl`（面板行为日志，联调排障用）

## 安装

1. 把本目录放到 `~/.config/openchamber/extensions/assistant/`
2. 在 OpenChamber「设置 → 扩展」里启用并批准一次授权（`sessions` + `service`）
3. 侧栏出现「assistant 守卫」面板；把面板放在 rail 上保持挂载即可（折叠不影响监听）

依赖运行中的 OpenCode（插件侧 assistant guard 在 `~/.config/opencode/plugins/assistant.ts`）。

## 构建

```sh
npm install        # 或复用别处的 node_modules
npm run build      # 产出 panel/main.js、status/main.js、service/main.js
```

没有本包 node_modules 时可用环境变量指路：

```sh
OPENCHAMBER_SDK_NODE_MODULES=/path/to/node_modules node build.mjs
```

## 服务路由

| 路由 | 说明 |
| --- | --- |
| `GET /health` | 就绪探针 |
| `GET /snapshot?sessionId=` | 配置 + 统计 + 子会话列表 + 整场放行状态 |
| `POST /config` | 保存设置（与现有文件合并，原子写） |
| `POST /exempt` | 本会话整场放行开 / 关 |
| `POST /panellog` | 面板行为日志（写 `assistant-panel.jsonl`） |

## 已知限制

- 服务轮询量级 1–2s；无事件推送
- `default chat` 会话对 `onSessions` 不可见（所以走 service 读库）
- `openSession` 是「切过去看」，连续调用只最后一个生效
- 子代理极短命（创建即结束）时可能 `NO_SESSION`，静默跳过
