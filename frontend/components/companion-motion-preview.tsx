'use client';
import { useEffect, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { readMotionPreparation, type PreparationState, type PreparationSummary } from '@/lib/motion-preparation';
import type { Activity } from '@/lib/life-simulation';
import PrivateMotionPlayer from './private-motion-player';
import MotionCandidateReview from './motion-candidate-review';
import MotionGenerationStatus from './motion-generation-status';
import styles from './companion-motion-preview.module.css';

type Props = Pick<ComponentProps<typeof PrivateMotionPlayer>, 'id' | 'src' | 'name' | 'onStaticLoad' | 'onStaticError'> & { activity?: Activity };
const labels = { rest: '休息', walk: '散步', observe: '观察' };
const activities = ['rest', 'walk', 'observe'] as const;
const stateLabels: Record<PreparationState, string> = {
  not_requested: '尚未准备', waiting_source: '等待动作素材', queued: '正在准备', ready: '已就绪', failed: '准备未完成',
};
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
  const [revision, setRevision] = useState(0);
  const [summary, setSummary] = useState<PreparationSummary | null>(null);
  const ready = activities.find(value => summary?.[value] === 'ready');
  const choice = selected ?? activity ?? ready ?? 'default';
  const readyForChoice = choice !== 'default' && summary?.[choice] === 'ready';
  return <div className={styles.preview}>
    <MotionCandidateReview id={props.id} token={token} onChange={() => setRevision(n => n+1)} />
    <div className={styles.choices} role="group" aria-label="预览哪种动作">
      {(['default', 'rest', 'walk', 'observe'] as const).map(value => <button type="button" key={value}
        aria-pressed={choice === value} onClick={() => setSelected(value)}>
        {value === 'default' ? '默认动作' : labels[value]}
      </button>)}
    </div>
    <PrivateMotionPlayer key={`player-${revision}-${readyForChoice}`} {...props} activity={choice === 'default' ? undefined : choice} />
    <PreparationStatus key={`status-${revision}`} id={props.id} token={token} onSummary={setSummary} />
    <button type="button" className={styles.refresh} onClick={() => setRevision(n => n + 1)}>更新动作状态</button>
    <MotionGenerationStatus key={`generation-${revision}`} id={props.id} token={token} />
  </div>;
}

function PreparationStatus({ id, token, onSummary }: {
  id: number; token: string; onSummary: (value: PreparationSummary | null) => void;
}) {
  const [summary, setSummary] = useState<PreparationSummary | null>(null);
  const [notice, setNotice] = useState('正在核对动作状态…');
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let next: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string) => {
      if (!active) return;
      active = false; controller.abort(); clearTimeout(next); clearTimeout(deadline); setNotice(message);
    };
    const deadline = setTimeout(() => stop('稍后可更新动作状态，伙伴图片仍可使用。'), 10_000);
    const hidden = () => { if (document.hidden) stop('已暂停核对，回来后可更新动作状态。'); };
    document.addEventListener('visibilitychange', hidden);
    const read = async (attempt: number) => {
      if (!active) return;
      if (document.hidden) { hidden(); return; }
      try {
        const result = await readMotionPreparation(id, token, controller.signal);
        if (!active || controller.signal.aborted) return;
        setSummary(result);
        onSummary(result);
        if (!result) { stop('暂时无法核对准备状态，仍可检查已有动作。'); return; }
        if (!Object.values(result).includes('queued')) {
          stop(Object.values(result).includes('ready')
            ? '可切换查看已就绪的动作，原来的图片仍保留。'
            : '图片已保留，动作准备好后可在这里查看。');
          return;
        }
        setNotice('动作正在后台准备，稍后会自动核对。');
        if (attempt < 9) next = setTimeout(() => void read(attempt + 1), 1000);
        else stop('仍在后台准备，稍后可更新动作状态。');
      } catch {
        if (active) stop('动作状态暂时没能加载，请更新后再看。');
      }
    };
    void read(0);
    return () => { active = false; controller.abort(); clearTimeout(next); clearTimeout(deadline);
      document.removeEventListener('visibilitychange', hidden); };
  }, [id, token, onSummary]);
  return <div className={styles.status} role="status" aria-live="polite" aria-label="动作准备状态">
    {summary && <ul>{(['rest', 'walk', 'observe'] as const).map(value => <li key={value}>
      <span>{labels[value]}</span><span>{stateLabels[summary[value]]}</span>
    </li>)}</ul>}
    <p>{notice}</p>
  </div>;
}
