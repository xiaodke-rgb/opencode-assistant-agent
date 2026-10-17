/**
 * assistant 面板（纯设置 + 统计）
 *
 * - 头顶三行：本会话直查统计（直查拦截 / 派单 / 豁免）、沙箱状态与拦截、
 *   本会话直查余额（读/网/命令剩余 · 豁免剩余），数据来自插件写的
 *   `~/.config/opencode/assistant-counts.json`（v2：按会话分片 + sandbox 状态）
 * - 设置分两块：assistant 沙箱（总开关）；plan 直查额度（豁免词 / 每轮直查额度 /
 *   会话总额（读·网·命令）/ 豁免轮次上限 + 本会话「整场放行」）
 *   ——全部直接读写 `~/.config/opencode/assistant.json`
 * - 无后台服务、无联动、无子代理列表：面板只用宿主的文件能力（filesystem）
 *
 * 面板折叠后仍挂载（宿主行为），所以统计会继续刷新（5s 一次，文件很小）。
 */
import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBanner,
  mountButton,
  mountSwitch,
  mountTextField,
  type BannerHandle,
  type ButtonHandle,
  type SwitchHandle,
  type TextFieldHandle,
} from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root') as HTMLElement;

const CONFIG_PATH = '~/.config/opencode/assistant.json';
const COUNTS_PATH = '~/.config/opencode/assistant-counts.json';
const POLL_MS = 5000;

type Totals = { read: number; web: number; command: number };
type Config = {
  enabled: boolean;
  exemptionWord: string;
  poolPerRound: number;
  sessionTotals: Totals;
  exemptionRoundCap: number;
  exemptSessions: Record<string, boolean>;
};
type RejectRec = { tool?: string; reason?: string; at?: number };
type SessionStats = {
  rejected: number;
  dispatched: number;
  exempted: number;
  sandboxRejects: number;
  used: Totals;
  updatedAt: number;
  lastReject: RejectRec | null;
  lastSandboxReject: RejectRec | null;
};
type SandboxState = { ok?: boolean; at?: number };
type CountsFile = {
  v?: number;
  updatedAt?: number;
  sessions?: Record<string, unknown>;
  sandbox?: SandboxState;
};

/** 与插件的默认值一致；配置文件缺失/字段缺失时兜底。 */
const DEFAULT_CONFIG: Config = {
  enabled: true,
  exemptionWord: '#nocap',
  poolPerRound: 3,
  sessionTotals: { read: 30, web: 10, command: 12 },
  exemptionRoundCap: 5,
  exemptSessions: {},
};

const REASON_LABEL: Record<string, string> = {
  direct: '直接拒',
  build: '施工类',
  pool: '额度用尽',
  total: '总额用尽',
  unknown: '未列工具',
  'sandbox-side-effect': '外部副作用',
  'tail-follow': 'tail -f',
  'sandbox-off': '沙箱不可用',
};

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let built = false;
let sessionId: string | null = null;
let sessionTitle: string | null = null;
let config: Config = clone(DEFAULT_CONFIG);
/** 设置区可编辑的字段（exemptSessions 不在草稿里，避免与「整场放行」互相覆盖）。 */
let draft: {
  enabled: boolean;
  exemptionWord: string;
  poolPerRound: number;
  read: number;
  web: number;
  command: number;
  exemptionRoundCap: number;
} | null = null;
let dirty = false;
let saving = false;
let polling = false;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function fmtTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function intOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

/** 把文件里读到的内容规整成完整 Config（未知键丢弃，缺失键取默认）。 */
function normalizeConfig(raw: unknown): Config {
  const d = DEFAULT_CONFIG;
  if (!raw || typeof raw !== 'object') return clone(d);
  const r = raw as Record<string, unknown>;
  const totals = (r.sessionTotals ?? {}) as Record<string, unknown>;
  const exemptIn = (r.exemptSessions ?? {}) as Record<string, unknown>;
  const exempt: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(exemptIn)) {
    if (v === true && /^[A-Za-z0-9_-]{1,80}$/.test(k)) exempt[k] = true;
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    exemptionWord: typeof r.exemptionWord === 'string' && r.exemptionWord.trim() ? r.exemptionWord : d.exemptionWord,
    poolPerRound: intOr(r.poolPerRound, d.poolPerRound),
    sessionTotals: {
      read: intOr(totals.read, d.sessionTotals.read),
      web: intOr(totals.web, d.sessionTotals.web),
      command: intOr(totals.command, d.sessionTotals.command),
    },
    exemptionRoundCap: intOr(r.exemptionRoundCap, d.exemptionRoundCap),
    exemptSessions: exempt,
  };
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

