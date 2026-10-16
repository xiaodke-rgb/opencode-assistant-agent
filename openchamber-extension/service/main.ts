/**
 * assistant 扩展 · 本地服务
 *
 * 全部文件 IO 都在这里（panel 不申请 files/filesystem 能力，只用 sessions + service）：
 *   - 读 opencode.db（session_v2）：按 parent_id 找当前会话的子代理子会话（default chat 也可见）
 *   - 读 ~/.config/opencode/assistant-counts.json：守卫统计（拦截/派单/豁免 + 最近一条拦截）
 *   - 读写 ~/.config/opencode/assistant.json：设置（6 可调项 + exemptSessions 整场放行），原子写
 *   - /panellog：面板行为日志（联调排障用，写 ~/.config/opencode/assistant-panel.jsonl）
 *
 * 路由：
 *   GET  /health
 *   GET  /snapshot?sessionId=ses_xxx
 *   POST /config   { config: {...} }
 *   POST /exempt   { sessionId, value: true|false }
 *   POST /panellog { event, data? }
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || '';

const HOME = homedir();
const OPENCODE_DIR = join(HOME, '.config', 'opencode');
const CFG_PATH = join(OPENCODE_DIR, 'assistant.json');
const COUNTS_PATH = join(OPENCODE_DIR, 'assistant-counts.json');
const PANEL_LOG_PATH = join(OPENCODE_DIR, 'assistant-panel.jsonl');

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const BODY_MAX = 200_000;
const CHILDREN_MAX = 200;

type Config = {
  enabled: boolean;
  autoOpen: boolean;
  exemptionWord: string;
  poolPerRound: number;
  sessionTotals: { read: number; web: number; command: number };
  exemptionRoundCap: number;
  exemptSessions: Record<string, boolean>;
};

const DEFAULT_CONFIG: Config = {
  enabled: true,
  autoOpen: true,
  exemptionWord: '#nocap',
  poolPerRound: 3,
  sessionTotals: { read: 30, web: 10, command: 12 },
  exemptionRoundCap: 5,
  exemptSessions: {},
};

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function intIn(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function normalizeConfig(raw: unknown): Config {
  const cfg: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof r.enabled === 'boolean') cfg.enabled = r.enabled;
  if (typeof r.autoOpen === 'boolean') cfg.autoOpen = r.autoOpen;
  if (typeof r.exemptionWord === 'string' && r.exemptionWord.trim()) cfg.exemptionWord = r.exemptionWord.trim().slice(0, 40);
  const pool = intIn(r.poolPerRound, 0, 50);
  if (pool !== null) cfg.poolPerRound = pool;
  const totals = (r.sessionTotals && typeof r.sessionTotals === 'object' ? r.sessionTotals : {}) as Record<string, unknown>;
  for (const k of ['read', 'web', 'command'] as const) {
    const v = intIn(totals[k], 0, 10000);
    if (v !== null) cfg.sessionTotals[k] = v;
  }
  const cap = intIn(r.exemptionRoundCap, 0, 100);
  if (cap !== null) cfg.exemptionRoundCap = cap;
  if (r.exemptSessions && typeof r.exemptSessions === 'object') {
    for (const [k, v] of Object.entries(r.exemptSessions as Record<string, unknown>)) {
      if (v === true && SESSION_ID_RE.test(k)) cfg.exemptSessions[k] = true;
    }
  }
  return cfg;
}

function loadConfig(): Config {
  return normalizeConfig(readJson(CFG_PATH));
}

function writeConfigAtomic(cfg: Config): void {
  const tmp = CFG_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, CFG_PATH);
}

function findDb(): string | null {
  const fromEnv = process.env.OPENCODE_DB;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const def = join(HOME, '.local', 'share', 'opencode', 'opencode.db');
  return existsSync(def) ? def : null;
}

type Child = { id: string; title: string; created: number; agent: string };

/** 直接子会话（按 parent_id）。agent 列不存在时自动降级为空串。 */
function childrenOf(sessionId: string): Child[] {
  const dbPath = findDb();
  if (!dbPath) throw new HttpError(503, 'db-missing', '找不到 opencode.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = new Set<string>();
    try {
      for (const row of db.prepare(`PRAGMA table_info(session_v2)`).all() as Array<Record<string, unknown>>) {
        cols.add(String(row.name ?? ''));
      }
    } catch {
      /* ignore */
    }
    if (!cols.size) return [];
    const hasAgent = cols.has('agent');
    const sql = `SELECT id, title, parent_id AS parentId, time_created AS created${hasAgent ? ', agent' : ''}
                 FROM session_v2 WHERE parent_id = ? ORDER BY time_created ASC LIMIT ${CHILDREN_MAX}`;
    const rows = db.prepare(sql).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id ?? ''),
      title: typeof r.title === 'string' ? r.title : '',
      created: num(r.created),
      agent: hasAgent && typeof r.agent === 'string' ? r.agent : '',
    })).filter((c) => c.id);
  } finally {
    db.close();
  }
}

