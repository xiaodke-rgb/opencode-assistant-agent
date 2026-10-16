/**
 * assistant 面板
 *
 * - 头顶：守卫统计一行（拦截 / 派单 / 豁免 + 最近一条拦截）
 * - 子代理列表：当前会话的子代理子会话，点一下跳过去
 * - 联动（核心）：1.5s 轮询本地服务；新子会话出现 → 自动 host.openSession 弹出
 *   规则：只跳批量里第一个；两次自动跳间隔 ≥ 20s；联动开关关闭即停；NO_SESSION 静默跳过
 * - 设置：6 个可调项 + 本会话「整场放行」→ 写 ~/.config/opencode/assistant.json
 *
 * 面板折叠仍挂载（宿主行为），所以隐藏时联动照跑。
 */
import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBanner,
  mountButton,
  mountList,
  mountSwitch,
  mountTextField,
  type BannerHandle,
  type ButtonHandle,
  type ListHandle,
  type SwitchHandle,
  type TextFieldHandle,
} from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root') as HTMLElement;

const POLL_MS = 1500;
const AUTO_COOLDOWN_MS = 20_000;
const BASE_SLACK_MS = 3_000;

type Config = {
  enabled: boolean;
  autoOpen: boolean;
  exemptionWord: string;
  poolPerRound: number;
  sessionTotals: { read: number; web: number; command: number };
  exemptionRoundCap: number;
  exemptSessions: Record<string, boolean>;
};
type Stats = {
  rejected: number;
  dispatched: number;
  exempted: number;
  updatedAt: number;
  lastReject: { tool?: string; reason?: string; at?: number; sessionID?: string } | null;
};
type Child = { id: string; title: string; created: number; agent: string };
type Snapshot = {
  ok: true;
  now: number;
  config: Config;
  stats: Stats;
  children: Child[];
  exempt: boolean;
  dbError: string | null;
};

const REASON_LABEL: Record<string, string> = {
  direct: '直接拒',
  build: '施工类',
  pool: '额度用尽',
  total: '总额用尽',
  unknown: '未列工具',
};

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let built = false;
let sessionId: string | null = null;
let baseAt = 0;
let seen = new Set<string>();
let lastAutoAt = 0;
let draft: Config | null = null;
let dirty = false;
let saving = false;
let polling = false;
let current: Snapshot | null = null;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function agentLabel(agent: string): string {
  return agent || '子代理';
}

function log(event: string, data?: unknown): void {
  void host
    .serviceRequest({ method: 'POST', path: '/panellog', body: JSON.stringify({ event, data: data ?? null }) })
    .catch(() => {});
}

let bannerWrap: HTMLElement;
let bannerHandle: BannerHandle | null = null;
let bannerText = '';

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

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

let statsEl!: HTMLElement;
let childrenTitleEl!: HTMLElement;
let childrenWrap!: HTMLElement;
let saveStateEl!: HTMLElement;

let listHandle: ListHandle | null = null;
let saveBtn: ButtonHandle | null = null;
let exemptBtn: ButtonHandle | null = null;
let swEnabled: SwitchHandle | null = null;
let swAuto: SwitchHandle | null = null;
let tfWord: TextFieldHandle | null = null;
let tfPool: TextFieldHandle | null = null;
let tfRead: TextFieldHandle | null = null;
let tfWeb: TextFieldHandle | null = null;
let tfCmd: TextFieldHandle | null = null;
let tfCap: TextFieldHandle | null = null;

function buildDom(): void {
  if (built) return;
  built = true;
  root.innerHTML = '';

  const hd = el('div', 'hd');
  hd.append(el('h1', '', 'assistant 守卫'));
  statsEl = el('div', 'stats muted');
  hd.append(statsEl);
  root.append(hd);

  bannerWrap = el('div');
  root.append(bannerWrap);

  const cSec = el('div', 'section');
  childrenTitleEl = el('div', 'section-title', '子代理');
  childrenWrap = el('div');
  cSec.append(childrenTitleEl, childrenWrap);
  root.append(cSec);

  const sSec = el('div', 'section');
  sSec.append(el('div', 'section-title', '设置'), el('div', 'muted', '改完点保存；插件每轮 prompt 时重读配置。'));
  const wrap = el('div', 'settings');
  buildSettings(wrap);
  sSec.append(wrap);
  root.append(sSec);

  renderPlaceholder();
}

