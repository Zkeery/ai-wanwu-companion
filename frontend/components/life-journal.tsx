'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { kindMeta } from '@/lib/living-ui';
import styles from './life-journal.module.css';
import { eventLabel, journalCategories, readJournal, type JournalCategory, type JournalPage, type JournalEvent } from '@/lib/life-journal';
import type { LivingItem, SceneType } from '@/lib/contracts';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Modal } from './common';
import LifeChatDraft from './life-chat-draft';

type Props = { spaceId: string; revision: number; visible?: boolean; companionId?: number; sceneType?: SceneType; items?: LivingItem[]; onLocate?: (id: string) => void; locatingDisabled?: boolean };

export default function LifeJournal({ visible = true, ...props }: Props) {
  const [token, setToken] = useState(getToken);
  useEffect(() => {
    const changed = () => setToken(getToken());
    window.addEventListener(AUTH_CHANGED, changed); window.addEventListener('storage', changed);
    return () => { window.removeEventListener(AUTH_CHANGED, changed); window.removeEventListener('storage', changed); };
  }, []);
  return visible ? <Journal key={`${props.spaceId}:${props.companionId}:${props.sceneType}:${token}`} {...props} /> : null;
}

function Journal({ spaceId, revision, companionId, sceneType, items, onLocate, locatingDisabled = false }: Props) {
  const token = useRef(getToken());
  const [chatEvent, setChatEvent] = useState<JournalEvent | null>(null);
  const [detail, setDetail] = useState<JournalEvent | null>(null);
  const canChat = Number.isSafeInteger(companionId) && Number(companionId) > 0 && !!sceneType;
  const [page, setPage] = useState<JournalPage | null>(null);
  const [category, setCategory] = useState<JournalCategory>('all');
  const [expanded, setExpanded] = useState(false), [loading, setBusy] = useState(true), [error, setError] = useState('');
  const [checkedRevision, setCheckedRevision] = useState<number | null>(null);
  const busy = loading || checkedRevision !== revision;
  const [denied, setDenied] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const anchorHandled = useRef(false);
  const startRead = useCallback((controller: AbortController, before?: number) => {
    const current = () => !controller.signal.aborted && pending.current === controller && getToken() === token.current;
    readJournal(spaceId, before, controller.signal, category).then(result => {
      if (!current()) return;
      setDenied(false); setError('');
      setPage(old => before && old?.space_id === spaceId ? { ...result, events: [...old.events, ...result.events.filter(e => !old.events.some(previous => previous.revision === e.revision))] } : result);
      if (!before) {
        setDetail(old => old ? result.events.find(e => e.revision === old.revision && e.request_id === old.request_id) ?? null : null);
        setChatEvent(old => old ? result.events.find(e => e.revision === old.revision && e.request_id === old.request_id) ?? null : null);
      }
    }).catch(failure => {
      if (!current()) return;
      setChatEvent(null);
      if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
        setPage(null); setDetail(null); setDenied(true); setError('当前生活记录无法访问，请返回本人伙伴重新打开。');
      } else setError('记录暂时无法更新，已保留上次结果。请刷新记录重试。');
    }).finally(() => {
      if (current()) { pending.current = null; setBusy(false); setCheckedRevision(revision); }
    });
  }, [spaceId, category, revision]);
  const load = (before?: number) => {
    if (getToken() !== token.current || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(''); startRead(controller, before);
  };
  useEffect(() => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    startRead(controller);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [startRead]);
  useEffect(() => {
    if (page?.space_id === spaceId && !anchorHandled.current && window.location.hash === '#life-journal') {
      document.getElementById('life-journal')?.scrollIntoView({ block: 'start' });
      anchorHandled.current = true;
    }
  }, [page, spaceId]);
  function chooseCategory(next: JournalCategory) {
    if (next === category) return;
    pending.current?.abort(); pending.current = null;
    setPage(null); setDetail(null); setChatEvent(null); setError(''); setBusy(true); setCategory(next);
  }
  function openChat(event: JournalEvent) {
    if (busy || error || denied || getToken() !== token.current) return;
    setDetail(null); setChatEvent(event);
  }
  const events = page?.space_id === spaceId ? page.events : [];
  const target = detail?.target_item_id ? items?.find(item => item.id === detail.target_item_id) : undefined;
  const targetMatches = !!target && target.kind === detail?.target_kind;
  const canLocate = targetMatches && !target!.stored && !!onLocate;
  const targetNote = !detail?.target_item_id
    ? detail?.target_kind ? '这条记录没有保存具体物件编号，无法从这里定位原物件。' : '这是整个场景或布置的记录，没有单一物件可以定位。'
    : !items ? '原物件状态暂时无法核对，请刷新场景后再查看。'
    : !target ? '这个物件已不在当前场景中，原记录仍保留。'
    : !targetMatches ? '原物件的资料暂时无法核对，请刷新场景后再查看。'
    : target.stored ? '原物件已收纳，摆回场景后可以再定位。'
    : !onLocate ? '当前页面仅供查看，原物件的记录仍保留。' : '可以回到当时操作的原物件，看看它现在的样子。';
  function locateTarget() {
    if (!canLocate || !detail?.target_item_id || busy || error || denied || locatingDisabled || getToken() !== token.current) return;
    const id = detail.target_item_id;
    flushSync(() => setDetail(null));
    if (getToken() === token.current) onLocate?.(id);
  }
  const time = (event: JournalEvent) => new Date(event.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return <section id="life-journal" className={styles.journal} aria-label="私人生活记录" aria-busy={busy}>
    <header className={styles.heading}><div><span>OUR LITTLE DAYS</span><h3>留在这里的小日子</h3></div><span className={styles.badge}>{expanded ? '生活记录' : '最近三件小事'}</span></header>
    <p className={styles.intro}>布置、照料，还有随手做的小调整，都替你记在这里。</p>
    {expanded && !denied && <div className={styles.filters} role="group" aria-label="生活记录分类">{Object.entries(journalCategories).map(([key, label]) => <button type="button" key={key} aria-pressed={category === key} onClick={() => chooseCategory(key as JournalCategory)}>{label}</button>)}</div>}
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">正在读取记录…</p>}
    {events.length ? <ol className={styles.events}>{(expanded ? events : events.slice(0, 3)).map(e => <li key={e.revision}>
      <span className={styles.icon} aria-hidden="true">{e.target_kind ? kindMeta[e.target_kind]?.emoji : e.action === 'layout' ? '🏜️' : e.action === 'undo' ? '↶' : '☁️'}</span><div><strong>{eventLabel(e)}</strong><p className={styles.source}>用户操作</p>
      <time dateTime={new Date(e.created_at * 1000).toISOString()}>{time(e)}（上海时间）</time>
      <button type="button" className={styles.chat} aria-label={`查看记录详情：${eventLabel(e)}`} onClick={() => { setChatEvent(null); setDetail(e); }}>查看详情</button>
      {canChat && <button type="button" className={styles.chat} disabled={busy || !!error} aria-label={`聊聊这件事：${eventLabel(e)}`} onClick={() => openChat(e)}>聊聊这件事 →</button>}</div>
    </li>)}</ol> : !busy && !error && <p>{category === 'all' ? '还没有生活记录。从现在开始，完成布置或照料后就会留下记录；之前的操作不会补写。' : `还没有“${journalCategories[category]}”记录。`}</p>}
    {!denied && <div className={styles.actions}>
      {(events.length > 0 || expanded) && <button className="button ghost" onClick={() => { setExpanded(!expanded); if (expanded) { setDetail(null); setChatEvent(null); chooseCategory('all'); } }}>{expanded ? '收起记录' : '查看生活记录'}</button>}
      {expanded && page?.next_before_revision != null && <button className="button ghost" disabled={busy} onClick={() => void load(page.next_before_revision!)}>加载更早记录</button>}
      <button className="button ghost" disabled={busy} onClick={() => void load()}>刷新生活记录</button>
    </div>}
    {detail && <Modal title="这条生活记录" close={() => setDetail(null)}>
      <p>{eventLabel(detail)}</p><dl className={styles.detail}><dt>操作来源</dt><dd>用户操作</dd><dt>目标种类</dt><dd>{detail.target_kind ? kindMeta[detail.target_kind].name : '整个场景或布置'}</dd><dt>记录时间</dt><dd>{time(detail)}（上海时间）</dd><dt>记录编号</dt><dd>{detail.revision} · {detail.request_id}</dd></dl>
      <p>{targetNote}</p><p>这条记录没有记录伙伴的感受或动作原因。</p>
      {(busy || error) && <p role="status">这是上次读取的记录，等待核对后再定位或带到聊天。</p>}
      <div className="row end"><button type="button" onClick={() => setDetail(null)}>关闭</button>{canLocate && <button type="button" disabled={busy || !!error || denied || locatingDisabled} onClick={locateTarget}>去看看这个物件</button>}{canChat && <button type="button" disabled={busy || !!error || denied} onClick={() => openChat(detail)}>聊聊这件事</button>}</div>
    </Modal>}
    {chatEvent && canChat && !error && <LifeChatDraft companionId={companionId!} sceneType={sceneType!} event={chatEvent} blocked={busy} close={() => setChatEvent(null)} />}
  </section>;
}
