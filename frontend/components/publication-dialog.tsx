'use client';
import PrivateImage from './private-image';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { errorText } from '@/lib/api';
import { wallApi, type PublicationPreview } from '@/lib/wall';
import { themeName } from '@/lib/themes';
import { Loading, Modal, Notice } from './common';

export default function PublicationDialog({ characterId, close }: { characterId: number; close: () => void }) {
  const [value, setValue] = useState<PublicationPreview | null>(null), [author, setAuthor] = useState('小小创作者');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [message, setMessage] = useState('');
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => {
    alive.current = true; const c = new AbortController();
    wallApi.preview(characterId, c.signal).then(v => { if (!c.signal.aborted) { setValue(v); setAuthor(v.author_name); } }).catch(e => { if (!c.signal.aborted) setError(errorText(e)); });
    return () => { alive.current = false; c.abort(); };
  }, [characterId]);
  async function check() {
    if (lock.current) return; lock.current = true; setBusy(true);
    try { const v = await wallApi.preview(characterId); if (alive.current) { setValue(v); if (v.publication_id) setAuthor(v.author_name); setUncertain(false); setError(''); setMessage('已核对最新发布状态'); } }
    catch (e) { if (alive.current) setError(errorText(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function save(withdraw = false) {
    if (lock.current || uncertain) return; lock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      if (withdraw) { await wallApi.withdraw(characterId); if (alive.current) { setValue(v => v ? { ...v, publication_id: null } : null); setMessage('已撤下，伙伴仍在你的收藏里'); } }
      else { const v = await wallApi.publish(characterId, author.trim()); if (alive.current) { setValue(v); setAuthor(v.author_name); setMessage('已发布到作品墙'); } }
    } catch (e) {
      if (!alive.current) return;
      setError(errorText(e)); setUncertain(true);
      try { const v = await wallApi.preview(characterId); if (alive.current) { setValue(v); if (v.publication_id) setAuthor(v.author_name); setUncertain(false); setMessage('已核对服务器状态，请查看下方的公开状态'); } } catch { /* Explicit check is required before another write. */ }
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const invalid = !author.trim() || Array.from(author.trim()).length > 20 || /[\p{C}]|1[3-9]\d{9}/u.test(author);
  return <Modal title="分享这位小伙伴" close={() => { if (!busy) close(); }}>
    {error && <Notice retry={!busy ? () => void check() : undefined}>{error}</Notice>}
    {!value ? !error && <Loading /> : <div className="publication-preview">
      <div className="wall-image"><PrivateImage src={value.image_url} alt={value.name} /></div>
      <span className="theme-tag">{themeName(value.theme_id)}</span><h3>{value.name}</h3><p>{value.introduction}</p>
      <label htmlFor="public-author">作品墙上的展示名</label><input id="public-author" value={author} maxLength={40} disabled={busy || !!value.publication_id} onChange={e => setAuthor(e.target.value)} aria-describedby="author-help" />
      <p id="author-help" className="muted">1–20 字，请不要填写手机号。{value.publication_id ? '撤下后可以修改展示名再发布。' : ''}</p>
      <p className="publication-privacy">公开后，大家能看到角色图、名字、这段介绍、主题和展示名。原照片、聊天、记忆和私人场景不会展示。别人可能保存公开内容。</p>
      <p className="publication-state">{value.publication_id ? '当前状态：已公开' : '当前状态：仅自己可见'}</p>
      {message && <p role="status">{message}</p>}
      {uncertain ? <button className="button" disabled={busy} onClick={() => void check()}>核对发布状态</button> : value.publication_id ? <><Link className="button primary" href={`/themes/${value.theme_id}?work=${value.publication_id}`}>查看公开作品</Link><p className="muted">撤下只移除作品墙展示，你的伙伴和聊天都会保留。</p><button className="button" disabled={busy} onClick={() => void save(true)}>{busy ? '正在处理…' : '撤下作品，保留伙伴'}</button></> : <button className="button primary" disabled={busy || invalid} onClick={() => void save()}>{busy ? '正在发布…' : '确认发布'}</button>}
    </div>}
  </Modal>;
}
