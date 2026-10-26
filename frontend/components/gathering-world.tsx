'use client';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { companionPosition, gatheringCompanionArea, itemNames, type Gathering, type GatheringArea } from '@/lib/gatherings';
import { seasonNames, type Season } from '@/lib/seasons';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { loadGatheringMotion } from '@/lib/private-motion';
import type { Activity } from '@/lib/life-simulation';
import type { HomeWorldView } from '@/lib/living-home-world';
import type { LivingLeisureRequest } from '@/lib/living-persistent-world';
import { redactSharedMahjongSnapshot } from '@/lib/shared-mahjong';
import type { GatheringCompanionPresence } from '@/lib/gathering-presence';
import { useSharedMahjong } from '@/lib/use-shared-mahjong';
import SharedMahjongPanel from './shared-mahjong-panel';
import OasisBackdrop from './oasis-backdrop';
import SceneSeasonBackdrop from './scene-season-backdrop';
import GatheringRoomBackdrop from './gathering-room-backdrop';
import PrivateImage from './private-image';
import MotionPlayer from './motion-player';
import dynamic from 'next/dynamic';
const SharedLivingWorld3D = dynamic(() => import('./shared-living-world-3d'), { ssr: false, loading: () => <p role="status">正在打开共同住处…</p> });

const activityNames: Record<string, string> = { arriving: '刚刚到达', rest: '休息', sleep: '睡觉', walk: '散步', observe: '观察', talk: '交流' };
const itemSymbols: Record<string, string> = { tree: '🌳', bench: '🪑', shade: '⛱️', cushion: '🪵', flower: '🌷' };

type Props = { gathering: Gathering; focusedId: number | null; onSelect: (id: number) => void; suspended?: boolean; busy?: boolean;
  onFloorOccupancyChange?: (ids: readonly number[]) => void;
  onCompanionPresenceChange?: (values: readonly GatheringCompanionPresence[]) => void;
  onActivity?: (id: number, activity: 'rest' | 'sleep' | 'walk' | 'observe' | 'talk') => Promise<void> | void;
  onLeisureAction?: (request: LivingLeisureRequest) => Promise<void> | void };
const subscribe = (change: () => void) => {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  window.addEventListener(AUTH_CHANGED, change); window.addEventListener('storage', change);
  document.addEventListener('visibilitychange', change); media?.addEventListener('change', change);
  return () => {
    window.removeEventListener(AUTH_CHANGED, change); window.removeEventListener('storage', change);
    document.removeEventListener('visibilitychange', change); media?.removeEventListener('change', change);
  };
};
const canAnimate = () => !document.hidden && !!window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const no = () => false;

export default function GatheringWorld(props: Props) {
  const token = useSyncExternalStore(subscribe, getToken, () => null);
  const visible = useSyncExternalStore(subscribe, canAnimate, no);
  return <World key={JSON.stringify([props.gathering.id, token])}
    {...props} token={token} visible={visible} />;
}

