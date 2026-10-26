// scout — OpenCode v2 plugin: hard guard for the scout-delegation flow.
// Design doc: scout-suite-plan.md §5.
//   plan sessions  = every category is guarded (read/search/web/light commands + quota).
//   build sessions = only web search/fetch is guarded (quota; over-limit -> reject + delegate).
//   scout subagent = read-only bwrap sandbox + external-side-effect denylist.
//   other subagents (general/stock/...) are never guarded.
// Rejection = throw; the message is returned to the model as the tool result.
//
// Files:
//   ~/.config/opencode/scout.json          — shared config (extension writes; plugin reads)
//   ~/.config/opencode/scout-events.jsonl  — audit events (boot/reject/dispatch/exempt/warn)
//   ~/.config/opencode/scout-counts.json   — per-session counters, v2 (panel polls)
//   ctx.storage key: scout:session:<id>    — durable per-session counters
//
// Counts flush is merge-based: re-read the file, take the max of every counter and the
// newest lastReject — so a second plugin instance can never overwrite newer values with
// its stale in-memory snapshot.

const HOME = process.env.HOME || "."
const CONFIG_PATH = HOME + "/.config/opencode/scout.json"
const EVENTS_PATH = HOME + "/.config/opencode/scout-events.jsonl"
const COUNTS_PATH = HOME + "/.config/opencode/scout-counts.json"

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
  prefix: "[scout 守卫] ",
  direct: (reason) =>
    `[scout 守卫] 拦截：${reason}。请派 scout 子代理完成查证（给它问题+已知范围），不要换工具或换写法重试。`,
  pool: (pool, word) =>
    `[scout 守卫] 本轮直查额度（${pool} 次）已用完。请派 scout、合并成一批，或请用户加豁免词「${word}」。`,
  total: (cat, total, word) =>
    `[scout 守卫] 本会话「${CAT_NAME[cat] || cat}」额度（${total} 次）已用完。请派 scout 子代理，或请用户加豁免词「${word}」。`,
  build: () => `[scout 守卫] 施工类操作不能在 plan 场次做——请切到 build 模式再执行。`,
  other: (first) =>
    `[scout 守卫] 命令不在只读白名单（${first}）。查证类请派 scout；施工类请切 build 模式。`,
  unknown: (tool) =>
    `[scout 守卫] 工具「${tool}」不在守卫名单，plan 场次默认拒绝。查证类请派 scout；如确需使用请先向用户说明。`,
  terminal: () => `[scout 守卫] 同类拦截已连续多次——立刻派 scout 子代理，勿重试。`,
  storage: () =>
    `[scout 守卫] 计数存储暂不可用，已暂停直查额度。请重试或改派 scout 子代理。`,
  subagentShell: (why) =>
    `[scout 守卫] ${why}。按提示改一处后重发一次；再被拒就停，把需求写进「缺」让主代理跑。`,
  subagentShellOut: (name) =>
    `[scout 守卫] 白名单外命令（${name}）：改用 read / grep 工具 / rg / jq / dbq，或写进「缺」；施工类由主代理在 build 做。`,
  sandboxDeny: (why) =>
    `[scout 守卫] 只读沙箱仍会改外部状态（${why}），不能做；换只读查证命令，或写进「缺」让主代理跑。`,
  sandboxOff: () =>
    `[scout 守卫] 只读沙箱不可用（bwrap 探测失败），shell 已停用；改用 read / grep 工具，或写进「缺」。`,
}

// ---------------------------------------------------------------- state / io
let ctxRef = null
let fsM = null
let fsP = null
let cpM = null
let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
let cfgAt = 0

const S = {
  sessions: new Map(), // sid -> record
  approvedShell: new Set(), // commands already classified & passed (for shell.create.before)
  dirtyCounts: new Set(), // sids with counter changes waiting to be merged into the counts file
  cfgWarned: 0,
  sandbox: null, // { ok, at } 最近一次 bwrap 探测结果（写入 counts 文件供面板显示）
}

