'use client';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { companionPosition, itemNames, type Gathering } from '@/lib/gatherings';
import { seasonNames, type Season } from '@/lib/seasons';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { loadGatheringMotion } from '@/lib/private-motion';
import type { Activity } from '@/lib/life-simulation';
import OasisBackdrop from './oasis-backdrop';
import SceneSeasonBackdrop from './scene-season-backdrop';
import PrivateImage from './private-image';
import MotionPlayer from './motion-player';

const activityNames: Record<string, string> = { arriving: '刚刚到达', rest: '休息', walk: '散步', observe: '观察', talk: '交流' };
const itemSymbols: Record<string, string> = { tree: '🌳', bench: '🪑', shade: '⛱️', cushion: '🪵', flower: '🌷' };

type Props = { gathering: Gathering; focusedId: number | null; onSelect: (id: number) => void; suspended?: boolean };
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
  const focused = props.gathering.companions.find(c => c.id === props.focusedId);
  return <World key={JSON.stringify([props.gathering.id, props.focusedId, focused?.activity, token])}
    {...props} token={token} visible={visible} />;
}

function World({ gathering: g, focusedId, onSelect, suspended, token, visible }: Props & { token: string | null; visible: boolean }) {
  const [paused, setPaused] = useState(false);
  const focused = g.companions.find(c => c.id === focusedId);
  const supported = focused && ['rest', 'walk', 'observe'].includes(focused.activity);
  const playing = !!token && visible && !suspended && !paused;
  const season = g.season && Object.hasOwn(seasonNames, g.season) ? g.season as Season : null;
  return <><div className={`hub-world hub-world-${g.scene_type} season-${season || 'unset'}`} aria-label="共同生活场景" data-season={season ?? 'base'} style={g.companions.length > 5 ? { minHeight: 420 } : undefined}>
    {season && (g.scene_type === 'desert' ? <OasisBackdrop season={season} />
      : (g.scene_type === 'home' || g.scene_type === 'forest') && <SceneSeasonBackdrop scene={g.scene_type} season={season} />)}
    {g.items.map(i => <span className="hub-world-item" key={i.id} style={{ left: `${i.x * 80 + 10}%`, top: `${i.y * 65 + 15}%` }} title={`${itemNames[i.kind]} · ${i.contributor_name}`}>{itemSymbols[i.kind] || '🌿'}</span>)}
    {g.companions.map(c => <div key={c.id} className={`hub-world-companion hub-activity-${c.activity}`} data-focused={focusedId === c.id} style={companionPosition(g, c.id) || undefined}>
      <div className="hub-companion-portrait">{playing && supported && focusedId === c.id
        ? <GatheringPortrait groupId={g.id} companion={c} token={token!} />
        : <PrivateImage src={`/api/v1/gatherings/${g.id}/companions/${c.id}/image`} alt={c.name} retryable={false} />}</div>
      <button type="button" className="hub-companion-select" aria-pressed={focusedId === c.id} aria-label={`查看${c.name}的生活近况`} onClick={() => onSelect(c.id)}><strong>{c.name}</strong><small>{activityNames[c.activity] || '在场'}</small></button>
    </div>)}
    {!g.companions.length && <p>把伙伴带来，这里就热闹起来了。</p>}
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
