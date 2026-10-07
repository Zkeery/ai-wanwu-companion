'use client';
import DesertScene from './desert-scene';
import SceneSeasonBackdrop, { SceneSeasonPreview, type SeasonalScene } from './scene-season-backdrop';
import seasonStyles from './scene-season-backdrop.module.css';
import SpaceDecorations from './space-decorations';
import SceneCompanions from './scene-companions';
import SeasonSettingsPanel from './season-settings';
import LifeSimulation from './life-simulation';
import LifeRuntimePanel from './life-runtime-panel';
import SceneActivityFeedback from './scene-activity-feedback';
import SceneLifeNow from './scene-life-now';
import SceneNavigation, { SceneSection, focusSceneSection } from './scene-navigation';
import TreeGrowthCard from './tree-growth';
import TreeOverview from './tree-overview';
import type { RuntimeView } from '@/lib/life-runtime';
import LifeJournal from './life-journal';
import { seasonPalette, type Season } from '@/lib/seasons';
import { useEffect, useRef, useState } from 'react';
import { Archive, Move, PackageOpen, RotateCcw, X } from 'lucide-react';
import { api, errorText } from '@/lib/api';
import { type Character, type LivingSpace, type LivingItem } from '@/lib/contracts';
import { RainAudio } from '@/lib/rain-audio';
import { kindMeta, sceneKinds, sceneMeta } from '@/lib/living-ui';

function requestId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

export type Props = { space: LivingSpace; companion?: Character; companions?: Character[]; readOnly?: boolean; visible?: boolean; onChange: (s: LivingSpace) => void };
type Drag = { pointerId: number; item: LivingItem; revision: number; rect: DOMRect; startX: number; startY: number; x: number; y: number; moved: boolean; valid: boolean };
const INSET_X = 52, INSET_Y = 48;
const rounded = (n: number) => Math.round(n * 100) / 100;
const validPosition = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;

export default function LivingScene(props: Props) {
  return props.space.scene_type === 'desert' ? <DesertScene key={props.space.id} {...props} /> : <SceneEditor key={props.space.id} {...props} />;
}

