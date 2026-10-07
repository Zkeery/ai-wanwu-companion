'use client';
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Camera, Flower2, Sparkles } from 'lucide-react';
import { errorText } from '@/lib/api';
import { wallApi, type PublicWork, type WorkPage } from '@/lib/wall';
import { themeName } from '@/lib/themes';
import { creationHref, rememberPosition, readPosition, clearPreviewQuery } from '@/lib/creation-origin';
import PublicationDialog from './publication-dialog';
import AuthModal from './auth-modal';
import { useTeamSession } from './team-shared';
import { Brand, Loading, Modal, Notice } from './common';

function WorkImage({ work }: { work: PublicWork }) {
  const [failed, setFailed] = useState(false);
  return <div className="wall-image">{failed ? <span className="wall-image-missing"><Flower2 />形象暂时看不到</span> : <img src={work.image_url} alt={work.name} onError={() => setFailed(true)} />}</div>;
}
function WorkDetail({ theme, id, close, depart }: { theme: string; id: string; close: () => void; depart: () => void }) {
  const [work, setWork] = useState<PublicWork | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    wallApi.detail(theme, id, c.signal).then(v => { if (!c.signal.aborted) setWork(v); }).catch(e => { if (!c.signal.aborted) setError(errorText(e)); });
    return () => c.abort();
  }, [theme, id, revision]);
  return <Modal title="认识这位小伙伴" close={close}>{error ? <Notice retry={() => { setError(''); setWork(null); setRevision(n => n + 1); }}>{error}</Notice> : !work ? <Loading /> : <article className="public-work-detail"><WorkImage work={work} /><span className="theme-tag">{themeName(work.theme_id)}</span><h3>{work.name}</h3><p>{work.introduction}</p><p className="muted">由 {work.author_name} 分享</p><Link className="button primary" href={creationHref({ kind: 'theme', theme: 'fruit' })} onClick={depart}>我也来创造一个</Link></article>}</Modal>;
}

export default function ThemeWall({ theme, initialWork = null, initialPreview = null, resume = false }: { theme: string; initialWork?: string | null; initialPreview?: number | null; resume?: boolean }) {
  const session = useTeamSession();
  const [preview, setPreview] = useState(initialPreview), [login, setLogin] = useState(false);
  const loadedOffset = useRef(0), restored = useRef(false);
  const [page, setPage] = useState<WorkPage | null>(null), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [selected, setSelected] = useState(initialWork);
  useEffect(() => {
    const c = new AbortController(); let frame = 0;
    const position = resume && !restored.current ? readPosition({ kind: 'theme', theme: 'fruit' }) : null;
    (async () => {
      let current = offset, combined: PublicWork[] = [];
      // Only restore previously requested pages, never an arbitrary query-string offset.
      for (let pages = 0; pages < 100; pages++) {
        const v = await wallApi.list(theme, current, c.signal); if (c.signal.aborted) return;
        combined = [...new Map([...combined, ...v.items].map(w => [w.id, w])).values()];
        loadedOffset.current = current;
        setPage(old => ({ ...v, items: offset === 0 ? combined : [...new Map([...(old?.items ?? []), ...combined].map(w => [w.id, w])).values()] }));
        if (!position || current >= position.offset || v.next_offset === null || v.next_offset <= current) break;
        current = v.next_offset;
      }
      restored.current = true;
      if (position) frame = requestAnimationFrame(() => window.scrollTo({ top: position.y, behavior: 'instant' }));
    })().catch(e => { if (!c.signal.aborted) setError(errorText(e)); }).finally(() => { if (!c.signal.aborted) setBusy(false); });
    return () => { c.abort(); cancelAnimationFrame(frame); };
  }, [theme, offset, revision, resume]);
  function depart() { rememberPosition({ kind: 'theme', theme: 'fruit' }, loadedOffset.current); }
  function closePreview() { setPreview(null); clearPreviewQuery(); }
  function reload() { setError(''); setPage(null); setBusy(true); setOffset(0); setRevision(n => n + 1); }
  function close() { setSelected(null); const url = new URL(location.href); url.searchParams.delete('work'); history.replaceState(history.state, '', url); }
  return <div className="shell"><header className="site-header"><Brand /><Link className="back-link" href="/themes">更多创作灵感</Link></header>
    <main className="theme-wall"><div className="wall-hero"><span className="wall-theme-emoji" aria-hidden="true">🍎</span><span className="eyebrow">LITTLE WONDERS, SHARED TOGETHER</span><h1>大家都拍一份水果，<br />却遇见不同的小生命。</h1><p>同一个主题，各自的想象。<br />这里是大家愿意分享的小小奇遇。</p><Link className="button primary" href={creationHref({ kind: 'theme', theme: 'fruit' })} onClick={depart}><Camera size={18} />参加创作</Link></div>
      <div className="wall-heading"><h2><Sparkles size={20} />{themeName(theme)} · 作品墙</h2><span>{page ? `${page.total} 份公开作品` : '正在核对作品数量'}</span><button className="text-button" disabled={busy} onClick={reload}>刷新作品</button></div>
      {error && <Notice retry={reload}>{error}</Notice>}
      {page && page.items.length === 0 && !error && <div className="empty"><Flower2 size={40} /><h3>第一份奇遇，等你分享</h3><p>创作后会先加入私人收藏。你可以预览，再决定要不要公开。</p><Link className="button" href="/">从我的收藏分享</Link></div>}
      {page && <div className="wall-grid">{page.items.map(work => <button className="wall-card" key={work.id} onClick={() => setSelected(work.id)} aria-label={`查看${work.name}的作品`}><WorkImage work={work} /><span className="wall-card-copy"><strong>{work.name}</strong><span>由 {work.author_name} 分享</span></span></button>)}</div>}
      {busy && <Loading />}{page?.next_offset != null && !busy && !error && <button className="button wall-more" onClick={() => { setBusy(true); setOffset(page.next_offset!); }}>再看看更多伙伴</button>}
      <p className="wall-footnote">每一位伙伴都属于它的创作者。这里只展示主动公开的作品。</p>
    </main>{preview && (session ? <PublicationDialog key={`${session}:${preview}`} characterId={preview} close={closePreview} /> : <Modal title="登录后预览分享" close={closePreview}><p>伙伴已在私人收藏里。登录后继续预览，确认后才公开。</p><button className="button primary" onClick={() => setLogin(true)}>注册 / 登录</button></Modal>)}{login && <AuthModal onClose={() => setLogin(false)} onLoggedIn={() => setLogin(false)} />}{!preview && selected && <WorkDetail key={selected} theme={theme} id={selected} close={close} depart={depart} />}
  </div>;
}
