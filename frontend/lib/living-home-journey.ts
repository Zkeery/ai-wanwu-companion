import type { LivingNavigationRoute, NavOccupied, NavPoint } from './living-navigation';

export type JourneyArea = 'indoor' | 'bedroom' | 'outdoor';
export type JourneyDoorId = 'home-main-entry-door' | 'home-room-connection-door';
export type JourneyPortalConfiguration = Readonly<{
  main: Readonly<{ door: 'home-main-entry-door'; before: NavPoint; elbow?: NavPoint; after: NavPoint }>;
  bedroom: Readonly<{ door: 'home-room-connection-door'; before: NavPoint; after: NavPoint }>;
}>;
export type JourneyPose = Readonly<{ x: number; y: number; z: number; yaw: number; tilt: number; scale: number; area: JourneyArea; contact: 'rest' | 'sleep' | null; bedSeat?: number; bedBreathing?: number; bedLegLift?: number }>;
export type JourneyTarget = Readonly<{ key: string; pose: JourneyPose; approach: NavPoint }>;
export type JourneyPhase = 'idle' | 'undock' | 'walk' | 'turn' | 'portal' | 'wait-door' | 'dock' | 'blocked';
export type JourneyFrame = Readonly<{ active: boolean; pose: JourneyPose; contactBlend: number; phase: JourneyPhase; targetKey: string; waitingFor?: JourneyDoorId }>;
export type JourneyContactPoint = Readonly<{ pose: JourneyPose; blend: number }>;
export type JourneyContext = Readonly<{
  plan(from: NavPoint, to: NavPoint, area: JourneyArea, avoid?: readonly NavOccupied[]): LivingNavigationRoute;
  isClear(from: NavPoint, to: NavPoint, area: JourneyArea): boolean;
  isContactClear?(from: JourneyPose, to: JourneyPose, fromBlend: number, toBlend: number, wholeTransfer?: boolean): boolean;
  contactPath?(from: JourneyPose, to: JourneyPose, fromBlend: number, toBlend: number): readonly JourneyContactPoint[];
  /** Actual rotation-safe body envelope, only for an exact contact reservation. */
  contactPeerRadius?(id: number): number;
  portalClear(from: NavPoint, to: NavPoint, door: JourneyDoorId): boolean;
  turnClear?(point: NavPoint, door: JourneyDoorId): boolean;
  doorOpen(door: JourneyDoorId): boolean;
  yaw?: number;
  revision?: number | string;
  radius?: number;
  recoverYieldingRoute?: boolean;
  coordinateContacts?: boolean;
  yieldPlan?(from: NavPoint, area: JourneyArea, avoid: readonly NavOccupied[], keepFree: readonly NavOccupied[]): LivingNavigationRoute | null;
}>;
export type JourneyProposal = Readonly<{
  id: number; position: NavPoint; desired: NavPoint; yaw: number; area: JourneyArea; phase: JourneyPhase;
  waitingFor?: JourneyDoorId; portal?: JourneyDoorId; contactTransition?: 'dock' | 'undock';
  contactTurning?: boolean;
  canTraverse(from: NavPoint, to: NavPoint): boolean; speed: number;
}>;
type YieldPeer = { id: number; position: NavPoint; area: JourneyArea; goalKey: string };
type WalkStage = { kind: 'walk'; area: JourneyArea; goal: NavPoint; yielding?: { peers: YieldPeer[]; checked: string | null; recoveryChecked?: string } };
type PortalStage = { kind: 'portal'; door: JourneyDoorId; from: NavPoint; to: NavPoint; fromArea: JourneyArea; toArea: JourneyArea; points: NavPoint[]; leg: number };
type Tween = { from: JourneyPose; to: JourneyPose; progress: number; fromBlend: number; toBlend: number; path?: readonly JourneyContactPoint[]; distances?: number[] };
type Pending = { proposal: JourneyProposal; dt: number; tweenProgress?: number };
type Holding = { door: JourneyDoorId; goal: NavPoint; route: LivingNavigationRoute; waypoint: number; fingerprint: string };
type ContactReservation = Readonly<{ from: NavPoint; to: NavPoint; radius: number }>;
type State = {
  id: number; target: JourneyTarget; frame: JourneyFrame; stages: Array<WalkStage | PortalStage>; stage: number;
  route: LivingNavigationRoute | null; waypoint: number; tween: Tween | null; pending: Pending | null;
  contactApproach: NavPoint | null; afterPortal: boolean; blockedFingerprint: string | null; blockedPeerFingerprint: string | null;
  holding: Holding | null;
  routeFingerprint: string | null;
  observed: JourneyPose; radius: number; waited: number;
};
export const HOME_JOURNEY_PORTALS = Object.freeze({
  main: Object.freeze({ door: 'home-main-entry-door' as const, before: Object.freeze({ x: -1.2, z: 1.25 }), elbow: Object.freeze({ x: -2.4, z: 1.25 }), after: Object.freeze({ x: -2.4, z: -1.6 }) }),
  bedroom: Object.freeze({ door: 'home-room-connection-door' as const, before: Object.freeze({ x: -2.4, z: -1.48934 }), after: Object.freeze({ x: 1.6, z: -1.48934 }) }),
});
// The reference villa keeps the original planted tree; its low crown needs a wider entry turn.
export const VILLA_JOURNEY_PORTALS:JourneyPortalConfiguration=Object.freeze({...HOME_JOURNEY_PORTALS,main:Object.freeze({...HOME_JOURNEY_PORTALS.main,before:Object.freeze({x:0,z:1.25}),elbow:Object.freeze({x:-2.4,z:.8})})});
const EPS = 1e-6, CONTACT_SECONDS = 1.2, TURN_SPEED = 3.6, CONTACT_HOLD = .03;
export const CONTACT_SPEED = 1.4;
const finite = Number.isFinite;
const validPoint = (p: NavPoint) => !!p && finite(p.x) && finite(p.z);
const validPose = (p: JourneyPose) => !!p && [p.x, p.y, p.z, p.yaw, p.tilt, p.scale].every(finite) && p.scale > 0 && ['indoor', 'bedroom', 'outdoor'].includes(p.area) && [null, 'rest', 'sleep'].includes(p.contact) && (p.bedSeat === undefined || finite(p.bedSeat) && p.bedSeat >= 0 && p.bedSeat <= 1) && (p.bedBreathing === undefined || finite(p.bedBreathing) && p.bedBreathing > 0) && (p.bedLegLift === undefined || finite(p.bedLegLift) && p.bedLegLift >= 0);
const point = (p: NavPoint): NavPoint => ({ x: p.x, z: p.z });
const dist = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const boundedDt = (dt: number) => finite(dt) && dt > 0 ? Math.min(.1, dt) : 0;
const angle = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const yawBetween = (a: NavPoint, b: NavPoint) => Math.atan2(b.x - a.x, b.z - a.z);
const limitYaw = (from: number, to: number, dt: number) => from + Math.max(-TURN_SPEED * dt, Math.min(TURN_SPEED * dt, angle(from, to)));
const towards = (from: NavPoint, to: NavPoint, budget: number) => { const ratio = Math.min(1, budget / Math.max(EPS, dist(from, to))); return { x: from.x + (to.x - from.x) * ratio, z: from.z + (to.z - from.z) * ratio }; };
const pointSegmentDistance = (p: NavPoint, a: NavPoint, b: NavPoint) => {
  const dx = b.x - a.x, dz = b.z - a.z, squared = dx * dx + dz * dz;
  const t = squared > EPS * EPS ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / squared)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
};
const segmentDistance = (a: NavPoint, b: NavPoint, c: NavPoint, d: NavPoint) => {
  const ab = { x: b.x - a.x, z: b.z - a.z }, cd = { x: d.x - c.x, z: d.z - c.z }, ac = { x: c.x - a.x, z: c.z - a.z };
  const cross = ab.x * cd.z - ab.z * cd.x;
  if (Math.abs(cross) > EPS) {
    const t = (ac.x * cd.z - ac.z * cd.x) / cross, u = (ac.x * ab.z - ac.z * ab.x) / cross;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
};
const copyTarget = (t: JourneyTarget): JourneyTarget => ({ key: t.key, pose: { ...t.pose }, approach: point(t.approach) });
const safeCall = (fn: () => boolean) => { try { return !!fn(); } catch { return false; } };
function copyPortals(value: JourneyPortalConfiguration): JourneyPortalConfiguration {
  if (!value || value.main?.door !== 'home-main-entry-door' || value.bedroom?.door !== 'home-room-connection-door') throw new TypeError('Invalid journey portal doors');
  const copy = (p: NavPoint): NavPoint => {
    if (!validPoint(p)) throw new TypeError('Invalid journey portal point');
    return Object.freeze(point(p));
  };
  const main = Object.freeze({ door: value.main.door, before: copy(value.main.before), ...(value.main.elbow === undefined ? {} : { elbow: copy(value.main.elbow) }), after: copy(value.main.after) });
  const bedroom = Object.freeze({ door: value.bedroom.door, before: copy(value.bedroom.before), after: copy(value.bedroom.after) });
  const paths = [[main.before, ...(main.elbow ? [main.elbow] : []), main.after], [bedroom.before, bedroom.after], [main.before, main.after]];
  for (const path of paths) for (let i = 1; i < path.length; i++) {
    const length = dist(path[i - 1], path[i]);
    if (!finite(length) || length <= EPS) throw new RangeError('Degenerate journey portal path');
  }
  return Object.freeze({ main, bedroom });
}
function frozenFrame(s: State, pose: JourneyPose, phase: JourneyPhase, contactBlend = s.frame.contactBlend, waitingFor?: JourneyDoorId): JourneyFrame {
  return Object.freeze({ active: phase !== 'idle', pose: Object.freeze({ ...pose }), phase, contactBlend: Math.max(0, Math.min(1, contactBlend)), targetKey: s.target.key, ...(waitingFor ? { waitingFor } : {}) });
}
function interpolate(a: JourneyPose, b: JourneyPose, fraction: number, contact: JourneyPose['contact']): JourneyPose {
  const mix = (v: number, end: number) => v + (end - v) * fraction;
  // A short step-up arc clears the real seat edge before settling. Linear
  // translation alone puts small bodies through the stool during docking.
  const seatTransfer = (a.contact === null && b.contact === 'rest') || (a.contact === 'rest' && b.contact === null);
  const lift = seatTransfer ? .18 * Math.sin(Math.PI * fraction) : 0;
  return { x: mix(a.x, b.x), y: mix(a.y, b.y) + lift, z: mix(a.z, b.z), yaw: a.yaw + angle(a.yaw, b.yaw) * fraction,
    tilt: mix(a.tilt, b.tilt), scale: mix(a.scale, b.scale), area: a.area, contact,
    ...(a.bedSeat !== undefined || b.bedSeat !== undefined ? { bedSeat: mix(a.bedSeat ?? 0, b.bedSeat ?? 0) } : {}),
    ...(a.bedBreathing !== undefined || b.bedBreathing !== undefined ? { bedBreathing: mix(a.bedBreathing ?? 1, b.bedBreathing ?? 1) } : {}),
    ...(a.bedLegLift !== undefined || b.bedLegLift !== undefined ? { bedLegLift: mix(a.bedLegLift ?? 0, b.bedLegLift ?? 0) } : {}) };
}

function sampleContact(tween: Tween, fraction: number, contact: JourneyPose['contact']): JourneyContactPoint {
  if (!tween.path || !tween.distances) return { pose: interpolate(tween.from, tween.to, fraction, contact), blend: tween.fromBlend + (tween.toBlend - tween.fromBlend) * fraction };
  const distance = fraction * tween.distances.at(-1)!;
  let index = 1; while (index < tween.distances.length - 1 && tween.distances[index] < distance) index++;
  const a = tween.path[index - 1], b = tween.path[index], span = tween.distances[index] - tween.distances[index - 1];
  const t = span > EPS ? Math.max(0, Math.min(1, (distance - tween.distances[index - 1]) / span)) : 1;
  // The physical path already contains its support height; the generic seat arc
  // must not be added to a sleeping body's piecewise contact transfer.
  // Support heights are solved only at path points; a lerped height between
  // two of them can sink a moving limb into the quilt, so lean towards the
  // higher one by at most a few centimetres (a visible pop is worse).
  const mix = (a: number, b: number) => a + (b - a) * t;
  const y = t <= 0 ? a.pose.y : t >= 1 ? b.pose.y : Math.min(Math.max(a.pose.y, b.pose.y), mix(a.pose.y, b.pose.y) + CONTACT_HOLD);
  return { pose: { ...a.pose, x: mix(a.pose.x, b.pose.x), y, z: mix(a.pose.z, b.pose.z),
    yaw: a.pose.yaw + angle(a.pose.yaw, b.pose.yaw) * t, tilt: mix(a.pose.tilt, b.pose.tilt), scale: mix(a.pose.scale, b.pose.scale), bedSeat: mix(a.pose.bedSeat ?? 0, b.pose.bedSeat ?? 0), bedBreathing: mix(a.pose.bedBreathing ?? 1, b.pose.bedBreathing ?? 1), bedLegLift: mix(a.pose.bedLegLift ?? 0, b.pose.bedLegLift ?? 0), contact }, blend: mix(a.blend, b.blend) };
}

export function createHomeJourneyController(configuration: JourneyPortalConfiguration = HOME_JOURNEY_PORTALS) {
  const portals = copyPortals(configuration), portalFingerprint = JSON.stringify(portals);
  const geometryFingerprint = (ctx: JourneyContext) => JSON.stringify([portalFingerprint, safeCall(() => ctx.doorOpen(portals.main.door)), safeCall(() => ctx.doorOpen(portals.bedroom.door)), ctx.revision ?? null]);
  const states = new Map<number, State>();
  const portalOwners = new Map<JourneyDoorId, number>();
  const contacts = new Map<number, ContactReservation>();
  function canCrossContact(id: number, from: NavPoint, to: NavPoint, radius: number): boolean {
    if (!finite(id) || !validPoint(from) || !validPoint(to) || !finite(radius) || radius < 0) return false;
    for (const [owner, lane] of contacts) if (owner !== id && segmentDistance(from, to, lane.from, lane.to) < radius + lane.radius + .035 - EPS) return false;
    return true;
  }
  function reserveContact(s: State, tween: Tween, ctx: JourneyContext): boolean {
    if (contacts.has(s.id)) return true;
    const from = point(tween.from), to = point(tween.to);
    const clear = () => tween.path && ctx.isContactClear ? tween.path.slice(1).every((to, index) => {
      const from = tween.path![index]; return ctx.isContactClear!(from.pose, to.pose, from.blend, to.blend);
    }) : ctx.isContactClear ? ctx.isContactClear(tween.from, tween.to, tween.fromBlend, tween.toBlend, true) : ctx.isClear(from, to, tween.from.area);
    if (!canCrossContact(s.id, from, to, s.radius) || !safeCall(clear)) return false;
    for (const other of states.values()) {
      if (other.id === s.id) continue;
      // Logical room membership must not hide a real body next to a doorway.
      const actual = ctx.contactPeerRadius?.(other.id), peerRadius = finite(actual ?? NaN) && actual! > 0 ? actual! : other.radius;
      if (pointSegmentDistance(peerPose(other), from, to) < s.radius + peerRadius + .035 - EPS) return false;
    }
    contacts.set(s.id, Object.freeze({ from, to, radius: s.radius })); return true;
  }
  function currentStage(s: State) { return s.stages[s.stage]; }
  function stageGoal(s: State): NavPoint { const stage = currentStage(s); return stage?.kind === 'walk' ? stage.goal : stage?.kind === 'portal' ? stage.to : s.target.pose; }
  function goalKey(s: State) { const stage = currentStage(s), goal = stageGoal(s); return `${stage?.kind ?? 'idle'}:${goal.x}:${goal.z}`; }
  function peerPose(s: State) { return s.frame.active ? s.frame.pose : s.observed; }
  function peerCorridor(peers: readonly State[]) {
    const segments: Array<{ from: NavPoint; to: NavPoint; radius: number }> = [];
    const samples: NavOccupied[] = [];
    for (const other of peers) {
      const remaining = [point(peerPose(other)), ...(other.route?.points.slice(other.waypoint) ?? []).map(point), point(stageGoal(other))].filter(validPoint);
      for (let i = 0; i < remaining.length; i++) {
        const from = remaining[i], to = remaining[i + 1] ?? from, length = dist(from, to), count = Math.max(1, Math.ceil(length / .35));
        segments.push({ from, to, radius: other.radius });
        // Half a sample interval covers every point of the real remaining path.
        // These reservations constrain the bay, not the route used to reach it.
        const margin = length / count / 2;
        for (let n = 0; n <= count; n++) samples.push({ position: { x: from.x + (to.x - from.x) * n / count, z: from.z + (to.z - from.z) * n / count }, radius: other.radius + margin });
      }
    }
    return { samples, clear: (end: NavPoint, radius: number) => segments.every(segment => pointSegmentDistance(end, segment.from, segment.to) >= radius + segment.radius + .035 - EPS) };
  }
  function releaseDoors(id: number) { for (const [door, owner] of portalOwners) if (owner === id) portalOwners.delete(door); }
  function setPhase(s: State, phase: JourneyPhase, waitingFor?: JourneyDoorId) {
    if (s.frame.phase === phase && s.frame.waitingFor === waitingFor && s.frame.targetKey === s.target.key) return;
    s.frame = frozenFrame(s, s.frame.pose, phase, s.frame.contactBlend, waitingFor);
  }
  function makeStages(s: State) {
    const stages: State['stages'] = [], destination = s.target.pose.area;
    let area = s.frame.pose.area;
    const portal = (door: JourneyDoorId, from: NavPoint, to: NavPoint, toArea: JourneyArea) => {
      const points = door === portals.main.door && portals.main.elbow ? [point(from), point(portals.main.elbow), point(to)] : [point(from), point(to)];
      stages.push({ kind: 'walk', area, goal: point(from) }, { kind: 'portal', door, from: point(from), to: point(to), fromArea: area, toArea, points, leg: 0 });
      area = toArea;
    };
    if (area === 'bedroom' && destination !== 'bedroom') portal(portals.bedroom.door, portals.bedroom.after, portals.bedroom.before, 'indoor');
    if (area === 'outdoor' && destination !== 'outdoor') portal(portals.main.door, portals.main.before, portals.main.after, 'indoor');
    if (destination === 'outdoor' && area !== 'outdoor') portal(portals.main.door, portals.main.after, portals.main.before, 'outdoor');
    if (destination === 'bedroom' && area !== 'bedroom') portal(portals.bedroom.door, portals.bedroom.before, portals.bedroom.after, 'bedroom');
    stages.push({ kind: 'walk', area, goal: point(s.target.approach) });
    s.stages = stages; s.stage = 0; s.route = null; s.routeFingerprint = null; s.waypoint = 1; s.blockedFingerprint = null; s.blockedPeerFingerprint = null; s.tween = null; s.holding = null; s.waited = 0;
    setPhase(s, 'walk');
  }
  function beginDock(s: State) {
    const from = s.frame.pose, to = { ...s.target.pose };
    s.tween = { from, to, progress: 0, fromBlend: 0, toBlend: to.contact ? 1 : 0 };
    s.contactApproach = to.contact ? point(s.target.approach) : null;
    s.frame = frozenFrame(s, { ...from, contact: to.contact }, 'dock', 0);
  }
  function advanceStage(s: State) {
    s.stage++; s.route = null; s.waypoint = 1; s.blockedFingerprint = null; s.blockedPeerFingerprint = null; s.waited = 0;
    const next = currentStage(s);
    if (!next) beginDock(s); else setPhase(s, next.kind === 'walk' ? 'walk' : 'turn');
  }
  function beginFromActual(s: State, actual: JourneyPose, blend: number) {
    releaseDoors(s.id); contacts.delete(s.id); s.pending = null; s.afterPortal = false; s.blockedFingerprint = null; s.blockedPeerFingerprint = null; s.route = null; s.holding = null; s.waited = 0; s.observed = actual;
    s.frame = frozenFrame(s, actual, 'walk', actual.contact ? blend : 0);
    if (actual.contact && s.contactApproach) {
      const approach = s.contactApproach;
      const standing: JourneyPose = { x: approach.x, z: approach.z, y: 0, yaw: dist(actual, approach) > EPS ? yawBetween(actual, approach) : actual.yaw,
        tilt: 0, scale: 1, area: actual.area, contact: null };
      s.tween = { from: actual, to: standing, progress: 0, fromBlend: blend, toBlend: 0 };
      s.stages = []; s.stage = 0; setPhase(s, 'undock');
    } else { s.contactApproach = null; makeStages(s); }
  }

  function reconcile(id: number, target: JourneyTarget, actualPose: JourneyPose): JourneyFrame | null {
    const previous = states.get(id);
    if (!finite(id) || !target || typeof target.key !== 'string' || !target.key || !validPose(target.pose) || !validPose(actualPose) || !validPoint(target.approach)) return previous?.frame ?? null;
    if (!previous) {
      const pose = Object.freeze({ ...actualPose });
      const initial: JourneyFrame = Object.freeze({ active: false, pose, contactBlend: pose.contact ? 1 : 0, phase: 'idle', targetKey: target.key });
      states.set(id, { id, target: copyTarget(target), frame: initial, stages: [], stage: 0, route: null, waypoint: 1, tween: null, pending: null,
        contactApproach: pose.contact ? point(target.approach) : null, afterPortal: false, blockedFingerprint: null, blockedPeerFingerprint: null, holding: null, routeFingerprint: null, observed: pose, radius: 1, waited: 0 });
      return initial;
    }
    previous.observed = { ...actualPose };
    if (previous.target.key === target.key) return previous.frame;
    const s = previous, stage = currentStage(s), oldBlend = s.frame.pose.contact === actualPose.contact ? s.frame.contactBlend : actualPose.contact ? 1 : 0;
    s.target = copyTarget(target); s.pending = null;
    if (s.frame.phase === 'undock' && s.tween?.path && actualPose.contact === 'sleep') {
      // A new floor/social goal does not change the bed/seat being left. Keep
      // the accepted physical exit and apply the newest goal after landing.
      s.frame = frozenFrame(s, { ...actualPose }, 'undock', oldBlend);
    } else if (stage?.kind === 'portal' && portalOwners.get(stage.door) === id && dist(actualPose, stage.from) > EPS && dist(actualPose, stage.to) > EPS) {
      // An in-flight doorway is the sole old waypoint retained. Its old destination
      // target is replaced immediately, and will never be resurrected after the exit.
      s.frame = frozenFrame(s, { ...actualPose, contact: null }, s.frame.phase, 0, s.frame.waitingFor);
      s.stages = [stage]; s.stage = 0; s.route = null; s.tween = null; s.afterPortal = true; s.holding = null;
    } else beginFromActual(s, { ...actualPose }, oldBlend);
    return s.frame;
  }

  function prepare(id: number, delta: number, ctx: JourneyContext): JourneyProposal | null {
    const s = states.get(id), dt = boundedDt(delta);
    if (!s) return null;
    if (ctx.coordinateContacts !== true) contacts.delete(id);
    if (finite(ctx.radius ?? NaN) && ctx.radius! > 0) s.radius = ctx.radius!;
    if (!s.frame.active || !dt) return null;
    s.pending = null;
    const fingerprint = geometryFingerprint(ctx);
    if (s.route && s.routeFingerprint !== fingerprint) { s.route = null; s.waypoint = 1; }
    // A local-world retreat is temporary. A later stationary body can seal its
    // old bay while the original destination is reachable again; keep the real pose
    // and replace only that stale retreat, never a doorway, contact or target.
    const retreat = currentStage(s), resume = s.stages[s.stage + 1];
    if (ctx.recoverYieldingRoute === true && retreat?.kind === 'walk' && retreat.yielding && resume?.kind === 'walk'
      && resume.area === retreat.area && (s.waited >= .9 || s.frame.phase === 'blocked' || dist(s.frame.pose, retreat.goal) <= EPS)) {
      const peers = [...states.values()].filter(other => other.id !== s.id)
        .map(other => ({ other, pose: peerPose(other) })).filter(({ pose }) => pose.area === retreat.area);
      const check = fingerprint + '|' + s.frame.pose.x.toFixed(4) + ':' + s.frame.pose.z.toFixed(4) + '|'
        + peers.map(({ other, pose }) => other.id + ':' + pose.x.toFixed(3) + ':' + pose.z.toFixed(3) + ':' + other.radius.toFixed(3) + ':' + other.frame.active + ':' + goalKey(other)).join('|');
      if (retreat.yielding.recoveryChecked !== check) {
        retreat.yielding.recoveryChecked = check;
        const avoid = peers.map(({ other, pose }) => ({ position: point(pose), radius: other.radius }));
        let replacement: LivingNavigationRoute | null = null;
        try { replacement = ctx.plan(point(s.frame.pose), resume.goal, retreat.area, avoid); } catch { /* The old safe wait remains authoritative. */ }
        const routeClear = replacement && !replacement.blocked && replacement.points.length >= 2 && replacement.points.every(validPoint)
          && dist(replacement.points[0], s.frame.pose) <= EPS && dist(replacement.points.at(-1)!, resume.goal) <= EPS
          && replacement.points.slice(1).every((to, index) => {
            const from = replacement!.points[index], dx = to.x - from.x, dz = to.z - from.z, squared = dx * dx + dz * dz;
            return safeCall(() => ctx.isClear(from, to, retreat.area)) && avoid.every(peer => {
              const t = squared > EPS * EPS ? Math.max(0, Math.min(1, ((peer.position.x - from.x) * dx + (peer.position.z - from.z) * dz) / squared)) : 0;
              return Math.hypot(from.x + dx * t - peer.position.x, from.z + dz * t - peer.position.z) >= s.radius + peer.radius + .035 - EPS;
            });
          });
        const priorityPassed = retreat.yielding.peers.every(saved => {
          const other = states.get(saved.id); return !other || !other.frame.active || peerPose(other).area !== saved.area || goalKey(other) !== saved.goalKey
            || dist(peerPose(other), saved.position) >= s.radius + other.radius + .1;
        });
        if (routeClear && replacement && priorityPassed) {
          advanceStage(s); s.route = replacement; s.routeFingerprint = fingerprint; s.waypoint = 1;
        } else if (!routeClear && ctx.yieldPlan && (dist(s.frame.pose, retreat.goal) > EPS
          || !safeCall(() => ctx.isClear(s.frame.pose, s.frame.pose, retreat.area))
          || avoid.some(peer => dist(s.frame.pose, peer.position) < s.radius + peer.radius + .035 - EPS)
          || !peerCorridor(peers.map(({ other }) => other)).clear(s.frame.pose, s.radius))) {
          // A reached bay may still obstruct a peer's actual remaining route.
          // Select a new safe bay using current bodies and corridors, retaining
          // the original destination and every physical clearance.
          const corridor = peerCorridor(peers.map(({ other }) => other));
          let alternative: LivingNavigationRoute | null = null;
          try { alternative = ctx.yieldPlan(point(s.frame.pose), retreat.area, avoid, corridor.samples); } catch { /* Keep the old safe wait. */ }
          const end = alternative?.points.at(-1);
          if (alternative && !alternative.blocked && alternative.points.length >= 2 && alternative.points.every(validPoint)
            && dist(alternative.points[0], s.frame.pose) <= EPS && end && dist(end, s.frame.pose) > .15
            && avoid.every(peer => dist(end, peer.position) >= s.radius + peer.radius + .035 - EPS) && corridor.clear(end, s.radius)) {
            const owed = new Set(retreat.yielding.peers.map(peer => peer.id));
            retreat.goal = point(end); retreat.yielding.peers = peers.filter(({ other }) => owed.has(other.id)).map(({ other, pose }) => ({ id: other.id, position: point(pose), area: pose.area, goalKey: goalKey(other) }));
            retreat.yielding.checked = null; s.route = alternative; s.routeFingerprint = fingerprint; s.waypoint = 1; s.waited = 0;
            s.blockedFingerprint = null; setPhase(s, 'walk');
          }
        }
      }
    }
    if (s.frame.phase === 'blocked') {
      const stage = currentStage(s), blockedArea = stage?.kind === 'walk' ? stage.area : null, localRetry = ctx.recoverYieldingRoute === true && blockedArea !== null;
      // A failed walking plan may depend on bodies rather than the fixed geometry
      // revision. Retry once for this blocked episode, then only after an actual
      // peer position/radius change; normal moving routes keep their cached plan.
      const peers = localRetry ? [...states.values()].filter(other => other.id !== s.id)
        .map(other => ({ other, pose: peerPose(other) })).filter(({ pose }) => pose.area === blockedArea)
        .sort((a, b) => a.other.id - b.other.id) : [];
      const peerFingerprint = localRetry ? blockedArea + '|' + peers.map(({ other, pose }) => other.id + ':' + pose.x + ':' + pose.z + ':' + other.radius).join('|') : null;
      if (s.blockedFingerprint === fingerprint && (!localRetry || s.blockedPeerFingerprint === peerFingerprint)) return null;
      if (localRetry) s.blockedPeerFingerprint = peerFingerprint;
      s.route = null; s.blockedFingerprint = null; setPhase(s, 'walk');
    }
    const proposal = (desired: NavPoint, yaw: number, speed: number, canTraverse: JourneyProposal['canTraverse'], extras: Partial<JourneyProposal> = {}, tweenProgress?: number): JourneyProposal => {
      const value: JourneyProposal = { id, position: point(s.frame.pose), desired: point(desired), yaw, area: s.frame.pose.area, phase: s.frame.phase, speed, canTraverse, ...extras };
      s.pending = { proposal: value, dt, tweenProgress }; return value;
    };
    const block = () => { s.blockedFingerprint = fingerprint; setPhase(s, 'blocked'); return null; };
    for (let guard = 0; guard < 10; guard++) {
      if (s.frame.phase === 'undock' || s.frame.phase === 'dock') {
        const tween = s.tween!;
        if (ctx.isContactClear && s.frame.phase === 'undock' && tween.progress === 0) tween.to = { ...tween.to, yaw: tween.from.yaw };
        if (ctx.contactPath && (tween.from.contact || tween.to.contact) && !tween.path) {
          const path = ctx.contactPath(tween.from, tween.to, tween.fromBlend, tween.toBlend);
          if (path.length >= 2 && path.every(p => validPose(p.pose) && finite(p.blend))) {
            tween.path = path; tween.distances = [0];
            for (let index = 1; index < path.length; index++) {
              const a = path[index - 1], b = path[index];
              tween.distances.push(tween.distances[index - 1] + Math.max(Math.hypot(b.pose.x - a.pose.x, b.pose.y - a.pose.y, b.pose.z - a.pose.z), Math.abs(angle(a.pose.yaw, b.pose.yaw)) * .65, Math.abs(b.pose.tilt - a.pose.tilt) * .65, Math.abs(b.blend - a.blend) * .5, Math.abs((b.pose.bedSeat ?? 0) - (a.pose.bedSeat ?? 0)) * .5, Math.abs((b.pose.bedBreathing ?? 1) - (a.pose.bedBreathing ?? 1)), Math.abs((b.pose.bedLegLift ?? 0) - (a.pose.bedLegLift ?? 0)), EPS));
            }
          }
        }
        // Sleep's first supported path pose supplies the floor-side facing.
        // Its final supine yaw belongs on the bed, not on the ground approach.
        const facingYaw = tween.to.contact === 'sleep' && tween.path ? tween.path[0].pose.yaw : tween.to.yaw;
        if (ctx.isContactClear && s.frame.phase === 'dock' && tween.progress === 0 && Math.abs(angle(s.frame.pose.yaw, facingYaw)) > .001) {
          // Face the seat while still on its safe standing approach. Rotating
          // through a chair while translating sideways sweeps the trailing hand
          // into its solid back, even when the final seated body fits.
          const facing = { ...s.frame.pose, yaw: limitYaw(s.frame.pose.yaw, facingYaw, dt) };
          const canTraverse = (from: NavPoint, to: NavPoint) => validPoint(from) && validPoint(to) && dist(from, s.frame.pose) <= EPS && dist(to, s.frame.pose) <= EPS
            && safeCall(() => ctx.isContactClear!(s.frame.pose, facing, 0, 0));
          return proposal(s.frame.pose, facing.yaw, 0, canTraverse, { contactTransition: 'dock', contactTurning: true }, 0);
        }
        if (ctx.coordinateContacts === true && (tween.from.contact || tween.to.contact) && !reserveContact(s, tween, ctx)) {
          if (ctx.isContactClear && ctx.recoverYieldingRoute && ctx.yieldPlan && s.frame.phase === 'dock' && tween.progress === 0) {
            // The standing approach can itself obstruct a lower-id traveller.
            // No contact has begun: physically walk to a safe bay, then return
            // to this exact approach rather than freezing in its corridor.
            const peers = [...states.values()].filter(other => other.id !== s.id && peerPose(other).area === s.frame.pose.area);
            const priority = peers.filter(other => other.frame.active && other.id < s.id);
            if (priority.length) {
              const avoid = peers.map(other => ({ position: point(peerPose(other)), radius: other.radius }));
              const corridor = peerCorridor(peers), area = s.frame.pose.area;
              let retreat: LivingNavigationRoute | null = null;
              try { retreat = ctx.yieldPlan(point(s.frame.pose), area, avoid, corridor.samples); } catch { /* Keep the safe standing approach. */ }
              const end = retreat?.points.at(-1);
              if (retreat && !retreat.blocked && retreat.points.length >= 2 && retreat.points.every(validPoint) && dist(retreat.points[0], s.frame.pose) <= EPS && end
                && dist(end, s.frame.pose) > .15 && [...avoid, ...corridor.samples].every(peer => dist(end, peer.position) >= s.radius + peer.radius + .035 - EPS) && corridor.clear(end, s.radius)) {
                const approach = point(tween.from);
                s.stages.splice(s.stage, 0,
                  { kind: 'walk', area, goal: point(end), yielding: { peers: priority.map(other => ({ id: other.id, position: point(peerPose(other)), area: peerPose(other).area, goalKey: goalKey(other) })), checked: null } },
                  { kind: 'walk', area, goal: approach });
                s.tween = null; s.route = retreat; s.routeFingerprint = fingerprint; s.waypoint = 1;
                s.frame = frozenFrame(s, { ...s.frame.pose, contact: null }, 'walk', 0);
                // The next engine frame reinstates the standing clearance before
                // any movement; a contact-sized radius is never used to walk.
                return null;
              }
            }
          }
          // A waiting companion remains exactly seated/lying. A granted corridor
          // is held atomically for the whole physical contact transition.
          return proposal(s.frame.pose, s.frame.pose.yaw, 0, (from, to) => validPoint(from) && validPoint(to) && dist(from, s.frame.pose) <= EPS && dist(to, s.frame.pose) <= EPS,
            { contactTransition: s.frame.phase }, tween.progress);
        }
        let progress = Math.min(1, tween.progress + Math.min(dt / CONTACT_SECONDS, tween.distances ? CONTACT_SPEED * dt / tween.distances.at(-1)! : 1));
        if (tween.distances) {
          const total = tween.distances.at(-1)!, next = tween.distances.find(distance => distance > tween.progress * total + EPS);
          if (next !== undefined) progress = Math.min(progress, next / total);
        }
        let desired = sampleContact(tween, progress, s.frame.pose.contact).pose;
        const stepDistance = dist(s.frame.pose, desired), budget = CONTACT_SPEED * dt;
        if (stepDistance > budget) {
          progress = tween.progress + (progress - tween.progress) * budget / stepDistance;
          desired = sampleContact(tween, progress, s.frame.pose.contact).pose;
        }
        // Furniture contact permission is supplied by the engine. The controller
        // additionally confines it to this exact docking line, so traffic cannot
        // sidestep through the rest of a sofa/bed using that permission.
        const line = point(desired), start = point(s.frame.pose), area = s.frame.pose.area;
        const canTraverse = (from: NavPoint, to: NavPoint) => {
          const dx = line.x - start.x, dz = line.z - start.z, squared = dx * dx + dz * dz;
          const t = squared > EPS * EPS ? ((to.x - start.x) * dx + (to.z - start.z) * dz) / squared : 1;
          const projection = { x: start.x + dx * t, z: start.z + dz * t };
          if (!(validPoint(from) && validPoint(to) && dist(from, start) < EPS && t >= -EPS && t <= 1 + EPS && dist(to, projection) < EPS)) return false;
          if (!ctx.isContactClear) return safeCall(() => ctx.isClear(from, to, area));
          const acceptedProgress = tween.progress + (progress - tween.progress) * Math.max(0, Math.min(1, t));
          const accepted = sampleContact(tween, acceptedProgress, s.frame.pose.contact), here = s.frame.pose;
          if (!tween.path || Math.abs(accepted.pose.y - here.y) <= EPS) return safeCall(() => ctx.isContactClear!(here, accepted.pose, s.frame.contactBlend, accepted.blend));
          // Path heights are solved per point. Rise before moving and move
          // before settling, so a lerped height never cuts the bed's edge.
          const rising = accepted.pose.y > here.y;
          const middle = rising ? { pose: { ...here, y: accepted.pose.y }, blend: s.frame.contactBlend } : { pose: { ...accepted.pose, y: here.y }, blend: accepted.blend };
          return safeCall(() => ctx.isContactClear!(here, middle.pose, s.frame.contactBlend, middle.blend))
            && safeCall(() => ctx.isContactClear!(middle.pose, accepted.pose, middle.blend, accepted.blend));
        };
        return proposal(desired, desired.yaw, CONTACT_SPEED, canTraverse, { contactTransition: s.frame.phase }, progress);
      }
      const stage = currentStage(s);
      if (!stage) { beginDock(s); continue; }
      if (stage.kind === 'walk') {
        const retreatingPeer = !stage.yielding && [...states.values()].some(other => {
          const retreat = currentStage(other);
          return other.id !== s.id && other.frame.active && other.frame.phase !== 'blocked' && retreat?.kind === 'walk' && retreat.area === stage.area &&
            !!retreat.yielding?.peers.some(peer => peer.id === s.id) && dist(other.frame.pose, retreat.goal) > EPS;
        });
        if (retreatingPeer) {
          // A retreat is planned around the waiting body. Do not let that body
          // follow into and close the escape route before the other reaches its bay.
          setPhase(s, 'walk');
          return proposal(s.frame.pose, s.frame.pose.yaw, 0, (from, to) => dist(from, to) < EPS);
        }
        if (dist(s.frame.pose, stage.goal) <= EPS) {
          if (stage.yielding) {
            const held = stage.yielding, peers = held.peers.map(saved => ({ saved, other: states.get(saved.id) }));
            const check = fingerprint + '|' + peers.map(({ other }) => other ? `${other.id}:${Math.round(peerPose(other).x * 4)}:${Math.round(peerPose(other).z * 4)}:${other.frame.active}:${goalKey(other)}` : 'removed').join('|');
            const progressed = peers.every(({ saved, other }) => !other || !other.frame.active || peerPose(other).area !== saved.area || goalKey(other) !== saved.goalKey || dist(peerPose(other), saved.position) >= s.radius + other.radius + .1);
            if (progressed && held.checked !== check) {
              held.checked = check;
              const next = s.stages[s.stage + 1], avoid = peers.filter(p => p.other).map(({ other }) => ({ position: point(peerPose(other!)), radius: other!.radius }));
              let route: LivingNavigationRoute | null = null;
              if (next?.kind === 'walk') try { route = ctx.plan(point(s.frame.pose), next.goal, stage.area, avoid); } catch { /* Wait at the safe bay. */ }
              if (route && !route.blocked && route.points.length >= 2 && route.points.every(validPoint) && dist(route.points[0], s.frame.pose) <= EPS && next?.kind === 'walk' && dist(route.points.at(-1)!, next.goal) <= EPS) {
                advanceStage(s); s.route = route; s.routeFingerprint = fingerprint; s.waypoint = 1; continue;
              }
            }
            setPhase(s, 'walk');
            return proposal(s.frame.pose, s.frame.pose.yaw, 0, (from, to) => dist(from, to) < EPS);
          }
          advanceStage(s); continue;
        }
        if (!s.route) {
          try { s.route = ctx.plan(point(s.frame.pose), stage.goal, stage.area); s.routeFingerprint = fingerprint; } catch { return block(); }
          const route = s.route;
          if (!route || route.blocked || route.points.length < 2 || !route.points.every(validPoint) || dist(route.points[0], s.frame.pose) > EPS || dist(route.points.at(-1)!, stage.goal) > EPS) return block();
          s.waypoint = 1;
        }
        if (s.waited >= .9) {
          const peers = [...states.values()].filter(other => other.id !== s.id).map(other => ({ other, pose: peerPose(other) }))
            .filter(({ other, pose }) => (pose.area === stage.area || other.frame.active && ['portal', 'turn', 'wait-door'].includes(other.frame.phase)) && dist(s.frame.pose, pose) < s.radius + other.radius + 1.2);
          const activeCount = [...states.values()].filter(other => other.frame.active && peerPose(other).area === stage.area).length;
          const priority = peers.filter(({ other }) => !other.frame.active || other.id < s.id);
          const canYield = priority.length > 0 || activeCount < 3 && s.waited >= 1.8;
          if (peers.length && canYield) {
            // Only actual rejected motion accrues this delay. Replan to the exact
            // existing waypoint; no target, furniture, contact or business anchor changes.
            const avoid = peers.map(({ other, pose }) => ({ position: point(pose), radius: other.radius }));
            let alternative: LivingNavigationRoute | null = null;
            try { alternative = ctx.plan(point(s.frame.pose), stage.goal, stage.area, avoid); } catch { /* Keep the current safe route and wait. */ }
            const firstAlternative = alternative?.points.find(value => dist(value, s.frame.pose) > EPS), currentNext = s.route?.points[s.waypoint];
            const alternativeClear = alternative && !alternative.blocked && alternative.points.length >= 2 && alternative.points.every(validPoint)
              && dist(alternative.points[0], s.frame.pose) <= EPS && dist(alternative.points.at(-1)!, stage.goal) <= EPS
              && alternative.points.slice(1).every((to, index) => safeCall(() => ctx.isClear(alternative!.points[index], to, stage.area))
                && avoid.every(peer => pointSegmentDistance(peer.position, alternative!.points[index], to) >= s.radius + peer.radius + .035 - EPS));
            // Finding the same blocked first leg is not physical progress. Keep
            // accruing the real wait and permit a safe bay instead of resetting
            // the timer every time a planner repeats that route.
            if (alternativeClear && alternative && firstAlternative && (!currentNext || dist(firstAlternative, currentNext) > .05)) {
              s.route = alternative; s.routeFingerprint = fingerprint; s.waypoint = 1;
            } else if (ctx.yieldPlan && !stage.yielding) {
              const corridor = peerCorridor(peers.map(({ other }) => other)), keepFree = corridor.samples;
              let retreat: LivingNavigationRoute | null = null;
              try { retreat = ctx.yieldPlan(point(s.frame.pose), stage.area, avoid, keepFree); } catch { /* No safe bay leaves the original journey waiting. */ }
              const end = retreat?.points.at(-1);
              if (retreat && !retreat.blocked && retreat.points.length >= 2 && retreat.points.every(validPoint) && dist(retreat.points[0], s.frame.pose) <= EPS && end && dist(end, s.frame.pose) > .15 &&
                [...avoid, ...keepFree].every(peer => dist(end, peer.position) >= s.radius + peer.radius + .035 - EPS) && corridor.clear(end, s.radius)) {
                const owed = priority.length ? priority : peers;
                s.stages.splice(s.stage, 0, { kind: 'walk', area: stage.area, goal: point(end), yielding: { peers: owed.map(({ other, pose }) => ({ id: other.id, position: point(pose), area: pose.area, goalKey: goalKey(other) })), checked: null } });
                s.route = retreat; s.routeFingerprint = fingerprint; s.waypoint = 1; continue;
              }
            }
          }
        }
        while (s.waypoint < s.route.points.length && dist(s.frame.pose, s.route.points[s.waypoint]) <= EPS) s.waypoint++;
        if (s.waypoint >= s.route.points.length) { advanceStage(s); continue; }
        const next = s.route.points[s.waypoint], desired = towards(s.frame.pose, next, dt);
        const area = stage.area, canTraverse = (from: NavPoint, to: NavPoint) => validPoint(from) && validPoint(to) && safeCall(() => ctx.isClear(from, to, area));
        if (!canTraverse(s.frame.pose, desired)) { s.route = null; return block(); }
        setPhase(s, 'walk');
        return proposal(desired, yawBetween(s.frame.pose, desired), 1, canTraverse);
      }
      const owner = portalOwners.get(stage.door), legFrom = stage.points[stage.leg], legTo = stage.points[stage.leg + 1];
      if (s.holding && (owner === undefined || owner === s.id)) {
        // Return to the exact safe entry by a regional route, never diagonally
        // enter the portal from the waiting bay.
        s.holding = null; s.stages.splice(s.stage, 0, { kind: 'walk', area: stage.fromArea, goal: stage.from });
        s.route = null; s.waypoint = 1; setPhase(s, 'walk'); continue;
      }
      const readyIds = [...states.values()].filter(other => {
        if (!other.frame.active || other.frame.phase === 'blocked') return false;
        const current = currentStage(other), pending = current?.kind === 'walk' && dist(other.frame.pose, current.goal) <= EPS ? other.stages[other.stage + 1] : current;
        return pending?.kind === 'portal' && pending.door === stage.door && dist(other.frame.pose, pending.from) <= EPS;
      }).map(other => other.id);
      const priority = Math.min(s.id, ...readyIds);
      const readyForMe = safeCall(() => ctx.doorOpen(stage.door)) && safeCall(() => ctx.portalClear(s.frame.pose, legTo, stage.door));
      if (owner !== undefined && owner !== s.id || owner === undefined && priority !== s.id && readyForMe) {
        const staleHolding = s.holding && s.holding.fingerprint !== fingerprint ? s.holding : null;
        if (staleHolding) s.holding = null;
        if (!s.holding) {
          const dx = stage.to.x - stage.from.x, dz = stage.to.z - stage.from.z, size = Math.hypot(dx, dz);
          const forward = { x: dx / size, z: dz / size }, side = { x: forward.z, z: -forward.x };
          const options = [{ x: -forward.x, z: -forward.z }, side, { x: -side.x, z: -side.z }];
          for (const v of options) {
            const goal = { x: stage.from.x + v.x * 2.25, z: stage.from.z + v.z * 2.25 };
            let route: LivingNavigationRoute;
            try { route = ctx.plan(point(s.frame.pose), goal, stage.fromArea); } catch { continue; }
            if (!route || route.blocked || !route.points.length || !route.points.every(validPoint) || dist(route.points[0], s.frame.pose) > EPS || dist(route.points.at(-1)!, goal) > EPS) continue;
            s.holding = { door: stage.door, goal, route, waypoint: 1, fingerprint }; break;
          }
          if (!s.holding && staleHolding) {
            // Keep the fact that this actor left the doorway even if a revision
            // removes all waiting bays. It must later walk back to the exact entry.
            const here = point(s.frame.pose), route = { ...staleHolding.route, points: [here], cumulative: [0], length: 0, safeAnchor: here };
            s.holding = { door: stage.door, goal: here, route, waypoint: 1, fingerprint };
          }
        }
        const hold = s.holding;
        if (hold) {
          while (hold.waypoint < hold.route.points.length && dist(s.frame.pose, hold.route.points[hold.waypoint]) <= EPS) hold.waypoint++;
          if (hold.waypoint < hold.route.points.length) {
            const desired = towards(s.frame.pose, hold.route.points[hold.waypoint], dt), area = stage.fromArea;
            const canTraverse = (from: NavPoint, to: NavPoint) => safeCall(() => ctx.isClear(from, to, area));
            if (canTraverse(s.frame.pose, desired)) {
              setPhase(s, 'walk', stage.door);
              return proposal(desired, yawBetween(s.frame.pose, desired), 1, canTraverse, { waitingFor: stage.door });
            }
          }
        }
        setPhase(s, 'wait-door', stage.door);
        return proposal(s.frame.pose, s.frame.pose.yaw, 1, (from, to) => dist(from, to) < EPS, { waitingFor: stage.door });
      }
      const targetYaw = yawBetween(legFrom, legTo), yaw = finite(ctx.yaw ?? NaN) ? ctx.yaw! : s.frame.pose.yaw;
      if (s.frame.phase === 'turn' || Math.abs(angle(yaw, targetYaw)) > .001) {
        if (ctx.turnClear && !safeCall(() => ctx.turnClear!(s.frame.pose, stage.door))) {
          setPhase(s, 'wait-door', stage.door);
          return proposal(s.frame.pose, s.frame.pose.yaw, 1, (from, to) => dist(from, to) < EPS, { portal: stage.door, waitingFor: stage.door });
        }
        setPhase(s, 'turn');
        return proposal(s.frame.pose, limitYaw(yaw, targetYaw, dt), 1, (from, to) => dist(from, to) < EPS, { portal: stage.door });
      }
      const doorReady = readyForMe;
      if (!doorReady) {
        setPhase(s, 'wait-door', stage.door);
        return proposal(s.frame.pose, targetYaw, 1, (from, to) => dist(from, to) < EPS, { portal: stage.door, waitingFor: stage.door });
      }
      portalOwners.set(stage.door, s.id);
      setPhase(s, 'portal');
      const desired = towards(s.frame.pose, legTo, dt), canTraverse = (from: NavPoint, to: NavPoint) => {
        const dx = legTo.x - legFrom.x, dz = legTo.z - legFrom.z, squared = dx * dx + dz * dz;
        const t = ((to.x - legFrom.x) * dx + (to.z - legFrom.z) * dz) / squared;
        const onLine = { x: legFrom.x + dx * t, z: legFrom.z + dz * t };
        return validPoint(from) && validPoint(to) && t >= -EPS && t <= 1 + EPS && dist(to, onLine) < EPS &&
          safeCall(() => ctx.doorOpen(stage.door)) && safeCall(() => ctx.portalClear(from, to, stage.door));
      };
      return proposal(desired, targetYaw, 1, canTraverse, { portal: stage.door });
    }
    return block();
  }

  function commit(id: number, acceptedXZ: NavPoint, delta: number): JourneyFrame | null {
    const s = states.get(id); if (!s) return null;
    const pending = s.pending; s.pending = null;
    const dt = pending ? Math.min(pending.dt, boundedDt(delta)) : 0;
    if (!pending || !dt || !validPoint(acceptedXZ)) return s.frame;
    const p = pending.proposal, previous = s.frame.pose;
    if (dist(previous, acceptedXZ) > p.speed * dt + EPS || !safeCall(() => p.canTraverse(previous, acceptedXZ))) return s.frame;
    if (p.phase === 'dock' || p.phase === 'undock') {
      const tween = s.tween!;
      if (p.contactTurning) {
        tween.from = { ...tween.from, yaw: p.yaw }; s.frame = frozenFrame(s, { ...previous, yaw: p.yaw }, 'dock', 0); s.observed = s.frame.pose;
        return s.frame;
      }
      const dx = p.desired.x - previous.x, dz = p.desired.z - previous.z, squared = dx * dx + dz * dz;
      const accepted = squared > EPS * EPS ? Math.max(0, Math.min(1, ((acceptedXZ.x - previous.x) * dx + (acceptedXZ.z - previous.z) * dz) / squared)) : 1;
      tween.progress += (Math.min(pending.tweenProgress!, tween.progress + dt / CONTACT_SECONDS) - tween.progress) * accepted;
      const sample = sampleContact(tween, tween.progress, previous.contact), blend = sample.blend;
      const pose = { ...sample.pose, x: acceptedXZ.x, z: acceptedXZ.z };
      s.frame = frozenFrame(s, pose, p.phase, blend);
      if (tween.progress >= 1 - EPS && dist(pose, tween.to) <= EPS) {
        contacts.delete(id);
        if (p.phase === 'undock') { s.frame = frozenFrame(s, { ...tween.to, x: acceptedXZ.x, z: acceptedXZ.z }, 'walk', 0); s.contactApproach = null; makeStages(s); }
        else { s.frame = frozenFrame(s, { ...s.target.pose, x: acceptedXZ.x, z: acceptedXZ.z }, 'idle', s.target.pose.contact ? 1 : 0); s.tween = null; s.stages = []; }
      }
      s.waited = 0; s.observed = s.frame.pose;
      return s.frame;
    }
    s.waited = p.phase === 'walk' && dist(p.position, p.desired) > EPS && dist(previous, acceptedXZ) <= EPS ? s.waited + dt : 0;
    if (dist(previous, acceptedXZ) > EPS) s.blockedPeerFingerprint = null;
    const yaw = p.phase === 'turn' ? limitYaw(previous.yaw, p.yaw, dt) : dist(previous, acceptedXZ) > EPS ? p.yaw : previous.yaw;
    s.frame = frozenFrame(s, { ...previous, x: acceptedXZ.x, z: acceptedXZ.z, yaw, contact: null }, p.phase, 0, p.waitingFor);
    const stage = currentStage(s);
    if (p.phase === 'turn' && stage?.kind === 'portal' && Math.abs(angle(yaw, yawBetween(stage.points[stage.leg], stage.points[stage.leg + 1]))) <= .001) setPhase(s, 'portal');
    if (p.phase === 'portal' && stage?.kind === 'portal' && dist(acceptedXZ, stage.points[stage.leg + 1]) <= EPS) {
      if (stage.leg + 1 < stage.points.length - 1) { stage.leg++; setPhase(s, 'turn'); }
      else {
        releaseDoors(id);
        s.frame = frozenFrame(s, { ...s.frame.pose, area: stage.toArea }, 'walk', 0);
        if (s.afterPortal) { s.afterPortal = false; makeStages(s); } else advanceStage(s);
      }
    }
    s.observed = s.frame.pose; return s.frame;
  }
  function redirectYieldBay(id: number, route: LivingNavigationRoute): boolean {
    const s=states.get(id),stage=s&&currentStage(s),end=route.points.at(-1);
    if(!s||!s.frame.active||stage?.kind!=='walk'||!stage.yielding||route.blocked||route.points.length<2||!route.points.every(validPoint)||!end||dist(route.points[0],s.frame.pose)>EPS||dist(end,s.frame.pose)<=.15)return false;
    stage.goal=point(end);stage.yielding.checked=null;stage.yielding.recoveryChecked=undefined;
    s.route=route;s.waypoint=1;s.waited=0;s.blockedFingerprint=null;setPhase(s,'walk');return true;
  }
  function releaseYieldFor(id: number, peerId: number): boolean {
    const s = states.get(id), stage = s && currentStage(s);
    if (!s || !s.frame.active || stage?.kind !== 'walk' || !stage.yielding?.peers.some(peer => peer.id === peerId)) return false;
    // That peer now owns a coordinated courtesy route. Remove our old retreat
    // reservation while retaining the physical pose and original destination.
    beginFromActual(s, { ...s.frame.pose }, s.frame.contactBlend);
    return true;
  }
  function occupiesDoor(door: string): boolean {
    return [...states.values()].some(s => { const stage = currentStage(s); return s.frame.active && stage?.kind === 'portal' && stage.door === door && portalOwners.get(stage.door) === s.id && dist(s.frame.pose, stage.from) > EPS && dist(s.frame.pose, stage.to) > EPS; });
  }
  function diagnostics(id: number) {
    const s = states.get(id); if (!s) return null;
    return { phase: s.frame.phase, stage: s.stage, stages: s.stages.map(stage => ({ ...stage })),
      waypoint: s.waypoint, route: s.route?.points.map(p => ({ ...p })) ?? null, waited: s.waited,
      radius: s.radius, target: copyTarget(s.target), contacts: [...contacts].map(([owner, lane]) => ({ owner, ...lane })) };
  }
  return { reconcile, prepare, commit, releaseYieldFor, redirectYieldBay, get: (id: number) => states.get(id)?.frame ?? null, diagnostics,
    remove: (id: number) => { releaseDoors(id); contacts.delete(id); return states.delete(id); }, reset: (id?: number) => { if (id === undefined) { states.clear(); portalOwners.clear(); contacts.clear(); } else { releaseDoors(id); contacts.delete(id); states.delete(id); } }, occupiesDoor, canCrossContact };
}
