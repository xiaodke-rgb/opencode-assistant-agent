# openchamber-extension（计划中）

OpenChamber 扩展 assistant：面板 + service。

- service：读 `opencode.db` 发现子会话（含 default chat），1–2s 轮询
- panel：自动弹子会话（可关・节流）、设置区（开关 / 豁免词 / 额度等可调项 + 整场放行）、一行守卫统计
- 权限：sessions + service

待扩展 SDK 实现阶段补。
