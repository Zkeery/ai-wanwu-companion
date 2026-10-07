'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { clearPrivateMotionCache } from '@/lib/private-motion';
import PrivateMotionPlayer from './private-motion-player';
import styles from './scene-walk-preview.module.css';
import type { Activity } from '@/lib/life-simulation';

const labels: Record<Activity, string> = { rest: '休息', walk: '散步', observe: '观察' };

const subscribe = (change: () => void) => {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  window.addEventListener(AUTH_CHANGED, change); window.addEventListener('storage', change);
  document.addEventListener('visibilitychange', change); media?.addEventListener('change', change);
  return () => {
    window.removeEventListener(AUTH_CHANGED, change); window.removeEventListener('storage', change);
    document.removeEventListener('visibilitychange', change); media?.removeEventListener('change', change);
  };
};
const visible = () => !document.hidden;
const fullMotion = () => !!window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const no = () => false;

type Props = { id: number; src: string; name: string; spaceId: string; disabled: boolean };
export default function SceneWalkPreview(props: Props) {
  const token = useSyncExternalStore(subscribe, getToken, () => null);
  const shown = useSyncExternalStore(subscribe, visible, no);
  const motion = useSyncExternalStore(subscribe, fullMotion, no);
  if (!token || !shown || props.disabled) return null;
  if (!motion) return <button type="button" className={styles.trigger} disabled>已减少动态</button>;
  return <Preview key={JSON.stringify([props.id, props.src, props.spaceId, token])} {...props} />;
}

function Preview({ id, src, name }: Props) {
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<Activity>('walk');
  return <>
    {!open && <button type="button" className={styles.trigger}
      aria-label={`在场景里预览${name}动作`} onClick={event => { event.stopPropagation(); setActivity('walk'); setOpen(true); }}>场景动作预览</button>}
    {open && <Motion key={activity} id={id} src={src} name={name} activity={activity} select={setActivity} close={() => setOpen(false)} />}
  </>;
}

function Motion({ id, src, name, activity, select, close }: Pick<Props, 'id' | 'src' | 'name'> & { activity: Activity; select: (activity: Activity) => void; close: () => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => () => clearPrivateMotionCache(id), [id]);
  return <div className={styles.layer} role="group" aria-label={`${name}的场景动作预览`}
    data-activity={activity} data-moving={activity === 'walk' && !!frame && !paused} onClick={event => event.stopPropagation()}>
    <div className={styles.tools}>
      <div className={styles.activities} role="group" aria-label="选择场景预览动作">
        {(Object.keys(labels) as Activity[]).map(value => <button key={value} type="button" aria-pressed={activity === value} onClick={() => select(value)}>{labels[value]}</button>)}
      </div>
      <span>{labels[activity]}预览 · 当前活动不变</span>
      <button type="button" disabled={!frame} aria-pressed={paused} onClick={() => { if (paused) setFrame(null); setPaused(value => !value); }}>{paused ? '继续预览' : '暂停预览'}</button>
      <button type="button" onClick={close}>结束预览</button>
    </div>
    <div className={styles.anchor}><div className={styles.traveller}>
      {paused && frame
        // eslint-disable-next-line @next/next/no-img-element -- Private verified canvas frame, only held in component memory.
        ? <img className={styles.still} src={frame} alt={`${name}的${labels[activity]}暂停画面`} />
        : <PrivateMotionPlayer id={id} src={src} name={name} activity={activity} scene compact onSceneStill={setFrame} />}
    </div></div>
    {!frame && <p className={styles.note}>有可用{labels[activity]}动作时播放，未就绪时保留原图。</p>}
  </div>;
}
