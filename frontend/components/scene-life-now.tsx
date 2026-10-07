'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Eye, Footprints, Moon, Sparkles } from 'lucide-react';
import { imageUrl, type Character, type LivingSpace } from '@/lib/contracts';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { runtimeApi, type RuntimeSnapshot, type RuntimeView } from '@/lib/life-runtime';
import { kindMeta } from '@/lib/living-ui';
import { activityChatDraft } from '@/lib/life-activity-draft';
import { clearPrivateMotionCache } from '@/lib/private-motion';
import { useCurrentActivity } from '@/lib/use-current-activity';
import { ChatDraftDialog } from './life-chat-draft';
import PrivateImage from './private-image';
import PrivateMotionPlayer from './private-motion-player';
import { Modal } from './common';
import styles from './scene-life-now.module.css';

type Props = { view: RuntimeView | null; space: LivingSpace; companions: Character[]; editing: boolean;
  onLocate: (id: string) => void; onUpdated: (value: RuntimeSnapshot) => void; onRefresh: () => void; onSettings?: () => void };
const format = (stamp: number) => new Date(stamp * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const subscribeVisibility = (change: () => void) => {
  document.addEventListener('visibilitychange', change);
  return () => document.removeEventListener('visibilitychange', change);
};
const visibleSnapshot = () => document.visibilityState !== 'hidden';
const serverVisibility = () => false;
const subscribeMotionPreference = (change: () => void) => {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  media?.addEventListener('change', change);
  return () => media?.removeEventListener('change', change);
};
const fullMotionSnapshot = () => window.matchMedia ? !window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
const serverMotionPreference = () => false;

export default function SceneLifeNow(props: Props) {
  const snapshot = props.view?.snapshot;
  const person = props.companions.find(item => String(item.id) === snapshot?.companion_id);
  if (!snapshot || !person || props.space.mode !== 'private' || snapshot.space_id !== props.space.id ||
      snapshot.companion_id !== props.space.companion_id || !snapshot.present) return null;
  return <LifeNow key={`${props.space.id}:${person.id}`} {...props} snapshot={snapshot} person={person} />;
}

function LifeNow({ view, space, editing, onLocate, onUpdated, onRefresh, onSettings, snapshot, person }: Props & { snapshot: RuntimeSnapshot; person: Character }) {
  const [open, setOpen] = useState(false), [paused, setPaused] = useState(false);
  const [chatDraft, setChatDraft] = useState<{ id: string; content: string } | null>(null);
  const [hidden, setHidden] = useState(false), [reduced, setReduced] = useState(false);
  const visibleAtRender = useSyncExternalStore(subscribeVisibility, visibleSnapshot, serverVisibility);
  const fullMotionAtRender = useSyncExternalStore(subscribeMotionPreference, fullMotionSnapshot, serverMotionPreference);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [message, setMessage] = useState('');
  const [accountLost, setAccountLost] = useState(false);
  const active = useRef(false), locked = useRef(false), controller = useRef<AbortController | null>(null);
  const uncertainAt = useRef<RuntimeSnapshot | null>(null);
  const [sceneStill, setSceneStill] = useState<{ taskId: string; png: string } | null>(null);
  const current = useCurrentActivity(snapshot);
  useEffect(() => {
    active.current = true;
    const token = getToken(), media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const visibility = () => setHidden(document.visibilityState === 'hidden');
    const motion = () => setReduced(media?.matches ?? true);
    const account = () => { if (getToken() !== token) { setSceneStill(null); clearPrivateMotionCache(); active.current = false; controller.current?.abort(); setAccountLost(true); setOpen(false); } };
    visibility(); motion();
    document.addEventListener('visibilitychange', visibility); media?.addEventListener('change', motion);
    window.addEventListener(AUTH_CHANGED, account); window.addEventListener('storage', account);
    return () => { clearPrivateMotionCache(person.id); active.current = false; controller.current?.abort(); document.removeEventListener('visibilitychange', visibility);
      media?.removeEventListener('change', motion); window.removeEventListener(AUTH_CHANGED, account); window.removeEventListener('storage', account); };
  }, [person.id]);
  useEffect(() => {
    if (uncertainAt.current && uncertainAt.current !== snapshot && !view?.stale && !locked.current) {
      uncertainAt.current = null; setUncertain(false); setMessage('状态已重新核对，请按当前设置继续。');
    }
  }, [snapshot, view?.stale]);

  const target = current?.activity === 'observe' ? space.items.find(item => item.id === current.target_id && !item.stored) : undefined;
  const ongoing = !view?.stale && snapshot.permission.enabled && current &&
    (current.activity !== 'observe' || target) ? current : null;
  useEffect(() => { if (!ongoing || paused || hidden || reduced || editing || busy || uncertain) clearPrivateMotionCache(person.id);
  }, [ongoing, paused, hidden, reduced, editing, busy, uncertain, person.id]);
  const title = view?.stale ? '状态待核对' : !snapshot.permission.enabled ? '自主活动已暂停'
    : ongoing?.activity === 'rest' ? '歇一会儿' : ongoing?.activity === 'walk' ? '慢慢散步'
    : ongoing?.activity === 'observe' ? `看看${kindMeta[target!.kind]?.name ?? '这个物件'}`
    : snapshot.tasks[0]?.state === 'running' ? '正在安排这轮活动' : snapshot.tasks[0]?.state === 'queued' ? '等待这轮活动' : '暂时没有进行中的活动';
  const Icon = ongoing?.activity === 'rest' ? Moon : ongoing?.activity === 'walk' ? Footprints : ongoing?.activity === 'observe' ? Eye : Sparkles;
  const task = snapshot.tasks[0];
  const initialDraft = ongoing && task?.id === ongoing.task_id ? activityChatDraft(space, snapshot.origin, task) : null;
  const chatAvailable = !editing && !uncertain && !busy && !!initialDraft;
  // Discard an invalid preview before rendering; it must not revive when a stale view recovers.
  if (chatDraft && (!chatAvailable || chatDraft.id !== ongoing?.task_id || chatDraft.content !== initialDraft)) setChatDraft(null);
  const moving = !!ongoing && !paused && !hidden && !reduced && !editing && !open && !chatDraft && !busy && !uncertain;
  if (sceneStill && sceneStill.taskId !== current?.task_id) setSceneStill(null);
  const stillSrc = ongoing && sceneStill?.taskId === ongoing.task_id && !hidden && !reduced && !busy && !uncertain
    ? sceneStill.png : null;
  const beside = target ? target.x + (target.x >= .5 ? -.22 : .22) : .5;
  const position = target ? {
    left: `clamp(115px, ${Math.max(18, Math.min(82, space.scene_type === 'desert' ? 9 + 82 * beside : 12 + 76 * beside))}%, calc(100% - 115px))`,
    top: `clamp(122px, ${Math.max(25, Math.min(68, space.scene_type === 'desert' ? 20 + 49 * target.y : -12 + 75 * target.y))}%, calc(100% - 122px))`,
  } : { left: '48%', top: '62%' };

  async function pauseLife() {
    if (!active.current || locked.current || view?.stale || uncertain || !snapshot.permission.enabled) return;
    locked.current = true; setBusy(true); setMessage('正在暂停自主活动…');
    const token = getToken(), request = new AbortController(); controller.current = request;
    const valid = () => active.current && !request.signal.aborted && getToken() === token;
    try {
      const result = await runtimeApi.save(space.id, snapshot.permission.revision, false, snapshot.permission.activities, request.signal);
      if (!valid()) return;
      onUpdated(result); setUncertain(false); setMessage('自主活动已暂停，已有记录会保留。');
    } catch {
      if (!valid()) return;
      setUncertain(true); setMessage('暂停结果还没核对清楚，正在查看已保存的状态…');
      try {
        const result = await runtimeApi.read(space.id, request.signal);
        if (!valid()) return;
        onUpdated(result); setUncertain(false);
        setMessage(result.permission.enabled ? '已核对：自主活动仍开启，可以再点一次暂停。' : '已核对：自主活动已暂停。');
      } catch {
        if (valid()) { uncertainAt.current = snapshot; setMessage('暂时连不上，请先关闭弹窗并刷新状态核对；本次不会重复提交。'); onRefresh(); }
      }
    } finally { locked.current = false; if (valid()) setBusy(false); }
  }

  if (accountLost) return null;
  return <>
    <div className={styles.layer} aria-label="伙伴当前活动画面" data-motion={moving ? 'playing' : 'paused'} onClick={e => e.stopPropagation()}>
      {ongoing && !editing ? <div className={styles.anchor} style={position}>
        <div className={`${styles.traveller} ${ongoing.activity === 'walk' ? styles.walk : ''}`}>
          <button type="button" className={styles.actor} onClick={() => setOpen(true)} aria-label={`看看${person.name}此刻在做什么`}>
            <span className={styles.bubble}><Icon size={15} />{title}</span>
            <span className={`${styles.portrait} ${ongoing.activity === 'rest' ? styles.rest : ''} ${moving || stillSrc ? styles.motionPortrait : ''}`}>
              {imageUrl(person.image_path) ? moving && visibleAtRender && fullMotionAtRender
                ? <PrivateMotionPlayer key={`${ongoing.task_id}:${ongoing.activity}:${snapshot.origin}:scene`}
                    id={person.id} src={imageUrl(person.image_path)!} name={person.name} activity={ongoing.activity} scene compact
                    onSceneStill={png => setSceneStill({ taskId: ongoing.task_id, png })} />
                : stillSrc
                  // eslint-disable-next-line @next/next/no-img-element -- Verified scene sprite frame is a private in-memory data URL.
                  ? <img src={stillSrc} alt={person.name} />
                  : <PrivateImage src={imageUrl(person.image_path)!} alt={person.name} retryable={false} />
                : <Sparkles size={38} />}
            </span>
            <span className={styles.shadow} />
          </button>
        </div>
      </div> : null}
      <div className={styles.tools}>
        <span className={styles.source}>{snapshot.origin === 'offline_fixture' ? '离线活动示意' : '已保存活动示意'}</span>
        <button type="button" onClick={() => setOpen(true)}>此刻在做什么</button>
        {ongoing && <button type="button" aria-pressed={paused} onClick={() => { if (!paused) clearPrivateMotionCache(person.id); setPaused(!paused); }} disabled={reduced}>{reduced ? '已减少动态' : paused ? '继续画面' : '暂停画面'}</button>}
      </div>
    </div>
    {open && <Modal title={`${person.name}此刻在做什么`} close={() => setOpen(false)}>
      <div className={styles.detail} onClick={e => e.stopPropagation()}>
        <p className={styles.source}>{snapshot.origin === 'offline_fixture' ? '离线预设活动，不是AI真实对话' : '依据已保存的AI活动'}</p>
        <h3>{title}</h3>
        {ongoing && !editing && !busy && !uncertain && !paused && !hidden && imageUrl(person.image_path) && <div aria-label="当前活动对应动作">
          <p>只展示这轮活动对应的动作；播放不会执行新任务。</p>
          <div className={styles.activityMotion}><PrivateMotionPlayer key={`${ongoing.task_id}:${ongoing.activity}:${snapshot.origin}`} id={person.id}
            src={imageUrl(person.image_path)!} name={person.name} activity={ongoing.activity} /></div>
        </div>}
        {ongoing && <p>这轮状态从 {format(ongoing.started_at)} 开始（上海时间）。画面只示意最近保存的活动，不改变场景布置。</p>}
        <h4>为什么这样显示</h4>
        <p>{view?.stale ? '暂时连不上，已停下画面；上次记录仍会保留。' : ongoing ? target ? `这轮选中了这里的${kindMeta[target.kind]?.name ?? '物件'}，也在你允许的观察范围内。` : ongoing.activity === 'rest' ? '这轮保存的是休息，你允许它在这里歇一歇。' : '这轮保存的是散步，你允许它在这里走走。' : !snapshot.permission.enabled ? '你暂停了自主活动；想继续时，可以到活动设置里重新开启。' : '这一会儿没有新的活动。之前做过的事，还可以在活动记录里找到。'}</p>
        {ongoing && task?.id === ongoing.task_id && task.reason && <p>{snapshot.origin === 'real_provider' ? '已保存的 AI 选择理由' : '本轮预设选择理由'}：{task.reason}</p>}
        <h4>接下来呢</h4>
        <p>{snapshot.automatic?.enabled ? `自动活动已开启，下一次会在 ${format(snapshot.automatic.next_at)} 后看看是否适合再安排一轮。` : '目前没有自动安排。你可以聊聊天，或到活动设置里安排一轮。'}</p>
        {paused && <p>你暂停的是画面，后台活动设置没有改变。</p>}
        {message && <p role="status">{message}</p>}
        <div className={styles.actions}>
          <Link className="button" href={`/companions/${person.id}?tab=chat`}>和{person.name}聊聊</Link>
          {initialDraft && <button className="button" disabled={!chatAvailable} onClick={() => { setOpen(false); setChatDraft({ id: task.id, content: initialDraft }); }}>聊聊这次活动</button>}
          {target && ongoing && <button className="button" disabled={editing || busy || uncertain} onClick={() => { setOpen(false); requestAnimationFrame(() => { if (active.current) onLocate(target.id); }); }}>看看这个物件</button>}
          {onSettings && <button className="button" disabled={busy} onClick={() => { setOpen(false); requestAnimationFrame(() => { if (active.current) onSettings(); }); }}>去活动设置</button>}
          {snapshot.permission.enabled && <button className="button" disabled={busy || !!view?.stale || uncertain} onClick={() => void pauseLife()}>暂停自主活动</button>}
        </div>
        <p className={styles.note}>暂停自主活动会取消未完成任务并关闭自动安排；聊天和手动布置仍可继续。</p>
      </div>
    </Modal>}
    {chatDraft && chatAvailable && chatDraft.id === ongoing?.task_id && chatDraft.content === initialDraft && <ChatDraftDialog companionId={person.id} initialDraft={chatDraft.content} close={() => setChatDraft(null)} />}
  </>;
}
