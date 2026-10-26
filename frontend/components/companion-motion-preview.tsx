'use client';
import { useEffect, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { readMotionPreparation, type PreparationSummary } from '@/lib/motion-preparation';
import type { Activity } from '@/lib/life-simulation';
import PrivateMotionPlayer from './private-motion-player';
import styles from './companion-motion-preview.module.css';

type Props = Pick<ComponentProps<typeof PrivateMotionPlayer>, 'id' | 'src' | 'name' | 'onStaticLoad' | 'onStaticStage' | 'onStaticError'> & { activity?: Activity };
const labels = { rest: '休息', walk: '散步', observe: '观察' };
const activities = ['rest', 'walk', 'observe'] as const;
const subscribe = (change: () => void) => {
  window.addEventListener(AUTH_CHANGED, change); window.addEventListener('storage', change);
  return () => { window.removeEventListener(AUTH_CHANGED, change); window.removeEventListener('storage', change); };
};

export default function CompanionMotionPreview(props: Props) {
  const token = useSyncExternalStore(subscribe, getToken, () => null);
  if (!token) return <p>登录后查看伙伴形象</p>;
  return <Preview key={JSON.stringify([props.id, props.src, token])} {...props} token={token} />;
}

function Preview({ activity, token, ...props }: Props & { token: string }) {
  const [selected, setSelected] = useState<Activity | 'default' | null>(null);
  const [playRequest, setPlayRequest] = useState(0);
  const [summary, setSummary] = useState<PreparationSummary | null>(null);
  const ready = activities.find(value => summary?.[value] === 'ready');
  const choice = selected ?? activity ?? ready ?? 'default';
  const readyForChoice = choice !== 'default' && summary?.[choice] === 'ready';
  return <div className={styles.preview}>
    {ready && <div className={styles.choices} role="group" aria-label="预览哪种动作">
      {(['default', 'rest', 'walk', 'observe'] as const).filter(value => value === 'default' || summary?.[value] === 'ready').map(value => <button type="button" key={value}
        aria-pressed={choice === value} onClick={() => { setSelected(value); setPlayRequest(n => n + 1); }}>
        {value === 'default' ? '默认动作' : labels[value]}
      </button>)}
    </div>}
    <PrivateMotionPlayer {...props} resourceKey={`${readyForChoice}`} playRequest={playRequest} activity={choice === 'default' ? undefined : choice} reuseLoadedActions quietWhenUnavailable />
    <PreparationStatus id={props.id} token={token} onSummary={setSummary} />
  </div>;
}

function PreparationStatus({ id, token, onSummary }: {
  id: number; token: string; onSummary: (value: PreparationSummary | null) => void;
}) {
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let next: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (!active) return;
      active = false; controller.abort(); clearTimeout(next); clearTimeout(deadline);
    };
    const deadline = setTimeout(stop, 10_000);
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hidden);
    const read = async (attempt: number) => {
      if (!active) return;
      if (document.hidden) { hidden(); return; }
      try {
        const result = await readMotionPreparation(id, token, controller.signal);
        if (!active || controller.signal.aborted) return;
        onSummary(result);
        if (!result || !Object.values(result).includes('queued')) { stop(); return; }
        if (attempt < 9) next = setTimeout(() => void read(attempt + 1), 1000);
        else stop();
      } catch {
        if (active) stop();
      }
    };
    void read(0);
    return () => { active = false; controller.abort(); clearTimeout(next); clearTimeout(deadline);
      document.removeEventListener('visibilitychange', hidden); };
  }, [id, token, onSummary]);
  return null;
}
