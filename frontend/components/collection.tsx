'use client';
import PrivateMotionPlayer from './private-motion-player';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Flower2, Heart, House, LogIn, LogOut, MessageCircle, Sparkles } from 'lucide-react';
import { api, ApiError, errorText } from '@/lib/api';
import { clearToken, getToken } from '@/lib/auth';
import { imageUrl, sceneNames, type CharacterOverview } from '@/lib/contracts';
import { Brand, Loading, Notice } from './common';
import AuthModal from './auth-modal';
import PublicationDialog from './publication-dialog';
import { clearCollectionPosition, readCollectionPosition, rememberCollectionPosition } from '@/lib/collection-position';
import { themeName } from '@/lib/themes';

export default function Collection() {
  const [items, setItems] = useState<CharacterOverview[] | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [authed, setAuthed] = useState<boolean | null>(null), [showAuth, setShowAuth] = useState(false);
  const [authCheck, setAuthCheck] = useState(0), [loggingOut, setLoggingOut] = useState(false);
  const logoutLock = useRef(false);
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

  if (authed === null) return <div className="shell toy-shell"><header className="site-header"><Brand /></header><main className="collection">{error ? <Notice retry={() => { setError(''); setAuthCheck(n => n + 1); }}>{error}</Notice> : <Loading />}</main></div>;

  if (authed === false) {
    return <div className="shell toy-shell">
      <header className="site-header"><Brand /></header>
      <main className="collection auth-welcome">
        <section className="toy-hero" aria-label="欢迎来到万物伙伴">
          <div className="hero-copy">
            <span className="toy-eyebrow">✦ 给日常，加一点不一样</span>
            <h1>平凡小物，<br /><span>不平凡的朋友。</span></h1>
            <p>把身边的喜欢，变成会回应的伙伴。<br />拍下杯子、植物或玩偶，认识一个独一无二的小生命。</p>
            <button className="button hero-cta" onClick={() => setShowAuth(true)}><LogIn size={21} />注册 / 登录，开始创造<ArrowUpRight size={21} /></button>
            <span className="hero-note">登录后，你的伙伴会安全地跟着你。</span>
          </div>
          <div className="hero-playground" aria-label="创作流程示意：照片中的杯子变成伙伴"><div className="playground-orbit" /><div className="creation-example"><span className="example-object" aria-hidden="true">☕</span><span className="example-arrow" aria-hidden="true">✦ →</span><div className="toy-mascot" aria-hidden="true"><i /><i /><b /><span>♡</span></div></div><div className="playground-caption">拍下小物 → 创造独特伙伴 → 聊天与生活<small>创作流程示意 · 每次生成都不同</small></div></div>
        </section>
        <div className="play-strip" aria-hidden="true"><span><Sparkles size={18} />把日常变成奇遇</span><span>MAKE A LITTLE MAGIC</span><span><Flower2 size={18} />收集喜欢，一起玩耍</span></div>
      </main>
      <footer><strong>万物有趣，陪伴有形。</strong><span>MADE FOR YOUR EVERYDAY MAGIC ✳</span></footer>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onLoggedIn={loggedIn} />}
    </div>;
  }

  return <div className="shell toy-shell v12-home">
    <header className="site-header"><Brand /><button className="button nav-auth" disabled={loggingOut} onClick={() => void logout()}><LogOut size={16} />退出</button></header>
    <main className="collection">
      <section className="return-welcome"><div><span className="toy-eyebrow">✦ 欢迎回到你的小世界</span><h1>今天，和谁一起度过？</h1><p>和熟悉的伙伴聊聊天，去它的小天地坐一坐。</p></div><span className="welcome-spark" aria-hidden="true">✳</span></section>
      <section id="my-companions" className="collection-section"><div className="section-heading"><div><span className="section-kicker">YOUR LITTLE CREW</span><h2>我的伙伴 <span>{items?.length ?? '—'}</span></h2></div><span className="collection-subtitle">熟悉的朋友，新的故事。</span></div>
        {error ? <Notice retry={() => { setError(''); setRevision(n => n + 1); }}>{error}</Notice> : items === null ? <Loading /> : items.length === 0 ? <div className="empty"><Flower2 size={52} /><h2>第一位朋友，会是谁呢？</h2><p>杯子、植物、玩偶，都可以成为故事的主角。</p><Link className="button primary" href="/companions/new">创建第一个伙伴 <ArrowUpRight size={17} /></Link></div> : <div className="companion-grid">{items.map(({ character: item, residence, gathering, last_interaction_at, recent_activity = [] }, i) => <article className="collection-card-wrap overview-card" key={item.id} id={`collection-companion-${item.id}`} tabIndex={-1} aria-label={item.name}
          onClickCapture={e => {
            const link = e.target instanceof Element ? e.target.closest('a') : null;
            if (!ownerId || !link || link.target === '_blank' || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            rememberCollectionPosition(ownerId, item.id, e.currentTarget.getBoundingClientRect().top);
          }}>
          <div className={`companion-card card-tone-${i % 3}`}>
            {imageUrl(item.image_path) ? <PrivateMotionPlayer id={item.id} src={imageUrl(item.image_path)!} name={item.name} compact href={`/companions/${item.id}?tab=chat`}
              overlay={<><span className="card-number">NO. {String(i + 1).padStart(2, '0')}</span><span className="card-sticker" aria-hidden="true">{['✦', '✳', '♡'][i % 3]}</span></>} />
              : <Link href={`/companions/${item.id}?tab=chat`} aria-label={`查看${item.name}`}><div className={`portrait tone-${i % 3}`}><span className="card-number">NO. {String(i + 1).padStart(2, '0')}</span><Flower2 size={76} /><span className="card-sticker" aria-hidden="true">{['✦', '✳', '♡'][i % 3]}</span></div></Link>}
            <Link href={`/companions/${item.id}?tab=chat`} className="card-info" aria-label={`认识${item.name}`}><div><h3>{item.name}</h3>{item.theme_id && <span className="theme-tag">{themeName(item.theme_id)}</span>}<p><House size={14} aria-hidden="true" />{gathering ? `正在 ${gathering.title} 相聚` : residence ? `${sceneNames[residence.scene_type]} · ${residence.mode === 'private' ? '独自生活' : '同住'}` : '还没有选择住处'}</p></div></Link>
          </div>
          <div className="overview-card-bottom"><p className="last-interaction">{last_interaction_at ? <>上次聊天 <time dateTime={last_interaction_at} suppressHydrationWarning>{new Date(last_interaction_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></> : '还没有聊天记录，来打个招呼吧。'}</p>
            {process.env.NEXT_PUBLIC_LIFE_JOURNAL === 'true' && residence?.mode === 'private' && <section className="overview-life" aria-label={`${item.name}的生活近况`}>
              <h4>最近生活记录</h4>
              {recent_activity.length ? <ol>{recent_activity.map(event => <li key={event.revision}><span>{event.text}</span><small>用户操作 · <time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}（上海时间）</time></small></li>)}</ol> : <p>还没有手动生活记录</p>}
              <Link className="text-button" href={`/companions/${item.id}?tab=life#life-journal`}>查看生活记录</Link>
            </section>}
            <div className="overview-actions"><Link className="button primary" href={`/companions/${item.id}?tab=chat`}><MessageCircle size={17} />聊聊天</Link><Link className="button" href={gathering ? `/gatherings?space=${gathering.id}` : `/companions/${item.id}?tab=life`}><House size={17} />{gathering ? '去相聚 / 回家' : residence ? '去住处' : '选择住处'}</Link></div>{item.theme_id && <button className="text-button share-work" onClick={() => setSharing(item.id)}>分享作品</button>}</div>
        </article>)}</div>}
      </section>
      <div className="collection-footnote"><Heart size={17} /><p>从“你好”开始，把普通的一天过得特别一点。</p></div>
    </main><footer><strong>万物有趣，陪伴有形。</strong><span>MADE FOR YOUR EVERYDAY MAGIC ✳</span></footer>
    {sharing !== null && <PublicationDialog key={sharing} characterId={sharing} close={() => setSharing(null)} />}
    {showAuth && <AuthModal onClose={() => setShowAuth(false)} onLoggedIn={loggedIn} />}
  </div>;
}
