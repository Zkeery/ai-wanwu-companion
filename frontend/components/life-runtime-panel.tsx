'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { runtimeApi, type RuntimeSnapshot, type RuntimeView } from '@/lib/life-runtime';
import { activityNames, type Activity } from '@/lib/life-simulation';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import LifeActivityHistory from './life-activity-history';
import LifeViewingControl from './life-viewing-control';
import type { ActivityScene } from './scene-activity-feedback';

const states = { queued: '待执行', running: '正在处理', done: '已完成体验', cancelled: '已取消', failed: '未能完成' };
const reasons: Record<string, string> = { invalid_action: '当前许可、时间或场景物件不支持这轮活动。', invalid_request: '这轮活动未通过检查。', conflict: '场景、许可或任务时机已变化，请重新安排。', not_found: '伙伴或空间已不可用。', worker_error: '这轮处理未能完成，可稍后重新安排。', budget_exhausted: '尚未开放付费试跑，本轮没有调用 AI。' };
const time = (value: number) => new Date(value * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
type Operation = 'read' | 'save' | 'pause' | 'schedule' | 'run' | 'automatic_start' | 'automatic_stop';

type Props = { spaceId: string; onSnapshot?: (view: RuntimeView | null) => void; historyScene?: ActivityScene; refreshVersion?: number };
const lostAccess = (cause: unknown) => cause instanceof ApiError && [401, 403, 404].includes(cause.status);

export default function LifeRuntimePanel(props: Props) {
  return <Panel key={props.spaceId} {...props} />;
}

function Panel({ spaceId, onSnapshot, historyScene, refreshVersion = 0 }: Props) {
  const appliedRefresh = useRef(refreshVersion);
  const [saved, setSaved] = useState<RuntimeSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [pollError, setPollError] = useState(false);
  const pollController = useRef<AbortController | null>(null);
  const active = useRef(false), locked = useRef(false), abort = useRef<AbortController | null>(null);
  const dirty = JSON.stringify([...activities].sort()) !== JSON.stringify([...(saved?.permission.activities ?? [])].sort());

  useEffect(() => { onSnapshot?.({ snapshot: saved, stale }); }, [saved, stale, onSnapshot]);
  useEffect(() => () => onSnapshot?.(null), [onSnapshot]);

  useEffect(() => {
    active.current = true;
    const requestToken = getToken();
    const controller = new AbortController(); abort.current = controller;
    runtimeApi.read(spaceId, controller.signal).then(result => {
      if (!active.current || controller.signal.aborted || getToken() !== requestToken) return;
      setSaved(result); setStale(false); setActivities(result.permission.activities);
    }).catch(() => { if (active.current && !controller.signal.aborted && getToken() === requestToken) { setStale(true); setError('暂时无法读取生活体验，请刷新状态。'); } });
    function accountChanged() {
      if (getToken() === requestToken) return;
      active.current = false; abort.current?.abort(); pollController.current?.abort();
      setSaved(null); setStale(true); setActivities([]); setBusy(false);
      setError('登录状态已变化，请重新进入这个空间。'); setMessage('');
    }
    window.addEventListener(AUTH_CHANGED, accountChanged);
    window.addEventListener('storage', accountChanged);
    return () => { active.current = false; abort.current?.abort(); pollController.current?.abort(); window.removeEventListener(AUTH_CHANGED, accountChanged); window.removeEventListener('storage', accountChanged); };
  }, [spaceId]);

  const run = useCallback(async (operation: Operation, taskId?: string) => {
    if (!active.current || locked.current || (operation !== 'read' && (!saved || uncertain))) return;
    pollController.current?.abort(); pollController.current = null;
    const requestToken = getToken();
    locked.current = true; setBusy(true); setError('');
    setMessage(operation === 'read' ? '正在核对…' : operation === 'run' ? '正在体验这轮活动…' : '正在保存…');
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    try {
      const result = operation === 'read' ? await runtimeApi.read(spaceId, controller.signal)
        : operation === 'automatic_start' || operation === 'automatic_stop' ? await runtimeApi.automatic(spaceId, saved!.automatic!.revision, operation === 'automatic_start', controller.signal)
        : operation === 'save' || operation === 'pause' ? await runtimeApi.save(spaceId, saved!.permission.revision, operation === 'save', operation === 'pause' ? saved!.permission.activities : activities, controller.signal)
        : operation === 'schedule' ? await runtimeApi.schedule(spaceId, controller.signal)
        : await runtimeApi.run(spaceId, taskId!, controller.signal);
      if (!active.current || controller.signal.aborted || getToken() !== requestToken) return;
      setSaved(result); setStale(false); setUncertain(false);
      setPollError(false);
      if (operation === 'save' || operation === 'pause' || !dirty) setActivities(result.permission.activities);
      setMessage({ read: '状态已核对。', save: saved?.automatic ? '活动范围已保存；每天自动安排需重新开启。' : '活动范围已保存。', pause: '已暂停，待执行任务已取消。', schedule: '已安排一轮，执行前仍可暂停。', run: '本轮结果已更新，请查看任务状态。', automatic_start: result.origin === 'real_provider' ? '每天 AI 自动安排已开启，后台只在已授权预算内执行。' : '每天自动体验已开启，后台会按节奏安排。', automatic_stop: '已停止自动安排，未完成的自动任务已取消。' }[operation]);
    } catch (cause) {
      if (!active.current || controller.signal.aborted || getToken() !== requestToken) return;
      setStale(true);
      if (lostAccess(cause)) { setSaved(null); setMessage(''); setError('这处生活状态暂时无法访问，请重新进入。'); return; }
      setMessage(''); setError(cause instanceof ApiError ? cause.message : '暂时无法完成，请刷新状态核对。');
      if (operation !== 'read') {
        setUncertain(true);
        try {
          const result = await runtimeApi.read(spaceId, controller.signal);
          if (!active.current || controller.signal.aborted || getToken() !== requestToken) return;
          setSaved(result); setStale(false); setUncertain(false);
          setError('已核对服务器状态；请查看结果后再操作。');
        } catch (readError) {
          if (active.current && !controller.signal.aborted && getToken() === requestToken && lostAccess(readError)) setSaved(null);
          // Do not repeat an uncertain write. Keep the user's draft.
        }
      }
    } finally {
      if (abort.current === controller) { locked.current = false; if (active.current) setBusy(false); }
    }
  }, [spaceId, saved, uncertain, activities, dirty]);

  useEffect(() => {
    if (appliedRefresh.current === refreshVersion || busy) return;
    appliedRefresh.current = refreshVersion;
    void run('read');
  }, [refreshVersion, busy, run]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && !locked.current) void run('read'); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [run]);

  const dispatched = saved?.tasks.some(task => task.dispatch_requested && (task.state === 'queued' || task.state === 'running')) ?? false;
  const automaticEnabled = !!saved?.automatic?.enabled;
  const currentActivity = !!saved?.current_activity;
  useEffect(() => {
    if ((!dispatched && !automaticEnabled && !currentActivity) || busy) return;
    let current = true, delay = 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requestToken = getToken();
    function schedule() {
      clearTimeout(timer);
      if (current && document.visibilityState !== 'hidden' && getToken() === requestToken) timer = setTimeout(() => { void check(); }, delay);
    }
    async function check() {
      if (!current || locked.current || document.visibilityState === 'hidden' || getToken() !== requestToken) return;
      pollController.current?.abort();
      const controller = new AbortController(); pollController.current = controller;
      try {
        const result = await runtimeApi.read(spaceId, controller.signal);
        if (!current || controller.signal.aborted || locked.current || getToken() !== requestToken) return;
        setSaved(result); setStale(false); setUncertain(false); setPollError(false);
        if (!dirty) setActivities(result.permission.activities);
        delay = 2000;
      } catch (cause) {
        if (!current || controller.signal.aborted || getToken() !== requestToken) return;
        setStale(true);
        if (lostAccess(cause)) {
          setSaved(null); setError('这处生活状态暂时无法访问，请重新进入。'); return;
        }
        setPollError(true); delay = Math.min(delay * 2, 10000);
      } finally {
        if (pollController.current === controller) pollController.current = null;
        if (!controller.signal.aborted) schedule();
      }
    }
    function visibility() {
      clearTimeout(timer); pollController.current?.abort();
      if (document.visibilityState !== 'hidden') void check();
    }
    document.addEventListener('visibilitychange', visibility); schedule();
    return () => { current = false; clearTimeout(timer); pollController.current?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [dispatched, automaticEnabled, currentActivity, busy, spaceId, saved, dirty]);

  const pending = saved?.tasks.some(task => task.state === 'queued' || task.state === 'running');
  const live = saved?.origin === 'real_provider';
  const waiting = !!saved && saved.observed_at < saved.next_allowed_at;
  const blocked = busy || uncertain || !saved;
  return <section className="season-panel life-runtime-panel" aria-label={live ? '自主生活 AI 活动试用' : '自主生活离线体验'}>
    <h3>自主生活 <small>· {live ? 'AI 活动试用' : '离线体验'}</small></h3>
    <p>{live ? '你允许活动后，可以主动安排一轮。AI 只选择获准的活动；结果保存后，场景会展示有效活动及已准备好的对应动作。每次执行可能产生模型费用。' : '先试试授权、安排与暂停。本轮使用预设活动，不调用AI，也不会生成角色对话。'}</p>
    <p><strong>{saved ? saved.permission.enabled ? '体验已开启' : '体验已暂停' : error ? '状态待核对' : '正在读取…'}</strong>{saved && !saved.present && ' · 伙伴不在这个空间'}</p>
    <fieldset disabled={blocked}><legend>允许伙伴体验哪些活动？</legend><div className="season-options">
      {(Object.keys(activityNames) as Activity[]).map(activity => <label key={activity}><input type="checkbox" checked={activities.includes(activity)} onChange={event => setActivities(current => event.target.checked ? [...current, activity] : current.filter(value => value !== activity))} />{activityNames[activity]}</label>)}
    </div></fieldset>
    <p>夜间只休息，观察需要现有物件。每轮至少间隔10分钟；刷新页面会保留已保存的任务。</p>
    {dirty && <p>活动范围有未保存的修改。</p>}
    <div className="season-actions">
      <button className="button" disabled={blocked || !activities.length || (saved?.permission.enabled && !dirty)} onClick={() => void run('save')}>{saved?.permission.enabled ? '保存活动范围' : '保存并开启体验'}</button>
      {saved?.permission.enabled && <button className="button ghost" disabled={blocked} onClick={() => void run('pause')}>暂停体验</button>}
      <button className="button" disabled={blocked || !saved?.permission.enabled || !saved.present || dirty || pending || waiting} onClick={() => void run('schedule')}>安排一轮</button>
      <button className="button ghost" disabled={busy} onClick={() => void run('read')}>刷新状态</button>
    </div>
    {waiting && <p className="muted">下一轮最早可在{time(saved!.next_allowed_at)}安排，到时请刷新状态。</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {dispatched && <p role="status">{pollError ? '暂时连不上，保留上次的任务状态；稍后会自动核对。' : '已交给后台处理，结果会自动更新；离开页面后也可以回来查看。'}</p>}
    <h4>最近任务 <small>· {live ? 'AI 活动试用' : '离线体验'}，最近3条</small></h4>
    {saved && (saved.tasks.length ? <ol className="life-events">{saved.tasks.slice(0, 3).map(task => <li key={task.id}>
      <strong>{task.state === 'queued' && task.dispatch_requested ? '等待后台处理' : states[task.state]}{task.activity ? ` · ${activityNames[task.activity]}` : ''}</strong>
      <p>{task.state === 'done' ? live ? 'AI 选择的活动已保存。有效期内可在场景查看；动作尚未准备好时保留原图。' : '已保存本轮活动状态；这是一条离线体验记录。' : task.error_code ? reasons[task.error_code] : task.dispatch_requested ? '后台会核对活动范围和当前住处；你仍然可以暂停。' : task.state === 'queued' ? '已安排，点击执行或暂停体验。' : '任务正在处理，请稍后刷新状态。'}</p>
      <time dateTime={new Date(task.created_at * 1000).toISOString()}>{time(task.created_at)}（上海时间）</time>
      {!task.dispatch_requested && (task.state === 'queued' || task.state === 'running') && <div className="season-actions"><button className="button" disabled={blocked || !saved.permission.enabled || !saved.present || dirty || (task.state === 'running' && saved.observed_at < task.retry_at)} onClick={() => void run('run', task.id)}>{task.state === 'queued' ? live ? '请求 AI 安排这轮' : '执行这轮体验' : live ? '核对这轮体验' : '继续这轮体验'}</button></div>}
    </li>)}</ol> : <p>还没有体验任务。选择活动并开启后，可以安排一轮。</p>)}
    {saved?.automatic && <section aria-label={live ? '每天 AI 自动安排' : '每天自动体验'} className="season-panel">
      <h4>{live ? '每天 AI 自动安排' : '每天自动体验'} · {saved.automatic.enabled ? '已开启' : '已关闭'}</h4>
      <p>{live ? '开启后，离开时由 AI 每天最多安排2轮，至少间隔10分钟；观看时可单独开启更频繁的安排。每轮可能产生模型费用，只使用已授权预算；额度不足时等待，额度恢复后继续。服务关闭时停止，不补写错过的活动。' : '离开时每天最多2轮，至少间隔10分钟。观看时可单独开启更频繁的体验；失联最多75秒后转为离开状态。服务关闭时停止，不补写错过的活动。这是预设体验，不调用AI。'}</p>
      <p>今日离开时已安排 {saved.automatic.today_count} / 2 轮（上海日期）</p>
      {live && saved.automatic.budget_available === false && <p role="status">已授权预算不足以执行下一轮，{saved.automatic.enabled ? '自动安排正在等待。' : '当前无法开启。'}</p>}
      {saved.automatic.enabled && <p>后台当前按{(saved.automatic.viewing_until ?? 0) > saved.observed_at ? '有人观看' : '无人观看'}的频率安排{stale ? '（上次状态，待核对）' : ''}。</p>}
      {saved.automatic.enabled && stale && <p role="status">暂时连不上，已停止本页观看状态的续报；失联最多75秒后转为离开时的频率。恢复后可重新开启观看{live ? '模式' : '体验'}。</p>}
      {saved.automatic.enabled && <p>下次检查：{time(saved.automatic.next_at)}（上海时间）。伙伴在场、授权有效且没有待处理任务时才会安排。</p>}
      {!saved.permission.enabled && <p>先选择活动，再点“保存并开启体验”。</p>}
      <button type="button" className="button" disabled={blocked || stale || (!saved.automatic.enabled && (!saved.permission.enabled || !saved.present || dirty || saved.automatic.budget_available === false))} onClick={() => void run(saved.automatic!.enabled ? 'automatic_stop' : 'automatic_start')}>{saved.automatic.enabled ? live ? '停止每天 AI 自动安排' : '停止每天自动体验' : live ? '开启每天 AI 自动安排' : '开启每天自动体验'}</button>
      {saved.automatic.enabled && saved.present && !stale && !uncertain && <LifeViewingControl key={`${saved.origin}:${saved.automatic.revision}`} spaceId={spaceId} revision={saved.automatic.revision} live={live} disabled={busy || dirty || saved.automatic.budget_available === false} />}
    </section>}
    {saved && <LifeActivityHistory snapshot={saved} available={!stale && !uncertain} scene={historyScene} />}
  </section>;
}