async function loadDeps() {
  if (!fsM) fsM = await import("node:fs")
  if (!fsP) fsP = fsM.promises
  if (!cpM) cpM = await import("node:child_process")
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
      sandboxRejects: 0, // scout 沙箱拦截（记到子代理的父会话）
      lastSandboxReject: null, // { tool, reason, at }
      recentRejects: [], // 最近几条直查拦截（面板日志框，最多 RECENT_KEEP 条）
      recentSandboxRejects: [], // 最近几条沙箱拦截
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
      const data = await ctxRef.storage.get("scout:session:" + r.sid)
      if (data && typeof data === "object") {
        if (data.counts) for (const k of ["read", "web", "command"]) {
          if (Number.isFinite(data.counts[k])) r.counts[k] = Math.max(r.counts[k], data.counts[k])
        }
        if (Number.isFinite(data.exemptRounds)) r.exemptRounds = Math.max(r.exemptRounds, data.exemptRounds)
        if (Number.isFinite(data.rejected)) r.rejected = Math.max(r.rejected, data.rejected)
        if (Number.isFinite(data.dispatched)) r.dispatched = Math.max(r.dispatched, data.dispatched)
        if (Number.isFinite(data.sandboxRejects)) r.sandboxRejects = Math.max(r.sandboxRejects, data.sandboxRejects)
        r.lastReject = pickNewest(data.lastReject, r.lastReject)
        r.lastSandboxReject = pickNewest(data.lastSandboxReject, r.lastSandboxReject)
        r.recentRejects = mergeRecent(r.recentRejects, data.recentRejects)
        r.recentSandboxRejects = mergeRecent(r.recentSandboxRejects, data.recentSandboxRejects)
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
      console.warn("[scout] storage.get failed:", err?.message ?? err)
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
        prev = await ctxRef.storage.get("scout:session:" + r.sid)
      } catch {}
      const p = prev && typeof prev === "object" ? prev : {}
      const counts = { read: 0, web: 0, command: 0 }
      const pc = p.counts && typeof p.counts === "object" ? p.counts : {}
      for (const k of ["read", "web", "command"]) counts[k] = Math.max(numOr(pc[k], 0), numOr(r.counts[k], 0))
      await ctxRef.storage.set("scout:session:" + r.sid, {
        v: 2,
        counts,
        exemptRounds: Math.max(numOr(p.exemptRounds, 0), numOr(r.exemptRounds, 0)),
        rejected: Math.max(numOr(p.rejected, 0), numOr(r.rejected, 0)),
        dispatched: Math.max(numOr(p.dispatched, 0), numOr(r.dispatched, 0)),
        sandboxRejects: Math.max(numOr(p.sandboxRejects, 0), numOr(r.sandboxRejects, 0)),
        lastReject: pickNewest(p.lastReject, r.lastReject),
        lastSandboxReject: pickNewest(p.lastSandboxReject, r.lastSandboxReject),
        recentRejects: mergeRecent(r.recentRejects, p.recentRejects),
        recentSandboxRejects: mergeRecent(r.recentSandboxRejects, p.recentSandboxRejects),
        main: !!(p.main || r.main),
        updatedAt: Date.now(),
      })
      r.storageOK = true
    } catch (err) {
      // set 失败 = 降级为内存继续守 + 告警（不拒死、也不静默放行）
      r.storageOK = false
      console.warn("[scout] storage.set failed:", err?.message ?? err)
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

const RECENT_KEEP = 5

/** 合并「最近拦截」小列表：按时间倒序、去重、只留最近几条（面板日志框用）。 */
function mergeRecent(a, b) {
  const seen = new Set()
  const out = []
  for (const it of [...(Array.isArray(b) ? b : []), ...(Array.isArray(a) ? a : [])]) {
    if (!it || typeof it !== "object") continue
    const at = numOr(it.at, 0)
    if (!at) continue
    const tool = String(it.tool ?? "").slice(0, 80)
    const reason = String(it.reason ?? "").slice(0, 40)
    const key = `${at}|${tool}|${reason}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ tool, reason, at })
  }
  out.sort((x, y) => y.at - x.at)
  return out.slice(0, RECENT_KEEP)
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
  const sb = pickNewest(a.lastSandboxReject, mine.lastSandboxReject)

  return {
    rejected: Math.max(numOr(a.rejected, 0), mine.rejected),
    dispatched: Math.max(numOr(a.dispatched, 0), mine.dispatched),
    exempted: Math.max(numOr(a.exempted, 0), mine.exempted),
    sandboxRejects: Math.max(numOr(a.sandboxRejects, 0), numOr(mine.sandboxRejects, 0)),
    used,
    lastReject: lr ? { tool: lr.tool, reason: lr.reason, at: numOr(lr.at, 0) } : null,
    lastSandboxReject: sb ? { tool: sb.tool, reason: sb.reason, at: numOr(sb.at, 0) } : null,
    recentRejects: mergeRecent(a.recentRejects, mine.recentRejects),
    recentSandboxRejects: mergeRecent(a.recentSandboxRejects, mine.recentSandboxRejects),
    updatedAt: Date.now(),
  }
}

let countsTimer = null
let flushing = false
let sandboxDirty = false
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
  if (!sids.length && !sandboxDirty) return
  flushing = true
  let wrote = false
  try {
    await loadDeps()
    let sessions = {}
    try {
      const raw = await fsP.readFile(COUNTS_PATH, "utf8")
      const j = JSON.parse(raw)
      if (j && typeof j === "object" && j.v === 2 && j.sessions && typeof j.sessions === "object") sessions = j.sessions
      // 旧版(v1 全局)/损坏/缺失 → 从空开始（历史仍在 scout-events.jsonl）
    } catch {}
    for (const sid of sids) {
      const r = S.sessions.get(sid)
      if (!r) continue
      sessions[sid] = mergeSession(sessions[sid], {
        rejected: numOr(r.rejected, 0),
        dispatched: numOr(r.dispatched, 0),
        exempted: numOr(r.exemptRounds, 0),
        sandboxRejects: numOr(r.sandboxRejects, 0),
        used: r.counts,
        lastReject: r.lastReject,
        lastSandboxReject: r.lastSandboxReject,
        recentRejects: r.recentRejects,
        recentSandboxRejects: r.recentSandboxRejects,
      })
    }
    const entries = Object.entries(sessions)
    if (entries.length > SESSION_KEEP) {
      entries.sort((x, y) => numOr(y[1]?.updatedAt, 0) - numOr(x[1]?.updatedAt, 0))
      sessions = Object.fromEntries(entries.slice(0, SESSION_KEEP))
    }
    const out = { v: 2, updatedAt: Date.now(), sessions }
    if (S.sandbox) out.sandbox = S.sandbox
    const tmp = COUNTS_PATH + "." + process.pid + ".tmp"
    await fsP.writeFile(tmp, JSON.stringify(out, null, 2))
    await fsP.rename(tmp, COUNTS_PATH)
    wrote = true
  } catch (err) {
    console.warn("[scout] counts flush failed:", err?.message ?? err)
  } finally {
    flushing = false
    if (wrote) {
      for (const sid of sids) S.dirtyCounts.delete(sid)
      sandboxDirty = false
    }
    if (S.dirtyCounts.size || sandboxDirty) scheduleCounts(wrote ? 300 : 2000)
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
      console.warn("[scout] config read failed, using defaults:", err?.message ?? err)
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
    tool === "recall" ||
    tool === "openchamber" || tool === "openchamber_knowledge" || tool === "openchamber_notify" ||
    tool === "openchamber_render"
  ) {
    return { cls: "pass" }
  }
  if (tool.startsWith("openchamber")) return { cls: "pass" }

  if (webOnly) return { cls: "pass" }
  return { cls: "reject", kind: "unknown", message: MSG.unknown(tool) }
}

// scout 子代理 shell 的「必拒品类」轻判：与 scout.md 的规则对应——
// ① 重定向：原生层已不再拦（5 条 redirect deny 下放到这里），由 findFileRedirect 做引号/替换体感知扫描——
//    单引号内全字面量；双引号里只有 $( ${ 反引号 才下钻；$((…)) 是算术（> 是比较符，不算重定向）；
//    ${…} 只做花括号层级；命令替换体（$()、反引号）按命令上下文继续扫（支持嵌套）。
//    目标 /dev/null 或 fd 复制（>&1 / >&2 / >&-）放行；指向真实文件的一律拒（含不空格 `cmd>f`）。
// ② 禁用旗标：子串匹配（xxd -r / --output / ss -K / tail -f）；--pre 走边界匹配，免得误伤 --pretty。
// ③ 解释器 argv0 与白名单外高频「探路」命令（给指向性文案）。其余交给原生白名单。
const SUBAGENT_FLAG_DENIES = ["xxd -r", "--output", "ss -K", "tail -f"]
const SUBAGENT_OUTSIDERS = new Set([
  // 读/检索：cat 与 shell grep 已收编（白名单），其余指向 rg / read / grep 工具 / head / tail
  "tac", "sed", "awk", "gawk", "less", "more", "vi", "vim", "nano",
  // 包/系统查询（指向 dbq、read、写进缺）
  "dpkg", "apt", "apt-get", "npm", "npx", "pnpm", "yarn", "pip", "pip3", "uv", "sqlite3", "systemctl",
  // 其余 shell 内建（printf 等）
  "command", "printf", "env", "printenv", "sleep", "source", "tee",
  // 网络与写操作（指向"施工类由主代理做"）
  "curl", "wget", "rm", "mv", "cp", "mkdir", "touch", "chmod", "chown", "kill", "pkill", "dd", "sudo",
  // 能起子进程的检索工具
  "find", "xargs",
])

// 引号/替换体感知：找第一个「写到真实文件」的重定向；/dev/null、fd 复制（>&1/>&2/>&-）放行。
function findFileRedirect(cmd) {
  const stack = ["cmd"] // cmd | dq | sq | sub | bt | arith | param
  let arithDepth = 0
  const top = () => stack[stack.length - 1]
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const ctx = top()
    if (ctx === "sq") {
      if (ch === "'") stack.pop()
      continue
    }
    if (ctx === "arith") {
      if (ch === "(") { arithDepth++; continue }
      if (ch === ")") { arithDepth--; if (arithDepth <= 0) stack.pop(); continue }
      if (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] === "(") { stack.push("arith"); arithDepth = 2; i += 2; continue }
      if (ch === "$" && cmd[i + 1] === "(") { stack.push("sub"); i++; continue }
      if (ch === "$" && cmd[i + 1] === "{") { stack.push("param"); i++; continue }
      if (ch === "`") { stack.push("bt"); continue }
      if (ch === "'") { stack.push("sq"); continue }
      if (ch === '"') { stack.push("dq"); continue }
      continue
    }
    if (ctx === "param") {
      if (ch === "}") { stack.pop(); continue }
      if (ch === "$" && cmd[i + 1] === "(") { stack.push("sub"); i++; continue }
      if (ch === "`") { stack.push("bt"); continue }
      continue
    }
    if (ch === "\\") { i++; continue }
    if (ctx === "dq") {
      if (ch === '"') { stack.pop(); continue }
      if (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] === "(") { stack.push("arith"); arithDepth = 2; i += 2; continue }
      if (ch === "$" && cmd[i + 1] === "(") { stack.push("sub"); i++; continue }
      if (ch === "$" && cmd[i + 1] === "{") { stack.push("param"); i++; continue }
      if (ch === "`") { stack.push("bt"); continue }
      continue
    }
    if (ch === "'") { stack.push("sq"); continue }
    if (ch === '"') { stack.push("dq"); continue }
    if (ch === "`") { if (ctx === "bt") stack.pop(); else stack.push("bt"); continue }
    if (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] === "(") { stack.push("arith"); arithDepth = 2; i += 2; continue }
    if (ch === "$" && cmd[i + 1] === "(") { stack.push("sub"); i++; continue }
    if (ch === "$" && cmd[i + 1] === "{") { stack.push("param"); i++; continue }
    if (ctx === "sub" && ch === ")") { stack.pop(); continue }
    if (ch !== ">") continue
    // 解析一个重定向：>> / >| / >&N / >&- / > file / >file
    let j = i + 1
    if (cmd[j] === ">") j++
    if (cmd[j] === "|") j++
    if (cmd[j] === "&") {
      j++
      while (j < cmd.length && /[0-9-]/.test(cmd[j])) j++
      i = j - 1
      continue
    }
    while (j < cmd.length && /\s/.test(cmd[j])) j++ // `> file` 允许空格
    let tgt = ""
    while (j < cmd.length) {
      const c2 = cmd[j]
      if (/\s/.test(c2) || ";|&<>()".includes(c2)) break
      if (c2 === '"' || c2 === "'") {
        const q2 = c2
        j++
        while (j < cmd.length && cmd[j] !== q2) { tgt += cmd[j]; j++ }
        j++
        continue
      }
      tgt += c2
      j++
    }
    if (tgt === "/dev/null") { i = j - 1; continue }
    return tgt ? "写文件的重定向（`> " + tgt + "`）" : "重定向缺目标（`>`）"
  }
  return null
}

