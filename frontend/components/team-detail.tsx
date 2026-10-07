'use client';
import InvitationLink from './invitation-link';
import PrivateImage from './private-image';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, errorText } from '@/lib/api';
import { imageUrl } from '@/lib/contracts';
import { teamsApi, type TeamDetail } from '@/lib/teams';
import { creationHref, rememberPosition, readPosition, clearPreviewQuery } from '@/lib/creation-origin';
import { Loading, Modal, Notice } from './common';
import { PrivateTeamImage } from './team-shared';
type Companion = Awaited<ReturnType<typeof api.characters>>[number];
export default function TeamDetailView({ id, initialPreview = null, resume = false }: { id: string; initialPreview?: number | null; resume?: boolean }) {
  const router = useRouter(), lock = useRef(false);
  const [team, setTeam] = useState<TeamDetail | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [gone, setGone] = useState(false);
  const [invite, setInvite] = useState(''), [notice, setNotice] = useState(''), [confirm, setConfirm] = useState<'leave' | 'dissolve' | null>(null);
  const [choose, setChoose] = useState(false), [characters, setCharacters] = useState<Companion[] | null>(null), [selected, setSelected] = useState('');
  async function refresh() {
    try { const value = await teamsApi.detail(id); setTeam(value); setUncertain(false); return value; }
    catch (e) { if (e instanceof ApiError && e.status === 404) { setGone(true); setTeam(null); setInvite(''); setUncertain(false); } throw e; }
  }
  useEffect(() => {
    let active = true, frame = 0;
    teamsApi.detail(id).then(async t => {
      if (!active) return;
      setTeam(t);
      const position = resume ? readPosition({ kind: 'team', theme: 'fruit', teamId: id }) : null;
      if (position) frame = requestAnimationFrame(() => window.scrollTo({ top: position.y, behavior: 'instant' }));
      if (initialPreview) {
        try {
          const values = await api.characters(); if (!active) return;
          setCharacters(values);
          const eligible = values.find(c => c.id === initialPreview && c.status === 'ready' && c.theme_id === t.theme_id && c.image_path);
          setSelected(eligible ? String(eligible.id) : ''); setChoose(true);
          if (!eligible) setNotice('刚才的伙伴暂时无法提交：可能已删除、尚未完成，或不属于这个主题。可以从收藏重新选择。');
        } catch (e) { if (active) setError(errorText(e)); }
      }
    }).catch(e => { if (active) { setError(errorText(e)); if (e instanceof ApiError && e.status === 404) setGone(true); } });
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [id, initialPreview, resume]);
  function closeChoices() { if (busy) return; setChoose(false); clearPreviewQuery(); }

  async function act(action: () => Promise<unknown>, message: string, leaves = false) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); if (leaves) { router.push('/teams'); return; } await refresh(); setNotice(message); }
    catch (e) { setError(errorText(e)); setUncertain(true); try { await refresh(); } catch { /* keep writes blocked */ } }
    finally { lock.current = false; setBusy(false); }
  }
  async function check() {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await refresh(); setNotice('已核对当前小队状态'); }
    catch (e) { setError(errorText(e)); setUncertain(true); }
    finally { lock.current = false; setBusy(false); }
  }
  async function openChoices() {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { setCharacters(await api.characters()); setSelected(''); setChoose(true); } catch (e) { setError(errorText(e)); } finally { lock.current = false; setBusy(false); }
  }
  const candidate = characters?.find(c => String(c.id) === selected && c.status === 'ready' && c.theme_id === team?.theme_id && c.image_path), disabled = busy || uncertain;
  return <><Link className="back-link" href="/teams">← 我的小队</Link>{error && <Notice>{error}</Notice>}{gone ? <section className="team-panel"><h1>小队已不可访问</h1><p>你可能已退出，或发起人已解散小队。个人伙伴仍在收藏里。</p><Link className="button" href="/">回到收藏</Link></section> : !team ? error ? <button className="button" disabled={busy} onClick={() => void check()}>重新加载小队</button> : <Loading /> : <>
    <div className="team-heading"><div><span className="create-kicker">🍎 一份水果 · 仅小队成员可见</span><h1>{team.title}</h1></div><button className="button" disabled={busy} onClick={() => void check()}>{uncertain ? '核对小队状态' : '刷新小队'}</button></div>
    {notice && <p role="status" className="team-status">{notice}</p>}
    <section className="team-panel"><h2>一起参与的朋友 · {team.member_count}</h2><ul className="team-members">{team.members.map(m => <li key={m.id}><strong>{m.display_name}</strong><span>{m.is_me ? '我 · ' : ''}{m.is_creator ? '发起人 · ' : ''}{m.submission_count} 份作品</span></li>)}</ul>
      {team.is_creator && <div className="team-invite"><p>{team.invitation_active ? '邀请已开启。生成新链接会让旧链接失效，已加入的成员会保留。' : '还没有有效邀请。准备好了，就邀请好友一起来玩。'}</p><div className="team-actions"><button className="button" disabled={disabled} onClick={() => { setInvite(''); void act(async () => setInvite(`${window.location.origin}/teams/join#invite=${await teamsApi.invite(id)}`), '邀请已准备好，请自行复制分享。'); }}>{team.invitation_active ? '生成新的邀请链接' : '生成邀请链接'}</button>{team.invitation_active && <button className="button" disabled={disabled} onClick={() => void act(async () => { await teamsApi.revoke(id); setInvite(''); }, '邀请已撤销，已加入的朋友不受影响。')}>撤销邀请</button>}</div>
        {invite && <InvitationLink key={invite} link={invite} />}
      </div>}
    </section>
    <section className="team-works"><div className="team-heading"><div><h2>我们各自的小发现</h2><p>提交才会出现在这里；不会同步发布到公开作品墙。</p></div><button className="button primary" disabled={disabled} onClick={() => void openChoices()}>提交我的伙伴</button></div>
      {team.submissions.length ? <div className="wall-grid">{team.submissions.map(w => <article className="wall-card" key={w.id}><PrivateTeamImage work={w} /><div className="wall-card-copy"><h3>{w.name}</h3><p>{w.introduction}</p><p>来自 {w.author_name}</p>{w.is_mine && <button className="button" disabled={disabled} onClick={() => void act(() => teamsApi.withdraw(id, w.id), '已撤回小队展示，伙伴仍在你的收藏里。')}>撤回这份作品</button>}</div></article>)}</div> : <div className="team-panel"><h3>第一份小惊喜，等你带来</h3><p>从收藏中选择水果主题伙伴，或先去创作一个。</p></div>}
      <Link className="back-link" href={creationHref({ kind: 'team', theme: 'fruit', teamId: id })} onClick={() => rememberPosition({ kind: 'team', theme: 'fruit', teamId: id })}>去创作水果伙伴 →</Link><p className="privacy-note">创作完成后可直接回到这里，预览确认才会提交。</p>
    </section>
    <div className="team-footer"><p>伙伴的聊天和记忆始终只属于本人。</p><button className="button" disabled={disabled} onClick={() => setConfirm(team.is_creator ? 'dissolve' : 'leave')}>{team.is_creator ? '解散小队' : '退出小队'}</button></div>
    {choose && <Modal title="把这份小可爱带给朋友" close={closeChoices}>{notice && <p role="status">{notice}</p>}<p className="modal-copy">仅展示形象、名字、性格简介和你的队内昵称。聊天与记忆不会分享。</p><label className="field">选择水果主题伙伴<select value={selected} disabled={disabled} onChange={e => setSelected(e.target.value)}><option value="">请选择</option>{characters?.filter(c => c.status === 'ready' && c.theme_id === team.theme_id && c.image_path).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{candidate && <div className="publication-preview"><div className="wall-image"><PrivateImage src={imageUrl(candidate.image_path) || ''} alt={candidate.name} /></div><h3>{candidate.name}</h3><p>{candidate.persona.slice(0, 160)}</p></div>}{!characters?.some(c => c.status === 'ready' && c.theme_id === team.theme_id && c.image_path) && <p>暂时没有可提交的水果伙伴，先去创作吧。</p>}{error && <Notice>{error}</Notice>}{uncertain && <button className="button" disabled={busy} onClick={() => void check()}>核对小队状态</button>}<button className="button primary" disabled={disabled || !candidate} onClick={() => void act(async () => { await teamsApi.submit(id, Number(selected)); setChoose(false); clearPreviewQuery(); }, '伙伴已加入小队展示。')}>确认提交到小队</button></Modal>}
    {confirm && <Modal title={confirm === 'dissolve' ? '确认解散这个小队？' : '确认离开这个小队？'} close={() => { if (!busy) setConfirm(null); }}><p className="modal-copy">{confirm === 'dissolve' ? '邀请和所有队内展示会移除，成员将无法访问小队。' : '你会失去小队访问权限，你提交的队内展示也会移除。'}个人收藏和独立发布到作品墙的作品会保留。</p>{error && <Notice>{error}</Notice>}{uncertain && <button className="button" disabled={busy} onClick={() => void check()}>核对小队状态</button>}<button className="button primary" disabled={disabled} onClick={() => void act(() => confirm === 'dissolve' ? teamsApi.dissolve(id) : teamsApi.leave(id), '', true)}>确认{confirm === 'dissolve' ? '解散' : '退出'}</button></Modal>}
  </>}</>;
}
