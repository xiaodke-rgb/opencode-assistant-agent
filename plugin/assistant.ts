// assistant — OpenCode v2 plugin: hard guard for the assistant-delegation flow.
// Design doc: assistant-suite-plan.md §5.
//   plan sessions  = every category is guarded (read/search/web/light commands + quota).
//   build sessions = only web search/fetch is guarded (quota; over-limit -> reject + delegate).
//   subagent sessions (agent=assistant/general/...) are never guarded.
// Rejection = throw; the message is returned to the model as the tool result.
//
// Files:
//   ~/.config/opencode/assistant.json          — shared config (extension writes; plugin reads)
//   ~/.config/opencode/assistant-events.jsonl  — audit events (boot/reject/dispatch/exempt/warn)
//   ~/.config/opencode/assistant-counts.json   — per-session counters, v2 (panel polls)
//   ctx.storage key: assistant:session:<id>    — durable per-session counters
//
// Counts flush is merge-based: re-read the file, take the max of every counter and the
// newest lastReject — so a second plugin instance can never overwrite newer values with
// its stale in-memory snapshot.

const HOME = process.env.HOME || "."
const CONFIG_PATH = HOME + "/.config/opencode/assistant.json"
const EVENTS_PATH = HOME + "/.config/opencode/assistant-events.jsonl"
const COUNTS_PATH = HOME + "/.config/opencode/assistant-counts.json"

const DEFAULT_CONFIG = {
  enabled: true,
  autoOpen: true, // read by the extension; plugin ignores it
  exemptionWord: "#nocap",
  poolPerRound: 3,
  sessionTotals: { read: 30, web: 10, command: 12 },
  exemptionRoundCap: 5,
}

const BIG_FILE = 30 * 1024
const CAT_NAME = { read: "读", web: "网", command: "命令" }

