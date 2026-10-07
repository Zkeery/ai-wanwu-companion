'use client';
import { useEffect, useRef, useState } from 'react';
import { automaticDialogueApi as api, type AutomaticDialogueStatus } from '@/lib/gathering-automatic';
import { getToken } from '@/lib/auth';
import { ApiError, errorText } from '@/lib/api';
import type { Gathering } from '@/lib/gatherings';
import { Modal } from './common';

const reasons: Record<string, string> = {
  paused: '自动交流已暂停，保存的对话仍可查看。', completed: '本批次数已用完，自动交流已结束。',
  expired: '本批额度已到期，自动交流已结束。', budget_exhausted: '累计额度不足，已停止后续交流。',
  permission_changed: '伙伴、位置或参与许可发生变化，本批已停止。', authorization_closed: '本批授权已结束。',
  failed: '本轮未能完成，本批已停止，不会自动重试。', interrupted: '本轮结果需要核对，本批已停止，不会重发。',
};
type Props = { gathering: Gathering; busy: boolean; onState: (enabled: boolean) => void; refresh: () => void };
export default function GatheringAutomatic({ gathering: g, busy, onState, refresh }: Props) {
  const [status, setStatus] = useState<AutomaticDialogueStatus | null>(null), [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false), [sending, setSending] = useState(false), [reload, setReload] = useState(0);
  const alive = useRef(true), lock = useRef(false), epoch = useRef(0), callbacks = useRef({ onState, refresh });
  const mutation = useRef<AbortController | null>(null), previous = useRef('');
  useEffect(() => { callbacks.current = { onState, refresh }; }, [onState, refresh]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; mutation.current?.abort(); }; }, []);
  useEffect(() => {
    if (sending) return;
    let active = true, suspended = false, failures = 0, controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = getToken();
    const valid = () => active && !suspended && !document.hidden && getToken() === token;
    function cancel() { clearTimeout(timer); controller?.abort(); controller = null; }
    async function read() {
      if (!valid() || controller) return;
      clearTimeout(timer);
      const request = new AbortController(), version = epoch.current; controller = request;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
      let delay: number | null = null;
      try {
        const value = await api.read(g.id, signal);
        if (!valid() || request.signal.aborted || controller !== request || epoch.current !== version) return;
        if (signal.aborted) throw signal.reason;
        failures = 0;
        setStatus(value); setError(''); callbacks.current.onState(value.enabled);
        const signature = `${value.last_task_id}:${value.last_task_state}`;
        if (previous.current && previous.current !== signature) callbacks.current.refresh();
        previous.current = signature;
        delay = value.enabled ? 5000 : value.available ? 15000 : null;
      } catch (e) {
        if (!valid() || request.signal.aborted || controller !== request || epoch.current !== version) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          active = false; setStatus(null); callbacks.current.onState(false); setError(errorText(e));
        } else {
          failures++;
          setError('自动安排暂未更新，正在重新核对。' + errorText(e));
          delay = failures === 1 ? 30000 : 60000;
        }
      } finally {
        if (controller === request) {
          controller = null;
          if (valid() && !request.signal.aborted && epoch.current === version && delay !== null)
            timer = setTimeout(() => void read(), delay);
        }
      }
    }
    function wake() { cancel(); void read(); }
    function leave() { suspended = true; cancel(); }
    function restore() { suspended = false; wake(); }
    void read(); window.addEventListener('focus', wake); window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    window.addEventListener('pagehide', leave); window.addEventListener('pageshow', restore);
    return () => { active = false; cancel(); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', restore); };
  }, [g.id, g.revision, reload, sending]);

  useEffect(() => {
    if (!status?.authorization) return;
    const timer = setTimeout(() => setReload(n => n + 1), Math.max(0, status.authorization.expires_at * 1000 - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [status?.authorization]);

  useEffect(() => {
    if (!status?.available) return;
    const token = getToken(); let viewer: string | null = null, suspended = false, disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | null = null;
    const valid = () => !disposed && !suspended && !document.hidden && getToken() === token;
    async function beat() {
      if (!valid() || !viewer) return;
      const current = viewer, request = new AbortController(); controller = request;
      try { await api.viewing(g.id, current, true, request.signal); } catch { /* Lease expires without renewal. */ }
      finally { if (valid() && viewer === current && !request.signal.aborted) timer = setTimeout(() => void beat(), 30000); }
    }
    function stop() {
      clearTimeout(timer); controller?.abort(); controller = null;
      const ended = viewer; viewer = null;
      if (ended && getToken() === token) void api.viewing(g.id, ended, false).catch(() => undefined);
    }
    function wake() { if (!valid()) { stop(); return; } if (!viewer) { viewer = crypto.randomUUID(); void beat(); } }
    function leave() { suspended = true; stop(); }
    function restore() { suspended = false; wake(); }
    wake(); document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake);
    window.addEventListener('pagehide', leave); window.addEventListener('pageshow', restore);
    return () => { disposed = true; stop(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake);
      window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', restore); };
  }, [g.id, status?.available]);

  const authorization = status?.authorization;
  const pair = authorization?.character_ids.map(id => g.companions.find(c => c.id === id));
  const eligible = !!pair && pair.length === 2 && pair.every(c => c?.dialogue_allowed) && pair.some(c => c?.owner_id === g.me);
  const ready = !!status?.available && !status.enabled && !!authorization && eligible && g.dialogue_enabled && !busy && !sending && !error;
  async function save(enabled: boolean) {
    if (!status || lock.current || (enabled && !ready)) return;
    lock.current = true; epoch.current++; setSending(true); setConfirm(false); setError('');
    const token = getToken(), controller = new AbortController(); mutation.current = controller;
    try {
      const value = await api.configure(g.id, { request_id: crypto.randomUUID(), expected_revision: status.revision,
        enabled, session_id: enabled && authorization ? authorization.id : null }, controller.signal);
      if (alive.current && getToken() === token) { setStatus(value); callbacks.current.onState(value.enabled); callbacks.current.refresh(); }
    } catch (e) {
      if (alive.current && getToken() === token) setError('设置结果需核对，不会自动重发。' + errorText(e));
    } finally { lock.current = false; if (alive.current && getToken() === token) setSending(false); }
  }
  return <div className="hub-item" aria-label="自动伙伴交流"><h3>自动聊一会儿</h3>
    <p>有人查看时最多每10分钟聊一轮；无人查看每天最多两轮。离开页面后按已确认次数继续，失败即停。</p>
    {!status && !error && <p role="status">正在读取自动安排…</p>}
    {status && <>
      {!status.available && <p>后台自动交流尚未开放，已有记录和暂停操作仍可使用。</p>}
      <p role="status">{status.enabled ? (status.available ? '自动交流已开启。' : '自动安排已保存，当前后台未运行。') : (status.stop_reason ? reasons[status.stop_reason] : '自动交流默认关闭。')}</p>
      <p>今日无人观看已安排 {status.today_count} / 2 轮。</p>
      {status.enabled && <p>{status.next_at > 0 ? `下一轮最早 ${new Date(status.next_at * 1000).toLocaleTimeString('zh-CN')}` : '即将核对第一轮安排'}；实际执行还需参与许可和剩余额度。</p>}
      {authorization ? <p>本批安排 {pair?.map((c, i) => c?.name ?? `伙伴${authorization.character_ids[i]}`).join('与')}；还可聊 {authorization.max_rounds - authorization.used_rounds} 轮，整批最多预留 ¥{(authorization.cap_micro / 1000000).toFixed(4)}，{new Date(authorization.expires_at * 1000).toLocaleString('zh-CN')} 到期。实际费用以账单为准。</p>
        : <p>你没有可用的自动交流额度；单轮授权不能用于自动安排。</p>}
      <div className="hub-actions"><button className="button primary" disabled={!ready} onClick={() => setConfirm(true)}>开启自动交流</button>
        <button className="button" disabled={!status.enabled || sending || busy} onClick={() => void save(false)}>暂停自动交流</button></div>
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="button" disabled={sending} onClick={() => setReload(n => n + 1)}>核对自动安排</button>
    {confirm && authorization && <Modal title="确认自动交流" close={() => setConfirm(false)}>
      <p>允许指定两位伙伴在本批剩余 {authorization.max_rounds - authorization.used_rounds} 轮内自动交流，整批最多预留 ¥{(authorization.cap_micro / 1000000).toFixed(4)}。离开页面后也可继续；任一成员可暂停，失败或结果未知会停止整个批次，不自动重试。</p>
      <p>模型仅接收两位公开名字、预设性格、当前共同场景及允许引用的共同交流，不带入私人聊天。</p>
      <button className="button" onClick={() => setConfirm(false)}>取消</button><button className="button primary" disabled={!ready} onClick={() => void save(true)}>确认开启自动交流</button>
    </Modal>}
  </div>;
}