function World({ gathering: all, focusedId, onSelect, suspended, busy, onActivity, onLeisureAction, onFloorOccupancyChange, onCompanionPresenceChange, token, visible }: Props & { token: string | null; visible: boolean }) {
  const mahjong = useSharedMahjong({ gatheringId: all.id, ownedCharacterIds: all.companions.filter(c => c.owner_id === all.me).map(c => c.id), session: token,
    enabled: all.mahjong_available === true && visible && !suspended });
  const signature = JSON.stringify(all.companions.map(c => [c.id, gatheringCompanionArea(all, c), c.owner_id]));
  const preferred = () => { const c = all.companions.find(c => c.id === focusedId) || all.companions.find(c => c.owner_id === all.me); return c ? gatheringCompanionArea(all, c) : 'outdoor' as GatheringArea; };
  const [view, setView] = useState(() => ({ signature, focus: focusedId, area: 'overview' as HomeWorldView }));
  if (view.signature !== signature || view.focus !== focusedId) {
    const old = JSON.parse(view.signature) as Array<[number, GatheringArea, string]>;
    const moved = all.companions.find(c => c.owner_id === all.me && old.some(p => p[0] === c.id && p[1] !== gatheringCompanionArea(all, c)));
    setView({ signature, focus: focusedId, area: view.area === 'overview' ? 'overview' : moved ? gatheringCompanionArea(all, moved) : focusedId !== view.focus && focusedId !== null ? preferred() : view.area });
  }
  const home = all.scene_type === 'home', bedroom = home && view.area === 'bedroom', indoors = home && (view.area === 'indoor' || bedroom);
  const g = all;
  const areaNavigation = home && <p className="hub-area-presence">院子：{all.companions.filter(c => gatheringCompanionArea(all, c) === 'outdoor').map(c => c.name).join('、') || '暂无伙伴'} · 客厅：{all.companions.filter(c => gatheringCompanionArea(all, c) === 'indoor').map(c => c.name).join('、') || '暂无伙伴'} · 卧室：{all.companions.filter(c => gatheringCompanionArea(all, c) === 'bedroom').map(c => c.name).join('、') || '暂无伙伴'}</p>;
  const [paused, setPaused] = useState(false);
  const focused = g.companions.find(c => c.id === focusedId);
  const supported = focused && ['rest', 'walk', 'observe'].includes(focused.activity);
  const playing = !!token && visible && !suspended && !paused;
  const season = g.season && Object.hasOwn(seasonNames, g.season) ? g.season as Season : null;
  const has3D = all.companions.some(c => c.avatar3d && c.avatar3d.kind !== 'unavailable');
  function chooseCompanion(id: number) {
    const companion = all.companions.find(c => c.id === id);
    if (home && companion && view.area !== 'overview') setView({ signature, focus: id, area: gatheringCompanionArea(all, companion) });
    onSelect(id);
  }
  if ((home || has3D || (all.companions.length === 0 && ['forest', 'desert'].includes(all.scene_type))) && token) return <>
    <SharedLivingWorld3D onCompanionPresenceChange={onCompanionPresenceChange} onFloorOccupancyChange={onFloorOccupancyChange} floorKind="shared" persistentWorld={typeof onLeisureAction === 'function'} localQuietAudio localMahjongRules="sichuan" sharedMahjongSnapshot={mahjong.snapshot ? redactSharedMahjongSnapshot(mahjong.snapshot) : undefined} gathering={g} focusedId={focusedId} onSelect={chooseCompanion} animate={playing} view={view.area} onFocusView={area => setView({ signature, focus: focusedId, area })} onPausedChange={setPaused} busy={busy || suspended} onActivity={onActivity} onLeisureAction={onLeisureAction} />
    {all.mahjong_available && <SharedMahjongPanel key={`${all.id}:${token}`} gathering={all} state={mahjong} suspended={!!suspended} />}
    {focused && <details className="hub-original-appearance"><summary>查看{focused.name}的原形象{supported ? '与动作' : ''}</summary>
      <div className="hub-original-portrait">{playing && supported ? <GatheringPortrait groupId={g.id} companion={focused} token={token} /> : <PrivateImage src={`/api/v1/gatherings/${g.id}/companions/${focused.id}/image`} alt={focused.name} retryable={false} />}</div>
    </details>}
  </>;
  return <>{areaNavigation}<div className={`hub-world hub-world-${g.scene_type} season-${season || 'unset'}`} aria-label="共同生活场景" data-season={season ?? 'base'} style={g.companions.length > 5 ? { minHeight: 420 } : undefined}>
    {bedroom ? <div data-bedroom-preview="true" role="img" aria-label="卧室预览"><p><span aria-hidden="true">🛏️</span> 卧室 · 睡觉的伙伴在这里</p></div> : indoors ? <GatheringRoomBackdrop season={season} /> : g.scene_type === 'desert' ? season && <OasisBackdrop season={season} />
      : (g.scene_type === 'home' || g.scene_type === 'forest') && <SceneSeasonBackdrop scene={g.scene_type} season={season} />}
    {g.items.filter(i=>!i.stored).map(i => <span className="hub-world-item" key={i.id} style={{ left: `${i.x * 80 + 10}%`, top: `${i.y * 65 + 15}%` }} title={`${itemNames[i.kind]} · ${i.contributor_name}`}>{itemSymbols[i.kind] || '🌿'}</span>)}
    {g.companions.map(c => <div key={c.id} className={`hub-world-companion hub-activity-${c.activity}`} data-focused={focusedId === c.id} style={companionPosition(g, c.id) || undefined}>
      <div className="hub-companion-portrait">{playing && supported && focusedId === c.id
        ? <GatheringPortrait groupId={g.id} companion={c} token={token!} />
        : <PrivateImage src={`/api/v1/gatherings/${g.id}/companions/${c.id}/image`} alt={c.name} retryable={false} />}</div>
      <button type="button" className="hub-companion-select" aria-pressed={focusedId === c.id} aria-label={`查看${c.name}的生活近况`} onClick={() => onSelect(c.id)}><strong>{c.name}</strong><small>{activityNames[c.activity] || '在场'}</small></button>
    </div>)}
    {!g.companions.length && <p>{bedroom ? '选择自己的伙伴并安排睡觉，它就会进入卧室。' : indoors ? '选择自己的伙伴并安排休息，它就会进入客厅。' : '把伙伴带来，这里就热闹起来了。'}</p>}
  </div>
    {supported ? <div className="hub-actions"><span>{focused.name} · {activityNames[focused.activity]}，有可用动作时播放</span>
      <button type="button" className="button" disabled={!token || !visible || !!suspended} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? '继续画面' : '暂停画面'}</button>
      {(!visible || suspended) && <span>画面暂时保持静态</span>}</div>
      : g.companions.length > 0 && <p>点选伙伴可查看近况和当前动作；动作未就绪时保留原图。</p>}
  </>;
}

function GatheringPortrait({ groupId, companion: c, token }: { groupId: string; companion: Gathering['companions'][number]; token: string }) {
  const activity = c.activity as Activity;
  const loadAsset = useCallback((signal: AbortSignal) => loadGatheringMotion(groupId, c.id, token, signal, activity), [groupId, c.id, token, activity]);
  return <MotionPlayer staticSrc={`/api/v1/gatherings/${groupId}/companions/${c.id}/image`} name={c.name}
    privateStatic loadAsset={loadAsset} activity={activity} compact scene />;
}
