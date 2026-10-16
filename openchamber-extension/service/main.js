"use strict";

// service/main.ts
var import_node_http = require("node:http");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_sqlite = require("node:sqlite");
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || "";
var HOME = (0, import_node_os.homedir)();
var OPENCODE_DIR = (0, import_node_path.join)(HOME, ".config", "opencode");
var CFG_PATH = (0, import_node_path.join)(OPENCODE_DIR, "assistant.json");
var COUNTS_PATH = (0, import_node_path.join)(OPENCODE_DIR, "assistant-counts.json");
var PANEL_LOG_PATH = (0, import_node_path.join)(OPENCODE_DIR, "assistant-panel.jsonl");
var SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
var BODY_MAX = 2e5;
var CHILDREN_MAX = 200;
var DEFAULT_CONFIG = {
  enabled: true,
  autoOpen: true,
  exemptionWord: "#nocap",
  poolPerRound: 3,
  sessionTotals: { read: 30, web: 10, command: 12 },
  exemptionRoundCap: 5,
  exemptSessions: {}
};
var HttpError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
function readJson(path) {
  try {
    return JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
  } catch {
    return null;
  }
}
function intIn(v, min, max) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
function normalizeConfig(raw) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const r = raw && typeof raw === "object" ? raw : {};
  if (typeof r.enabled === "boolean") cfg.enabled = r.enabled;
  if (typeof r.autoOpen === "boolean") cfg.autoOpen = r.autoOpen;
  if (typeof r.exemptionWord === "string" && r.exemptionWord.trim()) cfg.exemptionWord = r.exemptionWord.trim().slice(0, 40);
  const pool = intIn(r.poolPerRound, 0, 50);
  if (pool !== null) cfg.poolPerRound = pool;
  const totals = r.sessionTotals && typeof r.sessionTotals === "object" ? r.sessionTotals : {};
  for (const k of ["read", "web", "command"]) {
    const v = intIn(totals[k], 0, 1e4);
    if (v !== null) cfg.sessionTotals[k] = v;
  }
  const cap = intIn(r.exemptionRoundCap, 0, 100);
  if (cap !== null) cfg.exemptionRoundCap = cap;
  if (r.exemptSessions && typeof r.exemptSessions === "object") {
    for (const [k, v] of Object.entries(r.exemptSessions)) {
      if (v === true && SESSION_ID_RE.test(k)) cfg.exemptSessions[k] = true;
    }
  }
  return cfg;
}
function loadConfig() {
  return normalizeConfig(readJson(CFG_PATH));
}
function writeConfigAtomic(cfg) {
  const tmp = CFG_PATH + ".tmp";
  (0, import_node_fs.writeFileSync)(tmp, JSON.stringify(cfg, null, 2) + "\n");
  (0, import_node_fs.renameSync)(tmp, CFG_PATH);
}
function findDb() {
  const fromEnv = process.env.OPENCODE_DB;
  if (fromEnv) return (0, import_node_fs.existsSync)(fromEnv) ? fromEnv : null;
  const def = (0, import_node_path.join)(HOME, ".local", "share", "opencode", "opencode.db");
  return (0, import_node_fs.existsSync)(def) ? def : null;
}
function childrenOf(sessionId) {
  const dbPath = findDb();
  if (!dbPath) throw new HttpError(503, "db-missing", "\u627E\u4E0D\u5230 opencode.db");
  const db = new import_node_sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = /* @__PURE__ */ new Set();
    try {
      for (const row of db.prepare(`PRAGMA table_info(session_v2)`).all()) {
        cols.add(String(row.name ?? ""));
      }
    } catch {
    }
    if (!cols.size) return [];
    const hasAgent = cols.has("agent");
    const sql = `SELECT id, title, parent_id AS parentId, time_created AS created${hasAgent ? ", agent" : ""}
                 FROM session_v2 WHERE parent_id = ? ORDER BY time_created ASC LIMIT ${CHILDREN_MAX}`;
    const rows = db.prepare(sql).all(sessionId);
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      title: typeof r.title === "string" ? r.title : "",
      created: num(r.created),
      agent: hasAgent && typeof r.agent === "string" ? r.agent : ""
    })).filter((c) => c.id);
  } finally {
    db.close();
  }
}
function readStats() {
  const c = readJson(COUNTS_PATH) ?? {};
  const lr = c.lastReject && typeof c.lastReject === "object" ? c.lastReject : null;
  return {
    rejected: num(c.rejected),
    dispatched: num(c.dispatched),
    exempted: num(c.exempted),
    updatedAt: num(c.updatedAt),
    lastReject: lr ? {
      tool: typeof lr.tool === "string" ? lr.tool : void 0,
      reason: typeof lr.reason === "string" ? lr.reason : void 0,
      at: num(lr.at),
      sessionID: typeof lr.sessionID === "string" ? lr.sessionID : void 0
    } : null
  };
}
function panelLog(event, data) {
  try {
    (0, import_node_fs.appendFileSync)(PANEL_LOG_PATH, JSON.stringify({ t: Date.now(), event, data: data ?? null }) + "\n");
  } catch {
  }
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        reject(new HttpError(413, "body-too-large", "\u8BF7\u6C42\u4F53\u8FC7\u5927"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new HttpError(400, "bad-json", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON"));
      }
    });
    req.on("error", reject);
  });
}
async function handle(req, res) {
  try {
    if (TOKEN) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${TOKEN}`) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (url.pathname === "/snapshot") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        return;
      }
      const sid = url.searchParams.get("sessionId") ?? "";
      if (sid && !SESSION_ID_RE.test(sid)) {
        sendJson(res, 400, { ok: false, error: "bad-request", message: "sessionId \u65E0\u6548" });
        return;
      }
      const config = loadConfig();
      let children = [];
      let dbError = null;
      if (sid) {
        try {
          children = childrenOf(sid);
        } catch (err) {
          dbError = err instanceof Error ? err.message : String(err);
        }
      }
      sendJson(res, 200, {
        ok: true,
        now: Date.now(),
        config,
        stats: readStats(),
        children,
        exempt: sid ? config.exemptSessions[sid] === true : false,
        dbError
      });
      return;
    }
    if (url.pathname === "/config") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        return;
      }
      const body = await readBody(req);
      const current = readJson(CFG_PATH) ?? {};
      const patch = body.config && typeof body.config === "object" ? body.config : {};
      const merged = {
        ...DEFAULT_CONFIG,
        ...current,
        ...patch,
        sessionTotals: {
          ...DEFAULT_CONFIG.sessionTotals,
          ...current.sessionTotals ?? {},
          ...patch.sessionTotals ?? {}
        },
        exemptSessions: {
          ...current.exemptSessions ?? {},
          ...patch.exemptSessions ?? {}
        }
      };
      const next = normalizeConfig(merged);
      writeConfigAtomic(next);
      panelLog("config-saved", { enabled: next.enabled, autoOpen: next.autoOpen, poolPerRound: next.poolPerRound });
      sendJson(res, 200, { ok: true, config: next });
      return;
    }
    if (url.pathname === "/exempt") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        return;
      }
      const body = await readBody(req);
      const sid = String(body.sessionId ?? "");
      const value = body.value === true;
      if (!SESSION_ID_RE.test(sid)) {
        sendJson(res, 400, { ok: false, error: "bad-request", message: "sessionId \u65E0\u6548" });
        return;
      }
      const current = readJson(CFG_PATH) ?? {};
      const exempt = { ...current.exemptSessions ?? {} };
      if (value) exempt[sid] = true;
      else delete exempt[sid];
      const next = normalizeConfig({ ...current, exemptSessions: exempt });
      writeConfigAtomic(next);
      panelLog("exempt-toggle", { sessionId: sid, value });
      sendJson(res, 200, { ok: true, config: next });
      return;
    }
    if (url.pathname === "/panellog") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        return;
      }
      const body = await readBody(req);
      panelLog(String(body.event ?? "event").slice(0, 80), body.data);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not-found" });
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: "internal", message });
  }
}
var server = (0, import_node_http.createServer)((req, res) => {
  void handle(req, res);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[assistant-ext] service listening on 127.0.0.1:${PORT}`);
});
