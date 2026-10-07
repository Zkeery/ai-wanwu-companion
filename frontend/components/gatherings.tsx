'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { type Character } from '@/lib/contracts';
import { activityEvidence, gatherings, type Gathering, sceneNames, seasonNames, itemNames } from '@/lib/gatherings';
import AuthModal from './auth-modal';
import SpaceDecorations from './space-decorations';
import GatheringWorld from './gathering-world';
import GatheringDialogue from './gathering-dialogue';
import { Brand, Loading, Modal, Notice } from './common';
import { useTeamSession } from './team-shared';
import { getToken } from '@/lib/auth';
import { useGatheringSync } from '@/lib/use-gathering-sync';

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
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const selectionVersion = useRef(0), catalogVersion = useRef(0);
  const refresh = useCallback(async () => { const version = ++catalogVersion.current; const [ls, cs, ps] = await Promise.all([gatherings.list(), api.characters(), gatherings.personal()]); if (version !== catalogVersion.current || getToken() !== session) return; setList(ls); setCharacters(cs.filter(c => c.status === 'ready')); setPersonal(ps); }, [session]);
  useEffect(() => {
    let active = true;
    const selection = selectionVersion, version = selection.current;
    const catalog = ++catalogVersion.current;
    Promise.all([gatherings.list(), api.characters(), gatherings.personal()]).then(([ls, cs, ps]) => { if (active && catalog === catalogVersion.current) { setList(ls); setCharacters(cs.filter(c => c.status === 'ready')); setPersonal(ps); } }).catch(e => { if (active && catalog === catalogVersion.current) setError(errorText(e)); });
    const params = new URLSearchParams(location.search), invite = params.get('invite'), group = params.get('space');
    if (invite) { gatherings.preview(invite).then(p => { if (active && version === selectionVersion.current) { setToken(invite); setPreview(p); } }).catch(e => { if (active && version === selectionVersion.current) setError(errorText(e)); }); }
    else if (group) gatherings.read(group).then(v => { if (active && version === selectionVersion.current) setG(v); }).catch(e => { if (active && version === selectionVersion.current) setError(errorText(e)); });
    return () => { active = false; selection.current++; };
  }, []);
  const work = useCallback(async (fn: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { lock.current = false; setBusy(false); }
  }, []);
  const unavailable = useCallback(() => {
    setG(null); setList(null); setSelected([]); setFocusedId(null);
    history.replaceState(null, '', '/gatherings');
    void work(refresh);
    setError('这个共同住处暂时无法访问，已返回住处列表。');
  }, [work, refresh]);
  const spaceId = g?.id ?? null, currentRevision = g?.revision ?? 0;
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
  function open(v: Gathering) { selectionVersion.current++; setG(v); setSelected([]); setFocusedId(null); history.replaceState(null, '', `/gatherings?space=${v.id}`); }
  async function command(cmd: Record<string, unknown>) {
    if (!g) return;
    const current = g;
    await work(async () => {
      const v = await gatherings.command(current, cmd, requestId(JSON.stringify([current.id, current.revision, cmd])));
      pending.current = null; setConfirm(null); setSettings(false); setSelected([]);
      if (v.closed || !v.members.some(m => m.id === v.me)) { setG(null); history.replaceState(null, '', '/gatherings'); await refresh(); }
      else { setG(v); if (cmd.action === 'activity' && Array.isArray(cmd.character_ids)) setFocusedId(cmd.character_ids[0] ?? null); setPersonal(await gatherings.personal()); }
    });
  }
  const activeMembers = g?.companions.filter(c => c.owner_id === g.me) || [];
  const activityNames: Record<string, string> = { arriving: '刚刚到达', rest: '休息', walk: '散步', observe: '观察', talk: '交流' };
  const focused = g?.companions.find(c => c.id === focusedId);
  const evidence = g && focused ? activityEvidence(g, focused.id) : null;
  async function recover() {
    const version = ++selectionVersion.current;
    const params = new URLSearchParams(location.search), group = g?.id || params.get('space'), invite = params.get('invite');
    if (group) {
      const snapshot = await gatherings.read(group);
      if (version !== selectionVersion.current || getToken() !== session) return;
      if (g) applySynced(snapshot); else setG(snapshot);
    } else if (invite) { const snapshot = await gatherings.preview(invite); if (version !== selectionVersion.current || getToken() !== session) return; setToken(invite); setPreview(snapshot); }
    await refresh();
  }
  return <>
    <div className="eyebrow">LIFE TOGETHER</div><h1>{g ? g.title : '留个位置，一起生活。'}</h1>
    <p className="create-intro">伙伴相聚、一起布置，也随时可以回家。活动由主人安排，AI 交流需要参与许可和对应的费用授权。</p>
    {error && <Notice retry={() => void work(recover)}>{error}</Notice>}
    {!g ? <>
      <div className="hub-actions"><button className="button primary" disabled={busy} onClick={() => setCreate(true)}>创建共同生活空间</button><Link className="button" href="/teams">好友作品小队</Link></div>
      <section className="team-panel"><h2>收到好友的邀请？</h2><form onSubmit={e => { e.preventDefault(); void work(async () => { const value = token.includes('?') ? new URL(token).searchParams.get('invite') || '' : token; setToken(value); setPreview(await gatherings.preview(value)); }); }}><label className="field">邀请链接或邀请码<input value={token} maxLength={1000} onChange={e => { setToken(e.target.value); setPreview(null); }} /></label><button className="button" disabled={busy || !token}>查看邀请</button></form>{preview && <div className="hub-invitation"><h3>{preview.title}</h3><p>{sceneNames[preview.scene_type]} · {preview.member_count}/5 位成员 · {seasonNames[preview.season] || preview.season}</p><label className="field">你在这里的昵称<input value={name} maxLength={20} onChange={e => setName(e.target.value)} /></label><button className="button primary" disabled={busy || !name.trim()} onClick={() => void work(async () => { open(await gatherings.join({ request_id: requestId(JSON.stringify(['join', token, name])), token, display_name: name })); pending.current = null; setPreview(null); })}>确认加入</button></div>}</section>
      {list === null ? <Loading /> : <div className="team-list">{list.map(s => <button key={s.id} className="team-panel hub-space-button" disabled={busy} onClick={() => void work(async () => open(await gatherings.read(s.id)))}><span>{sceneNames[s.scene_type]} · {s.member_count} 位成员</span><h2>{s.title}</h2><span>进去相聚 →</span></button>)}{!list.length && <p>还没有共同住处，可以先用自己的两位伙伴体验。</p>}</div>}
      {personal && <section className="team-panel"><h2>我的库存与共同回忆</h2><p>{personal.inventory.length ? personal.inventory.map(i => itemNames[i.kind] || i.kind).join('、') : '暂时没有收回的物件。'}</p>{personal.notifications.map(n => <p key={n.id}>{n.message}</p>)}<details><summary>共同回忆（{personal.memories.length}）</summary>{personal.memories.slice(-30).reverse().map(m => <p key={m.id}>{m.message}</p>)}</details></section>}
    </> : <>
      <div className="hub-actions"><button className="button" disabled={busy} onClick={() => { setG(null); history.replaceState(null, '', '/gatherings'); void work(refresh); }}>所有共同住处</button><button className="button" disabled={busy} onClick={() => void work(recover)}>刷新近况</button><span>{sceneNames[g.scene_type]} · {g.season ? seasonNames[g.season] : '四季尚未选择'}</span></div>
      <p role="status">{sync.stale ? '暂时连不上，显示的是上次读取的近况；连接恢复后会继续更新。' : '近况会自动更新。'}</p>
      <GatheringWorld gathering={g} focusedId={focusedId} onSelect={setFocusedId} suspended={sync.stale || busy || settings || !!confirm} />
      {focused && <section className="team-panel hub-companion-detail" aria-label={`${focused.name}的生活近况`}><h2>{focused.name}现在在做什么</h2><p>{activityNames[focused.activity] || '在场'}</p><p><strong>为什么：</strong>{evidence ? <>{evidence.message}{evidence.origin === 'offline_rules' && '（离线规则记录）'}</> : '还没有与当前活动对应的记录，暂时无法说明原因。'}</p><p><strong>下一步：</strong>{focused.owner_id === g.me ? '你可以在下方安排下一项活动，或去和伙伴说话。' : '由伙伴的主人决定下一项活动。'}</p>{focused.owner_id === g.me && <div className="hub-actions"><button className="button" onClick={() => { setSelected(ids => ids.includes(focused.id) ? ids : [...ids, focused.id]); document.getElementById('gathering-activities')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>选中安排活动</button><Link className="button" href={`/companions/${focused.id}?tab=chat`}>和{focused.name}说话</Link></div>}</section>}
      <GatheringDialogue gathering={g} busy={busy} command={command} refresh={() => void work(async () => applySynced(await gatherings.read(g.id)))} />
      <SpaceDecorations spaceId={g.id} kind="gathering" /><div className="hub-columns"><section className="team-panel"><h2>伙伴来相聚</h2><p>私人住处会保留。每人最多带 2 位伙伴，随时可以召回。</p><div className="hub-actions">{characters.filter(c => !g.companions.some(v => v.id === c.id)).map(c => <button className="button" disabled={busy || activeMembers.length >= 2} key={c.id} onClick={() => void command({ action: 'visit', character_id: c.id })}>带 {c.name} 来</button>)}</div>
        {g.companions.map(c => <div className="hub-row" key={c.id}><span><strong>{c.name}</strong> · {activityNames[c.activity] || '在场'}</span>{c.owner_id === g.me && <><label><input type="checkbox" checked={selected.includes(c.id)} onChange={e => setSelected(e.target.checked ? [...selected, c.id] : selected.filter(id => id !== c.id))} />参与活动</label><button className="button" disabled={busy} onClick={() => void command({ action: 'recall', character_id: c.id })}>回家</button></>}</div>)}
        <div id="gathering-activities" className="hub-actions">{['rest', 'walk', 'observe', 'talk'].map(a => <button className="button" key={a} disabled={busy || !selected.length} onClick={() => void command({ action: 'activity', character_ids: selected, activity: a })}>{activityNames[a]}</button>)}</div>
      </section><section className="team-panel"><h2>一起布置休息角落</h2><p>{g.goal === 'completed' ? '目标已完成：树得到照料，休息位置也布置好了。' : '开始后，种一棵树、放好休息家具，再一起照料。'}</p>{!g.goal && <button className="button" disabled={busy} onClick={() => void command({ action: 'start_goal' })}>开始共同目标</button>}<p>物件属于贡献者。离队后保留，解散时退回各自库存。</p><div className="hub-actions">{['tree', { home: 'bench', desert: 'shade', forest: 'cushion' }[g.scene_type] || 'bench'].map(kind => <button className="button" key={kind} disabled={busy} onClick={() => void command({ action: 'layout', command: { action: 'place', kind, x: 0.2 + (g.items.length % 4) * 0.18, y: 0.25 + Math.floor(g.items.length % 12 / 4) * 0.2 } })}>添加{itemNames[kind]}</button>)}</div>{g.items.map(i => <div className="hub-item" key={i.id}><strong>{itemNames[i.kind] || i.kind}</strong><span>{i.contributor_name} 贡献{i.growth_status === 'needs_care' ? ' · 需要照料' : ''}</span><div className="hub-actions">{i.kind === 'tree' && <button className="button" disabled={busy} onClick={() => void command({ action: 'layout', command: { action: 'care', item_id: i.id } })}>照料</button>}{i.mine && <><button className="button" disabled={busy} onClick={() => void command({ action: 'layout', command: { action: 'move', item_id: i.id, x: i.x > 0.7 ? 0.2 : i.x + 0.1, y: i.y } })}>向旁边挪一挪</button><button className="button" disabled={busy} onClick={() => setConfirm({ title: '将这个物件撤回自己的库存？', command: { action: 'layout', command: { action: 'store', item_id: i.id } } })}>撤回库存</button></>}</div></div>)}</section></div>
      <section className="team-panel"><h2>把库存物件放回来</h2>{personal?.inventory.length ? <div className="hub-actions">{personal.inventory.map(i => <button className="button" key={i.id} disabled={busy} onClick={() => void command({ action: 'restore_inventory', item_id: i.id })}>放回{itemNames[i.kind] || i.kind}</button>)}</div> : <p>撤回或解散后返还的物件会保留在你的库存。</p>}</section><section className="team-panel"><h2>共同四季与投票</h2><button className="button" disabled={busy} onClick={() => { setSeason(null); setSettings(true); }}>提议调整四季</button>{g.votes.slice(-8).reverse().map(v => <div className="hub-item" key={v.id}><strong>{v.kind === 'season' ? '调整共同四季' : '解散共同空间'}</strong><p>{Object.values(v.choices).filter(Boolean).length} 票同意 / 需要 {Math.floor(v.electorate.length / 2) + 1} 票 · {({ pending: '投票中', passed: '已通过', expired: '已截止，未通过', cancelled_members_changed: '成员变化，已取消', cancelled_dissolved: '空间解散，已取消' } as Record<string, string>)[v.status] || v.status}</p><p>截止：{new Date(v.deadline * 1000).toLocaleString('zh-CN')}</p>{v.status === 'pending' && !(g.me in v.choices) && <div className="hub-actions"><button className="button" disabled={busy} onClick={() => void command({ action: 'vote', vote_id: v.id, agree: true })}>同意</button><button className="button" disabled={busy} onClick={() => void command({ action: 'vote', vote_id: v.id, agree: false })}>不同意</button></div>}</div>)}</section>
      <section className="team-panel"><h2>生活里的小故事</h2><label><input type="checkbox" checked={g.story_enabled} disabled={busy} onChange={e => void command({ action: 'story_preference', enabled: e.target.checked })} />允许我的伙伴参与温和分歧与和好</label><p>这是角色的故事表现。关闭后不产生新剧情，已经独处的伙伴仍会恢复。</p><button className="button" disabled={busy || selected.length !== 2 || !g.story_enabled} onClick={() => void command({ action: 'story', character_ids: selected })}>体验一次有分歧后回家休息</button>{g.stories.map(s => <div key={s.id}><p>{s.message} · {s.status === 'resting' ? '正在独处，约 20 分钟自然恢复' : '已经恢复平静'}</p>{s.status === 'resting' && <button className="button" disabled={busy} onClick={() => void command({ action: 'reconcile', story_id: s.id })}>表达善意，直接和好</button>}</div>)}</section>
      <section className="team-panel"><h2>空间成员</h2>{g.members.map(m => <div className="hub-row" key={m.id}><span>{m.name}{m.manager ? ' · 管理者' : ''}{m.id === g.me ? ' · 我' : ''}</span>{g.is_manager && m.id !== g.me && <div className="hub-actions"><button className="button" disabled={busy} onClick={() => setConfirm({ title: `将管理权转交给 ${m.name}？`, command: { action: 'transfer', member_id: m.id } })}>转交管理</button><button className="button" disabled={busy} onClick={() => setConfirm({ title: `移除 ${m.name} 并召回其伙伴？贡献物件仍保留。`, command: { action: 'remove', member_id: m.id } })}>移除</button></div>}</div>)}
        {g.is_manager ? <><div className="hub-actions"><button className="button" disabled={busy} onClick={() => void command({ action: 'invite' })}>生成新邀请</button>{g.invitation && <button className="button" disabled={busy} onClick={() => void command({ action: 'revoke_invitation' })}>撤销邀请</button>}<button className="button" disabled={busy} onClick={() => setConfirm({ title: '发起解散投票？超过半数成员同意后，伙伴回家，所有物件按贡献归属返还。', command: { action: 'propose_dissolve' } })}>发起解散投票</button></div>{g.invitation && <label className="field">复制邀请链接<input readOnly value={`${typeof location === 'undefined' ? '' : location.origin}/gatherings?invite=${g.invitation}`} onFocus={e => e.target.select()} /></label>}</> : <button className="button" disabled={busy} onClick={() => setConfirm({ title: '退出共同生活？伙伴会回家，未撤回的贡献物件继续保留。', command: { action: 'leave' } })}>退出共同生活</button>}
      </section><section className="team-panel"><h2>真实保存的共同经历</h2>{g.events.slice().reverse().map(e => <p key={e.id}><time>{new Date(e.at * 1000).toLocaleTimeString('zh-CN')}</time> · {e.message}</p>)}</section>
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