const LITE_CMDS = new Set(["ls", "stat", "pwd", "wc", "file", "which", "date"])
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "node", "deno", "python", "python3", "bun",
  "perl", "ruby", "eval", "exec", "find", "xargs",
])
const BUILD_RE = /\b(npm|pnpm|yarn|npx|make|cmake|cargo|go|mvn|gradle|pytest|jest|vitest|tsc|webpack|vite|docker|kubectl|systemctl|sudo|apt|apt-get|pip|pip3|uv|poetry|rm|mv|cp|mkdir|rmdir|touch|chmod|chown|kill|pkill|nohup)\b/
const GIT_WRITE_RE = /^git\s+(commit|push|pull|merge|rebase|checkout|switch|reset|stash|clean|add|init|clone|remote|tag|branch|worktree)\b/
const META_RE = /[;&|<>`]|\$\(|\$\{|\n/
const LOG_RE = /\.log\b|journalctl|dmesg|docker\s+logs|\/logs?\//i
const WEB_TOOL_RE = /^(chrome-devtools|browser|playwright|puppeteer)/

const MSG = {
  prefix: "[assistant 守卫] ",
  direct: (reason) =>
    `[assistant 守卫] 拦截：${reason}。请派 assistant 子代理完成查证（给它问题+已知范围），不要换工具或换写法重试。`,
  pool: (pool, word) =>
    `[assistant 守卫] 本轮直查额度（${pool} 次）已用完。请派 assistant、合并成一批，或请用户加豁免词「${word}」。`,
  total: (cat, total, word) =>
    `[assistant 守卫] 本会话「${CAT_NAME[cat] || cat}」额度（${total} 次）已用完。请派 assistant 子代理，或请用户加豁免词「${word}」。`,
  build: () => `[assistant 守卫] 施工类操作不能在 plan 场次做——请切到 build 模式再执行。`,
  other: (first) =>
    `[assistant 守卫] 命令不在只读白名单（${first}）。查证类请派 assistant；施工类请切 build 模式。`,
  unknown: (tool) =>
    `[assistant 守卫] 工具「${tool}」不在守卫名单，plan 场次默认拒绝。查证类请派 assistant；如确需使用请先向用户说明。`,
  terminal: () => `[assistant 守卫] 同类拦截已连续多次——立刻派 assistant 子代理，勿重试。`,
  storage: () =>
    `[assistant 守卫] 计数存储暂不可用，已暂停直查额度。请重试或改派 assistant 子代理。`,
  subagentShell: (why) =>
    `[assistant 守卫] ${why}：这条 shell 不会通过，不要换写法重试。改用 read / grep / rg / dbq 等只读工具，或把需求写进「缺」让主代理跑。`,
}

// ---------------------------------------------------------------- state / io
let ctxRef = null
let fsM = null
let fsP = null
let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
let cfgAt = 0

const S = {
  sessions: new Map(), // sid -> record
  approvedShell: new Set(), // commands already classified & passed (for shell.create.before)
  dirtyCounts: new Set(), // sids with counter changes waiting to be merged into the counts file
  cfgWarned: 0,
}

async function loadDeps() {
  if (!fsM) fsM = await import("node:fs")
  if (!fsP) fsP = fsM.promises
}

function rec(sid) {
  let r = S.sessions.get(sid)
  if (!r) {
    r = {
      sid,
      round: 0,
      poolUsed: 0,
      counts: { read: 0, web: 0, command: 0 },
      exemptRounds: 0,
      roundExempt: false,
      exemptAll: false,
      main: false,
      rejects: {},
      rejected: 0, // mirrored into the counts file (per session)
      dispatched: 0, // subagent sessions started from this session (session.created)
      lastReject: null, // { tool, reason, at }
      loaded: false,
      loading: null,
      storageOK: true,
      poolPaused: false,
    }
    S.sessions.set(sid, r)
  }
  return r
}

async function ensureLoaded(r) {
  if (r.loaded || r.loading) return
  r.loading = (async () => {
    try {
      const data = await ctxRef.storage.get("assistant:session:" + r.sid)
      if (data && typeof data === "object") {
        if (data.counts) for (const k of ["read", "web", "command"]) {
          if (Number.isFinite(data.counts[k])) r.counts[k] = Math.max(r.counts[k], data.counts[k])
        }
        if (Number.isFinite(data.exemptRounds)) r.exemptRounds = Math.max(r.exemptRounds, data.exemptRounds)
        if (Number.isFinite(data.rejected)) r.rejected = Math.max(r.rejected, data.rejected)
        if (Number.isFinite(data.dispatched)) r.dispatched = Math.max(r.dispatched, data.dispatched)
        r.lastReject = pickNewest(data.lastReject, r.lastReject)
        if (data.main) r.main = true
      }
      r.storageOK = true
      r.poolPaused = false
      r.loaded = true
    } catch (err) {
      // get 失败禁止从 0 重计：本进程已有计数就用；没有则暂停放行池
      r.storageOK = false
      r.loaded = true
      if (!r.counts.read && !r.counts.web && !r.counts.command && r.round === 0) r.poolPaused = true
      console.warn("[assistant] storage.get failed:", err?.message ?? err)
    } finally {
      r.loading = null
    }
  })()
  return r.loading
}

const persistTimers = new Map()
function persist(r) {
  if (persistTimers.has(r.sid)) return
  const t = setTimeout(async () => {
    persistTimers.delete(r.sid)
    try {
      // 读-合并-写：插件可能同时存在多份实例、各持一份计数，直接整份覆盖
      // 会让较低的一份盖掉较高的（计数冻结/回退的另一个入口）。
      let prev = null
      try {
        prev = await ctxRef.storage.get("assistant:session:" + r.sid)
      } catch {}
      const p = prev && typeof prev === "object" ? prev : {}
      const counts = { read: 0, web: 0, command: 0 }
      const pc = p.counts && typeof p.counts === "object" ? p.counts : {}
      for (const k of ["read", "web", "command"]) counts[k] = Math.max(numOr(pc[k], 0), numOr(r.counts[k], 0))
      await ctxRef.storage.set("assistant:session:" + r.sid, {
        v: 2,
        counts,
        exemptRounds: Math.max(numOr(p.exemptRounds, 0), numOr(r.exemptRounds, 0)),
        rejected: Math.max(numOr(p.rejected, 0), numOr(r.rejected, 0)),
        dispatched: Math.max(numOr(p.dispatched, 0), numOr(r.dispatched, 0)),
        lastReject: pickNewest(p.lastReject, r.lastReject),
        main: !!(p.main || r.main),
        updatedAt: Date.now(),
      })
      r.storageOK = true
    } catch (err) {
      // set 失败 = 降级为内存继续守 + 告警（不拒死、也不静默放行）
      r.storageOK = false
      console.warn("[assistant] storage.set failed:", err?.message ?? err)
    }
  }, 400)
  if (t.unref) t.unref()
  persistTimers.set(r.sid, t)
}

function logEvent(kind, fields) {
  try {
    const line = JSON.stringify({ t: Date.now(), kind, ...fields }) + "\n"
    fsP.appendFile(EVENTS_PATH, line).catch(() => {})
  } catch {}
}

function numOr(v, d) {
  return typeof v === "number" && Number.isFinite(v) ? v : d
}

/** 取更新的一条拦截记录（任一侧可能为 null）。 */
function pickNewest(a, b) {
  const x = a && typeof a === "object" ? a : null
  const y = b && typeof b === "object" ? b : null
  if (!x) return y
  if (!y) return x
  return numOr(y.at, 0) >= numOr(x.at, 0) ? y : x
}

// 计数落盘：多个插件实例各持一份快照整份写回，会互相把新值盖成旧值（面板看到
// "数字冻结/回退"）。现在每次落盘前重读文件，按会话做单调合并——计数取 max、
// 派单按子会话 id 并集、最近拦截取更新的一条——旧快照再也盖不掉新值。
function touchSession(r) {
  if (!r) return
  S.dirtyCounts.add(r.sid)
  scheduleCounts()
}

const SESSION_KEEP = 60

function mergeSession(fileRec, mine) {
  const a = fileRec && typeof fileRec === "object" ? fileRec : {}
  const used = { read: 0, web: 0, command: 0 }
  const fu = a.used && typeof a.used === "object" ? a.used : {}
  for (const k of ["read", "web", "command"]) used[k] = Math.max(numOr(fu[k], 0), numOr(mine.used[k], 0))

  const lrFile = a.lastReject && typeof a.lastReject === "object" ? a.lastReject : null
  const lrMine = mine.lastReject
  const lr = lrMine && (!lrFile || numOr(lrMine.at, 0) >= numOr(lrFile.at, 0)) ? lrMine : lrFile

  return {
    rejected: Math.max(numOr(a.rejected, 0), mine.rejected),
    dispatched: Math.max(numOr(a.dispatched, 0), mine.dispatched),
    exempted: Math.max(numOr(a.exempted, 0), mine.exempted),
    used,
    lastReject: lr ? { tool: lr.tool, reason: lr.reason, at: numOr(lr.at, 0) } : null,
    updatedAt: Date.now(),
  }
}

let countsTimer = null
let flushing = false
function scheduleCounts(delay) {
  if (countsTimer) return
  countsTimer = setTimeout(() => {
    countsTimer = null
    void flushCounts()
  }, delay ?? 300)
  if (countsTimer.unref) countsTimer.unref()
}

async function flushCounts() {
  if (flushing) {
    scheduleCounts(1000)
    return
  }
  const sids = [...S.dirtyCounts]
  if (!sids.length) return
  flushing = true
  let wrote = false
  try {
    await loadDeps()
    let sessions = {}
    try {
      const raw = await fsP.readFile(COUNTS_PATH, "utf8")
      const j = JSON.parse(raw)
      if (j && typeof j === "object" && j.v === 2 && j.sessions && typeof j.sessions === "object") sessions = j.sessions
      // 旧版(v1 全局)/损坏/缺失 → 从空开始（历史仍在 assistant-events.jsonl）
    } catch {}
    for (const sid of sids) {
      const r = S.sessions.get(sid)
      if (!r) continue
      sessions[sid] = mergeSession(sessions[sid], {
        rejected: numOr(r.rejected, 0),
        dispatched: numOr(r.dispatched, 0),
        exempted: numOr(r.exemptRounds, 0),
        used: r.counts,
        lastReject: r.lastReject,
      })
    }
    const entries = Object.entries(sessions)
    if (entries.length > SESSION_KEEP) {
      entries.sort((x, y) => numOr(y[1]?.updatedAt, 0) - numOr(x[1]?.updatedAt, 0))
      sessions = Object.fromEntries(entries.slice(0, SESSION_KEEP))
    }
    const tmp = COUNTS_PATH + "." + process.pid + ".tmp"
    await fsP.writeFile(tmp, JSON.stringify({ v: 2, updatedAt: Date.now(), sessions }, null, 2))
    await fsP.rename(tmp, COUNTS_PATH)
    wrote = true
  } catch (err) {
    console.warn("[assistant] counts flush failed:", err?.message ?? err)
  } finally {
    flushing = false
    if (wrote) for (const sid of sids) S.dirtyCounts.delete(sid)
    if (S.dirtyCounts.size) scheduleCounts(wrote ? 300 : 2000)
  }
}

async function refreshConfig(force) {
  if (!force && Date.now() - cfgAt < 3000) return
  cfgAt = Date.now()
  try {
    const raw = await fsP.readFile(CONFIG_PATH, "utf8")
    const j = JSON.parse(raw)
    const next = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
    if (typeof j.enabled === "boolean") next.enabled = j.enabled
    if (typeof j.autoOpen === "boolean") next.autoOpen = j.autoOpen
    if (typeof j.exemptionWord === "string" && j.exemptionWord) next.exemptionWord = j.exemptionWord
    if (Number.isFinite(j.poolPerRound) && j.poolPerRound >= 0) next.poolPerRound = j.poolPerRound
    if (j.sessionTotals && typeof j.sessionTotals === "object") {
      for (const k of ["read", "web", "command"]) {
        if (Number.isFinite(j.sessionTotals[k]) && j.sessionTotals[k] >= 0) next.sessionTotals[k] = j.sessionTotals[k]
      }
    }
    if (Number.isFinite(j.exemptionRoundCap) && j.exemptionRoundCap >= 0) next.exemptionRoundCap = j.exemptionRoundCap
    if (j.exemptSessions && typeof j.exemptSessions === "object") next.exemptSessions = j.exemptSessions
    cfg = next
  } catch (err) {
    // 配置读失败用缓存/默认值，不关守卫
    if (Date.now() - S.cfgWarned > 60000) {
      S.cfgWarned = Date.now()
      console.warn("[assistant] config read failed, using defaults:", err?.message ?? err)
    }
  }
}

// ---------------------------------------------------------------- classify
function normCmd(cmd) {
  let c = String(cmd ?? "").trim()
  for (;;) {
    const b = c
    c = c.replace(/^command\s+/i, "").replace(/^rtk\s+/i, "")
    if (c === b) break
  }
  return c
}

function shellKey(cmd) {
  return normCmd(cmd).replace(/\brtk\s+/g, " ").replace(/\s+/g, " ").trim()
}

function looksLikeLog(s) {
  return LOG_RE.test(String(s ?? ""))
}

function getStr(input, keys) {
  if (!input || typeof input !== "object") return ""
  for (const k of keys) if (typeof input[k] === "string" && input[k]) return input[k]
  return ""
}

function classifyWebTool(tool) {
  return tool === "websearch" || tool === "webfetch" || tool === "openchamber_web" || WEB_TOOL_RE.test(tool)
}

// -> { cls: "pass" | "pool" | "reject", cat?, kind?, message? }
function classify(tool, input, mode) {
  const webOnly = mode === "web"

  if (tool === "read") {
    if (webOnly) return { cls: "pass" }
    const p = getStr(input, ["filePath", "file_path", "path"])
    if (p && looksLikeLog(p)) return { cls: "reject", kind: "direct", message: MSG.direct("日志类读取") }
    const seg = (input && (input.offset != null || input.limit != null)) || false
    let size = null
    try {
      const st = fsM.statSync(p)
      if (st && st.isFile()) size = st.size
    } catch {}
    if (size != null && size > BIG_FILE && !seg) {
      return { cls: "reject", kind: "direct", message: MSG.direct("大文件整读（>30KB）") }
    }
    if (size == null && !seg) {
      return { cls: "reject", kind: "direct", message: MSG.direct("无法确认文件大小（按大文件拒）") }
    }
    return { cls: "pool", cat: "read" }
  }

  if (tool === "glob") {
    if (webOnly) return { cls: "pass" }
    return { cls: "pool", cat: "read" }
  }

  if (tool === "grep") {
    if (webOnly) return { cls: "pass" }
    return { cls: "reject", kind: "direct", message: MSG.direct("内容搜索（grep）") }
  }

  if (tool === "websearch" || tool === "openchamber_web") {
    if (webOnly) return { cls: "pool", cat: "web" }
    return { cls: "reject", kind: "direct", message: MSG.direct("网页搜索") }
  }

  if (tool === "webfetch") {
    // plan: 明确 URL 进放行池；build: 同（网额度）
    return { cls: "pool", cat: "web" }
  }

  if (tool === "shell" || tool === "bash") {
    if (webOnly) return { cls: "pass" }
    const raw = String(input?.command ?? "")
    if (!raw.trim()) return { cls: "pass" }
    const cmd = normCmd(raw)
    const first = cmd.split(/\s+/)[0] || ""
    if (META_RE.test(cmd)) return { cls: "reject", kind: "direct", message: MSG.direct("含管道/重定向/连接符") }
    if (INTERPRETERS.has(first)) return { cls: "reject", kind: "direct", message: MSG.direct("解释器命令") }
    if (first === "curl" || first === "wget") return { cls: "reject", kind: "direct", message: MSG.direct("网页抓取（curl/wget）") }
    if (looksLikeLog(cmd)) return { cls: "reject", kind: "direct", message: MSG.direct("日志类") }
    if (LITE_CMDS.has(first)) return { cls: "pool", cat: "command" }
    if (/^git\s+status\b/.test(cmd)) return { cls: "pool", cat: "command" }
    if (/^git\s+log\b/.test(cmd)) {
      const m = cmd.match(/(?:-n\s*|--max-count[= ])(\d+)/)
      if (m && Number(m[1]) <= 20) return { cls: "pool", cat: "command" }
      return { cls: "reject", kind: "direct", message: MSG.direct("git log 未限长（需 -n≤20）") }
    }
    if (BUILD_RE.test(first) || GIT_WRITE_RE.test(cmd)) return { cls: "reject", kind: "build", message: MSG.build() }
    return { cls: "reject", kind: "other", message: MSG.other(first) }
  }

  if (classifyWebTool(tool) && tool !== "websearch" && tool !== "openchamber_web") {
    // chrome-devtools / browser MCP 等
    if (webOnly) return { cls: "pool", cat: "web" }
    return { cls: "reject", kind: "direct", message: MSG.direct("浏览器/网页工具") }
  }

  // 明确放行的（笔记/会话/派单/执行入口/plan 原生权限管理的写类）
  if (
    tool === "execute" || tool === "task" || tool === "subagent" || tool === "agent" ||
    tool === "edit" || tool === "write" || tool === "patch" || tool === "multiedit" ||
    tool === "question" || tool === "skill" || tool === "todowrite" || tool === "todoread" ||
    tool === "openchamber" || tool === "openchamber_knowledge" || tool === "openchamber_notify" ||
    tool === "openchamber_render"
  ) {
    return { cls: "pass" }
  }
  if (tool.startsWith("openchamber")) return { cls: "pass" }

  if (webOnly) return { cls: "pass" }
  return { cls: "reject", kind: "unknown", message: MSG.unknown(tool) }
}

// assistant 子代理 shell 的「必拒品类」轻判：与 assistant.md 的 deny 规则逐条对应——
// ① 重定向 / 禁用旗标（子串匹配，语义等同原生 glob）；② 解释器 argv0（任何分段里都不允许）。
// 只抓原生必然拒绝、且模型最爱换写法重试的形态；其余一律交给原生权限白名单。
const SUBAGENT_DENY_SUBSTRS = [" >", "2>", "&>", ">>", "1>", "xxd -r", "--output", "ss -K", "--pre"]
function assistantShellHardNo(cmd) {
  const c = String(cmd ?? "")
  if (!c.trim()) return ""
  for (const s of SUBAGENT_DENY_SUBSTRS) {
    if (c.includes(s)) return "重定向或禁用旗标（`" + s.trim() + "`）"
  }
  for (const seg of c.split(/[;&|]+/)) {
    const argv0 = seg.trim().replace(/^command\s+/, "").replace(/^rtk\s+/, "").split(/\s+/)[0]
    if (argv0 && INTERPRETERS.has(argv0.toLowerCase())) return "解释器命令（" + argv0 + "）"
  }
  return ""
}

// ---------------------------------------------------------------- tool hook
async function onTool(event) {
  let controlled = false
  try {
    if (!ctxRef) return
    await loadDeps()
    await refreshConfig(false)
    if (!cfg.enabled) return

    const tool = String(event?.tool ?? "").toLowerCase()
    const sid = String(event?.sessionID ?? "")
    const agent = String(event?.agent ?? "")
    if (!sid || !tool) return

    // 记下 shell 命令（含未受控会话的），供 shell.create.before 的「已分类」判定，
    // 避免把模型发起的 shell 记成未分类（含 rtk 改写后的形态）。
    if (tool === "shell" || tool === "bash") {
      const raw = String(event?.input?.command ?? "")
      if (raw) {
        if (S.approvedShell.size > 96) S.approvedShell.clear()
        S.approvedShell.add(raw)
        S.approvedShell.add(shellKey(raw))
      }
    }

    // assistant 子代理的 shell：只做「必拒品类」轻判并给出可执行文案，
    // 其余放行（仍由原生权限白名单兜底）。general 等其它子代理一律放行。
    if (agent === "assistant") {
      if (tool === "shell" || tool === "bash") {
        const why = assistantShellHardNo(String(event?.input?.command ?? ""))
        if (why) {
          logEvent("reject", { sessionID: sid, agent, tool, reason: "subagent-shell", message: why })
          throw guardError(MSG.subagentShell(why))
        }
      }
      return
    }
    if (agent === "general") return

    // 判定优先级：event.agent 直接决定；自定义主 agent 按 plan 守。
    let mode = null
    const r = S.sessions.get(sid)
    if (agent === "plan") mode = "full"
    else if (agent === "build") mode = "web"
    else mode = r?.main ? "full" : null
    if (!mode) return
    controlled = true

    const rec0 = rec(sid)
    if (agent === "plan" || agent === "build") rec0.main = true
    await ensureLoaded(rec0)

    // 豁免：整场放行（配置）或本轮豁免词
    rec0.exemptAll = cfg.exemptSessions && cfg.exemptSessions[sid] === true
    if (rec0.exemptAll || rec0.roundExempt) return

    const dec = classify(tool, event?.input, mode)

    if (dec.cls !== "reject") {
      if (dec.cat) {
        // 先自增占坑、再判超限（同步占坑、异步落盘）
        rec0.poolUsed += 1
        rec0.counts[dec.cat] += 1
        touchSession(rec0) // 用量镜像给面板（本会话余额）
        const overPool = rec0.poolUsed > cfg.poolPerRound
        const overTotal = rec0.counts[dec.cat] > cfg.sessionTotals[dec.cat]
        if (rec0.poolPaused) {
          persist(rec0)
          throw guardError(MSG.storage())
        }
        if (overPool) {
          rec0.rejects.pool = (rec0.rejects.pool || 0) + 1
          const m = rec0.rejects.pool >= 3 ? MSG.terminal() : MSG.pool(cfg.poolPerRound, cfg.exemptionWord)
          rejectLog(rec0, tool, agent, "pool", m)
          throw guardError(m)
        }
        if (overTotal) {
          rec0.rejects.total = (rec0.rejects.total || 0) + 1
          const m = rec0.rejects.total >= 3 ? MSG.terminal() : MSG.total(dec.cat, cfg.sessionTotals[dec.cat], cfg.exemptionWord)
          rejectLog(rec0, tool, agent, "total", m)
          throw guardError(m)
        }
        persist(rec0)
      }
      return
    }

    // reject
    const kind = dec.kind || "direct"
    rec0.rejects[kind] = (rec0.rejects[kind] || 0) + 1
    const msg = rec0.rejects[kind] >= 3 ? MSG.terminal() : (dec.message || MSG.direct("查证类"))
    rejectLog(rec0, tool, agent, kind, msg)
    persist(rec0)
    throw guardError(msg)
  } catch (err) {
    if (err && err.__assistantGuard) throw err
    if (controlled) {
      console.warn("[assistant] guard internal error:", err?.message ?? err)
      throw guardError("[assistant 守卫] 内部错误，已保守拦截：" + String(err?.message ?? err).slice(0, 120))
    }
    return // never break subagent/uncontrolled traffic
  }
}

function rejectLog(r, tool, agent, kind, message) {
  r.rejected = numOr(r.rejected, 0) + 1
  r.lastReject = { tool, reason: kind, at: Date.now() }
  touchSession(r)
  // 字段名不能叫 kind，否则会覆盖 logEvent 的事件类型
  logEvent("reject", { sessionID: r.sid, agent, tool, reason: kind, message })
}

function guardError(msg) {
  const e = new Error(msg)
  e.__assistantGuard = true
  return e
}

// ---------------------------------------------------------------- prompt hook
async function onPrompt(event) {
  try {
    if (!ctxRef) return
    await loadDeps()
    await refreshConfig(false)
    if (!cfg.enabled) return

    const sid = String(event?.sessionID ?? event?.session?.id ?? event?.message?.sessionID ?? "")
    if (!sid) return
    const text = String(event?.prompt?.text ?? "")

    // 只认主会话：经 session.get 验证无 parentID 才记；拿不准就不记（不误卡子代理）
    let isMain = false
    try {
      const info = await ctxRef.session.get({ sessionID: sid })
      isMain = !!info && !info.parentID
      if (info && info.agent === "plan") isMain = true
    } catch (err) {
      console.warn("[assistant] session.get failed in prompt hook:", err?.message ?? err)
      return
    }
    if (!isMain) return

    const r = rec(sid)
    r.main = true
    await ensureLoaded(r)
    r.round += 1
    r.poolUsed = 0
    r.rejects = {}
    r.roundExempt = false

    const word = cfg.exemptionWord
    if (word && hasToken(text, word)) {
      r.exemptAll = cfg.exemptSessions && cfg.exemptSessions[sid] === true
      if (r.exemptRounds < cfg.exemptionRoundCap) {
        r.exemptRounds += 1
        r.roundExempt = true
        touchSession(r)
        logEvent("exempt", { sessionID: sid, round: r.round, rounds: r.exemptRounds })
      } else {
        logEvent("warn", { sessionID: sid, note: "exemption round cap reached", cap: cfg.exemptionRoundCap })
      }
    }
    persist(r)
  } catch (err) {
    console.warn("[assistant] prompt hook error:", err?.message ?? err)
  }
}

function hasToken(text, word) {
  try {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp("(^|[^\\w#])" + esc + "(?![\\w])").test(String(text ?? ""))
  } catch {
    return String(text ?? "").includes(word)
  }
}

// ---------------------------------------------------------------- shell hook (insurance only)
// 所有模型发起的 shell 都先经过 tool hook（已实测），这里只记录「未被分类过」的
// shell 创建（多为 opencode 内部调用）供审计用——不拦截，避免误伤内部命令。
async function onShell(event) {
  try {
    if (!fsP) return
    const cmd = String(event?.command ?? "")
    if (!cmd) return
    const k1 = cmd
    const k2 = shellKey(cmd)
    if (S.approvedShell.has(k1) || S.approvedShell.has(k2)) {
      S.approvedShell.delete(k1)
      S.approvedShell.delete(k2)
      return
    }
    const key = cmd.slice(0, 160)
    if (!S.shellSeen) S.shellSeen = new Set()
    if (S.shellSeen.has(key) || S.shellSeen.size > 128) return
    S.shellSeen.add(key)
    logEvent("warn", { where: "shell.create.before", note: "unaccounted shell", command: key })
  } catch {}
}

// ---------------------------------------------------------------- event stream
function subscribeLoop(ctx, signal) {
  ;(async () => {
    while (!signal.aborted) {
      try {
        for await (const ev of ctx.event.subscribe({ signal })) {
          try {
            onEvent(ev)
          } catch {}
        }
      } catch (err) {
        if (signal.aborted) return
        console.warn("[assistant] event stream error:", err?.message ?? err)
      }
      if (!signal.aborted) await new Promise((r) => setTimeout(r, 5000))
    }
  })()
}

const seenTypes = new Set()
function onEvent(ev) {
  const type = String(ev?.type ?? "")
  if (!type) return
  const data = ev?.data ?? ev?.properties ?? {}
  const info = data.info ?? data

  if (type === "session.created") {
    const parentID = String(info?.parentID ?? "")
    if (parentID) {
      // 子会话创建事件只带 parentID、不带 id：按「每个父会话 +1」记；
      // 多个插件实例各记一次，落盘取 max，所以不会重复计数。
      const pr = rec(parentID)
      pr.dispatched = numOr(pr.dispatched, 0) + 1
      touchSession(pr)
      persist(pr) // 事件驱动的计数也要落到 storage，插件重载后才不会从头数
      logEvent("dispatch", { sessionID: parentID, childID: info?.id })
    }
    return
  }
  if (type === "session.deleted" || type === "session.removed") {
    const id = info?.id ?? data?.sessionID
    if (id) {
      S.sessions.delete(id)
      S.dirtyCounts.delete(id)
      try { ctxRef.storage.remove("assistant:session:" + id).catch(() => {}) } catch {}
      logEvent("debug", { note: "session removed, storage cleaned", sessionID: id })
    }
    return
  }
  if (type.startsWith("session.") && !seenTypes.has(type) && seenTypes.size < 40) {
    seenTypes.add(type)
    logEvent("debug", { note: "first seen event type", type })
  }
}

// ---------------------------------------------------------------- setup
export default {
  id: "assistant",
  async setup(ctx) {
    ctxRef = ctx
    try {
      await loadDeps()
      await refreshConfig(true)
      logEvent("boot", { pid: process.pid, location: ctx?.location?.directory ?? "" })
      console.log("[assistant] guard loaded at", ctx?.location?.directory ?? "")
    } catch (err) {
      console.warn("[assistant] init:", err?.message ?? err)
    }

    try {
      await ctx.tool.hook("execute.before", onTool)
    } catch (err) {
      console.warn("[assistant] tool hook unavailable:", err?.message ?? err)
    }
    try {
      await ctx.session.hook("prompt", onPrompt)
    } catch (err) {
      console.warn("[assistant] prompt hook unavailable:", err?.message ?? err)
    }
    try {
      await ctx.shell.hook("create.before", onShell)
    } catch (err) {
      console.warn("[assistant] shell hook unavailable:", err?.message ?? err)
    }

    const controller = new AbortController()
    subscribeLoop(ctx, controller.signal)

    return () => {
      controller.abort()
      console.log("[assistant] guard unloaded")
    }
  },
}
