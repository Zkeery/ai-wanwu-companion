import type { JourneyArea, JourneyPhase } from './living-home-journey';

export type HomePresenceActor = Readonly<{ id: number; area: JourneyArea; active: boolean; phase: JourneyPhase; targetArea: JourneyArea }>;
export type HomePresenceSnapshot = Readonly<{ groupId: string; ownerId: string; actors: readonly HomePresenceActor[] }>;
export type HomePresenceScope = Readonly<{ groupId: string; ownerId: string; sceneType: string; enabled: boolean; localNaturalWorld?: boolean; persistentWorld?: boolean; actorIds?: readonly number[] }>;
const areas: readonly string[] = ['outdoor', 'indoor', 'bedroom'];
const phases: readonly string[] = ['idle', 'undock', 'walk', 'turn', 'portal', 'wait-door', 'dock', 'blocked'];
const areaNames: Record<JourneyArea, string> = { outdoor: '院子', indoor: '客厅', bedroom: '卧室' };
const idValid = (id: number) => Number.isSafeInteger(id) && id > 0;
function validSnapshot(snapshot: HomePresenceSnapshot | null | undefined): snapshot is HomePresenceSnapshot {
  if (!snapshot || typeof snapshot.groupId !== 'string' || !snapshot.groupId || typeof snapshot.ownerId !== 'string' || !snapshot.ownerId
    || !Array.isArray(snapshot.actors) || snapshot.actors.length > 10) return false;
  const ids = new Set<number>();
  for (const actor of snapshot.actors) {
    if (!actor || !idValid(actor.id) || ids.has(actor.id) || !areas.includes(actor.area) || !areas.includes(actor.targetArea)
      || typeof actor.active !== 'boolean' || !phases.includes(actor.phase) || actor.active === (actor.phase === 'idle')) return false;
    ids.add(actor.id);
  }
  return true;
}

/** Presentation only. Never use a projected area/activity as ownership, authorization or dialogue input. */
export function getHomePresenceActor(snapshot: HomePresenceSnapshot | null | undefined, scope: HomePresenceScope, id: number): HomePresenceActor | null {
  if (!scope || scope.enabled !== true || !(scope.sceneType === 'home' || scope.localNaturalWorld === true && ['forest','desert'].includes(scope.sceneType)) || typeof scope.groupId !== 'string' || typeof scope.ownerId !== 'string' || !(scope.groupId.startsWith('synthetic-') || scope.persistentWorld === true)
    || !idValid(id) || !validSnapshot(snapshot) || snapshot.groupId !== scope.groupId || snapshot.ownerId !== scope.ownerId
    || (scope.actorIds !== undefined && !scope.actorIds.includes(id))) return null;
  const actor = snapshot.actors.find(value => value.id === id);
  return actor ? Object.freeze({ id: actor.id, area: actor.area, active: actor.active, phase: actor.phase, targetArea: actor.targetArea }) : null;
}

/** List/menu copy only; saved dialogue bubbles continue to come exclusively from dialogue events. */
export function homePresenceActivityLabel(actor: HomePresenceActor | null | undefined, fallbackLabel: string): string {
  if (!actor?.active) return fallbackLabel;
  switch (actor.phase) {
    case 'undock': return '正在起身';
    case 'walk': return '走向' + areaNames[actor.targetArea] + '，准备' + fallbackLabel;
    case 'turn': return '正在转身';
    case 'portal': return '正在穿过房门';
    case 'wait-door': return '门前等候';
    case 'dock': return fallbackLabel === '睡觉' ? '正在躺下' : fallbackLabel === '休息' ? '正在坐下' : '正在就位';
    case 'blocked': return '暂时停下';
    default: return fallbackLabel;
  }
}

/** Stable discrete content key: no positions, timestamps or frame counters can cause per-frame React updates. */
export function homePresenceSnapshotKey(snapshot: HomePresenceSnapshot | null | undefined): string {
  if (!validSnapshot(snapshot)) return '';
  return JSON.stringify([snapshot.groupId, snapshot.ownerId, [...snapshot.actors].sort((a, b) => a.id - b.id)
    .map(actor => [actor.id, actor.area, actor.active, actor.phase, actor.targetArea])]);
}