// 引号感知地按 ; & | 换行拆段（引号里的分隔符不算）。
function shellSegments(cmd) {
  const out = []
  let cur = ""
  let quote = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      cur += ch
      if (ch === "\\" && quote === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "\\") { cur += ch; if (i + 1 < cmd.length) cur += cmd[++i]; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (";&|\n".includes(ch)) { out.push(cur); cur = ""; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

// 抠掉引号内内容（保留空格结构），用于识别「未加引号的旗标」。
function stripQuoted(cmd) {
  let out = ""
  let quote = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      if (ch === "\\" && quote === '"') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "\\") { out += cmd[i + 1] ?? ""; i++; continue }
    if (ch === '"' || ch === "'") { quote = ch; out += " "; continue }
    out += ch
  }
  return out
}

// 版本查询段：`命令名 --version`，尾部只准纯消噪（2>/dev/null、>/dev/null、2>&1）。
// 目的：放行模型查版本的日常写法，同时挡掉 `sh -c '…' --version` 这种借 $0 执行。
function isVersionQuery(seg) {
  const s = stripQuoted(seg).trim().replace(/^command\s+(?!-)/, "").replace(/^rtk\s+/, "")
  const parts = s.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return false
  if (!/^[A-Za-z0-9_./+-]+$/.test(parts[0])) return false
  if (parts[1] !== "--version") return false
  for (let i = 2; i < parts.length; i++) {
    const t = parts[i]
    if (t === "2>&1" || t === ">&2" || t === ">&-") continue
    if (/^[12&]?>>?\/dev\/null$/.test(t)) continue
    if (/^[12&]?>$/.test(t) && parts[i + 1] === "/dev/null") { i++; continue }
    return false
  }
  return true
}

function scoutShellHardNo(cmd) {
  const c = String(cmd ?? "")
  if (!c.trim()) return null
  const redirect = findFileRedirect(c)
  if (redirect) return { why: redirect, out: false }
  for (const f of SUBAGENT_FLAG_DENIES) {
    if (c.includes(f)) return { why: "禁用旗标（`" + f + "`）", out: false }
  }
  if (/--pre(=|\s)/.test(c)) return { why: "禁用旗标（`--pre`）", out: false }
  const hasVersion = /--version/.test(stripQuoted(c))
  for (const seg of shellSegments(c)) {
    if (isVersionQuery(seg)) continue
    if (hasVersion && /--version/.test(stripQuoted(seg)))
      return { why: "`--version` 只能单独查一个命令的版本（可带 2>/dev/null），禁止组合使用", out: false }
    const s = seg.replace(/^command\s+(?!-)/, "")
    const argv0 = s.replace(/^rtk\s+/, "").split(/\s+/)[0]
    if (!argv0) continue
    const a = argv0.toLowerCase()
    if (a === "tail") {
      const args = s.split(/\s+/).slice(1)
      // 任何含 f/F 的旗标都算 follow：-f、-F、-qf、--follow（会挂住一步）
      if (args.some((t) => t === "--follow" || /^-[^-]*[fF]/.test(t)))
        return { why: "tail -f / --follow（日志用 `tail -n 50`）", out: false }
    }
    if (a === "sort") {
      const args = s.split(/\s+/).slice(1)
      // -o 写输出文件；--compress-program 起子进程（含 o 的短旗标一并拒）
      if (args.some((t) => /^-[^-]*o/.test(t) || t === "--compress-program" || t.startsWith("--compress-program=")))
        return { why: "sort 的 -o / --compress-program（会写文件或起子进程）", out: false }
    }
    if (a === "uniq") {
      const args = s.split(/\s+/).slice(1)
      const pos: string[] = []
      for (let i = 0; i < args.length; i++) {
        const t = args[i]
        if (t === "--") { pos.push(...args.slice(i + 1)); break }
        if (t.startsWith("-") && t !== "-") {
          if (["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"].includes(t)) i++
          continue
        }
        pos.push(t)
      }
      // uniq [INPUT [OUTPUT]]：第二个位置参数是输出文件
      if (pos.length >= 2) return { why: "uniq 的第二个位置参数是输出文件（用管道）", out: false }
    }
    if (SUBAGENT_OUTSIDERS.has(a)) return { why: argv0, out: true }
    if (a === "git") {
      if (!/^git\s+(status|log)(\s|$)/.test(s)) return { why: "git " + (s.split(/\s+/)[1] || ""), out: true }
      continue
    }
    if (INTERPRETERS.has(a)) return { why: "解释器命令（" + argv0 + "）", out: false }
  }
  return null
}

export { findFileRedirect, shellSegments, scoutShellHardNo }

// ---------------------------------------------------------------- read-only sandbox (bwrap)
// scout 子代理的 shell 一律包进 bwrap：/ 只读、/tmp 为内存盘、进程命名空间隔离。
// frontmatter 只放行 `bwrap *`；插件没跑起来时命令不以 bwrap 开头，原生层直接拒——不会裸奔。
const SANDBOX_DENY = new Set([
  "ssh", "scp", "sftp", "rsync", "nc", "ncat", "socat", "telnet",
  "docker", "podman", "kubectl", "systemctl", "service",
  "crontab", "at", "sudo", "shutdown", "reboot", "poweroff", "halt", "init",
])
const CURL_IO_FLAGS = [
  "-o", "-O", "--output", "--remote-name", "-T", "--upload-file", "-K", "--config",
  "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form",
]
const WGET_IO_FLAGS = [
  "-O", "--output-document", "-P", "--directory-prefix",
  "--post-data", "--post-file", "--method", "--body-data", "--body-file",
]

let sandboxOK = null

function probeSandbox() {
  if (sandboxOK !== null) return sandboxOK
  try {
    if (!cpM) return (sandboxOK = false)
    const r = cpM.spawnSync(
      "bwrap",
      ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--unshare-pid", "--", "/bin/true"],
      { timeout: 5000 },
    )
    sandboxOK = r?.status === 0
  } catch {
    sandboxOK = false
  }
  S.sandbox = { ok: sandboxOK, at: Date.now() }
  sandboxDirty = true
  scheduleCounts(0)
  if (!sandboxOK) logEvent("warn", { note: "bwrap probe failed" })
  return sandboxOK
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function sandboxWrap(cmd) {
  const parts = ["bwrap", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
  for (const p of [HOME + "/.cache", HOME + "/.local/state", HOME + "/.npm"]) {
    try { if (fsM && fsM.existsSync(p)) parts.push("--tmpfs", p) } catch {}
  }
  parts.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup", "--share-net", "--", "/bin/bash", "-c")
  parts.push(shq('cd "$PWD" 2>/dev/null; ' + String(cmd)))
  return parts.join(" ")
}

// git 全局选项后取子命令（跳过 -C <path>、-c k=v、--no-pager、--git-dir=…）。
function gitSub(tokens) {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === "-C" || t === "-c") { i += 2; continue }
    if (t === "--no-pager") { i += 1; continue }
    if (t.startsWith("--git-dir=") || t.startsWith("--work-tree=")) { i += 1; continue }
    break
  }
  return (tokens[i] || "").toLowerCase()
}

function hasFlag(tokens, from, flags) {
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]
    for (const f of flags) {
      if (t === f || (f.startsWith("--") && t.startsWith(f + "="))) return true
    }
  }
  return false
}

