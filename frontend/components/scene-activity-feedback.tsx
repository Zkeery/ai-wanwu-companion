'use client';
import { useState } from 'react';
import { Eye, Footprints, Moon, Clock3 } from 'lucide-react';
import { type Character, type LivingSpace } from '@/lib/contracts';
import type { RuntimeView } from '@/lib/life-runtime';
import { kindMeta } from '@/lib/living-ui';
import { activityChatDraft } from '@/lib/life-activity-draft';
import { ChatDraftDialog } from './life-chat-draft';
import styles from './scene-activity-feedback.module.css';

export type ActivityScene = { space: LivingSpace; companions: Character[]; onLocate: (id: string) => void; locatingDisabled?: boolean };
type Props = ActivityScene & { view: RuntimeView | null; historical?: boolean };

export default function SceneActivityFeedback({ view, space, companions, onLocate, locatingDisabled = false, historical = false }: Props) {
  if (!view || space.mode !== 'private') return null;
  const snapshot = view.snapshot;
  if (!snapshot) return <aside className={styles.card} aria-label="伙伴的最近活动"><p>{view.stale ? '活动状态暂时无法核对，请在自主生活里刷新。' : '正在看看伙伴的最近活动…'}</p></aside>;
  const person = companions.find(item => String(item.id) === snapshot.companion_id);
  if (snapshot.space_id !== space.id || snapshot.companion_id !== space.companion_id || !snapshot.present || !person) return null;
  const task = snapshot.tasks[0];
  const target = task?.state === 'done' && task.activity === 'observe' ? space.items.find(item => item.id === task.target_id && !item.stored) : undefined;
  const Icon = task?.state !== 'done' ? Clock3 : task.activity === 'rest' ? Moon : task.activity === 'walk' ? Footprints : Eye;
  const title = !task ? '还没有活动记录'
    : task.state === 'done' ? task.activity === 'rest' ? '歇了一会儿' : task.activity === 'walk' ? '散了会儿步' : target ? `看了看${kindMeta[target.kind]?.name ?? '场景物件'}` : '观察了一会儿'
    : task.state === 'queued' ? task.dispatch_requested ? '这轮活动正在等候处理' : '已经安排，等你点执行'
    : task.state === 'running' ? '这轮活动正在处理'
    : task.state === 'cancelled' ? '这轮活动已取消' : task.error_code === 'budget_exhausted' ? '这轮未执行，AI预算尚未开放' : '这轮没能完成，可以查看原因';
  return <aside className={styles.card} aria-label={historical ? '历史活动内容' : '伙伴的最近活动'}>
    <span className={styles.icon} aria-hidden="true"><Icon size={25} /></span>
    <div className={styles.content}>
      <div className={styles.heading}><strong>{person.name} · {historical ? '这条活动' : '最近一轮'}</strong><span className={styles.source}>{snapshot.origin === 'offline_fixture' ? '离线样例' : 'AI活动记录'}</span></div>
      <p className={styles.title} aria-live="polite">{title}</p>
      {task && <time className={styles.time} dateTime={new Date(task.created_at * 1000).toISOString()}>本轮安排于 {new Date(task.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（上海时间）</time>}
      {!snapshot.permission.enabled && <p className={styles.note}>自主生活已暂停，已有记录会留下。</p>}
      {view.stale && <p className={styles.note}>暂时连不上，这是上次读取的记录；核对后再定位物件。</p>}
      {task?.state === 'done' && task.activity === 'observe' && !target && <p className={styles.note}>原来观察的物件已收纳或移走。</p>}
      {target && <button type="button" className="button ghost" disabled={view.stale || locatingDisabled} onClick={() => onLocate(target.id)}>看看它观察的物件</button>}
      {task?.state === 'done' && <ActivityChatEntry key={`${space.id}:${person.id}:${task.id}:${snapshot.origin}:${title}:${view.stale}`} disabled={view.stale} companionId={person.id}
        initialDraft={activityChatDraft(space, snapshot.origin, task)!} />}
    </div>
  </aside>;
}

function ActivityChatEntry({ companionId, initialDraft, disabled }: { companionId: number; initialDraft: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="button ghost" disabled={disabled} onClick={() => setOpen(true)}>聊聊这次活动</button>
    {open && !disabled && <ChatDraftDialog companionId={companionId} initialDraft={initialDraft} close={() => setOpen(false)} />}
  </>;
}
