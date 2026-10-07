'use client';
import { useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { Character } from '@/lib/contracts';
import { Modal } from './common';

export default function RenameCompanion({ character, onChange, close }: { character: Character; onChange: (c: Character) => void; close: () => void }) {
  const [name, setName] = useState(character.name), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const locked = useRef(false);
  const count = Array.from(name.trim()).length;
  async function save(check = false) {
    if (locked.current || (!check && (!count || count > 40))) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const result = check ? await api.character(character.id) : await api.renameCharacter(character.id, name.trim());
      onChange(result); setUncertain(false);
      if (!check || result.name === name.trim()) close();
      else setError(`当前保存的名字是「${result.name}」，你可以继续保存输入的新名字。`);
    } catch (e) { setError(errorText(e)); setUncertain(true); }
    finally { locked.current = false; setBusy(false); }
  }
  return <Modal title="给伙伴换个名字" close={() => { if (!busy) close(); }}>
    <form onSubmit={e => { e.preventDefault(); if (!uncertain) void save(); }}>
      <label className="field">伙伴名字<input autoFocus value={name} disabled={busy} onChange={e => setName(e.target.value)} aria-describedby="rename-hint" aria-invalid={count > 40} /></label>
      <p id="rename-hint" className="field-hint">1–40 字 · 改名不消耗生成额度<span>{count}/40</span></p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="row end"><button type="button" disabled={busy} onClick={close}>取消</button>{uncertain ? <button type="button" disabled={busy} onClick={() => void save(true)}>核对名字</button> : <button className="primary" disabled={busy || !count || count > 40 || name.trim() === character.name}>{busy ? '正在保存…' : '保存名字'}</button>}</div>
    </form>
  </Modal>;
}
