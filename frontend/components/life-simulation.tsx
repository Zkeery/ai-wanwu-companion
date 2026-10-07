'use client';
import { useEffect, useRef, useState } from 'react';
import { activityNames, lifeApi, type Activity, type LifeSnapshot } from '@/lib/life-simulation';
import { kindMeta } from '@/lib/living-ui';
import { seasonNames, type Season } from '@/lib/seasons';

const outcomes: Record<string, string> = { saved: '生活设置已保存。', executed: '已完成一步模拟，记录已保存。', paused: '模拟已暂停，不会执行活动。', away: '伙伴已离开这个空间，本轮没有执行。', cooldown: '还没到下一轮时间；每个空间至少间隔10分钟。', offline_limit: '今天的离线模拟次数已用完。', no_allowed_activity: '当前没有可执行的允许活动：夜间只休息，观察需要现有物件。' };

export default function LifeSimulation({ spaceId }: { spaceId: string }) {
  const [saved, setSaved] = useState<LifeSnapshot | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [uncertain, setUncertain] = useState(false);
  const active = useRef(false), locked = useRef(false), abort = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController(); abort.current = controller;
    lifeApi.read(spaceId, controller.signal).then(r => {
      if (!active.current || controller.signal.aborted) return;
      setSaved(r); setActivities(r.settings.activities);
    }).catch(() => { if (active.current && !controller.signal.aborted) setError('暂时无法读取生活模拟，请刷新记录。'); });
    return () => { active.current = false; abort.current?.abort(); };
  }, [spaceId]);

  async function run(operation: 'read' | 'save' | 'step', enabled = false) {
    if (!active.current || locked.current || (operation !== 'read' && (!saved || uncertain))) return;
    locked.current = true; setBusy(true); setError(''); setMessage(operation === 'step' ? '正在模拟…' : operation === 'save' ? '正在保存…' : '正在核对…');
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    try {
      const r = operation === 'read' ? await lifeApi.read(spaceId, controller.signal) : operation === 'save' ? await lifeApi.save(spaceId, saved!.revision, { enabled, activities }, controller.signal) : await lifeApi.step(spaceId, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      setSaved(r); setUncertain(false); setMessage(outcomes[r.outcome] ?? '记录已刷新。');
    } catch {
      if (!active.current || controller.signal.aborted) return;
      setMessage(''); setError('暂时无法完成，请先刷新记录核对。');
      if (operation !== 'read') {
        setUncertain(true);
        try {
          const r = await lifeApi.read(spaceId, controller.signal);
          if (!active.current || controller.signal.aborted) return;
          setSaved(r); setUncertain(false); setError('已核对服务器记录；请查看结果后再决定下一步。');
        } catch { /* Explicit read retry only; never repeat the write. */ }
      }
    } finally { if (abort.current === controller) { locked.current = false; if (active.current) setBusy(false); } }
  }
  const dirty = JSON.stringify([...activities].sort()) !== JSON.stringify([...(saved?.settings.activities ?? [])].sort());
  return <section className="season-panel life-simulation" aria-label="伙伴的一天模拟体验">
    <h3>伙伴的一天 <small>· 模拟体验</small></h3>
    <p>先试试它的一天。这里不调用AI，也不会改变成长或生成聊天。</p>
    <p><strong>{saved ? saved.settings.enabled ? '模拟已开启' : '模拟已暂停' : error ? '状态待核对' : '正在读取…'}</strong>{saved && !saved.present && ' · 伙伴不在这个空间'}</p>
    <fieldset disabled={busy || !saved || uncertain}><legend>你愿意让它做哪些事？</legend><div className="season-options">
      {(Object.keys(activityNames) as Activity[]).map(a => <label key={a}><input type="checkbox" checked={activities.includes(a)} onChange={e => setActivities(old => e.target.checked ? [...old, a] : old.filter(v => v !== a))} />{activityNames[a]}</label>)}
    </div></fieldset>
    <p>夜间只休息；观察需要场景里有物件。每个空间至少间隔10分钟执行一轮。</p>
    <div className="season-actions">
      <button className="button" disabled={busy || !saved || uncertain || !activities.length || (!!saved?.settings.enabled && !dirty)} onClick={() => void run('save', true)}>{saved?.settings.enabled ? '保存活动范围' : '开启模拟'}</button>
      {saved?.settings.enabled && <button className="button ghost" disabled={busy || uncertain} onClick={() => void run('save', false)}>暂停模拟</button>}
      <button className="button" disabled={busy || uncertain || !saved?.settings.enabled || !saved.present || dirty} onClick={() => void run('step')}>模拟一步</button>
      <button className="button ghost" disabled={busy} onClick={() => void run('read')}>刷新记录</button>
    </div>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <h4>生活记录 <small>· 仅模拟，最近20条</small></h4>
    {saved?.events.length ? <ol className="life-events">{saved.events.map(e => <li key={e.id}><strong>模拟 · {activityNames[e.activity]}{e.target_kind ? ` · ${kindMeta[e.target_kind]?.name ?? '场景物件'}` : ''}</strong><p>{e.reason}{e.season ? ` · ${seasonNames[e.season as Season]}` : ' · 基础场景'}</p><time dateTime={new Date(e.created_at * 1000).toISOString()}>{new Date(e.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（上海时间）</time></li>)}</ol> : <p>还没有模拟记录。开启后，点“模拟一步”试试看。</p>}
  </section>;
}
