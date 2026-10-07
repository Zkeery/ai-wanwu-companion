'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { seasonApi, seasonNames, type Season, type SeasonSettings, type SeasonSnapshot } from '@/lib/seasons';

export default function SeasonSettingsPanel({ spaceId, onSeason, readOnly = false, renderPreview }: { spaceId: string; onSeason: (season: Season | null) => void; readOnly?: boolean; renderPreview?: (season: Season) => ReactNode }) {
  const [saved, setSaved] = useState<SeasonSnapshot | null>(null);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(''), [hemisphere, setHemisphere] = useState(''), [weeks, setWeeks] = useState(''), [start, setStart] = useState('');
  const [preview, setPreview] = useState<SeasonSnapshot | null>(null);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const controller = useRef<AbortController | null>(null), lock = useRef(false);
  const alive = useRef(false);
  const editingRef = useRef(false);
  useEffect(() => { editingRef.current = editing; }, [editing]);
  const apply = useCallback((result: SeasonSnapshot) => { setSaved(result); onSeason(result.current_season); }, [onSeason]);
  const load = useCallback(async () => {
    if (lock.current || !alive.current) return;
    lock.current = true;
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await seasonApi.read(spaceId, abort.signal);
      if (!alive.current || abort.signal.aborted) return;
      apply(result); setError(''); setUncertain(false); setPreview(null);
    } catch {
      if (alive.current && !abort.signal.aborted) setError(readOnly ? '暂时无法读取四季设置，请重试核对。' : '暂时无法读取四季设置，请重试核对；布置仍可继续。');
    } finally { if (controller.current === abort) { lock.current = false; if (alive.current) setBusy(false); } }
  }, [spaceId, apply, readOnly]);

  useEffect(() => {
    alive.current = true;
    queueMicrotask(() => { if (alive.current) void load(); });
    const focus = () => { if (!editingRef.current && document.visibilityState !== 'hidden') void load(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { alive.current = false; controller.current?.abort(); lock.current = false; window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [load]);
  useEffect(() => {
    if (!saved?.next_change_at) return;
    const delay = Math.max(1000, Math.min(86400000, (saved.next_change_at - saved.observed_at) * 1000));
    let timer = setTimeout(tick, delay);
    function tick() {
      if (lock.current) { timer = setTimeout(tick, 1000); return; }
      void load();
    }
    return () => clearTimeout(timer);
  }, [saved, load]);

  const settings: SeasonSettings | null = mode === 'real' && (hemisphere === 'north' || hemisphere === 'south') ? { mode, hemisphere } : mode === 'virtual' && ['1', '2', '4'].includes(weeks) && Object.hasOwn(seasonNames, start) ? { mode, weeks: Number(weeks) as 1 | 2 | 4, start_season: start as Season } : null;
  function edit() {
    const s = saved?.settings;
    setMode(s?.mode ?? ''); setHemisphere(s?.mode === 'real' ? s.hemisphere : '');
    setWeeks(s?.mode === 'virtual' ? String(s.weeks) : ''); setStart(s?.mode === 'virtual' ? s.start_season : '');
    setPreview(null); setMessage(''); setEditing(true);
  }
  function changed(set: (value: string) => void, value: string) { set(value); setPreview(null); setMessage(''); }
  async function submit(confirm: boolean) {
    if (!settings || !saved || lock.current || uncertain || (confirm && !preview)) return;
    lock.current = true; setBusy(true); setError(''); setMessage(confirm ? '正在保存四季…' : '正在准备预览…');
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = confirm ? await seasonApi.save(spaceId, settings, preview!.revision, crypto.randomUUID(), abort.signal) : await seasonApi.preview(spaceId, settings, abort.signal);
      if (!alive.current || abort.signal.aborted) return;
      if (confirm) { apply(result); setEditing(false); setPreview(null); setMessage('四季已保存，场景现在生效。'); }
      else { setPreview(result); setMessage(''); }
    } catch {
      if (!alive.current || abort.signal.aborted) return;
      setPreview(null); setMessage('');
      if (confirm) {
        setUncertain(true); setError('保存结果待核对，正在读取服务器状态…');
        try {
          const result = await seasonApi.read(spaceId, abort.signal);
          if (!alive.current || abort.signal.aborted) return;
          apply(result); setUncertain(false);
          if (JSON.stringify(result.settings) === JSON.stringify(settings)) { setError(''); setEditing(false); setMessage('已核对：四季设置已保存。'); }
          else setError('已核对服务器设置，请重新预览后再确认。');
        } catch { if (alive.current && !abort.signal.aborted) setError('暂时无法确认保存结果，请先核对设置。'); }
      } else setError('预览暂时没有完成，请重试；尚未修改你的四季。');
    } finally { if (controller.current === abort) { lock.current = false; if (alive.current) setBusy(false); } }
  }

  return <section className="season-panel" aria-label="这里的四季">
    <div className="season-summary"><div><strong>这里的四季{saved?.current_season ? ` · ${seasonNames[saved.current_season]}` : ''}</strong><p>{saved ? saved.settings ? saved.settings.mode === 'real' ? `跟随现实 · ${saved.settings.hemisphere === 'north' ? '北' : '南'}半球` : `虚拟四季 · 每季 ${saved.settings.weeks} 周` : '保持基础场景，你可以稍后选择。' : error ? '四季状态待核对' : '正在读取四季设置…'}</p></div>
      {!editing && !readOnly && <button className="button ghost" onClick={edit} disabled={busy || !saved || uncertain}>{saved?.settings ? '调整四季' : '设置四季'}</button>}
    </div>
    {error && <p role="alert">{error} <button className="button ghost" disabled={busy} onClick={() => void load()}>核对设置</button></p>}
    {editing && !readOnly && <div className="season-editor">
      <fieldset disabled={busy || uncertain}><legend>让这里怎样度过四季？</legend><div className="season-options">
        <label><input type="radio" name={`season-${spaceId}`} checked={mode === 'real'} onChange={() => changed(setMode, 'real')} />跟随现实四季</label>
        <label><input type="radio" name={`season-${spaceId}`} checked={mode === 'virtual'} onChange={() => changed(setMode, 'virtual')} />虚拟四季</label>
      </div>
      {mode === 'real' && <><label className="season-field">半球<select value={hemisphere} onChange={e => changed(setHemisphere, e.target.value)}><option value="">请选择半球</option><option value="north">北半球</option><option value="south">南半球</option></select></label><p>按月份变化，使用上海时区。不读取位置，也不是实时天气。</p></>}
      {mode === 'virtual' && <div className="season-fields"><label className="season-field">每季多久<select value={weeks} onChange={e => changed(setWeeks, e.target.value)}><option value="">请选择周期</option>{[1, 2, 4].map(n => <option value={n} key={n}>{n} 周</option>)}</select></label><label className="season-field">从哪个季节开始<select value={start} onChange={e => changed(setStart, e.target.value)}><option value="">请选择起始季节</option>{Object.entries(seasonNames).map(([s, name]) => <option key={s} value={s}>{name}</option>)}</select></label></div>}
      </fieldset>
      {preview?.current_season && <div className="season-preview"><strong>确认后，这里将是{seasonNames[preview.current_season]}</strong><p>确认后立即生效，布置和成长进度保持原样。{mode === 'virtual' ? '修改规则会从所选季节重新计时；相同设置不会重置。' : '之后随月份更替季节。'}</p><small>空间时区：Asia/Shanghai</small>{renderPreview?.(preview.current_season)}</div>}
      <div className="season-actions"><button className="button" disabled={!settings || !saved || busy || uncertain} onClick={() => void submit(!!preview)}>{busy ? '请稍候…' : preview ? '确认设置' : '预览效果'}</button><button className="button ghost" disabled={busy} onClick={() => { setEditing(false); setPreview(null); setMessage(''); }}>{saved?.settings ? '取消修改' : '稍后选择'}</button></div>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
