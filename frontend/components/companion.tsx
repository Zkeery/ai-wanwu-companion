'use client';
import PrivateImage from './private-image';
import CompanionMotionPreview from './companion-motion-preview';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowUp, BookHeart, Flower2, Home, Leaf, MoreHorizontal, RefreshCw, Sparkles } from 'lucide-react';
import { api, errorText } from '@/lib/api';
import { actionNames, imageUrl, type Character, type CharacterOverview, type Message, type Scene } from '@/lib/contracts';
import { sendChat } from '@/lib/stream';
import { CHAT_DRAFT_UPDATED, readChatDraft, writeChatDraft } from '@/lib/chat-draft';
import { clearPendingChat, pendingChat, recoverPendingChat } from '@/lib/chat-recovery';
import { inspectText } from '@/lib/input-limits';
import { Brand, Loading, Modal, Notice, timeLabel } from './common';
import RenameCompanion from './rename-companion';
import PersonalityEditor from './personality-editor';
import LivingScene from './living-scene';
import Memories from './memories';
import RecreateCompanion from './recreate-companion';
import CompanionProfileFacts, { companionLocation } from './companion-profile-facts';

type Data = { character: Character; messages: Message[]; scene: Scene; presence: CharacterOverview | null };
export default function Companion({ id }: { id: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab = requestedTab === 'life' || requestedTab === 'profile' ? requestedTab : 'chat';
  function selectTab(next: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next); url.hash = '';
    window.history.pushState(null, '', url.pathname + url.search);
  }
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [draft, setDraft] = useState(''), [stream, setStream] = useState(''), [sending, setSending] = useState(false), [busy, setBusy] = useState(false), [memory, setMemory] = useState(false), [menu, setMenu] = useState(false), [confirm, setConfirm] = useState<'history' | 'character' | null>(null), [revision, setRevision] = useState(0), [uncertain, setUncertain] = useState(false);
  const [renaming, setRenaming] = useState(false), [portrait, setPortrait] = useState(false);
  const [personality, setPersonality] = useState(false);
  const [profileError, setProfileError] = useState(''), [profileNotice, setProfileNotice] = useState('');
  const profileAbort = useRef<AbortController | null>(null);
  const composing = useRef(false);
  const [submittedText, setSubmittedText] = useState('');
  const input = inspectText(draft, 'message');
  const locked = useRef(false), active = useRef(false), chatAbort = useRef<AbortController | null>(null), timeline = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let mounted = true;
    const syncDraft = (event: Event) => { if ((event as CustomEvent<{ id: number }>).detail?.id === id) setDraft(readChatDraft(id)); };
    window.addEventListener(CHAT_DRAFT_UPDATED, syncDraft);
    Promise.resolve().then(() => { if (mounted) setDraft(readChatDraft(id)); });
    return () => { mounted = false; window.removeEventListener(CHAT_DRAFT_UPDATED, syncDraft); };
  }, [id]);
  useEffect(() => {
    if (tab !== 'chat' || !data?.character.id || window.location.hash !== '#chat-draft') return;
    const frame = requestAnimationFrame(() => document.getElementById('chat-draft')?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [tab, data?.character.id]);
  function updateDraft(text: string) { setDraft(text); writeChatDraft(id, text); }
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    async function load() {
      const character = await api.character(id, controller.signal);
      const pending = await recoverPendingChat(id);
      const [messages, scene, overviews] = await Promise.all([api.messages(id, controller.signal), api.scene(id, controller.signal), api.characterOverview(controller.signal).catch(() => [])]);
      if (!controller.signal.aborted) {
        setData({ character, messages, scene, presence: overviews.find(item => item.character.id === id) ?? null });
        setError(pending ? '上条消息尚未确认，可以核对结果或继续处理原消息。' : '');
        setUncertain(pending); setDraft(readChatDraft(id));
      }
    }
    load().catch(e => { if (!controller.signal.aborted) { setError(errorText(e)); setUncertain(true); } });
    return () => { active.current = false; controller.abort(); chatAbort.current?.abort(); profileAbort.current?.abort(); };
  }, [id, revision]);
  useEffect(() => { if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight; }, [stream, data?.messages.length]);
  const recover = useCallback(async () => { const pending = await recoverPendingChat(id); const [messages, scene, overviews] = await Promise.all([api.messages(id), api.scene(id), api.characterOverview().catch(() => [])]); if (active.current) { setData(d => d ? { ...d, messages, scene, presence: overviews.find(item => item.character.id === id) ?? null } : d); setUncertain(pending); setDraft(readChatDraft(id)); if (pending) setError('上条消息尚未确认，可以核对结果或继续处理原消息。'); } }, [id]);
  async function refreshProfile() {
    if (locked.current || !data || renaming || personality) return;
    locked.current = true; setBusy(true); setProfileError(''); setProfileNotice('');
    const controller = new AbortController(); profileAbort.current = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('资料读取超时，请重试', 'TimeoutError')), 30000);
    try {
      const [character, scene, overviews] = await Promise.all([
        api.character(id, controller.signal), api.scene(id, controller.signal), api.characterOverview(controller.signal),
      ]);
      const presence = overviews.find(item => item.character.id === id) ?? null;
      if (character.status === 'ready' && !presence) throw new Error('伙伴去向暂时无法核对');
      if (!controller.signal.aborted && active.current) {
        setData(d => d ? { ...d, character, scene, presence } : d);
        setProfileNotice('资料已更新。');
      }
    } catch {
      if (active.current && profileAbort.current === controller) {
        setProfileError('资料还没更新，先保留上次看到的内容。请稍后再点“更新资料”重试。');
      }
    } finally {
      clearTimeout(timeout);
      if (profileAbort.current === controller) {
        profileAbort.current = null; locked.current = false;
        if (active.current) setBusy(false);
      }
    }
  }
  async function sceneMutation(action: () => Promise<Scene>) {
    if (locked.current) return; locked.current = true; setBusy(true); setError('');
    try { const scene = await action(); if (active.current) setData(d => d ? { ...d, scene } : d); }
    catch (e) { if (active.current) { setError(errorText(e)); try { await recover(); } catch { setUncertain(true); } } }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }
  async function submit(resume = false) {
    const pending = resume ? pendingChat(id) : null;
    if (resume && !pending) return;
    const checked = inspectText(pending?.message ?? draft, 'message');
    if (!checked.valid || composing.current || locked.current || (uncertain && !resume) || data?.character.status !== 'ready') return;
    const text = checked.text;
    setSubmittedText(text);
    locked.current = true; setSending(true); setError(''); setStream(''); const controller = new AbortController(); chatAbort.current = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('回复等待超时', 'TimeoutError')), 180000);
    try {
      const done = await sendChat(id, text, controller.signal, delta => { if (active.current) setStream(s => s + delta); });
      if (!active.current) return;
      // done confirms persistence. Don't keep the composer locked behind extra GETs.
      setData(d => {
        if (!d) return d;
        const messages = [...d.messages];
        if (!messages.some(message => message.id === done.message.id)) {
          const last = messages.at(-1);
          if (last?.role !== 'user' || last.content !== text) {
            // Presentation-only key; loading history replaces it with the persisted row.
            messages.push({ id: -done.message.id, role: 'user', content: text, created_at: '' });
          }
          messages.push(done.message);
        }
        return { ...d, messages, scene: { ...d.scene, proposal: done.proposal } };
      });
      setUncertain(false);
      if (readChatDraft(id).trim() === text) updateDraft('');
    } catch (e) {
      if (active.current) { setError(`${errorText(e)}。${pendingChat(id) ? '已保留输入，请先核对聊天记录再决定是否重发。' : '已保留输入，修改后可以重试。'}`); try { await recover(); } catch { setUncertain(true); } }
    } finally { clearTimeout(timeout); locked.current = false; chatAbort.current = null; if (active.current) { setSending(false); setStream(''); } }
  }
  async function remove() {
    if (locked.current || !confirm) return; locked.current = true; setBusy(true); setError('');
    try { if (confirm === 'character') { await api.deleteCharacter(id); clearPendingChat(id); router.push('/'); return; } await api.clearHistory(id); clearPendingChat(id); await recover(); setConfirm(null); }
    catch (e) { setConfirm(null); setError(errorText(e)); setUncertain(true); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }
  function reload() { if (locked.current) return; setUncertain(true); setRevision(n => n + 1); }
  const disabled = sending || busy || uncertain;
  return <div className="shell detail-shell v12-detail"><header className="site-header"><Brand /><Link className="back-link" href="/"><ArrowLeft size={16} />我的伙伴</Link></header>{!data ? <main className="detail-loading">{error ? <Notice retry={reload}>{error}</Notice> : <Loading />}<div className="row"><Link href={`/companions/${id}/scenes`}>选择生活场景</Link><Link href="/">返回收藏</Link></div></main> : <main className="detail-layout">
    <div className="companion-identity"><button className="profile-avatar" aria-label="放大伙伴形象" onClick={() => setPortrait(true)}>{imageUrl(data.character.image_path) ? <PrivateImage src={imageUrl(data.character.image_path)!} alt={data.character.name} /> : <Flower2 size={40} />}</button><div><span className="eyebrow">YOUR LITTLE COMPANION</span><h1>{data.character.name}</h1><p>{data.character.status === 'ready' ? '这里，是我们一起写故事的地方。' : '伙伴尚未准备好'}</p><span className="companion-residence">{companionLocation(data.presence)}</span></div></div>
    <div className="companion-tabs" role="tablist" aria-label="伙伴分区">{([{ key: 'chat', label: '聊天' }, { key: 'life', label: '生活' }, { key: 'profile', label: '资料' }] as const).map(({ key, label }) => <button key={key} id={`tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => selectTab(key)} onKeyDown={e => { const keys = ['chat', 'life', 'profile']; const index = keys.indexOf(tab); const next = e.key === 'ArrowRight' ? keys[(index + 1) % 3] : e.key === 'ArrowLeft' ? keys[(index + 2) % 3] : e.key === 'Home' ? 'chat' : e.key === 'End' ? 'profile' : null; if (next) { e.preventDefault(); selectTab(next); document.getElementById(`tab-${next}`)?.focus(); } }}>{label}{key === 'chat' && sending && <span className="tab-reply-status">回复中</span>}</button>)}</div>
    <section id="panel-life" className="companion-life" role="tabpanel" aria-labelledby="tab-life" hidden={tab !== 'life'}><div className="section-heading"><div><h2>伙伴的小天地</h2><p>布置住处，留一点喜欢在这里。</p></div><Link className="button" href={`/companions/${id}/scenes`}><Home size={18} />选择生活场景</Link></div>{data.presence?.gathering && !data.scene.living ? <div className="choose-home-note"><Home size={42} /><h3>{data.character.name}去小队相聚了</h3><p>从共同空间主动召回后，再选择住处；打开这个页面不会让伙伴自动回家。</p><Link className="button primary" href={`/gatherings?space=${encodeURIComponent(data.presence.gathering.id)}`}>去共同空间看看 →</Link></div> : data.scene.living ? data.scene.living.mode === 'private' && data.presence?.residence?.space_id === data.scene.living.id ? <LivingScene readOnly={busy} visible={tab === 'life'} space={data.scene.living} companion={data.character} onChange={living => setData(d => d ? { ...d, scene: { ...d.scene, living, proposal: null } } : d)} /> : <div className="choose-home-note"><Home size={42} /><h3>{data.presence?.gathering ? `${data.character.name}去小队相聚了` : data.scene.living.mode === 'shared' ? '看看同住的小天地' : '这处住处还在等伙伴回来'}</h3><p>这里的布置会保留；打开场景可核对谁在这里，不会因为查看而搬家。</p><Link className="button primary" href={`/companions/${id}/scenes/${data.scene.living.scene_type}/${encodeURIComponent(data.scene.living.id)}`}>查看已保存的场景 →</Link>{data.presence?.gathering && <Link className="button" href={`/gatherings?space=${encodeURIComponent(data.presence.gathering.id)}`}>去共同空间看看</Link>}</div> : <div className="choose-home-note"><Flower2 size={42} /><h3>为伙伴选一个住处吧</h3><p>家庭庭院、沙漠绿洲，或是林间营地。</p><Link className="button primary" href={`/companions/${id}/scenes`}>选择一个小天地 →</Link></div>}</section>
    <section id="panel-profile" className="companion-profile-panel" role="tabpanel" aria-labelledby="tab-profile" hidden={tab !== 'profile'}><div className="section-heading"><div><span className="section-kicker">GET TO KNOW ME</span><h2>认识{data.character.name}</h2></div><div className="row"><button className="button" disabled={busy || sending} onClick={() => void refreshProfile()}>{busy ? '正在处理…' : '更新资料'}</button><button className="button" disabled={busy || sending} onClick={() => setRenaming(true)}>修改名字</button></div></div>{profileError && <p role="alert" className="form-error">{profileError}</p>}{profileNotice && <p role="status">{profileNotice}</p>}<CompanionProfileFacts character={data.character} presence={data.presence} scene={data.scene}/><h3>我的性格</h3><p className="persona">{data.character.persona}</p><button className="button" disabled={busy || sending} onClick={() => setPersonality(true)}>调整性格</button><button className="memory-entry" disabled={sending || busy} onClick={() => setMemory(true)}><BookHeart size={21} /><span><strong>我们记得的小事</strong><small>把重要的事，轻轻留下</small></span><span>↗</span></button>{data.character.status === 'ready' && <RecreateCompanion key={id} id={id} />}<p className="sidebar-note"><Leaf size={13} />不赶时间，慢慢来就好。</p><button className="text-button danger" disabled={disabled} onClick={() => setConfirm('character')}>删除这个伙伴</button></section>
    <section id="panel-chat" className="chat-panel" role="tabpanel" aria-labelledby="tab-chat" hidden={tab !== 'chat'}><span id="chat" /><div className="chat-heading"><div><h2>和{data.character.name}聊聊</h2><p>今天有什么，想和我分享？</p></div><div className="chat-menu"><button className="icon-button" aria-label="聊天管理" aria-expanded={menu} disabled={disabled} onClick={() => setMenu(v => !v)}><MoreHorizontal /></button>{menu && <div className="dropdown"><button onClick={() => { setMenu(false); setConfirm('history'); }}>清空聊天记录</button><button className="danger" onClick={() => { setMenu(false); setConfirm('character'); }}>删除这个伙伴</button></div>}</div></div>
    {error && <Notice retry={reload}>{error}</Notice>}
    <div ref={timeline} className="chat-timeline" aria-label="聊天记录"><div className="conversation-marker"><span />故事还在继续<span /></div>{data.messages.length === 0 && <div className="message assistant"><span className="message-avatar">{imageUrl(data.character.image_path) ? <PrivateImage src={imageUrl(data.character.image_path)!} alt="" retryable={false} /> : <Flower2 size={19} />}</span><div><span className="message-name">{data.character.name}</span><p>{data.character.opening_line || '你好呀，来一起坐一会儿吧。'}</p></div></div>}{data.messages.map(message => <div className={`message ${message.role}`} key={message.id}>{message.role === 'assistant' && <span className="message-avatar">{imageUrl(data.character.image_path) ? <PrivateImage src={imageUrl(data.character.image_path)!} alt="" retryable={false} /> : <Flower2 size={19} />}</span>}<div><span className="message-name">{message.role === 'user' ? '我' : data.character.name}<time suppressHydrationWarning>{timeLabel(message.created_at)}</time></span><p>{message.content}</p></div></div>)}{sending && <><div className="message user"><div><span className="message-name">我 · 正在发送</span><p>{submittedText}</p></div></div><div className="message assistant"><span className="message-avatar">{imageUrl(data.character.image_path) ? <PrivateImage src={imageUrl(data.character.image_path)!} alt="" retryable={false} /> : <Flower2 size={19} />}</span><div><span className="message-name">{data.character.name}</span><p role="status">{stream || <span className="thinking">正在想怎么回应你<span>…</span></span>}</p></div></div></>}{data.scene.proposal && <div className="proposal"><div><Sparkles size={19} /><strong>一起布置{data.scene.scene_name}？</strong></div><p>{actionNames[data.scene.proposal.action]}。确认后才会改变当前场景，可以撤销最近一步。</p><div className="row"><button className="primary" disabled={disabled} onClick={() => void sceneMutation(() => api.decide(id, data.scene.proposal!.id, 'confirm'))}>好，就这样做</button><button disabled={disabled} onClick={() => void sceneMutation(() => api.decide(id, data.scene.proposal!.id, 'reject'))}>先不了</button></div></div>}</div>
    <div id="chat-draft" className="composer-wrap"><Link className="button" href={`/companions/${id}/voice`}>说话与心情</Link><div className="conversation-hint"><Sparkles size={14} />{data.scene.living ? '也可以说「种一棵树」，和伙伴一起照顾当前场景。' : '先说声你好吧，选好住处后还能一起布置。'}{data.scene.living && <button className="text-button chat-life-link" onClick={() => selectTab('life')}>去生活里看看 →</button>}</div><form className="composer" onSubmit={e => { e.preventDefault(); void submit(); }}><textarea aria-label="想对伙伴说的话" placeholder="说说今天，或只是打个招呼…" value={draft} onChange={e => updateDraft(e.target.value)} disabled={sending || data.character.status !== 'ready'} aria-describedby="chat-input-hint" aria-invalid={!!input.issue} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} rows={2} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current) { e.preventDefault(); void submit(); } }} /><div className="composer-bottom"><span>{sending ? '伙伴正在回复，请稍等…' : 'Enter 发送 · Shift + Enter 换行'}</span><button className="send-button" aria-label="发送消息" disabled={disabled || !input.valid || data.character.status !== 'ready'}><ArrowUp size={21} /></button></div></form><div id="chat-input-hint" className={`field-hint input-limit-hint ${input.issue ? 'error-text' : ''}`}><span>{input.issue || `最多 ${input.limit} 字`}</span><span>{input.count}/{input.limit}</span></div><p className="ai-note">伙伴由 AI 生成，可能会理解错。你的感受，始终最重要。</p>{uncertain && <div className="row"><button className="text-button" disabled={busy || sending} onClick={reload}><RefreshCw size={15} />重新核对已保存的记录</button>{pendingChat(id) && <button className="text-button" disabled={busy || sending} onClick={() => void submit(true)}>继续处理原消息</button>}</div>}</div></section></main>}{personality && data && <PersonalityEditor key={id} id={id} close={() => setPersonality(false)} onSaved={persona => setData(d => d ? { ...d, character: { ...d.character, persona } } : d)} />}{renaming && data && <RenameCompanion character={data.character} onChange={character => setData(d => d ? { ...d, character } : d)} close={() => setRenaming(false)} />}{portrait && data && <Modal title={data.character.name} close={() => setPortrait(false)}>{imageUrl(data.character.image_path) ? <CompanionMotionPreview id={id} src={imageUrl(data.character.image_path)!} name={data.character.name} /> : <p>伙伴的形象还没有准备好。</p>}</Modal>}{memory && <Memories id={id} close={() => setMemory(false)} />}{confirm && <Modal title={confirm === 'history' ? '清空聊天记录？' : '删除这个伙伴？'} close={() => { if (!busy) setConfirm(null); }}><p>{confirm === 'history' ? '聊天记录和待确认提议会被清除，手动记忆与花园会保留。此操作无法撤销。' : '这个伙伴的聊天记录、手动记忆、小花园和私人生活场景都会被删除。同住只解除成员关系，共居空间和其他伙伴会保留。此操作无法撤销。'}</p><div className="row end"><button disabled={busy} onClick={() => setConfirm(null)}>保留</button><button className="danger-button" disabled={busy} onClick={() => void remove()}>{busy ? '正在处理…' : '确认删除'}</button></div></Modal>}</div>;
}
