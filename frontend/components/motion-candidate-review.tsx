'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { getToken } from '@/lib/auth';
import { candidateImage, readCandidates, reviewCandidate, type CandidateActivity, type CandidateState, type MotionCandidate } from '@/lib/motion-candidates';
import styles from './motion-candidate-review.module.css';

const labels: Record<CandidateState, string> = { reserved: '等待处理', attempted: '正在获取结果', unknown: '结果待核对',
  needs_review: '等待你确认', rejected: '未采用', reviewed: '已确认，等待继续准备', queued: '正在准备散步动作', ready: '散步动作已就绪' };
const activityNames: Record<CandidateActivity, string> = { rest: '休息', walk: '散步', observe: '观察' };
const activityCriteria: Record<CandidateActivity, string> = {
  rest: '四个姿态都闭着眼睛，神情放松，用轻微呼吸表现闭目养神。',
  walk: '左右脚交替迈步，手臂自然摆动。',
  observe: '有清楚的左右转头和目光扫视，表现四处打量。',
};
const activityChecks: Record<CandidateActivity, string> = {
  rest: '四个姿态持续闭眼，放松休息；',
  walk: '',
  observe: '左右转头和视线变化清楚；',
};

export default function MotionCandidateReview(props: { id: number; token: string; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<CandidateActivity>('walk');
  return <section className={styles.section} aria-label="动作候选确认">
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? '收起待确认动作' : '查看待确认动作'}</button>
    {open && <>
      <label className={styles.category}>候选动作 <select aria-label="候选动作分类" value={activity} onChange={e => setActivity(e.target.value as CandidateActivity)}>
        {Object.entries(activityNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></label>
      <CandidateList key={activity} {...props} activity={activity} />
    </>}
  </section>;
}

function CandidateList({ id, token, onChange, activity }: { id: number; token: string; onChange: () => void; activity: CandidateActivity }) {
  const [revision, setRevision] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  return <div className={styles.list}>
    <p>检查形象是否一致、四个姿态是否完整。使用后会准备{activityNames[activity]}动作，原来的图片仍保留。</p>
    <button type="button" onClick={() => { setCursor(null); setRevision(n => n+1); }}>更新候选状态</button>
    <CandidatePage key={`${revision}-${cursor}`} id={id} token={token} cursor={cursor} activity={activity} onNext={setCursor} onChange={onChange} />
  </div>;
}

function CandidatePage({ id, token, cursor, activity, onNext, onChange }: { id: number; token: string; cursor: string | null; activity: CandidateActivity;
  onNext: (cursor: string) => void; onChange: () => void }) {
  const [items, setItems] = useState<MotionCandidate[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [notice, setNotice] = useState('正在读取动作候选…');
  useEffect(() => {
    const controller = new AbortController();
    void readCandidates(id, token, controller.signal, cursor, activity).then(page => {
      if (controller.signal.aborted || getToken() !== token) return;
      setItems(page.items); setNext(page.next_cursor); setNotice(page.items.length ? '' : '当前没有待确认的动作素材。');
    }).catch(() => { if (!controller.signal.aborted && getToken() === token) setNotice('候选暂时没能加载，请更新状态后再看。'); });
    return () => controller.abort();
  }, [id, token, cursor, activity]);
  return <div>
    <p role="status">{notice}</p>
    {items.map(item => <Candidate key={item.job_id} id={id} token={token} item={item} onChange={onChange} />)}
    {next && <button type="button" onClick={() => onNext(next)}>下一页候选</button>}
  </div>;
}

function Candidate({ id, token, item: initial, onChange }: { id: number; token: string; item: MotionCandidate; onChange: () => void }) {
  const [item, setItem] = useState(initial);
  const activityName = activityNames[item.activity ?? 'walk'];
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let url: string | null = null;
    if (initial.image_url) void candidateImage(initial, id, token, controller.signal).then(blob => {
      if (controller.signal.aborted || getToken() !== token) return;
      url = URL.createObjectURL(blob); setSrc(url);
    }).catch(() => { if (!controller.signal.aborted && getToken() === token) setNotice('图片暂时无法显示，请更新后再检查。'); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [initial, id, token]);
  const decide = async (decision: 'accept' | 'reject') => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || pending.current || uncertain || getToken() !== token
        || (decision === 'accept' && (!loaded || !checked))) return;
    pending.current = true; setBusy(true); setNotice('正在保存你的选择…');
    try {
      const result = await reviewCandidate(id, item, decision, token, controller.signal);
      if (controller.signal.aborted || getToken() !== token) return;
      setItem(result); setNotice(decision === 'reject' ? `已保留你的选择，这份候选不会用于${activityName}。` : `选择已保存，动作准备好后可切换到${activityName}查看。`);
      onChange();
    } catch {
      if (!controller.signal.aborted && getToken() === token) {
        setUncertain(true); setNotice('暂时无法核对提交结果。请先更新候选状态，再决定下一步。');
      }
    } finally {
      pending.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const reviewable = item.state === 'needs_review' || item.state === 'reviewed';
  return <article className={styles.card} aria-label={`${activityName}动作候选`}>
    <h3>{labels[item.state].replace('散步', activityName)}</h3>
    <p>{activityCriteria[item.activity ?? 'walk']}</p>
    {src && <Image unoptimized width={1024} height={1024} className={styles.image} src={src} alt={`伙伴的四个${activityName}姿态候选`} onLoad={() => setLoaded(true)}
      onError={() => { setLoaded(false); setNotice('图片未完整显示，请更新后再检查。'); }} />}
    {src && loaded && <a className={styles.fullImage} href={src} target="_blank" rel="noreferrer">打开完整图片</a>}
    {reviewable && <>
      <label className={styles.check}><input type="checkbox" checked={checked} disabled={!loaded || busy || uncertain}
        onChange={e => setChecked(e.target.checked)} />{activityChecks[item.activity ?? 'walk']}形象一致，姿态完整且没有多余背景</label>
      <div className={styles.actions}>
        <button type="button" disabled={!loaded || !checked || busy || uncertain} onClick={() => void decide('accept')}>
          {busy ? '正在保存…' : item.state === 'reviewed' ? '继续准备' : '使用这个动作'}</button>
        {item.state === 'needs_review' && <button type="button" disabled={busy || uncertain} onClick={() => void decide('reject')}>暂不使用</button>}
      </div>
    </>}
    <p role="status">{notice}</p>
  </article>;
}
