'use client';
import { useEffect, useRef, useState } from 'react';
import { getToken } from '@/lib/auth';
import { motionGenerationActivities, type ActivityGenerations, type GenerationState } from '@/lib/motion-generation';
import styles from './motion-candidate-review.module.css';

const text: Record<GenerationState, string> = {
  not_requested: '还没有准备任务，可以先保存任务。',
  waiting_authorization: '准备任务已保存。动作生成尚未开放，暂不会开始生成；你可以先离开页面。',
  queued: '已排队，后台会继续处理。', running: '正在生成候选，你可以先离开，回来后查看结果。',
  needs_review: '候选已生成，请打开“查看待确认动作”检查。',
  reviewed: '你的选择已保存，可在待确认动作中继续准备。',
  rejected: '这份候选未采用，原来的图片仍保留。', ready: '动作已就绪。',
  unknown: '这次生成结果仍需核对，原任务已保留，不会自动重新生成。',
  blocked: '原图或生成条件已变化，这次任务未继续。原来的图片仍保留。',
};
const names = { rest: '休息', walk: '散步', observe: '观察' };

export default function MotionGenerationStatus({ id, token }: { id: number; token: string }) {
  const [revision, setRevision] = useState(0);
  return <RequestState key={revision} id={id} token={token} onRefresh={() => setRevision(n => n+1)} />;
}

function RequestState({ id, token, onRefresh }: { id: number; token: string; onRefresh: () => void }) {
  const [value, setValue] = useState<ActivityGenerations | null>(null);
  const [notice, setNotice] = useState('正在核对三类动作任务…');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [paused, setPaused] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const posting = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { controller.abort(); clearTimeout(timer); clearTimeout(deadline); };
    const hidden = () => { if (document.hidden) { stop(); setPaused(true); setBusy(false); setNotice('已暂停核对，回来后可更新任务状态。'); } };
    const deadline = setTimeout(() => { stop(); setPaused(true); setBusy(false); setNotice('稍后可更新任务状态，已保存的任务会保留。'); }, 10_000);
    document.addEventListener('visibilitychange', hidden);
    const read = async (attempt: number) => {
      if (document.hidden) { hidden(); return; }
      try {
        const result = await motionGenerationActivities(id, token, controller.signal);
        if (controller.signal.aborted) return;
        setValue(result); setNotice('');
        if (result.activities.some(item => ['queued', 'running'].includes(item.state)) && attempt < 9) timer = setTimeout(() => void read(attempt+1), 1000);
        else clearTimeout(deadline);
      } catch { if (!controller.signal.aborted) { setNotice('暂时无法读取准备任务，请更新后再看。'); clearTimeout(deadline); } }
    };
    void read(0);
    return () => { stop(); document.removeEventListener('visibilitychange', hidden); };
  }, [id, token]);
  const register = async () => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || posting.current || uncertain || getToken() !== token) return;
    posting.current = true; setBusy(true);
    try {
      const result = await motionGenerationActivities(id, token, controller.signal, true);
      if (!controller.signal.aborted) { setValue(result); setNotice(''); }
    } catch { if (!controller.signal.aborted) { setUncertain(true); setNotice('暂时无法核对登记结果，请先更新任务状态。'); } }
    finally { posting.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  if (value?.activities.every(item => item.state === 'ready')) return null;
  return <section className={`${styles.section} ${styles.card}`} aria-label="三类动作准备">
    {value?.activities.map(item => <p key={item.activity} role="status"><strong>{names[item.activity]}：</strong>{text[item.state]}</p>)}
    {notice && <p role="status">{notice}</p>}
    {value?.activities.some(item => item.state === 'not_requested') && <button type="button" disabled={busy || uncertain || paused} onClick={() => void register()}>
      {busy ? '正在保存准备任务…' : '准备三类动作'}</button>}
    <button type="button" disabled={busy} onClick={onRefresh}>更新任务状态</button>
  </section>;
}
