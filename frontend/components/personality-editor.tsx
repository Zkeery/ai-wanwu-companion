'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText } from '@/lib/api';
import { normalizeDraft, originalDraft, personalityApi, personalityDraft, personalityIssue, personalityPreview, sameDraft, type Personality, type PersonalityCatalog, type PersonalityDraft, type PersonalityEdit } from '@/lib/personality';
import { Modal } from './common';

export default function PersonalityEditor({ id, onSaved, close }: { id: number; onSaved: (persona: string) => void; close: () => void }) {
  const [base, setBase] = useState<Personality | null>(null), [catalog, setCatalog] = useState<PersonalityCatalog | null>(null);
  const [draft, setDraft] = useState<PersonalityDraft>(originalDraft), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [review, setReview] = useState<Personality | null>(null), [attempt, setAttempt] = useState(0);
  const pending = useRef<PersonalityEdit | null>(null), lock = useRef(false), mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    Promise.all([personalityApi.read(id, controller.signal), personalityApi.catalog(controller.signal)])
      .then(([p, c]) => { if (!controller.signal.aborted) { setBase(p); setDraft(personalityDraft(p)); setCatalog(c); setError(''); } })
      .catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => { mounted.current = false; controller.abort(); };
  }, [id, attempt]);
  function change(next: PersonalityDraft) { setDraft(normalizeDraft(next)); setNotice(''); setError(''); }
  function accept(p: Personality) { setBase(p); setDraft(personalityDraft(p)); setUncertain(false); setReview(null); pending.current = null; setError(''); setNotice('性格已保存。之后的交流会采用新性格，形象保持不变。'); onSaved(p.effective_persona); }
  async function save() {
    if (!base || !catalog || lock.current || uncertain || personalityIssue(draft, catalog) || sameDraft(draft, base)) return;
    const edit = { ...normalizeDraft(draft), expected_revision: base.revision };
    pending.current = edit; lock.current = true; setBusy(true); setError(''); setNotice('');
    try { const p = await personalityApi.save(id, edit); if (mounted.current) accept(p); }
    catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error && e.name === 'TimeoutError' ? '保存结果暂未确认，请核对后再继续。' : errorText(e));
      if (!(e instanceof ApiError) || e.status >= 500 || e.code === 'personality_conflict') setUncertain(true);
      else pending.current = null;
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function verify() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const p = await personalityApi.read(id);
      if (!mounted.current) return;
      if (pending.current && p.revision > pending.current.expected_revision && sameDraft(p, pending.current)) accept(p);
      else { setReview(p); setNotice('已核对服务器状态，请选择采用哪一份。你的草稿还在。'); }
    } catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function resolve(useServer: boolean) {
    if (!review) return;
    setBase(review); if (useServer) setDraft(personalityDraft(review));
    onSaved(review.effective_persona); setReview(null); setUncertain(false); pending.current = null; setError('');
    setNotice(useServer ? '已载入服务器保存的性格。' : '已保留你的草稿，再次点击保存后才会生效。');
  }
  const issue = catalog ? personalityIssue(draft, catalog) : '';
  const disabled = busy || uncertain;
  const unchanged = !!base && sameDraft(draft, base);
  const savedState = unchanged && !disabled && !error;
  const saveLabel = busy ? (uncertain ? '核对中…' : '保存中…') : uncertain ? '待核对' : savedState ? '已保存' : '保存性格';
  return <Modal title="伙伴的性格" close={() => { if (!lock.current) close(); }}><div className="personality-editor">
    <p>最初的性格由 AI 生成。你可以慢慢调整，让相处更合拍。</p>
    {error && (!base || !catalog) && <p role="alert" className="notice">{error}</p>}
    {!base || !catalog ? <div>{error ? <button onClick={() => setAttempt(v => v + 1)}>重新加载性格</button> : <p role="status">正在读取性格…</p>}</div> : <>
      <details className="personality-original"><summary>最初的 AI 性格</summary><p>{base.original_persona}</p></details>
      <fieldset disabled={disabled}>
        <label htmlFor="personality-select">添加性格 <small>可多选，3–5 个只是建议</small></label>
        <select id="personality-select" value="" onChange={e => {
          const id = e.target.value; if (!id) return;
          if (draft.tags.includes(id)) { setNotice('这个性格已经选过啦。'); return; }
          const next = normalizeDraft({ ...draft, mode: 'custom', tags: [...draft.tags, id] });
          change(next); if (next.tags.length < draft.tags.length + 1) setNotice('「安静内敛」和「内向安静」已合并为同一项。');
        }}><option value="">从这些性格里挑一挑</option>{[...new Set(catalog.options.map(o => o.group))].map(group => <optgroup key={group} label={group}>{catalog.options.filter(o => o.group === group).map(o => <option value={o.id} key={o.id}>{o.label}</option>)}</optgroup>)}</select>
        <div className="personality-tags" aria-label="已选性格">{draft.tags.map(id => <button type="button" key={id} aria-label={`移除${catalog.options.find(o => o.id === id)?.label}`} onClick={() => change({ ...draft, mode: 'custom', tags: draft.tags.filter(t => t !== id) })}>{catalog.options.find(o => o.id === id)?.label}<span aria-hidden="true"> ×</span></button>)}</div>
        <label htmlFor="personality-custom">也可以自己描述</label>
        <textarea id="personality-custom" value={draft.custom_text} rows={3} placeholder="例如：慢热但很护短，熟悉后很爱开玩笑" aria-describedby="personality-limit personality-issue" onChange={e => change({ ...draft, mode: 'custom', custom_text: e.target.value })} />
        <p id="personality-limit" className="field-hint">最多 {catalog.max_custom_length} 字；文字会按原样保存<span>{Array.from(draft.custom_text).length}/{catalog.max_custom_length}</span></p>
        {draft.tags.length > 0 && draft.custom_text.trim() && <label>两种描述不一致时，以哪一种为主？<select aria-label="性格主次" value={draft.priority ?? ''} onChange={e => change({ ...draft, priority: e.target.value === 'custom' ? 'custom' : e.target.value === 'presets' ? 'presets' : null })}><option value="">请选择主次</option><option value="presets">预设为主</option><option value="custom">自定义为主</option></select></label>}
        <button type="button" className="text-button" onClick={() => change(originalDraft())}>恢复最初性格（保存后生效）</button>
      </fieldset>
      <div className="personality-preview"><h3>保存后的性格预览</h3><p>{issue && draft.priority === null && draft.tags.length > 0 && draft.custom_text.trim() ? '选好主次后，就能预览完整性格。' : personalityPreview(draft, catalog, base.original_persona) || '还没有选择性格。'}</p></div>
      {uncertain && <div className="personality-review"><p>保存结果需要先核对，避免覆盖其他页面的修改。</p><button disabled={busy} onClick={() => void verify()}>{busy ? '正在核对…' : '核对保存结果'}</button>{review && <><h3>服务器当前保存的性格</h3><p>{review.effective_persona}</p><div className="row"><button disabled={busy} onClick={() => resolve(true)}>使用服务器版本</button><button disabled={busy} onClick={() => resolve(false)}>保留我的草稿，继续编辑</button></div></>}</div>}
      <div className="personality-footer">
        <p id="personality-issue" role={issue ? 'alert' : undefined} className="error-text">{issue}</p>
        {error && <p role="alert" className="notice">{error}</p>}
        {notice && <p role="status" className="personality-status">{notice}</p>}
        <div className="row personality-actions"><button className={`primary${savedState ? ' personality-saved' : ''}`} aria-busy={busy} disabled={disabled || !!issue || unchanged} onClick={() => void save()}>{saveLabel}</button><button disabled={busy} onClick={close}>{savedState ? '完成' : '取消'}</button></div>
        <p className="field-hint">{savedState ? '当前性格已保存；修改后可再次保存。' : '只调整之后的交流，不重画形象、不扣生成额度。'}</p>
      </div>
    </>}
  </div></Modal>;
}
