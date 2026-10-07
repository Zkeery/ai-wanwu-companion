'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { creationApi, type Draft } from '@/lib/creation';
import { errorText } from '@/lib/api';

const GENERATION_BUDGET_MS = 8000;

export default function CreationDeadline({ startedAt, completedMs, active, getRecord, canQuery }: {
  startedAt: number; completedMs: number | null; active: boolean; getRecord: () => Draft | null; canQuery: boolean;
}) {
  const [overdue, setOverdue] = useState(false), [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState(''), [readyId, setReadyId] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active || completedMs !== null) return;
    const check = () => { if (performance.now() - startedAt >= GENERATION_BUDGET_MS) setOverdue(true); };
    const timer = setTimeout(check, Math.max(0, GENERATION_BUDGET_MS - (performance.now() - startedAt)));
    document.addEventListener('visibilitychange', check);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', check); };
  }, [startedAt, active, completedMs]);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, [active, completedMs]);

  async function checkSaved() {
    const record = getRecord();
    if (!record || controller.current) return;
    const c = new AbortController(); controller.current = c;
    setChecking(true); setNotice(''); setReadyId(null);
    const signal = AbortSignal.any([c.signal, AbortSignal.timeout(3000)]);
    try {
      if (record.objectId) {
        const result = await creationApi.byObject(record.objectId, signal);
        if (signal.aborted) return;
        if (result?.status === 'ready') { setReadyId(result.id); setNotice('伙伴已生成并保存，可以进入详情查看。'); }
        else if (result?.status === 'failed') setNotice('服务器确认本次生成未完成。原流程结束后可核对并手动重试。');
        else setNotice(result ? '服务器仍在生成中，不用重复提交。' : '暂未查到伙伴结果，请稍后再核对，不用重复提交。');
      } else {
        const result = await creationApi.receipt(record.requestId, signal);
        if (signal.aborted) return;
        setNotice(result.status === 'ready' ? '照片已识别，原流程会继续处理，不用重复上传。' : result.status === 'failed' ? '服务器确认照片识别未完成。原流程结束后可重新选择照片。' : '照片仍在识别中，不用重复上传。');
      }
    } catch (e) {
      if (!c.signal.aborted) setNotice(signal.aborted ? '暂时没有查到最新状态，可以稍后再核对；原请求没有被取消。' : errorText(e) + '。原请求没有被取消，可以稍后再核对。');
    } finally {
      if (controller.current === c) { controller.current = null; setChecking(false); }
    }
  }
  if (!active) return null;
  if (completedMs !== null) return completedMs > GENERATION_BUDGET_MS ? <p className="privacy-note" role="status">伙伴已显示，但本次超过了8秒目标。</p> : null;
  if (!overdue) return null;
  return <div className="creation-origin" aria-label="生成等待状态">
    <div><p role="status">这次等待已超过8秒，伙伴还没完整显示。</p><p>原请求可能仍在处理，不用重复上传或生成。你可以核对进度，也可以稍后回来。</p></div>
    <div className="create-actions"><button className="button" disabled={!canQuery || checking} onClick={() => void checkSaved()}>{checking ? '正在核对…' : '核对已保存状态'}</button><Link className="text-button" href="/">先回收藏</Link>{readyId && <Link className="button" href={`/companions/${readyId}`}>查看已保存的伙伴</Link>}</div>
    {notice && <p role="status">{notice}</p>}
  </div>;
}