let statsEl!: HTMLElement;
let sandboxEl!: HTMLElement;
let balanceEl!: HTMLElement;
let saveStateEl!: HTMLElement;
let exemptNoteEl: HTMLElement | null = null;
let bannerWrap!: HTMLElement;
let bannerHandle: BannerHandle | null = null;
let bannerText = '';

let saveBtn: ButtonHandle | null = null;
let exemptBtn: ButtonHandle | null = null;
let swEnabled: SwitchHandle | null = null;
let tfWord: TextFieldHandle | null = null;
let tfPool: TextFieldHandle | null = null;
let tfRead: TextFieldHandle | null = null;
let tfWeb: TextFieldHandle | null = null;
let tfCmd: TextFieldHandle | null = null;
let tfCap: TextFieldHandle | null = null;

function setBanner(tone: 'info' | 'warning' | 'error', title: string, body: string): void {
  const key = `${tone}|${title}|${body}`;
  if (bannerHandle && bannerText === key) return;
  bannerText = key;
  if (bannerHandle) bannerHandle.update({ tone, title, body });
  else bannerHandle = mountBanner(bannerWrap, { tone, title, body });
}

function clearBanner(): void {
  if (!bannerHandle) return;
  bannerHandle.dispose();
  bannerHandle = null;
  bannerText = '';
}

function buildDom(): void {
  if (built) return;
  built = true;
  root.innerHTML = '';

  const hd = el('div', 'hd');
  hd.append(el('h1', '', 'assistant 守卫'));
  statsEl = el('div', 'stats muted', '本会话：统计加载中…');
  sandboxEl = el('div', 'stats muted', '沙箱：状态未知');
  balanceEl = el('div', 'stats muted', '');
  hd.append(statsEl, sandboxEl, balanceEl);
  root.append(hd);

  bannerWrap = el('div');
  root.append(bannerWrap);

  const sandboxSec = el('div', 'section');
  sandboxSec.append(
    el('div', 'section-title', 'assistant 沙箱'),
    el('div', 'muted', '只影响 assistant 子代理的 shell；总开关关掉后沙箱仍生效。'),
  );
  const sbWrap = el('div', 'settings');
  buildSandboxSettings(sbWrap);
  sandboxSec.append(sbWrap);
  root.append(sandboxSec);

  const quotaSec = el('div', 'section');
  quotaSec.append(
    el('div', 'section-title', 'plan 直查额度'),
    el('div', 'muted', `改完点保存，写入 ${CONFIG_PATH}；插件每轮重读。`),
  );
  const wrap = el('div', 'settings');
  buildQuotaSettings(wrap);
  quotaSec.append(wrap);
  root.append(quotaSec);
}

function markDirty(): void {
  dirty = true;
  saveBtn?.update({ disabled: false });
  if (saveStateEl) saveStateEl.textContent = '有未保存更改';
}

function buildSandboxSettings(wrap: HTMLElement): void {
  swEnabled = mountSwitch(wrap, {
    label: '插件总开关',
    description: '关掉后 plan / build 直查不再拦截；assistant 只读沙箱始终生效',
    checked: true,
    onChange: (v) => {
      if (draft) draft.enabled = v;
      markDirty();
    },
  });
}