type Stats = {
  rejected: number;
  dispatched: number;
  exempted: number;
  updatedAt: number;
  lastReject: { tool?: string; reason?: string; at?: number; sessionID?: string } | null;
};

function readStats(): Stats {
  const c = (readJson(COUNTS_PATH) ?? {}) as Record<string, unknown>;
  const lr = c.lastReject && typeof c.lastReject === 'object' ? (c.lastReject as Record<string, unknown>) : null;
  return {
    rejected: num(c.rejected),
    dispatched: num(c.dispatched),
    exempted: num(c.exempted),
    updatedAt: num(c.updatedAt),
    lastReject: lr
      ? {
          tool: typeof lr.tool === 'string' ? lr.tool : undefined,
          reason: typeof lr.reason === 'string' ? lr.reason : undefined,
          at: num(lr.at),
          sessionID: typeof lr.sessionID === 'string' ? lr.sessionID : undefined,
        }
      : null,
  };
}

function panelLog(event: string, data?: unknown): void {
  try {
    appendFileSync(PANEL_LOG_PATH, JSON.stringify({ t: Date.now(), event, data: data ?? null }) + '\n');
  } catch {
    /* ignore */
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        reject(new HttpError(413, 'body-too-large', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {});
      } catch {
        reject(new HttpError(400, 'bad-json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (TOKEN) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${TOKEN}`) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (url.pathname === '/snapshot') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const sid = url.searchParams.get('sessionId') ?? '';
      if (sid && !SESSION_ID_RE.test(sid)) {
        sendJson(res, 400, { ok: false, error: 'bad-request', message: 'sessionId 无效' });
        return;
      }
      const config = loadConfig();
      let children: Child[] = [];
      let dbError: string | null = null;
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
        dbError,
      });
      return;
    }

    if (url.pathname === '/config') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const body = await readBody(req);
      const current = (readJson(CFG_PATH) ?? {}) as Record<string, unknown>;
      const patch = (body.config && typeof body.config === 'object' ? body.config : {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = {
        ...DEFAULT_CONFIG,
        ...current,
        ...patch,
        sessionTotals: {
          ...DEFAULT_CONFIG.sessionTotals,
          ...((current.sessionTotals as Record<string, unknown>) ?? {}),
          ...((patch.sessionTotals as Record<string, unknown>) ?? {}),
        },
        exemptSessions: {
          ...((current.exemptSessions as Record<string, unknown>) ?? {}),
          ...((patch.exemptSessions as Record<string, unknown>) ?? {}),
        },
      };
      const next = normalizeConfig(merged);
      writeConfigAtomic(next);
      panelLog('config-saved', { enabled: next.enabled, autoOpen: next.autoOpen, poolPerRound: next.poolPerRound });
      sendJson(res, 200, { ok: true, config: next });
      return;
    }

    if (url.pathname === '/exempt') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const body = await readBody(req);
      const sid = String(body.sessionId ?? '');
      const value = body.value === true;
      if (!SESSION_ID_RE.test(sid)) {
        sendJson(res, 400, { ok: false, error: 'bad-request', message: 'sessionId 无效' });
        return;
      }
      const current = (readJson(CFG_PATH) ?? {}) as Record<string, unknown>;
      const exempt: Record<string, boolean> = { ...((current.exemptSessions as Record<string, boolean>) ?? {}) };
      if (value) exempt[sid] = true;
      else delete exempt[sid];
      const next = normalizeConfig({ ...current, exemptSessions: exempt });
      writeConfigAtomic(next);
      panelLog('exempt-toggle', { sessionId: sid, value });
      sendJson(res, 200, { ok: true, config: next });
      return;
    }

    if (url.pathname === '/panellog') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const body = await readBody(req);
      panelLog(String(body.event ?? 'event').slice(0, 80), body.data);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not-found' });
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: 'internal', message });
  }
}

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[assistant-ext] service listening on 127.0.0.1:${PORT}`);
});
