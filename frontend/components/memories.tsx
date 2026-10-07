'use client';
import { useEffect, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { api, errorText } from '@/lib/api';
import type { Memory } from '@/lib/contracts';
import { inspectText } from '@/lib/input-limits';
import { Loading, Modal, Notice } from './common';

export default function Memories({ id, close }: { id: number; close: () => void }) {
  const [items, setItems] = useState<Memory[] | null>(null), [error, setError] = useState(''), [draft, setDraft] = useState(''), [editing, setEditing] = useState<number | null>(null), [deleting, setDeleting] = useState<number | null>(null), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0), [uncertain, setUncertain] = useState(false);
  const lock = useRef(false), composing = useRef(false);
  const input = inspectText(draft, 'memory');
  useEffect(() => {
    const controller = new AbortController();
    api.memories(id, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setItems(result); setUncertain(false); setError('');
    }).catch(e => { if (!controller.signal.aborted) { setError(errorText(e)); setUncertain(true); } });
    return () => controller.abort();
  }, [id, revision]);
  const disabled = busy || items === null || uncertain;
  async function mutate(action: () => Promise<unknown>) {
    if (lock.current || items === null || uncertain) return;
    lock.current = true; setBusy(true); setError('');
    let committed = false;
    try {
      await action(); committed = true;
      setDraft(''); setEditing(null); setDeleting(null);
      setItems(await api.memories(id));
    } catch (e) {
      setUncertain(true);
      setError(committed ? '操作已完成，但列表暂时未能刷新。请重新加载核对，勿重复提交。' : `${errorText(e)}。结果尚未确认，请重新加载核对后再决定是否提交。`);
    } finally { lock.current = false; setBusy(false); }
  }
  function reload() { if (lock.current) return; setUncertain(true); setError(''); setRevision(n => n + 1); }
  return <Modal title="想让伙伴记住的事" close={() => { if (!busy) close(); }}><p className="muted">由你手动保存，伙伴会在之后的聊天中参考。你随时可以修改或删除。</p>{error && <Notice retry={reload}>{error}</Notice>}{items === null && !error ? <Loading /> : <div className="memory-list">{items?.length === 0 && <p className="empty-small">还没有记忆，把一件小事留在这里吧。</p>}{items?.map(item => <div key={item.id} className="memory-item"><p>{item.content}</p>{deleting === item.id ? <div className="row"><span>确定删除这条记忆？</span><button disabled={disabled} className="danger" onClick={() => mutate(() => api.deleteMemory(item.id))}>确认删除</button><button disabled={disabled} onClick={() => setDeleting(null)}>取消</button></div> : <div className="row"><button disabled={disabled} onClick={() => { setEditing(item.id); setDraft(item.content); }} aria-label={`编辑记忆：${item.content}`}><Pencil size={14} />编辑</button><button disabled={disabled} onClick={() => setDeleting(item.id)} aria-label={`删除记忆：${item.content}`}><Trash2 size={14} />删除</button></div>}</div>)}</div>}
    <form onSubmit={e => { e.preventDefault(); const checked = inspectText(draft, 'memory'); if (checked.valid && !composing.current) void mutate(() => editing === null ? api.addMemory(id, checked.text) : api.editMemory(editing, checked.text)); }}><label htmlFor="memory-draft">{editing === null ? '留下一条记忆' : '修改这条记忆'}</label><textarea id="memory-draft" value={draft} aria-describedby="memory-input-hint" aria-invalid={!!input.issue} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} disabled={disabled} onChange={e => setDraft(e.target.value)} placeholder="比如：我最喜欢雨后的泥土气味。" rows={3} /><div id="memory-input-hint" className={`field-hint input-limit-hint ${input.issue ? 'error-text' : ''}`}><span>{input.issue || `最多 ${input.limit} 字`}</span><span>{input.count}/{input.limit}</span></div><div className="row end">{editing !== null && <button type="button" disabled={disabled} onClick={() => { setEditing(null); setDraft(''); }}>取消编辑</button>}<button className="primary" disabled={disabled || !input.valid}>{busy ? '正在保存…' : '保存记忆'}</button></div></form></Modal>;
}