function SceneEditor({ space, companion, companions, readOnly = false, visible = true, onChange }: Props) {
  const present = companions ?? (companion ? [companion] : []);
  const [runtimeView, setRuntimeView] = useState<RuntimeView | null>(null);
  const [runtimeRefresh, setRuntimeRefresh] = useState(0);
  const runtimeEnabled = visible && !readOnly && space.mode === 'private' && (process.env.NEXT_PUBLIC_LIFE_RUNTIME_ENABLED === 'true' || process.env.NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW === 'true');
  const [season, setSeason] = useState<Season | null>(null);
  const palette = seasonPalette(space.scene_type, season);
  const [busy, setBusy] = useState(false), [selected, setSelected] = useState<string | null>(null), [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const locked = useRef(false);
  const active = useRef(true);
  const board = useRef<HTMLDivElement>(null);
  const plantPanel = useRef<HTMLDivElement>(null);
  const activityPanel = useRef<HTMLDivElement>(null), journalPanel = useRef<HTMLDivElement>(null), seasonPanel = useRef<HTMLDivElement>(null);
  const journalEnabled = visible && space.mode === 'private' && process.env.NEXT_PUBLIC_LIFE_JOURNAL === 'true';
  const goActivity = () => focusSceneSection(activityPanel.current);
  const backToScene = () => focusSceneSection(board.current);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [arranging, setArranging] = useState(false);
  const [preview, setPreview] = useState<Drag | null>(null);
  const [message, setMessage] = useState('');
  const audio = useRef<RainAudio | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [audioError, setAudioError] = useState('');
  const raining = space.scene_type === 'home' && !!space.atmosphere?.rain;
  const playing = soundEnabled && raining && !!space.atmosphere?.sound;
  useEffect(() => {
    const engine = new RainAudio(); audio.current = engine;
    return () => { engine.close(); audio.current = null; };
  }, []);
  useEffect(() => { audio.current?.volume(playing); }, [playing]);
  async function toggleSound() {
    if (soundEnabled) { audio.current?.volume(false); setSoundEnabled(false); return; }
    try { await audio.current?.enable(); if (active.current) { setSoundEnabled(true); setAudioError(''); } }
    catch (e) { if (active.current) setAudioError(errorText(e)); }
  }
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  function cancelDrag() { drag.current = null; setPreview(null); }

  useEffect(() => {
    const leave = () => {
      if (readOnly || !visible) {
        drag.current = null; setPreview(null); setArranging(false); setSelected(null);
      } else if (document.visibilityState === 'hidden') {
        drag.current = null; setPreview(null);
      }
    };
    leave(); document.addEventListener('visibilitychange', leave);
    return () => document.removeEventListener('visibilitychange', leave);
  }, [visible, readOnly]);

  useEffect(() => {
    function cancel() { drag.current = null; setPreview(null); }
    function escape(e: KeyboardEvent) { if (e.key === 'Escape') cancel(); }
    window.addEventListener('keydown', escape);
    window.addEventListener('resize', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  const kinds = sceneKinds[space.scene_type] ?? [];
  const placed = space.items.filter(item => !item.stored);
  const stored = space.items.filter(item => item.stored);
  const selectedItem = space.items.find(item => item.id === selected) ?? null;

  async function act(command: Record<string, unknown>) {
    if (readOnly || !visible || locked.current || uncertain || !active.current) return;
    if (['place', 'move', 'store', 'restore', 'undo'].includes(String(command.action)) && !arranging) return;
    locked.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.living.action(space.id, requestId(), space.revision, command);
      if (!active.current) return;
      onChange(result);
      if (command.action !== 'move' && command.action !== 'care') setSelected(null);
      setMessage(command.action === 'care' ? '照料已保存' : command.action === 'move' ? '位置已保存' : '布置已保存');
    }
    catch (e) {
      if (!active.current) return;
      setError(errorText(e));
      // A timeout can hide a successful write. Read before allowing another action.
      try {
        const latest = await api.living.space(space.id);
        if (active.current) { onChange(latest); setSelected(null); setUncertain(false); }
      }
      catch { if (active.current) setUncertain(true); }
    }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }

  async function refresh() {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try {
      const latest = await api.living.space(space.id);
      if (active.current) { onChange(latest); setSelected(current => latest.items.some(item => item.id === current && !item.stored) ? current : null); setUncertain(false); setError(''); setMessage('状态已更新'); }
    }
    catch (e) { if (active.current) setError(errorText(e)); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }
  const disabled = busy || uncertain || readOnly || !visible;

  function place(kind: string) {
    const points = [0.15, 0.5, 0.85].flatMap(y => [0.05, 0.5, 0.95].map(x => ({ x, y })));
    const point = points.find(({ x, y }) => placed.every(item => Math.abs(item.x - x) > 0.4 || Math.abs(item.y - y) > 0.3)) ?? points[placed.length % points.length];
    void act({ action: 'place', kind, ...point });
  }

  function move(item: LivingItem, x: number, y: number) {
    if (!validPosition(x, y)) { setError('超出布置范围，已保留原来的位置。'); return; }
    x = rounded(x); y = rounded(y);
    if (x === item.x && y === item.y) return;
    void act({ action: 'move', item_id: item.id, x, y });
  }

  function boardClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!arranging || !selectedItem || disabled || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= INSET_X * 2 || rect.height <= INSET_Y * 2) return;
    move(selectedItem, (e.clientX - rect.left - INSET_X) / (rect.width - INSET_X * 2), (e.clientY - rect.top - INSET_Y) / (rect.height - INSET_Y * 2));
  }

  function pointerDown(e: React.PointerEvent<HTMLButtonElement>, item: LivingItem) {
    suppressClick.current = false;
    if (!arranging || selected !== item.id || disabled || drag.current || e.button !== 0 || !e.isPrimary) return;
    const rect = board.current?.getBoundingClientRect();
    if (!rect || rect.width <= INSET_X * 2 || rect.height <= INSET_Y * 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, item, revision: space.revision, rect, startX: e.clientX, startY: e.clientY, x: item.x, y: item.y, moved: false, valid: true };
    // Keep any error in place until drop: removing it here moves the board
    // after its geometry was captured and would cancel the next gesture.
    setMessage('');
  }

  function updateDrag(e: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current, rect = board.current?.getBoundingClientRect();
    if (!d || d.pointerId !== e.pointerId) return null;
    if (!rect || d.revision !== space.revision || rect.width !== d.rect.width || rect.height !== d.rect.height || rect.top !== d.rect.top || rect.left !== d.rect.left) { cancelDrag(); return null; }
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    const x = d.item.x + dx / (rect.width - INSET_X * 2), y = d.item.y + dy / (rect.height - INSET_Y * 2);
    const next = { ...d, x, y, moved: d.moved || Math.hypot(dx, dy) > 6, valid: validPosition(x, y) };
    drag.current = next;
    if (next.moved) { suppressClick.current = true; setPreview(next); }
    return next;
  }

  function pointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = updateDrag(e);
    if (!d) return;
    cancelDrag();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.moved) move(d.item, d.x, d.y);
  }

  function itemLabel(item: LivingItem): string {
    const meta = kindMeta[item.kind] ?? { name: item.kind, emoji: '❔' };
    const stage = item.kind === 'tree' ? (item.stage === 'mature' ? '已长成' : item.stage === 'growing' ? '成长中' : '幼苗') : '';
    return stage ? `${meta.name}·${stage}` : meta.name;
  }

  const locateActivityItem = (id: string) => {
      if (disabled || preview || !placed.some(item => item.id === id)) return;
      cancelDrag(); setSelected(id);
      const target = Array.from(board.current?.querySelectorAll<HTMLButtonElement>('[data-living-item-id]') ?? []).find(node => node.dataset.livingItemId === id);
      target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'center' });
    };

  return <div className="living-scene">
    <div className="scene-heading">
      <div><span className="scene-emoji">{sceneMeta[space.scene_type].emoji}</span><h2>{sceneMeta[space.scene_type].name}</h2></div>
      <div className="scene-heading-actions"><button className="button ghost" disabled={busy} onClick={() => void refresh()}>刷新状态</button>{!readOnly && arranging && <button className="button ghost" disabled={disabled || !space.can_undo} onClick={() => void act({ action: 'undo' })}><RotateCcw size={16} />撤销一步</button>}</div>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {uncertain && <p>暂时无法确认场景状态，请先核对。<button className="button" disabled={busy} onClick={() => void refresh()}>核对场景</button></p>}

    {visible && space.mode === 'private' && <SceneNavigation onPlants={() => focusSceneSection(plantPanel.current)} onActivity={runtimeEnabled ? goActivity : undefined} onJournal={journalEnabled ? () => focusSceneSection(journalPanel.current) : undefined} onSeason={() => focusSceneSection(seasonPanel.current)} />}
    {!readOnly && <div className="arrange-controls">
      <button className="button" aria-pressed={arranging} disabled={disabled} onClick={() => { cancelDrag(); setSelected(null); setArranging(!arranging); setMessage(''); }}><Move size={16} />{arranging ? '完成布置' : '布置场景'}</button>
      <p id="arrange-help">{arranging ? '每次调整都会保存；完成布置后，工具就收起来。' : '看看伙伴，点物件也能照料；想换个位置时，再点「布置场景」。'}</p>
    </div>}
    {!readOnly && arranging && placed.length > 0 && <label className="arrange-picker">选择物件 · 共 {placed.length} 件，重叠时也能在这里找到
      <select aria-label="选择物件" disabled={disabled} value={placed.some(item => item.id === selected) ? selected ?? '' : ''} onChange={e => { cancelDrag(); setSelected(e.target.value || null); }}>
        <option value="">请选择，也可以直接点场景中的物件</option>
        {placed.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {itemLabel(item)}</option>)}
      </select>
    </label>}
    <div ref={board} tabIndex={-1} style={palette && !raining ? { background: palette.sky } : undefined} data-season={season ?? 'base'} className={`scene-board ${season ? seasonStyles.seasonBoard : ''} scene-${space.scene_type} ${arranging && !readOnly ? 'arranging' : ''} ${raining ? 'scene-raining' : ''}`} role="group" aria-label="场景" aria-describedby={readOnly ? undefined : 'arrange-help'} aria-busy={busy} onClick={boardClick}>
      <svg className="scene-landscape" viewBox="0 0 780 420" preserveAspectRatio="none" aria-hidden="true">
        <circle cx="650" cy="65" r="29" fill={raining ? '#edf0f7' : '#ffe9ad'} />
        <path d="M65 76c-7-28 35-40 48-17 23-12 40 10 30 22 32 20-93 23-78-5M390 48c-2-22 29-32 40-13 27-4 31 18 16 23-36 9-82 4-56-10" fill="#fffcf2" opacity=".85" />
        <path d="M0 80Q175 40 380 75T780 65V420H0Z" fill={palette?.hill ?? (space.scene_type === 'desert' ? '#f1d6a3' : space.scene_type === 'forest' ? '#8ebbaf' : '#b2d59f')} />
        <path d="M0 230Q170 150 400 210T780 170V420H0Z" fill={palette?.ground ?? (space.scene_type === 'desert' ? '#e7bc87' : space.scene_type === 'forest' ? '#76a690' : '#8fbf93')} />
        <path d="M405 77Q325 182 410 230T400 450" fill="none" stroke={space.scene_type === 'desert' ? '#fbe6be' : '#f6eacb'} strokeWidth="35" strokeLinecap="round" />
      </svg>
      <SceneSeasonBackdrop scene={space.scene_type as SeasonalScene} season={season} raining={raining} />
       {visible && present.length > 0 && <SceneCompanions key={present.map(person => person.id).sort((a, b) => a - b).join(':')} companions={present} space={space} view={runtimeView} editing={arranging || disabled || !!preview} />}
      {runtimeEnabled && <SceneLifeNow onSettings={goActivity} view={runtimeView} space={space} companions={present} editing={arranging || disabled || !!preview} onLocate={locateActivityItem} onRefresh={() => setRuntimeRefresh(n => n + 1)} onUpdated={snapshot => { setRuntimeView({ snapshot, stale: false }); setRuntimeRefresh(n => n + 1); }} />}
      {raining && <span className="scene-weather" aria-label="庭院正在下小雨">🌧️</span>}
       {placed.length === 0 && (!runtimeEnabled || arranging) && <p className="scene-empty">{readOnly ? '原住处还没有布置物件。' : arranging ? '从下面挑一件喜欢的东西吧。' : '这里还空空的，点「布置场景」添点喜欢的东西吧。'}</p>}
      {placed.map(item => {
        const moving = preview?.item.id === item.id ? preview : null;
        const x = moving?.x ?? item.x, y = moving?.y ?? item.y;
        return readOnly ? <span key={item.id} className="scene-item" style={{ left: `calc(${x * 100}% + ${INSET_X * (1 - 2 * x)}px)`, top: `calc(${y * 100}% + ${INSET_Y * (1 - 2 * y)}px)` }} title={itemLabel(item)}><span className="item-emoji">{kindMeta[item.kind]?.emoji ?? '❔'}</span><span className="item-name">{itemLabel(item)}</span></span> : <button key={item.id} type="button" data-living-item-id={item.id} disabled={disabled} className={`scene-item ${selected === item.id ? 'selected' : ''} ${moving ? moving.valid ? 'drag-valid' : 'drag-invalid' : ''}`} style={{ left: `calc(${x * 100}% + ${INSET_X * (1 - 2 * x)}px)`, top: `calc(${y * 100}% + ${INSET_Y * (1 - 2 * y)}px)`, touchAction: arranging && selected === item.id ? 'none' : 'pan-y' }} aria-pressed={selected === item.id} onPointerDown={e => pointerDown(e, item)} onPointerMove={updateDrag} onPointerUp={pointerUp} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onClick={e => {
          e.stopPropagation();
          if (suppressClick.current) { suppressClick.current = false; return; }
          setSelected(selected === item.id ? null : item.id);
        }} title={itemLabel(item)}><span className="item-emoji">{kindMeta[item.kind]?.emoji ?? '❔'}</span><span className="item-name">{itemLabel(item)}</span>{item.kind === 'tree' && item.growth_status === 'needs_care' && <span className="item-care" aria-label="需要照料">💧</span>}</button>;
      })}
    </div>

    {runtimeEnabled && <SceneActivityFeedback view={runtimeView} space={space} companions={present} locatingDisabled={disabled || !!preview} onLocate={locateActivityItem} />}

    {!readOnly && <p className="placement-status" role="status">{busy ? '正在保存布置…' : preview ? preview.valid ? '松手保存位置' : '超出布置范围，松手回到原位' : message}</p>}
    {!readOnly && selectedItem && <div className="item-actions" role="toolbar" aria-label="物件操作">
      <span className="item-actions-title">{itemLabel(selectedItem)}</span>
      {arranging && !selectedItem.stored && <div className="move-buttons" role="group" aria-label="移动物件">
        {([{ name: '向左移动', dx: -0.05, dy: 0, icon: '←' }, { name: '向上移动', dx: 0, dy: -0.05, icon: '↑' }, { name: '向下移动', dx: 0, dy: 0.05, icon: '↓' }, { name: '向右移动', dx: 0.05, dy: 0, icon: '→' }]).map(({ name, dx, dy, icon }) => <button key={name} className="button ghost" aria-label={name} disabled={disabled || !validPosition(rounded(selectedItem.x + dx), rounded(selectedItem.y + dy))} onClick={() => move(selectedItem, rounded(selectedItem.x + dx), rounded(selectedItem.y + dy))}>{icon}</button>)}
      </div>}
      {arranging && <button className="button" disabled={disabled} onClick={() => void act({ action: 'store', item_id: selectedItem.id })}><Archive size={16} />收纳</button>}
      <button className="button ghost" disabled={busy} onClick={() => setSelected(null)}><X size={16} />收起</button>
    </div>}
    {!readOnly && visible && selectedItem && <TreeGrowthCard item={selectedItem} observedAt={space.observed_at} disabled={disabled} refreshing={busy} onCare={() => void act({ action: 'care', item_id: selectedItem.id })} onRefresh={() => void refresh()} />}

    {stored.length > 0 && <div className="storage-area" aria-label="收纳区">
      <h3><PackageOpen size={16} />收纳区</h3>
        <div className="storage-row">{stored.map(item => <div className="stored-item" key={item.id} style={{ flexWrap: 'wrap', maxWidth: '100%' }}><span className="item-emoji">{kindMeta[item.kind]?.emoji ?? '❔'}</span><span>{kindMeta[item.kind]?.name ?? item.kind}</span>{item.kind === 'tree' && <details style={{ flexBasis: '100%', minWidth: 0 }}><summary>{item.stage === 'mature' ? '已长成 · 已收纳' : '已收纳 · 暂停成长'}</summary><TreeGrowthCard item={item} observedAt={space.observed_at} /></details>}{!readOnly && arranging && <button className="text-button" disabled={disabled} onClick={() => void act({ action: 'restore', item_id: item.id, x: 0.5, y: 0.5 })}>摆出</button>}</div>)}</div>
    </div>}

    {space.scene_type === 'home' && !readOnly && <div className="atmosphere-panel" aria-label="庭院氛围">
      <h3>让小天地更舒服</h3>
      <div className="tool-row">
        <button className="tool-chip" disabled={disabled} onClick={() => void act({ action: 'atmosphere', weather: 'rain' })}>🌧️ 下点小雨</button>
        <button className="tool-chip" disabled={disabled} onClick={() => void act({ action: 'atmosphere', weather: 'clear' })}>☀️ 放晴</button>
        <button className="tool-chip" disabled={disabled} onClick={() => void act({ action: 'atmosphere', weather: 'quiet' })}>安静一会</button>
        <button className="text-button" onClick={() => void toggleSound()}>{playing ? '关闭雨声' : soundEnabled ? '声音已开启 · 当前安静' : '开启声音'}</button>
      </div>
      {audioError && <p role="alert" className="error-text">{audioError}</p>}
    </div>}
    {!readOnly && arranging && <div className="tool-panel" aria-label="场景工具">
      <h3>放点什么</h3>
      <div className="tool-row">{kinds.map(kind => <button key={kind} className="tool-chip" disabled={disabled} onClick={() => place(kind)}><span className="item-emoji">{kindMeta[kind]?.emoji ?? '❔'}</span>{kindMeta[kind]?.name ?? kind}</button>)}</div>
      <p className="tool-hint"><Move size={13} />物件会记住自己的位置，下次回来还能接着布置。</p>
    </div>}
    {visible && space.mode === 'private' && <SceneSection sectionRef={plantPanel} title="植物照料" onBack={backToScene}><TreeOverview key={space.id} space={space} onLocate={readOnly ? undefined : locateActivityItem} onRefresh={() => void refresh()} busy={busy} locatingDisabled={disabled || !!preview} /></SceneSection>}
    {journalEnabled && <SceneSection sectionRef={journalPanel} title="生活记录" onBack={backToScene}><LifeJournal key={`journal-${space.id}`} spaceId={space.id} revision={space.revision} visible={visible} companionId={Number(space.companion_id)} sceneType={space.scene_type} items={space.items} onLocate={readOnly ? undefined : locateActivityItem} locatingDisabled={disabled || !!preview} /></SceneSection>}
    {runtimeEnabled && <SceneSection sectionRef={activityPanel} title="活动设置" onBack={backToScene}><LifeRuntimePanel key={`runtime-${space.id}`} spaceId={space.id} onSnapshot={setRuntimeView} refreshVersion={runtimeRefresh} historyScene={{ space, companions: present, onLocate: locateActivityItem, locatingDisabled: disabled || !!preview }} /></SceneSection>}
    {space.mode === 'private' && <SceneSection sectionRef={seasonPanel} title="四季" onBack={backToScene}><SeasonSettingsPanel spaceId={space.id} onSeason={setSeason} readOnly={readOnly} renderPreview={current => <SceneSeasonPreview scene={space.scene_type as SeasonalScene} season={current} />} /></SceneSection>}
    <SpaceDecorations spaceId={space.id} kind="private" />
    {space.mode === 'private' && !readOnly && process.env.NEXT_PUBLIC_LIFE_SIMULATION === 'true' && <LifeSimulation key={space.id} spaceId={space.id} />}
  </div>;
}
