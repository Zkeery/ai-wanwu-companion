'use client';
/* eslint-disable @next/next/no-img-element */
import PrivateMotionPlayer from './private-motion-player';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Camera, Flower2, House, LogOut, MessageCircle } from 'lucide-react';
import { api, ApiError, errorText } from '@/lib/api';
import { clearToken, getToken, setToken } from '@/lib/auth';
import { withBasePath } from '@/lib/base-path';
import { imageUrl, sceneNames, type CharacterOverview } from '@/lib/contracts';
import { Brand, Loading, Notice } from './common';
import AuthModal from './auth-modal';
import PublicationDialog from './publication-dialog';
import { clearCollectionPosition, readCollectionPosition, rememberCollectionPosition } from '@/lib/collection-position';
import { themeName } from '@/lib/themes';

const examples = [
  { id: 'pencil', name: '小彩', object: '彩色铅笔' },
  { id: 'pot', name: '陶陶', object: '陶土花盆' },
  { id: 'headphones', name: '听听', object: '头戴耳机' },
  { id: 'book', name: '页页', object: '一本旧书' },
  { id: 'dragon', name: '小龙', object: '彩色铅笔' },
  { id: 'flower', name: '朵朵', object: '非洲菊' },
  { id: 'cream', name: '沫沫', object: '咖啡杯' },
  { id: 'cup', name: '小杯', object: '咖啡杯' },
] as const;

function FirstMeeting({ children }: { children: ReactNode }) {
  return <section className="first-meeting" aria-labelledby="first-meeting-title">
    <h1 id="first-meeting-title">拍一下身边的东西，<br />它就变成你的伙伴</h1>
    <ul className="example-cards" aria-label="示例：身边的东西变成的伙伴">
      {examples.map(example => <li key={example.id} className="example-card">
        <img className="example-portrait" src={withBasePath(`/home-examples/${example.id}.webp`)} alt={`${example.object}变成的伙伴${example.name}`} width={480} height={640} />
        <span className="example-source"><img src={withBasePath(`/home-examples/${example.id}-object.webp`)} alt={`原来的${example.object}`} width={160} height={160} /></span>
        <span className="example-name"><strong>{example.name}</strong><small>来自{example.object}</small></span>
      </li>)}
    </ul>
    {children}
  </section>;
}

