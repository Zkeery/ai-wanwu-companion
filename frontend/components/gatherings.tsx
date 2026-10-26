'use client';
import { withBasePath } from '@/lib/base-path';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorText } from '@/lib/api';
import { type Character } from '@/lib/contracts';
import { activityEvidence, gatheringAreaNames, gatheringCompanionArea, gatherings, type Gathering, sceneNames, seasonNames, itemNames } from '@/lib/gatherings';
import AuthModal from './auth-modal';
import SpaceDecorations from './space-decorations';
import GatheringWorld from './gathering-world';
import GatheringDialogue from './gathering-dialogue';
import { Brand, Loading, Modal, Notice } from './common';
import { useTeamSession } from './team-shared';
import { getToken } from '@/lib/auth';
import { useGatheringSync } from '@/lib/use-gathering-sync';
import { describeCompanionPresence, type GatheringCompanionPresence } from '@/lib/gathering-presence';

async function previewHomeInvitation(token: string) {
  try { return await gatherings.preview(token); }
  catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw new Error('住处邀请无效或已失效，请向住处管理者获取当前邀请。账号登录码不能填在这里；如果你已经加入过，请从下方住处列表直接进入。');
    throw error;
  }
}

function SeasonFields({ choose }: { choose: (value: Record<string, unknown> | null) => void }) {
  const [mode, setMode] = useState(''), [hemisphere, setHemisphere] = useState('north'), [weeks, setWeeks] = useState(1), [season, setSeason] = useState('spring');
  function change(m: string, h = hemisphere, w = weeks, s = season) { setMode(m); setHemisphere(h); setWeeks(w); setSeason(s); choose(m === 'real' ? { mode: m, hemisphere: h } : m === 'virtual' ? { mode: m, weeks: w, start_season: s } : null); }
  return <div className="hub-fields"><label className="field">四季方式<select value={mode} onChange={e => change(e.target.value)}><option value="">稍后选择</option><option value="real">跟随现实四季</option><option value="virtual">体验虚拟四季</option></select></label>{mode === 'real' && <label className="field">半球<select value={hemisphere} onChange={e => change(mode, e.target.value)}><option value="north">北半球</option><option value="south">南半球</option></select></label>}{mode === 'virtual' && <><label className="field">每个季节<select value={weeks} onChange={e => change(mode, hemisphere, Number(e.target.value))}>{[1, 2, 4].map(w => <option key={w} value={w}>{w} 周</option>)}</select></label><label className="field">从哪个季节开始<select value={season} onChange={e => change(mode, hemisphere, weeks, e.target.value)}>{Object.entries(seasonNames).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></>}</div>;
}

function SharedLife({ session }: { session: string }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof gatherings.list>> | null>(null);
  const [personal, setPersonal] = useState<Awaited<ReturnType<typeof gatherings.personal>> | null>(null);
  const [g, setG] = useState<Gathering | null>(null), [characters, setCharacters] = useState<Character[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), lock = useRef(false);
  const [title, setTitle] = useState(''), [name, setName] = useState(''), [scene, setScene] = useState('home');
  const [season, setSeason] = useState<Record<string, unknown> | null>(null), [token, setToken] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof gatherings.preview>> | null>(null);
  const [create, setCreate] = useState(false), [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; command: Record<string, unknown> } | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [task, setTask] = useState<'companions' | 'decorate' | 'records' | 'settings'>('companions');
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [floorOccupancy, setFloorOccupancy] = useState<{space: string | null; ids: readonly number[]}>({space:null,ids:[]});
  const [companionPresence, setCompanionPresence] = useState<{space:string|null;values:readonly GatheringCompanionPresence[]}>({space:null,values:[]});
  const [commandFeedback, setCommandFeedback] = useState<{space:string;scope:string;message:string;failed:boolean}|null>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const selectionVersion = useRef(0), catalogVersion = useRef(0), personalVersion = useRef(0);
  const refreshPersonal = useCallback(async () => {
    const version = ++personalVersion.current, selection = selectionVersion.current;
    const valid = () => version === personalVersion.current && selection === selectionVersion.current && getToken() === session;
    try { const value = await gatherings.personal(); if (valid()) setPersonal(value); }
    catch { if (valid()) setError('活动已保存，库存信息稍后刷新。'); }
  }, [session]);
  const refresh = useCallback(async () => { const version = ++catalogVersion.current, personalRequest = ++personalVersion.current; const [ls, cs, ps] = await Promise.all([gatherings.list(), api.characters(), gatherings.personal()]); if (version !== catalogVersion.current || getToken() !== session) return; setList(ls); setCharacters(cs.filter(c => c.status === 'ready')); if (personalRequest === personalVersion.current) setPersonal(ps); }, [session]);
  useEffect(() => {
    let active = true;
    const selection = selectionVersion, version = selection.current;
    const catalog = ++catalogVersion.current, personalRequest = ++personalVersion.current;
    Promise.all([gatherings.list(), api.characters(), gatherings.personal()]).then(([ls, cs, ps]) => { if (active && catalog === catalogVersion.current && getToken() === session) { setList(ls); setCharacters(cs.filter(c => c.status === 'ready')); if (personalRequest === personalVersion.current) setPersonal(ps); } }).catch(e => { if (active && catalog === catalogVersion.current) setError(errorText(e)); });
    const params = new URLSearchParams(location.search), invite = params.get('invite'), group = params.get('space');
    if (invite) { previewHomeInvitation(invite).then(p => { if (active && version === selectionVersion.current) { setToken(invite); setPreview(p); } }).catch(e => { if (active && version === selectionVersion.current) setError(errorText(e)); }); }
    else if (group) gatherings.read(group).then(v => { if (active && version === selectionVersion.current) setG(v); }).catch(e => { if (active && version === selectionVersion.current) setError(errorText(e)); });
    return () => { active = false; selection.current++; };
  }, []);
  const work = useCallback(async (fn: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { lock.current = false; setBusy(false); }
  }, []);
  const unavailable = useCallback(() => {
    selectionVersion.current++;
    setG(null); setList(null); setSelected([]); setFocusedId(null);
    history.replaceState(null, '', withBasePath('/gatherings'));
    void work(refresh);
    setError('这个共同住处暂时无法访问，已返回住处列表。');
  }, [work, refresh]);
  const spaceId = g?.id ?? null, currentRevision = g?.revision ?? 0;
  const updateFloorOccupancy = useCallback((ids: readonly number[]) => { const sorted = [...ids].sort((a,b) => a-b); setFloorOccupancy(previous => previous.space === spaceId && JSON.stringify(previous.ids) === JSON.stringify(sorted) ? previous : {space:spaceId,ids:sorted}); }, [spaceId]);
  const updateCompanionPresence = useCallback((values: readonly GatheringCompanionPresence[]) => { const sorted = [...values].sort((a,b) => a.id-b.id); setCompanionPresence(previous => previous.space === spaceId && JSON.stringify(previous.values) === JSON.stringify(sorted) ? previous : {space:spaceId,values:sorted}); }, [spaceId]);
  const displayPresence = (c: Gathering['companions'][number]) => (companionPresence.space === spaceId ? companionPresence.values.find(v => v.id === c.id) : undefined) ?? describeCompanionPresence(g!, c);
  const layoutBlocked = floorOccupancy.space === spaceId && floorOccupancy.ids.length > 0;
  const feedbackScope = (cmd: Record<string, unknown>) => ['layout','restore_inventory','start_goal'].includes(String(cmd.action)) ? 'decorate' : ['activity','leisure','recall','visit'].includes(String(cmd.action)) ? 'companions' : null;
  const applySynced = useCallback((snapshot: Gathering) => {
    if (snapshot.id !== spaceId || snapshot.revision < currentRevision) return;
    if (snapshot.closed || !snapshot.members.some(m => m.id === snapshot.me)) { unavailable(); return; }
    setG(snapshot);
    setSelected(ids => ids.filter(id => snapshot.companions.some(c => c.id === id && c.owner_id === snapshot.me)));
    setFocusedId(id => snapshot.companions.some(c => c.id === id) ? id : null);
  }, [spaceId, currentRevision, unavailable]);
  const blocked = useCallback(() => lock.current, []);
  const sync = useGatheringSync({ spaceId, accountToken: session, paused: busy || create || settings || !!confirm, blocked, onSnapshot: applySynced, onUnavailable: unavailable });
  function requestId(key: string) { if (!pending.current || pending.current.key !== key) pending.current = { key, id: crypto.randomUUID() }; return pending.current.id; }
  function open(v: Gathering) { selectionVersion.current++; setTask('companions'); setG(v); setSelected([]); setFocusedId(null); history.replaceState(null, '', withBasePath(`/gatherings?space=${v.id}`)); }
  async function command(cmd: Record<string, unknown>, propagate = false) {
    if (!g || lock.current) { if (propagate) throw new Error('上一项操作正在保存，请稍后再试。'); return; }
    const current = g, account = session, version = selectionVersion.current, scope = feedbackScope(cmd);
    if (scope) setCommandFeedback(null);
    let failure: unknown;
    await work(async () => {
      let v: Gathering;
      try { v = await gatherings.command(current, cmd, requestId(JSON.stringify([current.id, current.revision, cmd]))); }
      catch (error) {
        failure = error;
        // A lost acknowledgement may follow a committed command. Read once; never resend the POST.
        try { const recovered = await gatherings.read(current.id); if (getToken() === account && version === selectionVersion.current) applySynced(recovered); } catch { /* Keep the previous snapshot and pending receipt for an explicit recovery. */ }
        throw error;
      }
      if (getToken() !== account || version !== selectionVersion.current) return;
      pending.current = null; setConfirm(null); setSettings(false); setSelected([]);
      if (v.closed || !v.members.some(m => m.id === v.me)) { setG(null); history.replaceState(null, '', withBasePath('/gatherings')); await refresh(); }
      else {
        setG(v);
        if (scope) setCommandFeedback({space:current.id,scope,failed:false,message:cmd.action === 'layout' && (cmd.command as {action?:string})?.action === 'care' ? '照料已保存，成长和照料时间已更新。' : scope === 'decorate' ? '布置已保存，画面与物件列表已更新。' : '安排已保存，伙伴会按新活动行动。'});
        if (cmd.action === 'activity' && Array.isArray(cmd.character_ids)) setFocusedId(cmd.character_ids[0] ?? null);
        if (cmd.action === 'leisure' && typeof cmd.character_id === 'number') setFocusedId(cmd.character_id);
        // The POST is the activity receipt. Inventory refresh must not keep
        // the command lock or animation paused after that receipt arrives.
        void refreshPersonal();
      }
    });
    if (scope && failure && getToken() === account && version === selectionVersion.current) { setError(''); setCommandFeedback({space:current.id,scope,failed:true,message:errorText(failure)}); }
    if (propagate && failure) throw failure;
  }
  const activeMembers = g?.companions.filter(c => c.owner_id === g.me) || [];
  const activityNames: Record<string, string> = { arriving: '刚刚到达', rest: '休息', sleep: '睡觉', walk: '散步', observe: '观察', talk: '相聚' };
  const focused = g?.companions.find(c => c.id === focusedId);
  const evidence = g && focused ? activityEvidence(g, focused.id) : null;
  async function recover() {
    const version = ++selectionVersion.current;
    const params = new URLSearchParams(location.search), group = g?.id || params.get('space'), invite = params.get('invite');
    if (group) {
      const snapshot = await gatherings.read(group);
      if (version !== selectionVersion.current || getToken() !== session) return;
      if (g) applySynced(snapshot); else setG(snapshot);
    } else if (invite) { const snapshot = await previewHomeInvitation(invite); if (version !== selectionVersion.current || getToken() !== session) return; setToken(invite); setPreview(snapshot); }
    await refresh();
  }
  function chooseTask(next: typeof task, scroll = false) {
    setTask(next);
    if (scroll) requestAnimationFrame(() => document.getElementById('gathering-task-navigation')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  }
  const tasks = [
    { id: 'companions', label: '伙伴与活动', description: '带伙伴来 · 安排活动' },
    { id: 'decorate', label: '布置与照料', description: '摆放物件 · 照料小树' },
    { id: 'records', label: '共同记录', description: '生活故事 · 一起的回忆' },
    { id: 'settings', label: '成员与设置', description: '邀请朋友 · 四季投票' },
  ] as const;
  return <>
    {g ? <header className="hub-home-heading">
      <div><button type="button" className="hub-text-button" disabled={busy} onClick={() => { selectionVersion.current++; setG(null); setSelected([]); setFocusedId(null); setTask('companions'); history.replaceState(null, '', withBasePath('/gatherings')); void work(refresh); }}>← 所有共同住处</button>
        <h1>{g.title}</h1><p className="hub-home-meta">{sceneNames[g.scene_type]} · {g.season ? seasonNames[g.season] : '四季尚未选择'}<span>{g.members.length} 位成员 · {g.companions.length} 位伙伴</span></p></div>
      <div className="hub-actions"><button className="button" onClick={() => chooseTask('decorate', true)}>布置住处</button><button className="button primary" onClick={() => chooseTask('settings', true)}>{g.is_manager ? '邀请朋友' : '查看成员'}</button></div>
    </header> : <header className="hub-home-heading"><div><div className="eyebrow">LIFE TOGETHER</div><h1>留个位置，一起生活。</h1><p>带伙伴相聚、布置共同住处，也随时可以回家。</p></div></header>}
    {error && <Notice retry={() => void work(recover)}>{error}</Notice>}
    {!g ? <>
      <div className="hub-actions hub-start-actions"><button className="button primary" disabled={busy} onClick={() => setCreate(true)}>创建共同生活空间</button><Link className="button" href="/teams">好友作品小队</Link></div>
      <section className="team-panel"><h2>加入朋友的住处</h2><p id="home-invitation-help">这里只填写住处邀请，账号登录码不要填在这里。已经加入过？登录后可从下方列表或原住处地址直接进入，无需再次加入。</p><form onSubmit={e => { e.preventDefault(); void work(async () => { const value = token.includes('?') ? new URL(token).searchParams.get('invite') || '' : token; setToken(value); setPreview(await previewHomeInvitation(value)); }); }}><label className="field">住处邀请链接或邀请码<input value={token} maxLength={1000} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby="home-invitation-help" placeholder="粘贴住处管理者发来的邀请" onChange={e => { setToken(e.target.value); setPreview(null); }} /></label><button className="button" disabled={busy || !token}>查看住处邀请</button></form>{preview && <div className="hub-invitation"><h3>{preview.title}</h3><p>{sceneNames[preview.scene_type]} · {preview.member_count}/5 位成员 · {seasonNames[preview.season] || preview.season}</p><label className="field">你在这里的昵称<input value={name} maxLength={20} onChange={e => setName(e.target.value)} /></label><button className="button primary" disabled={busy || !name.trim()} onClick={() => void work(async () => { open(await gatherings.join({ request_id: requestId(JSON.stringify(['join', token, name])), token, display_name: name })); pending.current = null; setPreview(null); })}>确认加入</button></div>}</section>
      {list === null ? <Loading /> : <div className="team-list">{list.map(s => <button key={s.id} className="team-panel hub-space-button" disabled={busy} onClick={() => void work(async () => open(await gatherings.read(s.id)))}><span>{sceneNames[s.scene_type]} · {s.member_count} 位成员</span><h2>{s.title}</h2><span>进去相聚 →</span></button>)}{!list.length && <p>还没有共同住处，可以先用自己的两位伙伴体验。</p>}</div>}
      {personal && <section className="team-panel"><h2>我的库存与共同回忆</h2><p>{personal.inventory.length ? personal.inventory.map(i => itemNames[i.kind] || i.kind).join('、') : '暂时没有收回的物件。'}</p>{personal.notifications.map(n => <p key={n.id}>{n.message}</p>)}<details><summary>共同回忆（{personal.memories.length}）</summary>{personal.memories.slice(-30).reverse().map(m => <p key={m.id}>{m.message}</p>)}</details></section>}

    </> : <>
      <div id="gathering-task-navigation" className="hub-task-navigation" role="tablist" aria-label="共同住处功能">{tasks.map((entry, index) => <button type="button" key={entry.id} id={`gathering-tab-${entry.id}`} role="tab" aria-label={entry.label} aria-selected={task === entry.id} aria-controls={`gathering-panel-${entry.id}`} tabIndex={task === entry.id ? 0 : -1} onClick={() => chooseTask(entry.id)} onKeyDown={e => { const next = e.key === 'ArrowRight' ? (index + 1) % tasks.length : e.key === 'ArrowLeft' ? (index + tasks.length - 1) % tasks.length : e.key === 'Home' ? 0 : e.key === 'End' ? tasks.length - 1 : null; if (next === null) return; e.preventDefault(); chooseTask(tasks[next].id); document.getElementById(`gathering-tab-${tasks[next].id}`)?.focus(); }}><strong>{entry.label}</strong><span>{entry.description}</span></button>)}</div>
      <div className="hub-sync"><p role="status" data-stale={sync.stale}>{sync.stale ? '暂时连不上，显示的是上次读取的近况；连接恢复后会继续更新。' : '近况自动更新'}</p><button className="hub-text-button" disabled={busy} onClick={() => void work(recover)}>刷新近况</button></div>
      <div className="hub-scene-workspace" hidden={task === 'records' || task === 'settings'}>
      <GatheringWorld onCompanionPresenceChange={updateCompanionPresence} onFloorOccupancyChange={updateFloorOccupancy} gathering={g} focusedId={focusedId} onSelect={setFocusedId} busy={busy} onActivity={(id, activity) => {
        if (!g.companions.some(c => c.id === id && c.owner_id === g.me)) return;
        return command({ action: 'activity', character_ids: [id], activity }, true);
      }} onLeisureAction={request => {
        if (!g.companions.some(c => c.id === request.actorId && c.owner_id === g.me)) return;
        return command({ action: 'leisure', character_id: request.actorId, activity: request.activity, seat_id: request.seatId ?? null, station_version: 1 }, true);
      }} suspended={busy || settings || !!confirm || task === 'records' || task === 'settings'} />
      {focused && <section className="team-panel hub-companion-detail" aria-label={`${focused.name}的生活近况`}>
        <div className="hub-section-heading"><div><h2>{focused.name}<span className="hub-activity-chip">{displayPresence(focused).activityLabel}</span></h2><p>{focused.owner_id === g.me ? '你的伙伴' : '朋友的伙伴 · 活动由主人安排'}{g.scene_type === 'home' && <> · {displayPresence(focused).locationLabel}</>}</p></div>
        {focused.owner_id === g.me && <div className="hub-actions"><button className="button primary" onClick={() => { setSelected(ids => ids.includes(focused.id) ? ids : [...ids, focused.id]); chooseTask('companions', true); }}>选中安排活动</button><Link className="button" href={`/companions/${focused.id}?tab=chat`}>和{focused.name}说话</Link></div>}</div>
        <details className="hub-disclosure"><summary>查看活动记录</summary><p>{evidence ? evidence.message : '还没有与当前活动对应的记录。'}</p></details>
      </section>}
      </div>
      <div className="hub-task-panel" role="tabpanel" id="gathering-panel-companions" aria-labelledby="gathering-tab-companions" hidden={task !== 'companions'}>
        <section className="team-panel hub-partner-controls">
          {commandFeedback?.space === g.id && commandFeedback.scope === 'companions' && <p role={commandFeedback.failed ? 'alert' : 'status'}>{commandFeedback.message}</p>}
          <p className="hub-helper">直接点画面里的伙伴安排免费活动，也可以展开这里批量安排或带伙伴来。</p>
          <details className="hub-settings-disclosure" open={activeMembers.length === 0 ? true : undefined}><summary>伙伴管理与更多活动</summary>
          <div className="hub-section-heading"><div><h2>伙伴来相聚</h2><p>选中自己的伙伴，为它安排接下来的活动。</p></div><span className="hub-count">我的伙伴 {activeMembers.length}/2</span></div>
          <div className="hub-own-partners" role="group" aria-label="自己的伙伴">
            <h3><span className="hub-step-number" aria-hidden="true">1</span>选择自己的伙伴</h3>
            {activeMembers.length ? activeMembers.map(c => <div className="hub-partner-control-row" key={c.id}>
              <label className="hub-partner-choice" data-selected={selected.includes(c.id)}><input type="checkbox" aria-label="参与活动" aria-describedby={`gathering-partner-choice-${c.id}`} checked={selected.includes(c.id)} disabled={busy} onChange={e => setSelected(ids => e.target.checked ? [...new Set([...ids, c.id])] : ids.filter(id => id !== c.id))} /><span id={`gathering-partner-choice-${c.id}`}><strong>{c.name}</strong><small>{selected.includes(c.id) ? '已选中' : '点击选择'} · {displayPresence(c).activityLabel}{g.scene_type === 'home' && <> · {displayPresence(c).locationLabel}</>}</small></span></label>
              <button className="button hub-recall-button" disabled={busy} onClick={() => void command({ action: 'recall', character_id: c.id })}>回家</button>
            </div>) : <p className="hub-helper">还没有你的伙伴在场，先从下方带一位来。</p>}
          </div>
          <div className="hub-activity-picker"><h3><span className="hub-step-number" aria-hidden="true">2</span>安排活动</h3><p id="gathering-selection-hint" role="status">{selected.length ? `已选：${activeMembers.filter(c => selected.includes(c.id)).map(c => c.name).join('、')}` : '先在上方点选伙伴，活动按钮就可以使用了。'}</p>
            <div id="gathering-activities" className="hub-activity-grid" aria-describedby="gathering-selection-hint">{[{ id: 'rest', label: '休息', hint: g.scene_type === 'home' ? '坐客厅沙发' : '放松片刻', icon: '☾' }, ...(g.scene_type === 'home' ? [{ id: 'sleep', label: '睡觉', hint: '进卧室睡觉', icon: '☁' }] : []), { id: 'walk', label: '散步', hint: g.scene_type === 'home' ? '在院子走一走' : '走一走', icon: '↝' }, { id: 'observe', label: '观察', hint: g.scene_type === 'home' ? '回院子看看' : '看看周围', icon: '◉' }, { id: 'talk', label: '相聚', hint: '和大家待一会儿', icon: '♡' }].map(a => <button type="button" className="hub-activity-button" aria-label={a.label} key={a.id} disabled={busy || !selected.length} onClick={() => void command({ action: 'activity', character_ids: selected, activity: a.id })}><span className="hub-activity-symbol" aria-hidden="true">{a.icon}</span><strong>{a.label}</strong><small>{a.hint}</small></button>)}</div>
            <p className="hub-helper hub-activity-note">{g.scene_type === 'home' ? '休息坐客厅沙发，睡觉进卧室，散步和观察回院子；相聚保持所在位置。这些活动不会发起 AI 对话。' : '这些活动只改变场景中的动作，不会发起 AI 对话。'}</p>
          </div>
          {g.companions.some(c => c.owner_id !== g.me) && <div className="hub-friend-partners" role="group" aria-label="朋友的伙伴"><h3>朋友的伙伴</h3><div className="hub-friend-list">{g.companions.filter(c => c.owner_id !== g.me).map(c => <div key={c.id}><strong>{c.name}</strong><span>{activityNames[c.activity] || '在场'}{g.scene_type === 'home' && <> · {gatheringAreaNames[gatheringCompanionArea(g, c)]}</>}</span></div>)}</div><p className="hub-helper">可以一起相聚，活动由它的主人安排。</p></div>}
          <details className="hub-bring-partner hub-settings-disclosure" open={activeMembers.length === 0 ? true : undefined}><summary>＋ 带伙伴来</summary><p className="hub-helper">每人最多带两位。原来的私人住处和布置都会保留。</p><div className="hub-actions">{characters.filter(c => !g.companions.some(v => v.id === c.id)).map(c => <button className="button" disabled={busy || activeMembers.length >= 2} key={c.id} onClick={() => void command({ action: 'visit', character_id: c.id })}>带 {c.name} 来</button>)}</div>{characters.every(c => g.companions.some(v => v.id === c.id)) && <p className="hub-helper">目前没有其他可带来的伙伴。</p>}</details>
          </details>
        </section>
        <GatheringDialogue compact gathering={g} busy={busy} command={command} refresh={() => void work(async () => applySynced(await gatherings.read(g.id)))} />
      </div>
      <div className="hub-task-panel" role="tabpanel" id="gathering-panel-decorate" aria-labelledby="gathering-tab-decorate" hidden={task !== 'decorate'}>
        <section className="team-panel"><h2>一起布置休息角落</h2>{layoutBlocked && <p role="status">有伙伴在二楼。添加、移动、撤回或放回物件前，请由伙伴的主人先安排下楼；其他一楼活动和植物照料仍可进行。</p>}{commandFeedback?.space === g.id && commandFeedback.scope === 'decorate' && <p role={commandFeedback.failed ? 'alert' : 'status'}>{commandFeedback.message}</p>}<p>{g.goal === 'completed' ? g.items.some(item => item.kind === 'tree' && item.growth_status === 'mature') ? '目标已完成：小树已经长成，休息位置也布置好了。' : '这个目标已有完成记录，原记录保留。' : '开始后，种一棵树、放好休息家具，一起照料至小树长成。每次照料覆盖24小时，累计约3天有效成长。'}</p>{!g.goal && <button className="button" disabled={busy} onClick={() => void command({ action: 'start_goal' })}>开始共同目标</button>}<p>物件属于贡献者。离队后保留，解散时退回各自库存。</p><div className="hub-actions">{['tree', { home: 'bench', desert: 'shade', forest: 'cushion' }[g.scene_type] || 'bench'].map(kind => <button className="button" key={kind} disabled={busy || layoutBlocked} onClick={() => void command({ action: 'layout', command: { action: 'place', kind, x: 0.2 + (g.items.length % 4) * 0.18, y: 0.25 + Math.floor(g.items.length % 12 / 4) * 0.2 } })}>添加{itemNames[kind]}</button>)}</div>{g.items.map(i => <div className="hub-item" key={i.id}><strong>{itemNames[i.kind] || i.kind}</strong><span>{i.contributor_name} 贡献{i.growth_status === 'needs_care' ? ' · 需要照料' : ''}</span>{i.kind === 'tree' && <p>{i.stage ? ({planted:'已种下',seedling:'幼苗',growing:'生长中',mature:'已长成'} as Record<string,string>)[i.stage] || '生长状态已更新' : ''}{i.care_remaining_seconds !== undefined && i.care_remaining_seconds !== null ? i.care_remaining_seconds > 0 ? ` · 已照料，还可保持约${Math.ceil(i.care_remaining_seconds/3600)}小时` : ' · 等待照料' : ''}</p>}<div className="hub-actions">{i.kind === 'tree' && <button className="button" disabled={busy} onClick={() => void command({ action: 'layout', command: { action: 'care', item_id: i.id } })}>照料</button>}{i.mine && <><button className="button" disabled={busy || layoutBlocked} onClick={() => void command({ action: 'layout', command: { action: 'move', item_id: i.id, x: i.x > 0.7 ? 0.2 : i.x + 0.1, y: i.y } })}>向旁边挪一挪</button><button className="button" disabled={busy || layoutBlocked} onClick={() => setConfirm({ title: '将这个物件撤回自己的库存？', command: { action: 'layout', command: { action: 'store', item_id: i.id } } })}>撤回库存</button></>}</div></div>)}</section>
        <SpaceDecorations spaceId={g.id} kind="gathering" />
        <section className="team-panel"><h2>把库存物件放回来</h2>{personal?.inventory.length ? <div className="hub-actions">{personal.inventory.map(i => <button className="button" key={i.id} disabled={busy || layoutBlocked} onClick={() => void command({ action: 'restore_inventory', item_id: i.id })}>放回{itemNames[i.kind] || i.kind}</button>)}</div> : <p>撤回或解散后返还的物件会保留在你的库存。</p>}</section>
      </div>
      <div className="hub-task-panel" role="tabpanel" id="gathering-panel-records" aria-labelledby="gathering-tab-records" hidden={task !== 'records'}>
        <section className="team-panel"><h2>共同经历</h2>{!g.events.length && <p>把伙伴带来，一起留下第一段回忆。</p>}{g.events.slice().reverse().map(e => <p key={e.id}><time>{new Date(e.at * 1000).toLocaleTimeString('zh-CN')}</time> · {e.message}</p>)}</section>
        <details className="hub-disclosure hub-story-disclosure"><summary>生活里的小故事与和好</summary><section className="team-panel"><h2>生活里的小故事</h2><label><input type="checkbox" checked={g.story_enabled} disabled={busy} onChange={e => void command({ action: 'story_preference', enabled: e.target.checked })} />允许我的伙伴参与温和分歧与和好</label><p>这是角色的故事表现。关闭后不产生新剧情，已经独处的伙伴仍会恢复。</p><button className="button" disabled={busy || selected.length !== 2 || !g.story_enabled} onClick={() => void command({ action: 'story', character_ids: selected })}>体验一次有分歧后回家休息</button>{g.stories.map(s => <div key={s.id}><p>{s.message} · {s.status === 'resting' ? '正在独处，约 20 分钟自然恢复' : '已经恢复平静'}</p>{s.status === 'resting' && <button className="button" disabled={busy} onClick={() => void command({ action: 'reconcile', story_id: s.id })}>表达善意，直接和好</button>}</div>)}</section></details>
      </div>
      <div className="hub-task-panel" role="tabpanel" id="gathering-panel-settings" aria-labelledby="gathering-tab-settings" hidden={task !== 'settings'}>
        <section className="team-panel"><h2>空间成员</h2><p>邀请朋友加入，或管理共同住处。每个人只能安排自己的伙伴。</p>{g.members.map(m => <div className="hub-row" key={m.id}><span>{m.name}{m.manager ? ' · 管理者' : ''}{m.id === g.me ? ' · 我' : ''}</span>{g.is_manager && m.id !== g.me && <details className="hub-settings-disclosure"><summary>管理成员</summary><div className="hub-actions"><button className="button" disabled={busy} onClick={() => setConfirm({ title: `将管理权转交给 ${m.name}？`, command: { action: 'transfer', member_id: m.id } })}>转交管理</button><button className="button" disabled={busy} onClick={() => setConfirm({ title: `移除 ${m.name} 并召回其伙伴？贡献物件仍保留。`, command: { action: 'remove', member_id: m.id } })}>移除</button></div></details>}</div>)}
        {g.is_manager ? <><div className="hub-actions"><button className="button" disabled={busy} onClick={() => void command({ action: 'invite' })}>生成新邀请</button>{g.invitation && <button className="button" disabled={busy} onClick={() => void command({ action: 'revoke_invitation' })}>撤销邀请</button>}</div>{g.invitation && <label className="field">复制邀请链接<input readOnly value={`${typeof location === 'undefined' ? '' : location.origin}${withBasePath('/gatherings')}?invite=${g.invitation}`} onFocus={e => e.target.select()} /></label>}<details className="hub-disclosure"><summary>空间管理</summary><p>解散需成员投票通过，伙伴回家，物件按贡献归属返还。</p><button className="button" disabled={busy} onClick={() => setConfirm({ title: '发起解散投票？超过半数成员同意后，伙伴回家，所有物件按贡献归属返还。', command: { action: 'propose_dissolve' } })}>发起解散投票</button></details></> : <button className="button" disabled={busy} onClick={() => setConfirm({ title: '退出共同生活？伙伴会回家，未撤回的贡献物件继续保留。', command: { action: 'leave' } })}>退出共同生活</button>}
      </section>
        <section className="team-panel"><h2>共同四季与投票</h2><p>调整四季需要成员投票，过半同意后生效。</p><button className="button" disabled={busy} onClick={() => { setSeason(null); setSettings(true); }}>提议调整四季</button>{g.votes.slice(-8).reverse().map(v => <div className="hub-item" key={v.id}><strong>{v.kind === 'season' ? '调整共同四季' : '解散共同空间'}</strong><p>{Object.values(v.choices).filter(Boolean).length} 票同意 / 需要 {Math.floor(v.electorate.length / 2) + 1} 票 · {({ pending: '投票中', passed: '已通过', expired: '已截止，未通过', cancelled_members_changed: '成员变化，已取消', cancelled_dissolved: '空间解散，已取消' } as Record<string, string>)[v.status] || v.status}</p><p>截止：{new Date(v.deadline * 1000).toLocaleString('zh-CN')}</p>{v.status === 'pending' && !(g.me in v.choices) && <div className="hub-actions"><button className="button" disabled={busy} onClick={() => void command({ action: 'vote', vote_id: v.id, agree: true })}>同意</button><button className="button" disabled={busy} onClick={() => void command({ action: 'vote', vote_id: v.id, agree: false })}>不同意</button></div>}</div>)}</section>
      </div>
    </>}
    {create && <Modal title="开始一起生活" close={() => { if (!busy) setCreate(false); }}>{error && <Notice>{error}</Notice>}<form onSubmit={e => { e.preventDefault(); void work(async () => { const payload = { title, display_name: name, scene_type: scene, season }; open(await gatherings.create({ ...payload, request_id: requestId(JSON.stringify(['create', payload])) })); pending.current = null; setCreate(false); }); }}><label className="field">空间名字<input maxLength={30} value={title} onChange={e => setTitle(e.target.value)} /></label><label className="field">你的昵称<input maxLength={20} value={name} onChange={e => setName(e.target.value)} /></label><label className="field">生活场景<select value={scene} onChange={e => setScene(e.target.value)}>{Object.entries(sceneNames).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><SeasonFields choose={setSeason} /><button className="button primary" disabled={busy || !title.trim() || !name.trim()}>确认创建</button></form></Modal>}
    {settings && <Modal title="提议共同四季" close={() => { if (!busy) setSettings(false); }}><p>需要当前成员过半同意，24 小时截止。季节变化保留任务与植物成长。</p><SeasonFields choose={setSeason} /><button className="button primary" disabled={busy || !season} onClick={() => void command({ action: 'propose_season', settings: season })}>提交提议并投同意票</button></Modal>}
    {confirm && <Modal title="确认操作" close={() => { if (!busy) setConfirm(null); }}>{error && <Notice>{error}</Notice>}<p>{confirm.title}</p><div className="hub-actions"><button className="button" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className="button primary" disabled={busy} onClick={() => void command(confirm.command)}>确认</button></div></Modal>}
  </>;
}

export default function Gatherings() {
  const session = useTeamSession(), [login, setLogin] = useState(false);
  return <div className="shell"><header className="site-header"><Brand /><Link className="back-link" href="/discover">返回发现</Link></header><main className="teams-page hub-page">{session ? <SharedLife key={session} session={session} /> : <section className="team-panel"><h1>一起生活</h1><p>登录后，带伙伴来相聚。</p><button className="button primary" onClick={() => setLogin(true)}>注册 / 登录</button></section>}</main>{login && <AuthModal onClose={() => setLogin(false)} onLoggedIn={() => setLogin(false)} />}</div>;
}
