/**
 * assistant Work Status 区块：子代理数量 + 「打开最新」一键跳（联动关闭时的兜底通道）。
 */
import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton, type ButtonHandle } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root') as HTMLElement;

type Child = { id: string; title: string; created: number; agent: string };

let built = false;
let sessionId: string | null = null;
let latest: Child | null = null;
let count = 0;
let textEl: HTMLElement | null = null;
let subEl: HTMLElement | null = null;
let openBtn: ButtonHandle | null = null;
let refreshing = false;

function buildDom(): void {
  if (built) return;
  built = true;
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  textEl = document.createElement('div');
  textEl.className = 'title';
  subEl = document.createElement('div');
  subEl.className = 'sub';
  const btnWrap = document.createElement('div');
  btnWrap.className = 'btn';
  wrap.append(textEl, subEl, btnWrap);
  root.append(wrap);
  openBtn = mountButton(btnWrap, {
    label: '打开最新子代理',
    size: 'sm',
    variant: 'secondary',
    disabled: true,
    onClick: () => {
      if (latest) void host.openSession(latest.id).catch(() => {});
    },
  });
}

async function refresh(): Promise<void> {
  if (!built || !sessionId || refreshing) {
    render();
    return;
  }
  refreshing = true;
  try {
    const res = await host.serviceRequest({ method: 'GET', path: '/snapshot', query: { sessionId } });
    const payload = JSON.parse(res.body) as { ok?: boolean; children?: Child[] };
    if (res.status === 200 && payload?.ok && Array.isArray(payload.children)) {
      count = payload.children.length;
      latest = payload.children.length ? payload.children[payload.children.length - 1] : null;
    }
  } catch {
    /* 服务不可用时静默，保留上一次 */
  } finally {
    refreshing = false;
    render();
  }
}

function render(): void {
  if (!built || !textEl || !subEl || !openBtn) return;
  if (!sessionId) {
    textEl.textContent = 'assistant 子代理';
    subEl.textContent = '打开一个会话后显示子代理';
    openBtn.update({ disabled: true });
    return;
  }
  textEl.textContent = count > 0 ? `子代理 ${count} 个` : '本会话暂无子代理';
  subEl.textContent = latest
    ? `最近：${latest.title || latest.agent || latest.id.slice(0, 12)}`
    : '派 assistant 后这里一键直达';
  openBtn.update({ disabled: !latest });
}

function attach(id: string | null): void {
  if (id === sessionId) return;
  sessionId = id;
  latest = null;
  count = 0;
  void refresh();
}

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  buildDom();
  attach(ctx.session?.id ?? null);
});

host.onSession((snapshot) => {
  if (!built) return;
  attach(snapshot?.id ?? null);
});

setInterval(() => {
  void refresh();
}, 2000);

setTimeout(() => {
  if (!built) buildDom();
}, 1500);
