'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, errorText } from '@/lib/api';
import { teamsApi, type TeamSummary } from '@/lib/teams';
import AuthModal from './auth-modal';
import { Loading, Modal, Notice } from './common';
import { TeamShell, useTeamSession, validAlias } from './team-shared';
import TeamDetailView from './team-detail';

type Draft = { request_id: string; title: string; display_name: string; theme_id: string };
function CreateTeam({ uid, close }: { uid: string; close: () => void }) {
  const router = useRouter(), key = `team-create:${uid}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(key) || 'null'); if (saved && typeof saved.request_id === 'string' && typeof saved.title === 'string' && typeof saved.display_name === 'string' && saved.theme_id === 'fruit') return { request_id: saved.request_id, title: saved.title, display_name: saved.display_name, theme_id: saved.theme_id }; } catch { /* fresh draft */ }
    return { request_id: crypto.randomUUID(), title: '', display_name: '', theme_id: 'fruit' };
  });
  const lock = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(() => { try { return JSON.parse(sessionStorage.getItem(key) || 'null')?.pending === true; } catch { return false; } });
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify({ ...draft, pending: uncertain })); } catch { /* same-page replay remains safe */ } }, [draft, key, uncertain]);
  async function check() {
    const team = await teamsApi.detail(draft.request_id);
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
    router.push(`/teams/${team.id}`);
  }
  async function submit() {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      if (uncertain) { try { await check(); } catch (e) { if (e instanceof ApiError && e.status === 404) { setUncertain(false); setError('尚未创建成功，可以再次确认创建。'); } else throw e; } }
      else { setUncertain(true); await teamsApi.create(draft); await check(); }
    } catch (e) { setError(errorText(e)); setUncertain(true); }
    finally { lock.current = false; setBusy(false); }
  }
  return <Modal title="和好友开始一个小主题" close={() => { if (!busy) close(); }}><p className="modal-copy">本次主题：一份水果。小队里的作品仅成员可见，加入不会自动公开伙伴。</p><form className="auth-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <label className="field">小队名字<input value={draft.title} maxLength={30} disabled={busy || uncertain} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="比如：我们的甜甜奇遇" /></label>
    <label className="field">你在小队里的昵称<input value={draft.display_name} maxLength={20} disabled={busy || uncertain} onChange={e => setDraft({ ...draft, display_name: e.target.value })} placeholder="1–20 字，请勿填写手机号" /></label>
    {error && <Notice>{error}</Notice>}<button className="button primary" disabled={busy || !draft.title.trim() || !validAlias(draft.display_name)}>{busy ? '正在核对…' : uncertain ? '核对创建结果' : '确认创建小队'}</button>
  </form></Modal>;
}
function TeamList() {
  const [teams, setTeams] = useState<TeamSummary[] | null>(null), [uid, setUid] = useState(''), [create, setCreate] = useState(false), [error, setError] = useState(''), [rev, setRev] = useState(0);
  useEffect(() => { let active = true; Promise.all([teamsApi.list(), api.auth.me()]).then(([list, user]) => { if (active) { setTeams(list); setUid(user.id); } }).catch(e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, [rev]);
  return <><div className="eyebrow">A LITTLE THEME, TOGETHER</div><h1>和喜欢的人，<br />收集不一样的可爱。</h1><p className="create-intro">选一个共同的主题，各自拍下自己的发现。<br />作品只在小队里相见，伙伴仍属于自己。</p>
    {error ? <Notice retry={() => { setError(''); setRev(n => n + 1); }}>{error}</Notice> : teams === null ? <Loading /> : <><button className="button primary" onClick={() => setCreate(true)}>创建好友小队</button><div className="team-list">{teams.length ? teams.map(t => <Link className="team-panel" key={t.id} href={`/teams/${t.id}`}><span className="create-kicker">🍎 一份水果 · {t.member_count} 位成员</span><h2>{t.title}</h2><p>{t.is_creator ? '我发起的小队' : '我加入的小队'} · 进去看看 →</p></Link>) : <section className="team-panel"><h2>给共同的小奇遇留个位置</h2><p>创建小队后复制邀请链接，或打开好友分享给你的邀请。</p></section>}</div></>}
    {create && <CreateTeam uid={uid} close={() => setCreate(false)} />}</>;
}
export default function Teams({ id, initialPreview = null, resume = false }: { id?: string; initialPreview?: number | null; resume?: boolean }) {
  const session = useTeamSession(), [login, setLogin] = useState(false);
  return <TeamShell>{session ? id ? <TeamDetailView key={session + id} id={id} initialPreview={initialPreview} resume={resume} /> : <TeamList key={session} /> : <section className="team-panel"><h1>好友主题小队</h1><p>登录后，和好友分享同一个主题下各不相同的伙伴。</p><button className="button primary" onClick={() => setLogin(true)}>注册 / 登录</button></section>}{login && <AuthModal onClose={() => setLogin(false)} onLoggedIn={() => setLogin(false)} />}</TeamShell>;
}
