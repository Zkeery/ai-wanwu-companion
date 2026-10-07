'use client';
import { useEffect, useRef, useState } from 'react';
import { dialogueApi, type DialogueStatus } from '@/lib/gathering-dialogue';
import type { Gathering } from '@/lib/gatherings';
import { errorText, ApiError } from '@/lib/api';
import { getToken } from '@/lib/auth';
import { Modal } from './common';
import GatheringAutomatic from './gathering-automatic';

type Props = { gathering: Gathering; busy: boolean; command: (command: Record<string, unknown>) => Promise<void>; refresh: () => void };
export default function GatheringDialogue(props: Props) {
  return <Dialogue key={props.gathering.id} {...props} />;
}
function Dialogue({ gathering: g, busy, command, refresh }: Props) {
  const [status, setStatus] = useState<DialogueStatus | null>(null), [error, setError] = useState('');
  const [selected, setSelected] = useState<number[]>([]), [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false), [reload, setReload] = useState(0);
  const [automatic, setAutomatic] = useState(false);
  const alive = useRef(true), lock = useRef(false), sendController = useRef<AbortController | null>(null);
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sendController.current?.abort(); }; }, []);
  useEffect(() => {
    if (sending) return;
    let active = true, suspended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const token = getToken();
    const valid = () => active && !suspended && getToken() === token && !document.hidden;
    function cancelRead() {
      clearTimeout(timer);
      controller?.abort(); controller = null;
    }
    async function read() {
      if (!valid() || controller) return;
      const request = new AbortController(); controller = request;
      try {
        const value = await dialogueApi.read(g.id, request.signal);
        if (!valid() || request.signal.aborted || controller !== request) return;
        setStatus(value); setError('');
        if (value.tasks.some(t => t.state === 'running')) timer = setTimeout(() => void read(), 2000);
      } catch (e) {
        if (valid() && !request.signal.aborted && controller === request) {
          if (e instanceof ApiError && [401, 403, 404].includes(e.status)) setStatus(null);
          setError(errorText(e));
        }
      } finally { if (controller === request) controller = null; }
    }
    function wake() { cancelRead(); void read(); }
    function leave() { suspended = true; cancelRead(); }
    function restore() { suspended = false; wake(); }
    void read(); window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    window.addEventListener('pagehide', leave); window.addEventListener('pageshow', restore);
    return () => {
      active = false; cancelRead();
      window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', restore);
    };
  }, [g.id, g.revision, reload, sending]);
  useEffect(() => {
    if (!status?.grants.length) return;
    const delay = Math.max(0, Math.min(...status.grants.map(grant => grant.expires_at)) * 1000 - Date.now()) + 50;
    const timer = setTimeout(() => setReload(n => n + 1), delay);
    return () => clearTimeout(timer);
  }, [status]);
  const eligible = g.companions.filter(c => c.dialogue_allowed);
  const activeSelected = selected.filter(id => eligible.some(c => c.id === id));
  const validSelection = activeSelected.length === 2
    && activeSelected.some(id => eligible.some(c => c.id === id && c.owner_id === g.me));
  const grant = status?.grants.find(grant => grant.character_ids.length === 2
    && grant.character_ids.every(id => activeSelected.includes(id)));
  const running = sending || !!status?.tasks.some(t => t.state === 'running');
  const ready = !!status?.available && g.dialogue_enabled && validSelection && !!grant && !busy && !running && !automatic && !error;
  async function send() {
    if (!ready || !grant || lock.current) return;
    lock.current = true; setSending(true); setConfirm(false); setError('');
    const token = getToken(), controller = new AbortController(); sendController.current = controller;
    try {
      const value = await dialogueApi.start(g.id, { request_id: crypto.randomUUID(), expected_revision: g.revision,
        character_ids: grant.character_ids, grant_id: grant.id }, controller.signal);
      if (alive.current && getToken() === token) { setStatus(value); refreshRef.current(); }
    } catch (e) {
      if (alive.current && getToken() === token) setError('本次发送结果需核对；不会自动重发。' + errorText(e));
    } finally {
      lock.current = false;
      if (alive.current && getToken() === token) { setSending(false); setReload(n => n + 1); }
    }
  }
  return <section className="team-panel" aria-label="伙伴们聊两句"><h2>伙伴们聊两句</h2>
    <p>聊聊眼前的场景。只使用在场名字、预设性格标签和共同物件，私人聊天、记忆与自定义性格不会带入。</p>
    {g.is_manager ? <label><input type="checkbox" checked={g.dialogue_enabled} disabled={busy} onChange={e => void command({ action: 'dialogue_space', enabled: e.target.checked })} />允许这个空间开展伙伴交流</label>
      : <p>{g.dialogue_enabled ? '共同交流已开启' : '等待管理者开启共同交流'}</p>}
    {g.companions.filter(c => c.owner_id === g.me).map(c => <div className="hub-row" key={c.id}><label><input type="checkbox" checked={c.dialogue_allowed} disabled={busy}
      onChange={e => void command({ action: 'dialogue_consent', character_id: c.id, enabled: e.target.checked })} />允许{c.name}在这次相聚中参与交流</label></div>)}
    <p>每轮两位伙伴各说一句，至少一位是你的伙伴；回家后需要重新允许。</p>
    <div className="hub-actions">{eligible.map(c => <label key={c.id}><input type="checkbox" checked={activeSelected.includes(c.id)} disabled={running || busy || (!activeSelected.includes(c.id) && activeSelected.length >= 2)}
      onChange={e => setSelected(e.target.checked ? [...activeSelected, c.id] : activeSelected.filter(id => id !== c.id))} />选择{c.name}</label>)}</div>
    {status === null && !error && <p role="status">正在读取交流记录…</p>}
    {status && !status.available && <p>真实交流尚未开放，参与许可和已有记录仍可查看。</p>}
    {status?.available && !grant && <p>当前组合没有可用的单轮费用授权。</p>}
    {grant && <p>本轮最多预留 ¥{(grant.cap_micro / 1_000_000).toFixed(4)}，仅发送一次；实际费用以账单为准。</p>}
    {automatic && <p>自动交流正在安排；暂停后可以发起手动单轮交流。</p>}
    <div className="hub-actions"><button className="button primary" disabled={!ready} onClick={() => setConfirm(true)}>让他们聊两句</button>
      <button className="button" disabled={sending} onClick={() => setReload(n => n + 1)}>更新交流记录</button></div>
    {running && <p role="status">{automatic ? '伙伴正在组织想法，可随时暂停自动安排。' : '伙伴正在组织想法，离开后可回来查看；不会自动开启下一轮。'}</p>}
    {error && <p role="alert">{error}</p>}
    {status?.tasks.slice(0,1).filter(t => t.state === 'failed' || t.state === 'unknown').map(t => <p key={t.id} role="status">{t.state === 'unknown' ? '上一轮结果未知，已停止且不会重发。' : '上一轮未发布对话，已停止；可核对参与许可与场景。'}</p>)}
    {status?.exchanges.length ? status.exchanges.slice().reverse().map(e => <div className="hub-item" key={e.id}><small>AI 伙伴交流 · {new Date(e.at * 1000).toLocaleString('zh-CN')}</small>
      {e.lines.map(line => <p key={line.character_id}><strong>{line.name}：</strong>{line.text}</p>)}</div>) : status && <p>还没有保存的 AI 交流。</p>}
    <GatheringAutomatic gathering={g} busy={busy || sending} onState={setAutomatic} refresh={() => { setReload(n => n + 1); refreshRef.current(); }} />
    {confirm && <Modal title="确认这一轮交流" close={() => setConfirm(false)}><p>将所选伙伴的公开名字、预设性格标签及当前场景交给模型，生成结果在共同空间中可见。本轮只发送一次，最多预留 ¥{grant ? (grant.cap_micro / 1_000_000).toFixed(4) : '—'}。</p>
      <div className="hub-actions"><button className="button" onClick={() => setConfirm(false)}>取消</button><button className="button primary" disabled={!ready} onClick={() => void send()}>确认这一轮</button></div></Modal>}
  </section>;
}
