'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/auth';
import { errorText } from '@/lib/api';
import { teamsApi, type InvitePreview } from '@/lib/teams';
import AuthModal from './auth-modal';
import { Loading, Notice } from './common';
import { TeamShell, useTeamSession, validAlias } from './team-shared';
const key = 'pending-team-invitation';
export default function TeamInvitation() {
  const router = useRouter();
  const session = useTeamSession(), token = useRef(''), lock = useRef(false);
  const [preview, setPreview] = useState<InvitePreview | null>(null), [error, setError] = useState(''), [login, setLogin] = useState(false), [alias, setAlias] = useState(''), [busy, setBusy] = useState(false), [rev, setRev] = useState(0), [result, setJoined] = useState<{ team_id: string; already_member: boolean; session: string | null } | null>(null);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1)).get('invite');
    if (fragment) { token.current = fragment; window.history.replaceState(null, '', window.location.pathname); try { sessionStorage.setItem(key, fragment); } catch { /* in-page fallback */ } }
    else if (!token.current) { try { token.current = sessionStorage.getItem(key) || ''; } catch { /* show missing */ } }
    let active = true;
    if (!token.current) { setError('这里还没有邀请，请打开好友分享的完整邀请链接。'); return; }
    teamsApi.preview(token.current).then(p => { if (active) { setPreview(p); setError(''); } }).catch(e => { if (active) { setError(errorText(e)); setPreview(null); } });
    return () => { active = false; };
  }, [rev]);
  const joined = result?.session === session ? result : null;
  async function join() {
    if (lock.current || !validAlias(alias)) return; lock.current = true; setBusy(true); setError('');
    try {
      const value = await teamsApi.join(token.current, alias.trim());
      if (getToken() !== session) return;
      setJoined({ ...value, session });
      try { sessionStorage.removeItem(key); } catch { /* ignore */ }
      router.replace(`/teams/${encodeURIComponent(value.team_id)}`);
    }
    catch (e) { setError(errorText(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <TeamShell><div className="eyebrow">A LITTLE INVITATION FOR YOU</div><h1>一起发现，<br />日常里的小可爱。</h1>{error && <Notice retry={() => { setError(''); setRev(n => n + 1); }}>{error}</Notice>}{preview ? <section className="team-panel"><span className="create-kicker">🍎 共同主题：一份水果</span><h2>{preview.title}</h2><p>{preview.creator_name} 邀请你加入 · 当前 {preview.member_count} 位成员</p><p>每个人拍自己的水果，遇见独一无二的伙伴。加入后才能看队内作品；你的收藏不会自动提交，聊天与记忆始终私密。</p>{joined ? <><p role="status">{joined.already_member ? '你已经是这个小队的成员了。' : '加入成功，朋友们在里面等你。'}</p><Link className="button primary" href={`/teams/${joined.team_id}`}>进入小队</Link></> : session ? <form className="auth-form" onSubmit={e => { e.preventDefault(); void join(); }}><label className="field">你在小队里的昵称<input value={alias} disabled={busy} maxLength={20} onChange={e => setAlias(e.target.value)} placeholder="1–20 字，请勿填写手机号" /></label><button className="button primary" disabled={busy || !validAlias(alias)}>{busy ? '正在确认…' : '确认加入小队'}</button></form> : <button className="button primary" onClick={() => setLogin(true)}>登录后确认加入</button>}</section> : !error && <Loading />}<Link className="back-link" href="/teams">查看我的小队 →</Link>{login && <AuthModal onClose={() => setLogin(false)} onLoggedIn={() => setLogin(false)} />}</TeamShell>;
}
