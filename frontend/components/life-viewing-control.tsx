'use client';
import { useEffect, useState } from 'react';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { runtimeApi } from '@/lib/life-runtime';

/** Local opt-in; each visible visit has its own expiring server lease. */
export default function LifeViewingControl({ spaceId, revision, disabled, live = false }: { spaceId: string; revision: number; disabled: boolean; live?: boolean }) {
  const [selected, setSelected] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!selected) return;
    const token = getToken();
    let disposed = false, lease: string | null = null;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function release() {
      clearTimeout(timer); controller?.abort();
      const previous = lease; lease = null;
      // After an account switch, let the old lease expire; never use the new token.
      if (previous && getToken() === token) void runtimeApi.viewing(spaceId, previous, revision, false).catch(() => {});
    }
    async function heartbeat() {
      if (disposed || document.visibilityState === 'hidden' || getToken() !== token) return;
      lease ??= crypto.randomUUID();
      const id = lease, request = new AbortController(); controller = request;
      try {
        await runtimeApi.viewing(spaceId, id, revision, true, request.signal);
        if (disposed || request.signal.aborted || lease !== id || getToken() !== token) return;
        setStatus(live ? '观看时 AI 自动安排已开启。' : '观看时自动体验已开启。');
        timer = setTimeout(() => { void heartbeat(); }, 30000);
      } catch {
        if (disposed || request.signal.aborted || lease !== id || getToken() !== token) return;
        release(); setSelected(false);
        setStatus('观看状态未能确认，已停止续报；最多75秒后转为离开时的频率。可以重新开启。');
      }
    }
    function visibility() {
      release();
      if (document.visibilityState === 'hidden') setStatus('页面已隐藏，暂停观看时的频率。');
      else { setStatus('正在确认观看状态…'); void heartbeat(); }
    }
    function account() {
      if (getToken() === token) return;
      release(); setSelected(false); setStatus('登录状态已变化，请重新进入空间。');
    }
    function leave() {
      disposed = true; release(); setSelected(false);
      setStatus('已离开页面，观看模式已停止；返回后可重新开启。');
    }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', leave);
    window.addEventListener(AUTH_CHANGED, account); window.addEventListener('storage', account);
    void heartbeat();
    return () => {
      disposed = true; release();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener(AUTH_CHANGED, account); window.removeEventListener('storage', account);
    };
  }, [selected, spaceId, revision, live]);

  return <section aria-label={live ? '观看时 AI 自动安排' : '观看时自动体验'}>
    <p>想在这里多陪一会儿？开启后，看着页面时最多每10分钟一轮；多开页面也不会加快。刷新页面后需要重新开启。</p>
    {live && <p>观看时可能增加模型调用和费用，仍受已授权预算限制。离开后恢复每天最多2轮；本页失联最多75秒后到期。</p>}
    <button type="button" className="button ghost" disabled={!selected && disabled} onClick={() => {
      setSelected(!selected);
      setStatus(selected ? '本页已停止观看模式；其他打开的页面可能仍在观看。失联时最多75秒后到期。' : '正在确认观看状态…');
    }}>{selected ? live ? '停止本页 AI 观看模式' : '停止本页观看体验' : live ? '观看时继续 AI 安排' : '观看时继续自动体验'}</button>
    {status && <p role="status">{status}</p>}
  </section>;
}