function buildQuotaSettings(wrap: HTMLElement): void {
  tfWord = mountTextField(wrap, {
    label: '豁免词',
    placeholder: '#nocap',
    value: '',
    onChange: (v) => {
      if (draft) draft.exemptionWord = v;
      markDirty();
    },
  });

  tfPool = mountTextField(wrap, {
    label: '每轮直查额度（次）',
    helper: '默认 3',
    value: '',
    onChange: (v) => {
      if (draft) draft.poolPerRound = v.trim() === '' ? NaN : Number(v);
      markDirty();
    },
  });

  const row = el('div', 'row3');
  wrap.append(row);
  tfRead = mountTextField(row, {
    label: '总额·读',
    value: '',
    onChange: (v) => {
      if (draft) draft.read = v.trim() === '' ? NaN : Number(v);
      markDirty();
    },
  });
  tfWeb = mountTextField(row, {
    label: '总额·网',
    value: '',
    onChange: (v) => {
      if (draft) draft.web = v.trim() === '' ? NaN : Number(v);
      markDirty();
    },
  });
  tfCmd = mountTextField(row, {
    label: '总额·命令',
    value: '',
    onChange: (v) => {
      if (draft) draft.command = v.trim() === '' ? NaN : Number(v);
      markDirty();
    },
  });

  tfCap = mountTextField(wrap, {
    label: '豁免轮次上限（轮）',
    helper: '默认 5',
    value: '',
    onChange: (v) => {
      if (draft) draft.exemptionRoundCap = v.trim() === '' ? NaN : Number(v);
      markDirty();
    },
  });

  const saveRow = el('div', 'save-row');
  saveBtn = mountButton(saveRow, { label: '保存', variant: 'default', disabled: true, onClick: () => void save() });
  saveStateEl = el('span', 'save-state', '');
  saveRow.append(saveStateEl);
  wrap.append(saveRow);

  const exemptRow = el('div', 'save-row');
  exemptBtn = mountButton(exemptRow, {
    label: '整场放行：关',
    variant: 'secondary',
    disabled: true,
    onClick: () => void toggleExempt(),
  });
  exemptRow.append(el('span', 'save-state', '本会话全部直查不计数（插件侧即刻生效）'));
  wrap.append(exemptRow);

  // 「整场放行」作用于哪个会话——面板跟随宿主当前打开的会话，foo/bar 容易混，显式标出来。
  exemptNoteEl = el('div', 'muted', '');
  wrap.append(exemptNoteEl);
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function rejectText(lr: RejectRec): string {
  const raw = (lr.tool ?? '').trim();
  const label = lr.reason ? REASON_LABEL[lr.reason] ?? lr.reason : '';
  // 只显示短工具名；旧记录里可能是整段提示词，宁可不显示。
  const tool = raw.length <= 24 && raw !== (lr.reason ?? '') ? raw : '';
  const head = tool && label ? `${tool}（${label}）` : tool || label;
  return `${head} ${fmtTime(lr.at ?? 0)}`.trim();
}

/** 上两行看本会话（直查拦截 + 沙箱拦截），末行是本会话直查余额。 */
function renderStats(
  sessions: Record<string, SessionStats> | null,
  sandbox: SandboxState | null,
  cfg: Config,
): void {
  if (!statsEl) return;
  const s = sessionId ? sessions?.[sessionId] : undefined;
  const rejected = s?.rejected ?? 0;
  const dispatched = s?.dispatched ?? 0;
  const exempted = s?.exempted ?? 0;
  const lr = s?.lastReject ?? null;

  let text = sessionId ? `本会话：直查拦截 ${rejected} · 派单 ${dispatched} · 豁免 ${exempted}` : '本会话：未绑定会话';
  if (lr) text += ` · 最近 ${rejectText(lr)}`;
  statsEl.textContent = text;

  if (sandboxEl) {
    const sbRejected = s?.sandboxRejects ?? 0;
    const sbLast = s?.lastSandboxReject ?? null;
    const state = sandbox ? (sandbox.ok ? '正常' : '不可用') : '未知';
    let sb = `沙箱：${state}`;
    if (sandbox?.at) sb += ` ${fmtTime(sandbox.at)}`;
    sb += ` · 拦截 ${sbRejected}`;
    if (sbLast) sb += ` · 最近 ${rejectText(sbLast)}`;
    sandboxEl.textContent = sb;
  }

  if (!balanceEl) return;
  const used = s?.used ?? { read: 0, web: 0, command: 0 };
  const rem = (total: number, u: number): string => `${Math.max(0, total - u)}/${total}`;
  balanceEl.textContent =
    `直查余额：读 ${rem(cfg.sessionTotals.read, used.read)}` +
    ` · 网 ${rem(cfg.sessionTotals.web, used.web)}` +
    ` · 命令 ${rem(cfg.sessionTotals.command, used.command)}` +
    ` · 豁免 ${rem(cfg.exemptionRoundCap, exempted)}`;
}

function applyConfig(cfg: Config, force: boolean): void {
  config = cfg;
  if (!draft) {
    draft = draftFrom(cfg);
    dirty = false;
  } else if (!force && dirty) {
    renderExempt(cfg.exemptSessions[sessionId ?? ''] === true);
    return; // 用户正在编辑，别覆盖
  } else {
    draft = draftFrom(cfg);
  }
  const d = draft;
  swEnabled?.update({ checked: d.enabled });
  tfWord?.update({ value: d.exemptionWord });
  tfPool?.update({ value: String(d.poolPerRound) });
  tfRead?.update({ value: String(d.read) });
  tfWeb?.update({ value: String(d.web) });
  tfCmd?.update({ value: String(d.command) });
  tfCap?.update({ value: String(d.exemptionRoundCap) });
  if (force) dirty = false;
  saveBtn?.update({ disabled: !dirty });
  if (!dirty && saveStateEl) saveStateEl.textContent = '';
  renderExempt(cfg.exemptSessions[sessionId ?? ''] === true);
}

function draftFrom(cfg: Config): NonNullable<typeof draft> {
  return {
    enabled: cfg.enabled,
    exemptionWord: cfg.exemptionWord,
    poolPerRound: cfg.poolPerRound,
    read: cfg.sessionTotals.read,
    web: cfg.sessionTotals.web,
    command: cfg.sessionTotals.command,
    exemptionRoundCap: cfg.exemptionRoundCap,
  };
}

function sessionLabel(): string {
  if (!sessionId) return '未绑定会话';
  const tail = sessionId.length > 10 ? `…${sessionId.slice(-8)}` : sessionId;
  const title = (sessionTitle ?? '').trim();
  return title ? `${title}（${tail}）` : tail;
}

function renderExempt(on: boolean): void {
  exemptBtn?.update({
    label: on ? '整场放行：开' : '整场放行：关',
    variant: on ? 'outline' : 'secondary',
    disabled: !sessionId,
  });
  if (exemptNoteEl) {
    exemptNoteEl.textContent = sessionId
      ? `绑定会话：${sessionLabel()}`
      : '绑定会话：（面板尚未拿到当前会话 id）';
  }
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

function errText(err: unknown): string {
  if (err instanceof HostRequestError) return err.code;
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return err instanceof HostRequestError && (err.code === 'NOT_FOUND' || err.code === 'NO_FILE');
}

async function readConfigFile(): Promise<{ cfg: Config; missing: boolean }> {
  try {
    const res = await host.readFile(CONFIG_PATH);
    return { cfg: normalizeConfig(JSON.parse(res.content)), missing: false };
  } catch (err) {
    if (isNotFound(err)) return { cfg: clone(DEFAULT_CONFIG), missing: true };
    throw err;
  }
}

function normReject(raw: unknown): RejectRec | null {
  const lr = (raw ?? null) as Record<string, unknown> | null;
  if (!lr) return null;
  return {
    tool: typeof lr.tool === 'string' ? lr.tool : undefined,
    reason: typeof lr.reason === 'string' ? lr.reason : undefined,
    at: intOr(lr.at, 0),
  };
}

function normalizeSessionStats(raw: unknown): SessionStats {
  const r = (raw ?? {}) as Record<string, unknown>;
  const used = (r.used ?? {}) as Record<string, unknown>;
  return {
    rejected: intOr(r.rejected, 0),
    dispatched: intOr(r.dispatched, 0),
    exempted: intOr(r.exempted, 0),
    sandboxRejects: intOr(r.sandboxRejects, 0),
    used: {
      read: intOr(used.read, 0),
      web: intOr(used.web, 0),
      command: intOr(used.command, 0),
    },
    updatedAt: intOr(r.updatedAt, 0),
    lastReject: normReject(r.lastReject),
    lastSandboxReject: normReject(r.lastSandboxReject),
  };
}

/** 读统计文件（v2：按会话分片）。缺失/旧版/损坏都返回空表（显示零）。 */
async function readCountsFile(): Promise<{ sessions: Record<string, SessionStats>; sandbox: SandboxState | null }> {
  try {
    const res = await host.readFile(COUNTS_PATH);
    const raw = JSON.parse(res.content) as CountsFile;
    const out: Record<string, SessionStats> = {};
    const sessions = raw?.sessions;
    if (sessions && typeof sessions === 'object') {
      for (const [sid, rec] of Object.entries(sessions)) out[sid] = normalizeSessionStats(rec);
    }
    const sb = raw?.sandbox;
    return { sessions: out, sandbox: sb && typeof sb === 'object' ? sb : null };
  } catch {
    return { sessions: {}, sandbox: null };
  }
}

async function writeConfigFile(cfg: Config): Promise<void> {
  await host.writeFile(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  if (!built || polling) return;
  polling = true;
  try {
    const [cfgRes, counts] = await Promise.all([readConfigFile(), readCountsFile()]);
    if (cfgRes.missing) {
      setBanner('info', '还没有配置文件', `保存一次即可创建 ${CONFIG_PATH}（当前显示默认值）`);
    } else {
      clearBanner();
    }
    applyConfig(cfgRes.cfg, false);
    renderStats(counts.sessions, counts.sandbox, config);
  } catch (err) {
    setBanner('warning', '读配置失败', `${errText(err)} · ${CONFIG_PATH}`);
  } finally {
    polling = false;
  }
}

async function save(): Promise<void> {
  if (!draft || saving) return;
  const d = draft;
  const bad: string[] = [];
  const okInt = (v: number, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;
  if (!okInt(d.poolPerRound, 0, 50)) bad.push('每轮池');
  if (!okInt(d.read, 0, 10000)) bad.push('总额·读');
  if (!okInt(d.web, 0, 10000)) bad.push('总额·网');
  if (!okInt(d.command, 0, 10000)) bad.push('总额·命令');
  if (!okInt(d.exemptionRoundCap, 0, 100)) bad.push('豁免轮次上限');
  if (!d.exemptionWord.trim()) bad.push('豁免词');
  if (bad.length) {
    if (saveStateEl) saveStateEl.textContent = `检查：${bad.join('、')}`;
    return;
  }
  saving = true;
  saveBtn?.update({ loading: true });
  try {
    const next: Config = {
      enabled: d.enabled,
      exemptionWord: d.exemptionWord.trim(),
      poolPerRound: d.poolPerRound,
      sessionTotals: { read: d.read, web: d.web, command: d.command },
      exemptionRoundCap: d.exemptionRoundCap,
      exemptSessions: config.exemptSessions,
    };
    await writeConfigFile(next);
    applyConfig(next, true);
    if (saveStateEl) saveStateEl.textContent = '已保存';
    void host.toast({ kind: 'success', message: 'assistant 设置已保存' }).catch(() => {});
  } catch (err) {
    if (saveStateEl) saveStateEl.textContent = `保存失败：${errText(err)}`;
  } finally {
    saving = false;
    saveBtn?.update({ loading: false, disabled: !dirty });
  }
}

async function toggleExempt(): Promise<void> {
  if (!sessionId) return;
  const on = config.exemptSessions[sessionId] === true;
  const nextMap = { ...config.exemptSessions };
  if (on) delete nextMap[sessionId];
  else nextMap[sessionId] = true;
  const next: Config = { ...config, exemptSessions: nextMap };
  exemptBtn?.update({ loading: true });
  try {
    await writeConfigFile(next);
    applyConfig(next, true);
  } catch (err) {
    if (saveStateEl) saveStateEl.textContent = `整场放行失败：${errText(err)}`;
  } finally {
    exemptBtn?.update({ loading: false });
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function attachSession(id: string | null, title: string | null): void {
  const changed = id !== sessionId;
  sessionId = id;
  sessionTitle = title ?? null;
  if (!built) return;
  renderExempt(config.exemptSessions[id ?? ''] === true);
  if (changed) void poll();
}

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  buildDom();
  attachSession(ctx.session?.id ?? null, ctx.session?.title ?? null);
  void poll();
});

host.onSession((snapshot) => {
  if (!built) return;
  attachSession(snapshot?.id ?? null, snapshot?.title ?? null);
});

setInterval(() => {
  void poll();
}, POLL_MS);

setTimeout(() => {
  if (!built) buildDom();
}, 1500);