function curlMethod(tokens, from) {
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === "-X" || t === "--request") return String(tokens[i + 1] || "")
    if (t.startsWith("--request=")) return t.slice("--request=".length)
    if (/^-X./.test(t)) return t.slice(2)
  }
  return ""
}

function sandboxDeny(cmd) {
  for (const seg of shellSegments(String(cmd ?? ""))) {
    const s = stripQuoted(seg).trim()
    if (!s) continue
    const toks = s.split(/\s+/).filter(Boolean)
    let i = 0
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++
    const a = (toks[i] || "").toLowerCase().replace(/^.*\//, "")
    if (!a) continue
    if (SANDBOX_DENY.has(a)) return a
    if (a === "git" && gitSub(toks.slice(i + 1)) === "push") return "git push"
    if (a === "curl") {
      if (hasFlag(toks, i + 1, CURL_IO_FLAGS)) return "curl 写文件/上传"
      const m = curlMethod(toks, i + 1)
      if (m && m.toUpperCase() !== "GET") return "curl 非 GET 请求"
    }
    if (a === "wget" && hasFlag(toks, i + 1, WGET_IO_FLAGS)) return "wget 落盘/上传"
  }
  return null
}

// 沙箱拦截计数记到子代理的父会话，面板才能在「本会话」下看到；
// 查不到父会话时记在子会话上。任何失败都不能影响拒绝本身。
const parentCache = new Map()
async function noteSandboxReject(sid, reason, why) {
  try {
    let pid = parentCache.get(sid)
    if (pid === undefined) {
      pid = ""
      try {
        const info = await ctxRef.session.get({ sessionID: sid })
        pid = String(info?.parentID ?? "")
      } catch {}
      parentCache.set(sid, pid)
    }
    const target = pid ? rec(pid) : rec(sid)
    await ensureLoaded(target)
    target.sandboxRejects = numOr(target.sandboxRejects, 0) + 1
    target.lastSandboxReject = { tool: "", reason, at: Date.now() }
    target.recentSandboxRejects = mergeRecent(target.recentSandboxRejects, [target.lastSandboxReject])
    touchSession(target)
    persist(target)
    logEvent("reject", { sessionID: sid, parentID: pid || undefined, agent: "scout", reason, message: why })
  } catch {}
}

function hasTailFollow(cmd) {
  for (const seg of shellSegments(String(cmd ?? ""))) {
    const s = stripQuoted(seg).trim()
    const parts = s.split(/\s+/).filter(Boolean)
    if ((parts[0] || "").toLowerCase().replace(/^.*\//, "") !== "tail") continue
    const args = parts.slice(1)
    if (args.some((t) => t === "--follow" || /^-[^-]*[fF]/.test(t))) return true
  }
  return false
}

export { sandboxWrap, sandboxDeny, probeSandbox }
// ---------------------------------------------------------------- tool hook
async function onTool(event) {
  let controlled = false
  try {
    if (!ctxRef) return
    await loadDeps()
    await refreshConfig(false)

    // 总开关：关掉后插件全部停止（直查拦截、scout 沙箱、计数与拦截记录都不再写）。
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

    // scout 子代理的 shell：只做「必拒品类」轻判并给出可执行文案，
    // 其余放行（仍由原生权限白名单兜底）。general / stock 等其它子代理一律放行。
    if (agent === "scout") {
      if (tool === "shell" || tool === "bash") {
        const raw = String(event?.input?.command ?? "")
        if (raw) {
          if (hasTailFollow(raw)) {
            const why = "tail -f / --follow（日志用 `tail -n 50`）"
            await noteSandboxReject(sid, "tail-follow", why)
            throw guardError(MSG.subagentShell(why))
          }
          const deny = sandboxDeny(raw)
          if (deny) {
            await noteSandboxReject(sid, "sandbox-side-effect", deny)
            throw guardError(MSG.sandboxDeny(deny))
          }
          if (!probeSandbox()) {
            await noteSandboxReject(sid, "sandbox-off", "bwrap 探测失败")
            throw guardError(MSG.sandboxOff())
          }
          if (event?.input && typeof event.input === "object") {
            const wrapped = sandboxWrap(raw)
            event.input.command = wrapped
            if (S.approvedShell.size > 96) S.approvedShell.clear()
            S.approvedShell.add(wrapped)
            S.approvedShell.add(shellKey(wrapped))
            logEvent("debug", { note: "sandboxed", sessionID: sid, command: raw.slice(0, 120) })
          }
        }
      }
      return
    }
    if (agent === "general" || agent === "stock") return

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
    if (err && err.__scoutGuard) throw err
    if (controlled) {
      console.warn("[scout] guard internal error:", err?.message ?? err)
      throw guardError("[scout 守卫] 内部错误，已保守拦截：" + String(err?.message ?? err).slice(0, 120))
    }
    return // never break subagent/uncontrolled traffic
  }
}

function rejectLog(r, tool, agent, kind, message) {
  r.rejected = numOr(r.rejected, 0) + 1
  r.lastReject = { tool, reason: kind, at: Date.now() }
  r.recentRejects = mergeRecent(r.recentRejects, [r.lastReject])
  touchSession(r)
  // 字段名不能叫 kind，否则会覆盖 logEvent 的事件类型
  logEvent("reject", { sessionID: r.sid, agent, tool, reason: kind, message })
}

function guardError(msg) {
  const e = new Error(msg)
  e.__scoutGuard = true
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
      console.warn("[scout] session.get failed in prompt hook:", err?.message ?? err)
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
    console.warn("[scout] prompt hook error:", err?.message ?? err)
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
        console.warn("[scout] event stream error:", err?.message ?? err)
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
      try { ctxRef.storage.remove("scout:session:" + id).catch(() => {}) } catch {}
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
  id: "scout",
  async setup(ctx) {
    ctxRef = ctx
    try {
      await loadDeps()
      await refreshConfig(true)
      const sb = probeSandbox()
      logEvent("boot", { pid: process.pid, location: ctx?.location?.directory ?? "", sandbox: sb })
      console.log("[scout] guard loaded at", ctx?.location?.directory ?? "")
    } catch (err) {
      console.warn("[scout] init:", err?.message ?? err)
    }

    try {
      await ctx.tool.hook("execute.before", onTool)
    } catch (err) {
      console.warn("[scout] tool hook unavailable:", err?.message ?? err)
    }
    try {
      await ctx.session.hook("prompt", onPrompt)
    } catch (err) {
      console.warn("[scout] prompt hook unavailable:", err?.message ?? err)
    }
    try {
      await ctx.shell.hook("create.before", onShell)
    } catch (err) {
      console.warn("[scout] shell hook unavailable:", err?.message ?? err)
    }

    const controller = new AbortController()
    subscribeLoop(ctx, controller.signal)

    return () => {
      controller.abort()
      console.log("[scout] guard unloaded")
    }
  },
}
