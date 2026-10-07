'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, errorText } from '@/lib/api';
import { recreateCompanion, recreationKey, saveRecreationKey } from '@/lib/recreation';
import { Modal } from './common';

export default function RecreateCompanion({ id }: { id: number }) {
  const router = useRouter();
  const [credits, setCredits] = useState<Awaited<ReturnType<typeof api.generationCredits>> | null>(null);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null), [ready, setReady] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const locked = useRef(false), mounted = useRef(false), abort = useRef<AbortController | null>(null);
  const recover = useCallback(async () => {
    const key = recreationKey(id);
    if (mounted.current) setPending(key);
    if (key) {
      const result = await api.recreation(key);
      if (!mounted.current) return;
      if (result.status === 'ready' && result.character) {
        saveRecreationKey(id, null); setPending(null); setReady(result.character.id); setNotice('新的伙伴已经准备好了。');
      } else if (result.status === 'failed' || result.status === 'deleted') {
        saveRecreationKey(id, null); setPending(null);
        setNotice(result.status === 'failed' ? '这次生成没有完成，预留额度已返还。原伙伴仍在。' : '这次创作的伙伴已被删除。');
      } else setNotice('新的伙伴还在准备中，请稍后核对结果。');
    }
    const latest = await api.generationCredits();
    if (mounted.current) setCredits(latest);
  }, [id]);
  useEffect(() => {
    mounted.current = true;
    Promise.resolve().then(recover).catch(e => { if (mounted.current) setNotice(errorText(e)); });
    return () => { mounted.current = false; abort.current?.abort(); };
  }, [recover]);
  async function check() {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try { await recover(); } catch (e) { if (mounted.current) setNotice(errorText(e)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  async function start() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setConfirm(false); setReady(null);
    const controller = new AbortController(); abort.current = controller;
    try {
      const key = recreationKey(id) ?? crypto.randomUUID();
      saveRecreationKey(id, key); setPending(key); setNotice('正在构思一个新的伙伴…');
      const result = await recreateCompanion(id, key, controller.signal, text => { if (mounted.current) setNotice(text); });
      if (!mounted.current) return;
      saveRecreationKey(id, null); setPending(null);
      router.push(`/companions/${result.id}`);
    } catch (e) {
      if (mounted.current) {
        if (e instanceof ApiError && ['credits_exhausted', 'not_ready', 'invalid_request'].includes(e.code)) {
          saveRecreationKey(id, null); setPending(null);
        }
        setNotice(`${errorText(e)}。原伙伴会保留，请先核对结果。`);
        try { await recover(); } catch { /* Retain the receipt for a later explicit check. */ }
      }
    } finally { locked.current = false; abort.current = null; if (mounted.current) setBusy(false); }
  }
  if (credits && !credits.enabled && !pending && !ready) return null;
  if (!credits && !notice) return null;
  return <section className="recreation-panel" aria-label="伙伴再创作">
    <div className="row"><button disabled={busy || !!pending || !credits?.enabled || credits.available === 0} onClick={() => setConfirm(true)}>再创造一个</button>{credits?.enabled && <small>剩余 {credits.available} 次</small>}</div>
    {notice && <p role="status">{notice}</p>}
    {ready && <Link href={`/companions/${ready}`}>去认识新的伙伴 →</Link>}
    {pending && <div className="row"><button disabled={busy} onClick={() => void check()}>核对再创作结果</button><button disabled={busy} onClick={() => void start()}>继续这次创作</button></div>}
    {!pending && !credits && <button disabled={busy} onClick={() => void check()}>重新核对额度</button>}
    {confirm && <Modal title="再创造一个伙伴？" close={() => setConfirm(false)}><p>这次会消耗 1 次生成额度，重新构思名字、性格和形象。现在的伙伴及聊天、记忆和生活场景都会保留。</p><p>技术失败会返还额度；成功后因不满意再次创作仍会消耗 1 次。</p><div className="row end"><button onClick={() => setConfirm(false)}>再想想</button><button className="primary" onClick={() => void start()}>确认创作 · 消耗 1 次</button></div></Modal>}
  </section>;
}
