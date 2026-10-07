'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ArrowUpRight, Home, Users } from 'lucide-react';
import { api, errorText } from '@/lib/api';
import { type Character, type SpaceSummary, type SceneType } from '@/lib/contracts';
import { sceneMeta } from '@/lib/living-ui';
import { Brand, Loading, Notice } from '@/components/common';

const SCENES: SceneType[] = ['home', 'desert', 'forest'];

export default function ScenePicker() {
  const params = useParams();
  const characterId = Number(params.id);
  if (!Number.isInteger(characterId) || characterId < 1) return <Notice>找不到这个伙伴。</Notice>;
  return <ResidencePicker key={characterId} characterId={characterId} />;
}

function ResidencePicker({ characterId }: { characterId: number }) {
  const router = useRouter();
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(null);
  const [companions, setCompanions] = useState<Character[]>([]);
  const [location, setLocation] = useState<string | null>(null);
  const [gathering, setGathering] = useState<{ id: string; title: string } | null>(null);
  const [mode, setMode] = useState<'private' | 'shared'>('private');
  const [chosen, setChosen] = useState<Partial<Record<SceneType, string>>>({});
  const [invitees, setInvitees] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [notice, setNotice] = useState(''), [uncertain, setUncertain] = useState(false);
  const [revision, setRevision] = useState(0);
  const locked = useRef(false), generation = useRef(0);

  const readState = useCallback(async (run: number, initial = false) => {
    const [s, loc, chars, overviews] = await Promise.all([api.living.spaces(), api.living.location(characterId), api.characters(), api.characterOverview()]);
    if (run !== generation.current) return;
    setSpaces(s); setLocation(loc); setCompanions(chars.filter(c => c.status === 'ready'));
    setGathering(overviews.find(item => item.character.id === characterId)?.gathering ?? null);
    setUncertain(false);
    if (initial) setMode(s.find(space => space.id === loc)?.mode ?? 'private');
  }, [characterId]);

  useEffect(() => {
    const run = ++generation.current;
    void readState(run, true).catch(e => { if (run === generation.current) setError(errorText(e)); });
    return () => { generation.current = run + 1; };
  }, [characterId, revision, readState]);

  function privateSpace(type: SceneType) {
    return spaces?.find(s => s.scene_type === type && s.mode === 'private' && s.companion_id === String(characterId));
  }
  function sharedSpace(type: SceneType) {
    const options = spaces?.filter(s => s.scene_type === type && s.mode === 'shared') ?? [];
    return options.find(s => s.id === chosen[type]) ?? options.find(s => s.id === location) ?? options[0];
  }

  async function write(operation: (isActive: () => boolean) => Promise<string | void>) {
    if (locked.current || uncertain) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    const run = generation.current, isActive = () => run === generation.current;
    try {
      const message = await operation(isActive);
      if (!isActive()) return;
      await readState(run);
      if (isActive() && message) setNotice(message);
    } catch (e) {
      if (!isActive()) return;
      setError(`${errorText(e)}。请以核对后的居住状态为准；未自动重试操作。`);
      try { await readState(run); }
      catch { if (isActive()) setUncertain(true); }
    } finally { if (isActive()) { locked.current = false; setBusy(false); } }
  }

  async function verify() {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    const run = generation.current;
    try { await readState(run); if (run === generation.current) { setError(''); setNotice('居住状态已核对，可以继续。'); } }
    catch (e) { if (run === generation.current) setError(errorText(e)); }
    finally { if (run === generation.current) { locked.current = false; setBusy(false); } }
  }

  function enter(type: SceneType, target?: SpaceSummary) {
    void write(async active => {
      const space = target ?? privateSpace(type) ?? await api.living.create(type, 'private', characterId);
      if (!active()) return;
      if (space.mode === 'shared' && !(target?.members ?? []).some(m => m.companion_id === String(characterId))) {
        await api.living.addMember(space.id, characterId);
        if (!active()) return;
      }
      await api.living.setLocation(characterId, space.id);
      if (active()) router.push(`/companions/${characterId}/scenes/${type}/${encodeURIComponent(space.id)}`);
    });
  }

  const disabled = busy || uncertain;
  return <div className="shell toy-shell">
    <header className="site-header"><Brand /><Link className="back-link" href={`/companions/${characterId}`}><ArrowLeft size={16} />返回伙伴</Link></header>
    <main className="collection scene-picker">
      <div className="section-heading"><div><span className="section-kicker">WHERE TO LIVE</span><h2>你们想在哪里生活？</h2></div><span className="collection-subtitle">每个场景都保留自己的样子。</span></div>
      {spaces === null ? error ? <Notice retry={() => { setError(''); setRevision(n => n + 1); }}>{error}</Notice> : <Loading /> : <>
        <div className="residence-choice"><fieldset disabled={disabled}><legend>选择你喜欢的生活方式</legend>
          <div className="residence-options">
          <label><input type="radio" name="residence-mode" value="private" checked={mode === 'private'} onChange={() => setMode('private')} /><Home size={18} />独自生活</label>
          <label><input type="radio" name="residence-mode" value="shared" checked={mode === 'shared'} onChange={() => setMode('shared')} /><Users size={18} />和我的其他伙伴同住</label>
          </div>
        </fieldset></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="residence-notice" role="status">{notice}</p>}
        {gathering && <p className="residence-notice" role="status">伙伴正在“{gathering.title}”相聚。可以查看已保存的原住处；想搬家或加入同住，请先<Link href={`/gatherings?space=${encodeURIComponent(gathering.id)}`}>去共同空间召回伙伴</Link>。</p>}
        {uncertain && <p className="residence-notice">暂时无法确认是否保存，请先核对。<button className="button" disabled={busy} onClick={() => void verify()}>核对居住状态</button></p>}
        {mode === 'shared' && <p className="residence-help">一起生活，共用这一处的植物和布置。只邀请你自己的伙伴，彼此的聊天和记忆仍分别保存。</p>}
        <div className="scene-cards">{SCENES.map(type => {
          const meta = sceneMeta[type], personal = privateSpace(type), shared = sharedSpace(type);
          const options = spaces.filter(s => s.scene_type === type && s.mode === 'shared');
          const target = mode === 'private' ? personal : shared;
          const current = target?.id === location;
          const available = companions.filter(c => !(shared?.members ?? []).some(m => m.companion_id === String(c.id)));
          const invitee = available.find(c => String(c.id) === invitees[shared?.id ?? '']) ?? available[0];
          return <article className={`scene-card${current ? ' current' : ''}`} key={type} aria-label={meta.name}>
            <span className="scene-card-emoji">{meta.emoji}</span>
            <div className="scene-card-info"><h3>{meta.name}{current && <span className="current-tag">当前所在</span>}{personal && mode === 'private' && !current && <span className="visited-tag">已去过</span>}</h3><p>{meta.desc}</p></div>
            {mode === 'private' ? <button className="button primary" disabled={disabled || (!!gathering && !personal)} onClick={() => gathering && personal ? router.push(`/companions/${characterId}/scenes/${type}/${encodeURIComponent(personal.id)}`) : enter(type)}><Home size={16} />{gathering ? personal ? '查看已保存的住处' : '召回后再搬进来' : personal ? '进去看看' : '搬进来'}<ArrowUpRight size={15} /></button> : <div className="shared-residence">
              {shared ? <>
                <label htmlFor={`shared-${type}`}>选择同住空间</label>
                <select id={`shared-${type}`} value={shared.id} disabled={disabled} onChange={e => setChosen(c => ({ ...c, [type]: e.target.value }))}>{options.map((s, i) => <option key={s.id} value={s.id}>{meta.name} · 同住空间 {i + 1}{s.id === location ? '（当前所在）' : ''}</option>)}</select>
                <ul className="residence-members" aria-label={`${meta.name}同住成员`}>{(shared.members ?? []).map(m => <li key={m.companion_id}><span>{m.name ?? '未命名伙伴'} <small>#{m.companion_id}{m.companion_id === String(characterId) ? ' · 当前伙伴' : ''}</small></span><button className="text-button" disabled={disabled} aria-label={`移出${m.name ?? '未命名伙伴'} #${m.companion_id}`} onClick={() => void write(async () => { await api.living.removeMember(shared.id, Number(m.companion_id)); return '已移出同住成员；伙伴和所有布置都保留。若原本住在这里，可重新选择去处。'; })}>移出</button></li>)}</ul>
                {!shared.members?.length && <p className="residence-help">这里暂时没有伙伴，布置会一直为你保留。</p>}
                 {invitee ? <div className="residence-invite"><label htmlFor={`invite-${type}`}>邀请我的伙伴</label><select id={`invite-${type}`} value={String(invitee.id)} disabled={disabled || !!gathering} onChange={e => setInvitees(c => ({ ...c, [shared.id]: e.target.value }))}>{available.map(c => <option key={c.id} value={c.id}>{c.name} · #{c.id}</option>)}</select><button className="button" disabled={disabled || !!gathering} onClick={() => void write(async () => { await api.living.addMember(shared.id, invitee.id); return '已加入同住成员。加入不会自动搬家，可以从这个伙伴的页面进入。'; })}>加入成员</button></div> : <p className="residence-help">你已生成的伙伴都已加入这个空间。</p>}
                 <button className="button primary" disabled={disabled || !!gathering} onClick={() => enter(type, shared)}><Users size={16} />{gathering ? '召回后再搬进来' : current ? '进去看看' : '搬进这个同住空间'}<ArrowUpRight size={15} /></button>
              </> : <p className="residence-help">还没有同住空间，一起布置一个温暖的小家吧。</p>}
               <button className="button ghost" disabled={disabled} onClick={() => void write(async active => { const created = await api.living.create(type, 'shared'); if (active()) setChosen(c => ({ ...c, [type]: created.id })); return '同住空间已准备好，添加伙伴后可以搬进来。'; })}>{shared ? '再建一个同住空间' : '创建同住空间'}</button>
            </div>}
          </article>;
        })}</div>
      </>}
      <p className="collection-footnote"><span>搬家会保留原来的布置；独居与同住分别保存，不会互相覆盖。</span></p>
    </main>
    <footer><strong>万物有趣，陪伴有形。</strong><span>MADE FOR YOUR EVERYDAY MAGIC ✳</span></footer>
  </div>;
}
