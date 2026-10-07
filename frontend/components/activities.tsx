'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { activities, activityNames, decorationNames, phaseNames, type Match } from '@/lib/activities';
import { gatherings, sceneNames } from '@/lib/gatherings';
import { api, errorText } from '@/lib/api';
import { type Character } from '@/lib/contracts';
import { useTeamSession } from './team-shared';
import { Brand, Loading, Modal, Notice } from './common';
import AuthModal from './auth-modal';
import { getToken } from '@/lib/auth';
import CompetitionAI from './competition-ai';

function ActivityList() {
  const [list, setList] = useState<Awaited<ReturnType<typeof activities.list>> | null>(null), [match, setMatch] = useState<Match | null>(null), [characters, setCharacters] = useState<Character[]>([]);
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof activities.inventory>> | null>(null), [spaces, setSpaces] = useState<{ id: string; label: string; kind: string }[]>([]);
  const [name, setName] = useState(''), [kind, setKind] = useState('observe'), [token, setToken] = useState(''), [destination, setDestination] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof activities.preview>> | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ message: string; run: () => Promise<void> } | null>(null);
  const lock = useRef(false), pending = useRef<{ key: string; id: string } | null>(null);
  const selectionVersion = useRef(0), catalogVersion = useRef(0), account = useRef(getToken()), mounted = useRef(true);
  const matchId = match?.id, matchStatus = match?.status;
  function key(value: unknown) { const k = JSON.stringify(value); if (pending.current?.key !== k) pending.current = { key: k, id: crypto.randomUUID() }; return pending.current.id; }
  function open(m: Match) { if (!mounted.current || getToken() !== account.current) return; selectionVersion.current++; setMatch(m); history.replaceState(null, '', `/activities?match=${m.id}`); }
  async function load() {
    const version = ++catalogVersion.current;
    const [ls, w, cs, privateSpaces, shared] = await Promise.all([activities.list(), activities.inventory(), api.characters(), api.living.spaces(), gatherings.list()]);
    if (!mounted.current || version !== catalogVersion.current || getToken() !== account.current) return;
    setList(ls); setInventory(w); setCharacters(cs.filter(c => c.status === 'ready'));
    setSpaces([...privateSpaces.map(s => ({ id: s.id, label: `${sceneNames[s.scene_type]} · 我的住处`, kind: 'private' })), ...shared.map(s => ({ id: s.id, label: s.title, kind: 'gathering' }))]);
  }
  async function recover() {
    const version = ++selectionVersion.current;
    const params = new URLSearchParams(location.search), mid = match?.id || params.get('match'), invitation = params.get('invite');
    if (mid) { const result = await activities.read(mid); if (version !== selectionVersion.current || getToken() !== account.current) return; open(result); }
    else if (invitation) { const result = await activities.preview(invitation); if (version !== selectionVersion.current || getToken() !== account.current) return; setToken(invitation); setPreview(result); }
    await load();
  }
  useEffect(() => {
    let active = true;
    mounted.current = true;
    const selection = selectionVersion, version = selection.current;
    const catalog = ++catalogVersion.current;
    const params = new URLSearchParams(location.search), invitation = params.get('invite'), mid = params.get('match');
    const matchRequest = !invitation && mid ? activities.read(mid) : null;
    Promise.all([activities.list(), matchRequest ? matchRequest.then(() => activities.inventory()) : activities.inventory(), api.characters(), api.living.spaces(), gatherings.list()]).then(([ls, w, cs, privateSpaces, shared]) => { if (active && catalog === catalogVersion.current) { setList(ls); setInventory(w); setCharacters(cs.filter(c => c.status === 'ready')); setSpaces([...privateSpaces.map(s => ({ id: s.id, label: `${sceneNames[s.scene_type]} · 我的住处`, kind: 'private' })), ...shared.map(s => ({ id: s.id, label: s.title, kind: 'gathering' }))]); } }).catch(e => { if (active && catalog === catalogVersion.current) setError(errorText(e)); });
    if (invitation) activities.preview(invitation).then(p => { if (active && version === selectionVersion.current) { setToken(invitation); setPreview(p); } }).catch(e => { if (active && version === selectionVersion.current) setError(errorText(e)); });
    else if (matchRequest) matchRequest.then(m => { if (active && version === selectionVersion.current) setMatch(m); }).catch(e => { if (active && version === selectionVersion.current) setError(errorText(e)); });
    return () => { active = false; mounted.current = false; selection.current++; };
  }, []);
  useEffect(() => {
    if (!matchId || !matchStatus || !['running', 'voting'].includes(matchStatus)) return;
    let active = true, checking = false;
    const timer = setInterval(() => { if (document.hidden || lock.current || checking) return; checking = true; activities.read(matchId).then(m => { if (active) { setMatch(m); if (m.status === 'completed') void activities.inventory().then(w => { if (active) setInventory(w); }); } }).catch(e => { if (active) setError(errorText(e)); }).finally(() => { checking = false; }); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [matchId, matchStatus]);
  async function work(fn: () => Promise<void>) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice(''); try { await fn(); setConfirm(null); } catch (e) { setError(errorText(e)); } finally { lock.current = false; setBusy(false); } }
  async function command(cmd: Record<string, unknown>) { if (!match) return; const m = await activities.command(match.id, cmd, key([match.id, cmd])); pending.current = null; open(m); if (m.status === 'completed') await load(); }
  const remaining = match?.end_at ? Math.max(0, (match.status === 'running' ? match.phase_end! : match.end_at) - match.observed_at) : null;
  const reward = match?.rewards[match.me];
  return <>
    <div className="eyebrow">LITTLE GAMES, SHARED MEMORIES</div><h1>{match ? activityNames[match.kind] : '让伙伴们，玩一场。'}</h1><p>你来报名、观战和加油，伙伴按已保存的策略行动；没有AI策略时使用规则路线。</p>
    {error && <Notice retry={() => void work(recover)}>{error}</Notice>}{notice && <p role="status">{notice}</p>}
    {!match ? <>
      <section className="team-panel"><h2>开始一场小比赛</h2><p>至少 2 位伙伴，最多 5 个账号，每人最多 2 位。同一个账号也可以用两位伙伴比赛。</p><label className="field">活动<select value={kind} onChange={e => setKind(e.target.value)}>{Object.entries(activityNames).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><p>{kind === 'garden' ? '伙伴自主布置 5 分钟，再由参赛用户投票 3 分钟。每账号 1 票，可投自己的伙伴。' : kind === 'observe' ? '3 分钟，寻找指定树木、花朵、蘑菇和石头。每个有效目标 1 分。' : '3 分钟，独立秋日场地拾叶，每片有效落叶 1 分，不改变住处季节。'}</p><label className="field">你的参赛昵称<input value={name} maxLength={20} onChange={e => setName(e.target.value)} /></label><button className="button primary" disabled={busy || !name.trim()} onClick={() => void work(async () => { open(await activities.create(key(['create', kind, name]), kind, name)); pending.current = null; })}>创建活动，选择伙伴</button></section>
      <section className="team-panel"><h2>受邀参加</h2><label className="field">邀请链接或邀请码<input value={token} onChange={e => { setToken(e.target.value); setPreview(null); }} /></label><button className="button" disabled={busy || !token} onClick={() => void work(async () => { const t = token.includes('?') ? new URL(token).searchParams.get('invite') || '' : token; setToken(t); setPreview(await activities.preview(t)); })}>查看邀请</button>{preview && <div><p>{activityNames[preview.kind]} · {preview.participants} 位伙伴 · {preview.duration / 60} 分钟</p><label className="field">参赛昵称<input value={name} maxLength={20} onChange={e => setName(e.target.value)} /></label><div className="hub-actions"><button className="button primary" disabled={busy || !name.trim()} onClick={() => void work(async () => { const m = await activities.join(token, name, true, key(['join', token, name])); if (m) open(m); pending.current = null; setPreview(null); })}>接受邀请，再选择伙伴</button><button className="button" disabled={busy} onClick={() => void work(async () => { await activities.join(token, name || '受邀者', false, key(['decline', token])); pending.current = null; setPreview(null); setNotice('已拒绝邀请，不会自动报名。'); })}>拒绝</button></div></div>}</section>
      {list === null ? <Loading /> : <div className="team-list">{list.slice().reverse().map(m => <button className="team-panel hub-space-button" key={m.id} disabled={busy} onClick={() => void work(async () => open(await activities.read(m.id)))}><h2>{activityNames[m.kind]}</h2><p>{phaseNames[m.status]}</p><span>查看比赛与回忆 →</span></button>)}</div>}
    </> : <>
      <div className="hub-actions"><button className="button" disabled={busy} onClick={() => { setMatch(null); history.replaceState(null, '', '/activities'); void work(load); }}>所有活动</button><button className="button" disabled={busy} onClick={() => void work(recover)}>刷新比赛</button><strong role="status">{phaseNames[match.status]}{remaining != null && ['running', 'voting'].includes(match.status) ? ` · 本阶段剩余 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : ''}</strong></div>
      {match.status === 'registration' && <section className="team-panel"><h2>选择自己的伙伴参赛</h2><div className="hub-actions">{characters.filter(c => !match.participants.some(p => p.id === c.id)).map(c => <button key={c.id} className="button" disabled={busy || match.participants.filter(p => p.owner_id === match.me).length >= 2} onClick={() => void work(() => command({ action: 'register', character_id: c.id }))}>报名 {c.name}</button>)}</div>{match.invitation && <label className="field">分享给受邀者<input readOnly value={`${location.origin}/activities?invite=${match.invitation}`} onFocus={e => e.target.select()} /></label>}{match.is_organizer && <button className="button primary" disabled={busy || match.participants.length < 2} onClick={() => void work(() => command({ action: 'start' }))}>伙伴都到齐了，开始比赛</button>}</section>}
      <div className="hub-columns">{match.participants.map(p => <section className="team-panel" key={p.id}><h2>{p.name}{p.winner ? ' · 🏅 获胜' : ''}</h2><p>{p.status === 'withdrawn' ? '已主动退出，不计完赛或获胜' : p.status === 'completed' ? '已正常完赛' : p.status === 'registered' ? '已报名' : '正在参与'} · {p.score} {match.kind === 'garden' ? '票' : '分'}</p>{match.kind === 'garden' ? <div className="activity-layout" aria-label={`${p.name}的独立布置`}>{p.layout.map((i, index) => <span key={index} style={{ left: `${i.x}%`, top: `${i.y}%` }}>{({ tree: '🌳', flower: '🌷', bench: '🪑', lamp: '🏮', stone: '🪨' } as Record<string, string>)[i.kind]}</span>)}</div> : <p>{p.targets.length ? `已核验 ${p.targets.length} 个独立目标，每个 1 分` : '从同样的起点出发，等待伙伴发现目标。'}</p>}{match.status === 'voting' && !(match.me in match.votes) && p.status !== 'withdrawn' && <button className="button primary" disabled={busy} onClick={() => void work(() => command({ action: 'vote', character_id: p.id }))}>投给 {p.name}</button>}{p.owner_id === match.me && !['completed', 'cancelled'].includes(match.status) && p.status !== 'withdrawn' && <button className="button" disabled={busy} onClick={() => setConfirm({ message: '这位伙伴退出后不算完赛或获胜。同账号另一位伙伴仍可继续，关闭页面则不会退赛。', run: () => command({ action: 'withdraw', character_id: p.id }) })}>退出这位伙伴</button>}</section>)}</div>
      <section className="team-panel"><h2>观战与赛后回忆</h2><p>成绩按服务器核验的行动结算；同分可并列，零分或无人投票不设冠军。刷新不会重复发奖。</p>{['running', 'voting'].includes(match.status) && <button className="button" disabled={busy} onClick={() => void work(() => command({ action: 'cheer' }))}>给伙伴们加油</button>}{match.events.map((e, i) => <p key={i}>{e}</p>)}{reward && <p className="activity-reward">本账号基础奖励 {reward.base} 资源，获胜奖励 {reward.bonus} 资源{reward.first_decoration ? `；首次完成：${decorationNames[reward.first_decoration]}` : ''}。</p>}{match.is_organizer && !['completed', 'cancelled'].includes(match.status) && <button className="button" disabled={busy} onClick={() => setConfirm({ message: '取消这场活动？本场不发奖、不占每日奖励次数，之后可以重新报名。', run: () => command({ action: 'cancel' }) })}>取消活动</button>}{match.participants.filter(p => p.owner_id === match.me).map(p => <Link className="button" key={p.id} href={`/companions/${p.id}?tab=chat`}>和 {p.name} 聊聊</Link>)}</section>
      {match.thoughts.map(t => <section className="team-panel" key={`${t.id}-${t.phase}`}><h3>{t.name} · {t.phase === 'ai_strategy' ? 'AI策略' : '赛后感受'}</h3><p>{t.text}</p>{t.evidence && <p>本场记录：{t.evidence}</p>}</section>)}
      <CompetitionAI key={`${match.id}-${match.status}`} match={match} refresh={recover} />
    </>}
    {inventory && <section className="team-panel"><h2>建设资源与装饰</h2><p><strong>{inventory.balance}</strong> 点建设资源。每天前 3 场正常完赛获得基础 10 点，获胜另 10 点；多伙伴同场不倍增。第 4 场仍保留成绩与回忆。装饰不提升比赛能力、不加速植物。</p><div className="hub-actions">{Object.entries(inventory.shop).map(([k, price]) => <button key={k} className="button" disabled={busy || inventory.balance < price} onClick={() => setConfirm({ message: `用 ${price} 点资源兑换一个${decorationNames[k]}？`, run: async () => { await activities.exchange(k, key(['exchange', k, inventory.balance])); pending.current = null; await load(); } })}>{decorationNames[k]} · {price} 点{inventory.balance < price ? '（资源不足）' : ''}</button>)}</div><label className="field">装饰放到哪里<select value={destination} onChange={e => setDestination(e.target.value)}><option value="">请选择住处</option>{spaces.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label><p>放到共同住处后仍属于你；离队时保留，解散时返还。可以在离队前撤回。</p>{inventory.decorations.map(d => <div className="hub-row" key={d.id}><span>{decorationNames[d.kind]} · {d.space_id ? '已放置' : '在库存'}</span><div className="hub-actions"><button className="button" disabled={busy || !destination} onClick={() => void work(async () => { const s = spaces.find(s => s.id === destination); if (!s) return; await activities.place(d.id, s.id, s.kind, key(['place', d.id, s.id])); pending.current = null; await load(); })}>放到选定住处</button>{d.space_id && <button className="button" disabled={busy} onClick={() => void work(async () => { await activities.place(d.id, null, d.space_kind || 'private', key(['withdraw-decor', d.id])); pending.current = null; await load(); })}>撤回库存</button>}</div></div>)}</section>}
    {confirm && <Modal title="确认操作" close={() => { if (!busy) setConfirm(null); }}><p>{confirm.message}</p><div className="hub-actions"><button className="button" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className="button primary" disabled={busy} onClick={() => void work(confirm.run)}>确认</button></div></Modal>}
  </>;
}

export default function Activities() { const session = useTeamSession(), [login, setLogin] = useState(false); return <div className="shell"><header className="site-header"><Brand /><Link className="back-link" href="/discover">返回发现</Link></header><main className="teams-page hub-page">{session ? <ActivityList key={session} /> : <section className="team-panel"><h1>伙伴活动</h1><button className="button primary" onClick={() => setLogin(true)}>注册 / 登录</button></section>}</main>{login && <AuthModal onClose={() => setLogin(false)} onLoggedIn={() => setLogin(false)} />}</div>; }
