'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CHAT_DRAFT_UPDATED, readChatDraft, writeChatDraft } from '@/lib/chat-draft';
import { inspectText } from '@/lib/input-limits';
import { sceneNames, type SceneType } from '@/lib/contracts';
import { eventLabel, type JournalEvent } from '@/lib/life-journal';
import { Modal } from './common';
import { AUTH_CHANGED, getToken } from '@/lib/auth';

export default function LifeChatDraft({ companionId, sceneType, event, close, blocked = false }: {
  companionId: number; sceneType: SceneType; event: JournalEvent; close: () => void; blocked?: boolean;
}) {
  const initialDraft = `想和你聊聊这条生活记录：\n${new Date(event.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（上海时间） · ${sceneNames[sceneType]}\n用户操作：${eventLabel(event)}。`;
  return <ChatDraftDialog key={`${companionId}:${event.revision}`} companionId={companionId} initialDraft={initialDraft} close={close} blocked={blocked} />;
}

export function ChatDraftDialog({ companionId, initialDraft, close, blocked = false }: {
  companionId: number; initialDraft: string; close: () => void; blocked?: boolean;
}) {
  const router = useRouter(), lock = useRef(false), composing = useRef(false);
  const requestToken = useRef(getToken());
  const [draft, setDraft] = useState(initialDraft);
  const [existing, setExisting] = useState(() => readChatDraft(companionId)), [error, setError] = useState('');
  useEffect(() => {
    const sync = (e: Event) => { if ((e as CustomEvent<{ id: number }>).detail?.id === companionId) setExisting(readChatDraft(companionId)); };
    window.addEventListener(CHAT_DRAFT_UPDATED, sync);
    return () => window.removeEventListener(CHAT_DRAFT_UPDATED, sync);
  }, [companionId]);
  useEffect(() => {
    const changed = () => { if (getToken() !== requestToken.current) { lock.current = true; close(); } };
    window.addEventListener(AUTH_CHANGED, changed); window.addEventListener('storage', changed);
    return () => { window.removeEventListener(AUTH_CHANGED, changed); window.removeEventListener('storage', changed); };
  }, [close]);
  const combine = (previous: string) => previous ? `${previous}\n\n${draft.trim()}` : draft.trim();
  const input = inspectText(combine(existing), 'message');
  function transfer() {
    if (getToken() !== requestToken.current) { lock.current = true; close(); return; }
    if (blocked || lock.current || composing.current || !draft.trim()) return;
    const latest = readChatDraft(companionId), combined = combine(latest), checked = inspectText(combined, 'message');
    if (!checked.valid) { setExisting(latest); setError(checked.issue || '先写下想聊的话吧。'); return; }
    lock.current = true;
    writeChatDraft(companionId, combined);
    close(); router.push(`/companions/${companionId}?tab=chat#chat-draft`);
  }
  return <Modal title="聊聊这件小事" close={close}>
    <p>把这件小事带到聊天里，想怎么聊都可以。确认后还需要你点发送。</p>
    <form onSubmit={e => { e.preventDefault(); transfer(); }}>
      <label className="field" htmlFor="life-chat-draft">想和伙伴聊的话</label>
      <textarea id="life-chat-draft" value={draft} rows={5} style={{ width: '100%' }}
        aria-describedby="life-chat-hint" aria-invalid={!!input.issue}
        onChange={e => { setDraft(e.target.value); setError(''); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      <p id="life-chat-hint" className="field-hint">{existing ? '原来的草稿会保留，这段话接在后面。' : '先放进草稿，发送前还可以再改。'}<span>{input.count}/{input.limit}</span></p>
      {(input.issue || error) && <p role="alert" className="form-error">{input.issue || error}。请缩短这段话，或先整理原来的草稿。</p>}
      {existing && <Link className="text-button" href={`/companions/${companionId}?tab=chat#chat-draft`} onClick={close}>先去看看原草稿 →</Link>}
      {blocked && <p role="status">正在核对这条记录，请稍后再带到聊天。</p>}
      <div className="row end"><button type="button" onClick={close}>取消</button><button className="primary" disabled={blocked || !draft.trim() || !input.valid}>{existing ? '接在原草稿后面' : '带到聊天'}</button></div>
    </form>
  </Modal>;
}
