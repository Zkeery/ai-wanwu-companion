'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { getToken } from '@/lib/auth';
import { readRuntimeHistory, type RuntimeHistory, type RuntimeSnapshot } from '@/lib/life-runtime';
import { activityNames } from '@/lib/life-simulation';
import SceneActivityFeedback, { type ActivityScene } from './scene-activity-feedback';

type Props = { snapshot: RuntimeSnapshot; available: boolean; scene?: ActivityScene };
const states = { queued: '等待执行', running: '正在处理', done: '已完成', cancelled: '已取消', failed: '未能完成' };

export default function LifeActivityHistory({ snapshot, available, scene }: Props) {
  const [open, setOpen] = useState(false);
  return <div className="activity-history">
    <button className="button ghost" disabled={!available} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起活动记录' : '查看活动记录'}</button>
    {open && available && <History key={`${snapshot.space_id}:${snapshot.companion_id}:${snapshot.origin}`} snapshot={snapshot} scene={scene} />}
  </div>;
}

function History({ snapshot, scene }: Pick<Props, 'snapshot' | 'scene'>) {
  const { space_id: spaceId, companion_id: companionId, origin } = snapshot;
  const [page, setPage] = useState<RuntimeHistory | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useRef<HTMLDivElement | null>(null), opener = useRef<HTMLButtonElement | null>(null);
  const task = page?.tasks.find(item => item.id === selected);
  const canDetail = scene && scene.space.mode === 'private' && scene.space.id === spaceId && scene.space.companion_id === companionId && snapshot.present && scene.companions.some(item => String(item.id) === companionId);
  useEffect(() => { if (selected) { detail.current?.focus({ preventScroll: true }); detail.current?.scrollIntoView({ block: 'center' }); } }, [selected]);
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const unavailable = (cause: unknown) => cause instanceof ApiError && [401, 403, 404].includes(cause.status);
  useEffect(() => {
    const controller = new AbortController(), token = getToken(); pending.current = controller;
    readRuntimeHistory(spaceId, undefined, controller.signal).then(result => {
      if (controller.signal.aborted || getToken() !== token) return;
      if (result.companion_id !== companionId || result.origin !== origin) throw new Error('scope changed');
      setPage(result);
    }).catch(() => { if (!controller.signal.aborted && getToken() === token) setError('活动记录暂时读不到，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) { pending.current = null; setBusy(false); } });
    return () => { controller.abort(); pending.current?.abort(); pending.current = null; };
  }, [spaceId, companionId, origin]);

  async function load(older = false) {
    if (pending.current || (older && !page?.next_before)) return;
    if (!older) setSelected(null);
    const controller = new AbortController(), token = getToken(); pending.current = controller; setBusy(true); setError('');
    try {
      const result = await readRuntimeHistory(spaceId, older ? page!.next_before! : undefined, controller.signal);
      if (controller.signal.aborted || getToken() !== token) return;
      if (result.companion_id !== companionId || result.origin !== origin || (older && result.tasks.some(item => page!.tasks.some(old => old.id === item.id)))) throw new Error('history changed');
      setPage(older ? { ...result, tasks: [...page!.tasks, ...result.tasks] } : result);
    } catch (cause) {
      if (controller.signal.aborted || getToken() !== token) return;
      if (unavailable(cause)) { setPage(null); setError('暂时无法访问这些活动记录，请重新进入。'); }
      else setError('活动记录暂时读不到，已保留读取的内容，请重试。');
    } finally {
      if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
    }
  }

  return <section className="season-panel" aria-label="活动历史记录" aria-busy={busy}>
    <h4>活动历史 <small>· {origin === 'offline_fixture' ? '离线样例' : 'AI活动记录'}</small></h4>
    <p>这里记着实际保存的任务。查看记录不会安排新的活动。</p>
    {busy && <p role="status">正在读取活动记录…</p>}
    {error && <p role="alert">{error}</p>}
    {page && <>
      <p>已加载 {page.tasks.length} 条记录</p>
      {page.tasks.length ? <ol className="life-events">{page.tasks.map(task => <li key={task.id}>
        <strong>{states[task.state]}{task.activity ? ` · ${activityNames[task.activity]}` : ''}</strong>
        {task.state === 'done' && <p>{origin === 'offline_fixture' ? '预设活动已保存，不代表真实AI经历。' : '已保存的AI活动结果。'}</p>}
        {task.state === 'done' && task.reason && <p>{origin === 'offline_fixture' ? '本轮预设选择理由' : '已保存的 AI 选择理由'}：{task.reason}</p>}
        {task.error_code && <p>{task.error_code === 'budget_exhausted' ? '预算未开放，这轮没有调用AI。' : task.state === 'cancelled' ? '这轮已取消，没有完成活动。' : '这轮未完成，没有记为成功活动。'}</p>}
        <time dateTime={new Date(task.created_at * 1000).toISOString()}>本轮安排于 {new Date(task.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（上海时间）</time>
        {canDetail && <button type="button" className="button ghost" disabled={busy || !!error} aria-expanded={selected === task.id} onClick={event => { opener.current = event.currentTarget; setSelected(task.id); }}>查看活动详情</button>}
      </li>)}</ol> : <p>还没有活动记录。</p>}
      {!page.next_before && page.tasks.length > 0 && <p>已经是最早的记录了。</p>}
      {task && canDetail && <div ref={detail} tabIndex={-1} role="region" aria-label="活动详情">
        <p>记录读取于 {new Date(page.observed_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（上海时间），可更新活动记录核对最新状态。</p>
        <SceneActivityFeedback historical {...scene} view={{ snapshot: { ...snapshot, origin: page.origin, tasks: [task] }, stale: busy || !!error }} />
        <button type="button" className="button ghost" onClick={() => { setSelected(null); opener.current?.focus(); }}>关闭活动详情</button>
      </div>}
    </>}
    <div className="season-actions">
      {page?.next_before && <button className="button" disabled={busy} onClick={() => void load(true)}>加载更早记录</button>}
      <button className="button ghost" disabled={busy} onClick={() => void load()}>更新活动记录</button>
    </div>
  </section>;
}