export default function Collection() {
  const router = useRouter();
  const [guestBusy, setGuestBusy] = useState(false);
  const [items, setItems] = useState<CharacterOverview[] | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [authed, setAuthed] = useState<boolean | null>(null), [showAuth, setShowAuth] = useState(false);
  const [authCheck, setAuthCheck] = useState(0), [loggingOut, setLoggingOut] = useState(false);
  const logoutLock = useRef(false), guestLock = useRef(false);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const positionRestored = useRef(false);
  const [sharing, setSharing] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    (async () => {
      if (!getToken()) { if (active) setAuthed(false); return; }
      try { const user = await api.auth.me(); if (active) { setOwnerId(user.id); setAuthed(true); } }
      catch (e) { if (active) { if (e instanceof ApiError && e.status === 401) setAuthed(false); else setError(errorText(e)); } }
    })();
    return () => { active = false; };
  }, [authCheck]);
  useEffect(() => {
    if (authed !== true) return;
    const controller = new AbortController();
    api.characterOverview(controller.signal).then(value => { if (!controller.signal.aborted) setItems(value); }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [revision, authed]);

  useEffect(() => {
    if (!ownerId || authed !== true || !items || error || positionRestored.current) return;
    const saved = readCollectionPosition(ownerId);
    if (!saved) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const card = items.some(item => item.character.id === saved.companionId)
          ? document.getElementById(`collection-companion-${saved.companionId}`) : null;
        if (card) {
          const offset = saved.width === window.innerWidth ? saved.offset : 24;
          window.scrollTo({ top: Math.max(0, window.scrollY + card.getBoundingClientRect().top - offset), behavior: 'instant' });
          card.focus({ preventScroll: true });
        } else document.getElementById('my-companions')?.scrollIntoView({ block: 'start' });
        positionRestored.current = true;
        clearCollectionPosition();
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [ownerId, authed, items, error]);

  function loggedIn() { setShowAuth(false); setAuthed(null); setOwnerId(null); setItems(null); positionRestored.current = false; setAuthCheck(n => n + 1); }

  async function logout() {
    if (logoutLock.current) return;
    logoutLock.current = true; setLoggingOut(true); setError('');
    try { await api.auth.logout(); clearToken(); setAuthed(false); setOwnerId(null); setItems(null); }
    catch (e) { setError(errorText(e)); }
    finally { logoutLock.current = false; setLoggingOut(false); }
  }

  async function startGuest() {
    if (guestLock.current) return;
    guestLock.current = true; setGuestBusy(true); setError('');
    try { const result = await api.auth.guest(); setToken(result.token); router.push('/companions/new'); }
    catch (e) { setError(errorText(e)); }
    finally { guestLock.current = false; setGuestBusy(false); }
  }
  if (authed === null) return <div className="shell toy-shell"><header className="site-header"><Brand /></header><main className="collection">{error ? <Notice retry={() => { setError(''); setAuthCheck(n => n + 1); }}>{error}</Notice> : <Loading />}</main></div>;

  if (authed === false) {
    return <div className="shell toy-shell">
      <header className="site-header"><Brand /></header>
      <main className="collection">
        <FirstMeeting>
          <button className="button primary first-meeting-cta" type="button" disabled={guestBusy} onClick={() => void startGuest()}><Camera size={22} aria-hidden="true" />拍一样东西</button>
          <button className="guest-login" type="button" disabled={guestBusy} onClick={() => setShowAuth(true)}>{process.env.NEXT_PUBLIC_AUTH_MODE === 'invite' ? '已有账号？用邀请码登录' : '已有账号？登录'}</button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </FirstMeeting>
      </main>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onLoggedIn={loggedIn} />}
    </div>;
  }

  return <div className="shell toy-shell v12-home">
    <header className="site-header"><Brand /><button className="button nav-auth" disabled={loggingOut} onClick={() => void logout()}><LogOut size={16} />退出</button></header>
    <main className="collection">
      {error ? <Notice retry={() => { setError(''); setRevision(n => n + 1); }}>{error}</Notice> : items === null ? <Loading /> : items.length === 0 ? <FirstMeeting><Link className="button primary first-meeting-cta" href="/companions/new"><Camera size={22} aria-hidden="true" />拍一样东西</Link></FirstMeeting> : <>
      <section className="return-welcome"><div><span className="toy-eyebrow">✦ 欢迎回到你的小世界</span><h1>今天，和谁一起度过？</h1><p>和熟悉的伙伴聊聊天，去它的小天地坐一坐。</p></div><span className="welcome-spark" aria-hidden="true">✳</span></section>
      <section id="my-companions" className="collection-section"><div className="section-heading"><div><h2>我的伙伴 <span>{items.length}</span></h2></div><span className="collection-subtitle">熟悉的朋友，新的故事。</span></div>
        <div className="companion-grid">{items.map(({ character: item, residence, gathering, last_interaction_at, recent_activity = [] }, i) => <article className="collection-card-wrap overview-card" key={item.id} id={`collection-companion-${item.id}`} tabIndex={-1} aria-label={item.name}
          onClickCapture={e => {
            const link = e.target instanceof Element ? e.target.closest('a') : null;
            if (!ownerId || !link || link.target === '_blank' || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            rememberCollectionPosition(ownerId, item.id, e.currentTarget.getBoundingClientRect().top);
          }}>
          <div className={`companion-card card-tone-${i % 3}`}>
            {imageUrl(item.image_path) ? <PrivateMotionPlayer id={item.id} src={imageUrl(item.image_path)!} name={item.name} compact href={`/companions/${item.id}?tab=chat`}
              overlay={<span className="card-sticker" aria-hidden="true">{['✦', '✳', '♡'][i % 3]}</span>} />
              : <Link href={`/companions/${item.id}?tab=chat`} aria-label={`查看${item.name}`}><div className={`portrait tone-${i % 3}`}><Flower2 size={76} /><span className="card-sticker" aria-hidden="true">{['✦', '✳', '♡'][i % 3]}</span></div></Link>}
            <Link href={`/companions/${item.id}?tab=chat`} className="card-info" aria-label={`认识${item.name}`}><div><h3>{item.name}</h3>{item.theme_id && <span className="theme-tag">{themeName(item.theme_id)}</span>}<p><House size={14} aria-hidden="true" />{gathering ? `正在 ${gathering.title} 相聚` : residence ? `${sceneNames[residence.scene_type]} · ${residence.mode === 'private' ? '独自生活' : '同住'}` : '还没有选择住处'}</p></div></Link>
          </div>
          <div className="overview-card-bottom"><p className="last-interaction">{last_interaction_at ? <>上次聊天 <time dateTime={last_interaction_at} suppressHydrationWarning>{new Date(last_interaction_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></> : '还没有聊天记录，来打个招呼吧。'}</p>
            {process.env.NEXT_PUBLIC_LIFE_JOURNAL === 'true' && residence?.mode === 'private' && <section className="overview-life" aria-label={`${item.name}的生活近况`}>
              <h4>最近生活记录</h4>
              {recent_activity.length ? <ol>{recent_activity.map(event => <li key={event.revision}><span>{event.text}</span><small>用户操作 · <time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}（上海时间）</time></small></li>)}</ol> : <p>还没有手动生活记录</p>}
              <Link className="text-button" href={`/companions/${item.id}?tab=life#life-journal`}>查看生活记录</Link>
            </section>}
            <div className="overview-actions"><Link className="button primary" href={`/companions/${item.id}?tab=chat`}><MessageCircle size={17} />聊聊天</Link><Link className="button" href={gathering ? `/gatherings?space=${gathering.id}` : `/companions/${item.id}?tab=life`}><House size={17} />{gathering ? '去相聚 / 回家' : residence ? '去住处' : '选择住处'}</Link></div>{item.theme_id && <button className="text-button share-work" onClick={() => setSharing(item.id)}>分享作品</button>}</div>
        </article>)}</div>
      </section></>}
    </main>
    {sharing !== null && <PublicationDialog key={sharing} characterId={sharing} close={() => setSharing(null)} />}
    {showAuth && <AuthModal onClose={() => setShowAuth(false)} onLoggedIn={loggedIn} />}
  </div>;
}