function buildSettings(wrap: HTMLElement): void {
  const mark = (): void => {
    dirty = true;
    if (saveBtn) saveBtn.update({ disabled: false });
    saveStateEl.textContent = '有未保存更改';
  };

  swEnabled = mountSwitch(wrap, {
    label: '插件总开关',
    description: '关掉后守卫不再拦截（plan / build 全放行）',
    checked: true,
    onChange: (v) => {
      if (draft) draft.enabled = v;
      mark();
    },
  });

  swAuto = mountSwitch(wrap, {
    label: '派单联动（自动弹子代理会话）',
    description: '新子代理出现即弹出；20 秒内只跳第一个',
    checked: true,
    onChange: (v) => {
      if (draft) draft.autoOpen = v;
      mark();
    },
  });

  tfWord = mountTextField(wrap, {
    label: '豁免词',
    placeholder: '#nocap',
    value: '',
    onChange: (v) => {
      if (draft) draft.exemptionWord = v;
      mark();
    },
  });

  tfPool = mountTextField(wrap, {
    label: '每轮直查额度（次）',
    helper: '默认 3',
    value: '',
    onChange: (v) => {
      if (draft) draft.poolPerRound = v.trim() === '' ? NaN : Number(v);
      mark();
    },
  });

  const row = el('div', 'row3');
  wrap.append(row);
  tfRead = mountTextField(row, {
    label: '总额·读',
    value: '',
    onChange: (v) => {
      if (draft) draft.sessionTotals.read = v.trim() === '' ? NaN : Number(v);
      mark();
    },
  });
  tfWeb = mountTextField(row, {
    label: '总额·网',
    value: '',
    onChange: (v) => {
      if (draft) draft.sessionTotals.web = v.trim() === '' ? NaN : Number(v);
      mark();
    },
  });
  tfCmd = mountTextField(row, {
    label: '总额·命令',
    value: '',
    onChange: (v) => {
      if (draft) draft.sessionTotals.command = v.trim() === '' ? NaN : Number(v);
      mark();
    },
  });

  tfCap = mountTextField(wrap, {
    label: '豁免轮次上限（轮）',
    helper: '默认 5',
    value: '',
    onChange: (v) => {
      if (draft) draft.exemptionRoundCap = v.trim() === '' ? NaN : Number(v);
      mark();
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
}

function renderPlaceholder(): void {
  if (!built) return;
  childrenTitleEl.textContent = sessionId ? '子代理' : '子代理（未打开会话）';
  if (!sessionId && statsEl) statsEl.textContent = '未打开会话 · 设置仍可编辑';
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderStats(stats: Stats): void {
  if (!statsEl) return;
  const lr = stats.lastReject;
  let text = `拦截 ${stats.rejected} · 派单 ${stats.dispatched} · 豁免 ${stats.exempted}`;
  if (lr) {
    const reason = lr.reason ? REASON_LABEL[lr.reason] ?? lr.reason : '';
    text += ` · 最近 ${lr.tool ?? ''}${reason ? `（${reason}）` : ''} ${fmtTime(lr.at ?? 0)}`;
  }
  statsEl.textContent = text;
}

function renderChildren(children: Child[], dbError: string | null): void {
  if (!childrenTitleEl) return;
  childrenTitleEl.textContent = `子代理（${children.length}）${dbError ? ' · 读库失败' : ''}`;
  const items = children
    .slice()
    .reverse()
    .slice(0, 60)
    .map((c) => ({
      id: c.id,
      title: c.title || `${agentLabel(c.agent)} 子会话`,
      subtitle: `${agentLabel(c.agent)} · ${fmtTime(c.created)}`,
    }));
  if (!listHandle) {
    listHandle = mountList(childrenWrap, { items, emptyText: '本会话暂无子代理', onSelect: (id) => void openChild(id, 'manual') });
  } else {
    listHandle.update({ items });
  }
}

function applyConfig(cfg: Config, force: boolean): void {
  if (!draft) {
    draft = JSON.parse(JSON.stringify(cfg)) as Config;
    dirty = false;
  } else if (!force && dirty) {
    return; // 用户正在编辑，别覆盖
  } else {
    draft = JSON.parse(JSON.stringify(cfg)) as Config;
  }
  const d = draft as Config;
  swEnabled?.update({ checked: d.enabled });
  swAuto?.update({ checked: d.autoOpen });
  tfWord?.update({ value: d.exemptionWord });
  tfPool?.update({ value: String(d.poolPerRound) });
  tfRead?.update({ value: String(d.sessionTotals.read) });
  tfWeb?.update({ value: String(d.sessionTotals.web) });
  tfCmd?.update({ value: String(d.sessionTotals.command) });
  tfCap?.update({ value: String(d.exemptionRoundCap) });
  if (force) dirty = false;
  saveBtn?.update({ disabled: !dirty });
  if (!dirty) saveStateEl.textContent = '';
}

function renderExempt(on: boolean): void {
  if (!exemptBtn) return;
  exemptBtn.update({ label: on ? '整场放行：开' : '整场放行：关', variant: on ? 'outline' : 'secondary', disabled: !sessionId });
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function openChild(id: string, why: 'auto' | 'manual'): Promise<void> {
  try {
    await host.openSession(id);
    log('open.ok', { id, why });
  } catch (err) {
    const code = err instanceof HostRequestError ? err.code : 'unknown';
    log('open.fail', { id, why, code: String(code) });
    if (why === 'auto' && code !== 'NO_SESSION') {
      void host
        .toast({ kind: 'info', message: `子代理会话跳转失败（${String(code)}），可在面板里手动点开`, dismiss: true })
        .catch(() => {});
    }
  }
}

function maybeAutoOpen(children: Child[], cfg: Config): void {
  const fresh = children.filter((c) => !seen.has(c.id) && c.created > baseAt - BASE_SLACK_MS);
  for (const c of children) seen.add(c.id);
  if (!cfg.autoOpen || !sessionId || fresh.length === 0) return;
  const first = fresh[0];
  if (Date.now() - lastAutoAt < AUTO_COOLDOWN_MS) {
    log('auto.skip', { id: first.id, why: 'cooldown' });
    return;
  }
  lastAutoAt = Date.now();
  log('auto.open', { id: first.id, title: first.title, count: fresh.length });
  void openChild(first.id, 'auto');
}

async function fetchSnapshot(): Promise<{ snap?: Snapshot; error?: string }> {
  try {
    const query: Record<string, string> = sessionId ? { sessionId } : {};
    const res = await host.serviceRequest({ method: 'GET', path: '/snapshot', query });
    const payload = JSON.parse(res.body) as Snapshot & { message?: string };
    if (res.status === 200 && payload && payload.ok) return { snap: payload };
    return { error: payload?.message ?? `HTTP ${res.status}` };
  } catch (err) {
    if (err instanceof HostRequestError) {
      return { error: err.code === 'NO_SERVICE' ? '本地服务未启动或未授权' : err.message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function poll(): Promise<void> {
  if (!built || polling) return;
  polling = true;
  try {
    const { snap, error } = await fetchSnapshot();
    if (!snap) {
      setBanner('warning', '本地服务不可用', error ?? '未知错误');
      return;
    }
    clearBanner();
    current = snap;
    renderStats(snap.stats);
    renderChildren(snap.children, snap.dbError);
    applyConfig(snap.config, false);
    renderExempt(snap.exempt);
    maybeAutoOpen(snap.children, snap.config);
  } finally {
    polling = false;
  }
}

async function save(): Promise<void> {
  if (!draft || saving) return;
  const d = draft as Config;
  const bad: string[] = [];
  const okInt = (v: number, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;
  if (!okInt(d.poolPerRound, 0, 50)) bad.push('每轮池');
  if (!okInt(d.sessionTotals.read, 0, 10000)) bad.push('总额·读');
  if (!okInt(d.sessionTotals.web, 0, 10000)) bad.push('总额·网');
  if (!okInt(d.sessionTotals.command, 0, 10000)) bad.push('总额·命令');
  if (!okInt(d.exemptionRoundCap, 0, 100)) bad.push('豁免轮次上限');
  if (!d.exemptionWord.trim()) bad.push('豁免词');
  if (bad.length) {
    saveStateEl.textContent = `检查：${bad.join('、')}`;
    return;
  }
  saving = true;
  saveBtn?.update({ loading: true });
  try {
    const res = await host.serviceRequest({
      method: 'POST',
      path: '/config',
      body: JSON.stringify({ config: { ...d, exemptionWord: d.exemptionWord.trim() } }),
    });
    const payload = JSON.parse(res.body) as { ok?: boolean; config?: Config; message?: string };
    if (res.status !== 200 || !payload?.ok || !payload.config) throw new Error(payload?.message ?? `HTTP ${res.status}`);
    applyConfig(payload.config, true);
    saveStateEl.textContent = '已保存';
    log('config.saved');
    void host.toast({ kind: 'success', message: 'assistant 设置已保存' }).catch(() => {});
  } catch (err) {
    saveStateEl.textContent = `保存失败：${err instanceof Error ? err.message : String(err)}`;
    log('config.fail', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    saving = false;
    saveBtn?.update({ loading: false, disabled: !dirty });
  }
}

async function toggleExempt(): Promise<void> {
  if (!sessionId) return;
  const next = !(current?.exempt ?? false);
  try {
    const res = await host.serviceRequest({ method: 'POST', path: '/exempt', body: JSON.stringify({ sessionId, value: next }) });
    const payload = JSON.parse(res.body) as { ok?: boolean; config?: Config };
    if (res.status === 200 && payload?.ok && payload.config && current) {
      current = { ...current, exempt: next, config: payload.config };
      renderExempt(next);
      log('exempt.toggle', { value: next });
    }
  } catch (err) {
    log('exempt.fail', { message: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function attachSession(id: string | null): void {
  if (id === sessionId) return;
  sessionId = id;
  baseAt = Date.now();
  seen = new Set();
  lastAutoAt = 0;
  log('session.changed', { sessionId: id });
  if (built) {
    renderPlaceholder();
    void poll();
  }
}

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  buildDom();
  attachSession(ctx.session?.id ?? null);
  void poll();
});

host.onSession((snapshot) => {
  if (!built) return;
  attachSession(snapshot?.id ?? null);
});

setInterval(() => {
  void poll();
}, POLL_MS);

setTimeout(() => {
  if (!built) buildDom();
}, 1500);
