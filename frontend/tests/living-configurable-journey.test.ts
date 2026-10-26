import { describe, expect, it } from 'vitest';
import { createLivingNavigation, type NavPoint } from '../lib/living-navigation';
import { createLivingPedestrianTraffic } from '../lib/living-pedestrian-traffic';
import { createHomeJourneyController, HOME_JOURNEY_PORTALS, type JourneyArea, type JourneyContext, type JourneyDoorId, type JourneyPortalConfiguration, type JourneyPose, type JourneyProposal, type JourneyTarget } from '../lib/living-home-journey';

const graphFor = (a: NavPoint, b: NavPoint) => createLivingNavigation({ bounds: { minX: Math.min(a.x, b.x) - 3, maxX: Math.max(a.x, b.x) + 3, minZ: Math.min(a.z, b.z) - 3, maxZ: Math.max(a.z, b.z) + 3 }, blocked: [], clearance: .9 });
const distance = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const pose = (x: number, z: number, area: JourneyArea = 'outdoor', contact: JourneyPose['contact'] = null): JourneyPose => ({ x, z, y: contact ? .6 : 0, yaw: 0, tilt: contact === 'sleep' ? Math.PI / 2 : 0, scale: 1, area, contact });
const target = (key: string, end: JourneyPose, approach: NavPoint = end): JourneyTarget => ({ key, pose: end, approach });
const context = (): JourneyContext => ({ plan: (from, to, _area, avoid) => graphFor(from, to).planTo({ from, to, id: 1, avoid }), isClear: () => true, doorOpen: () => true, portalClear: () => true, radius: .9 });
type Controller = ReturnType<typeof createHomeJourneyController>;
function tick(c: Controller, ctx: JourneyContext, id = 1, delta = .1) {
  const before = c.get(id)!, p = c.prepare(id, delta, { ...ctx, yaw: before.pose.yaw });
  if (p) {
    expect(p.canTraverse(p.position, p.desired)).toBe(true);
    const next = c.commit(id, p.desired, delta)!;
    expect(distance(before.pose, next.pose)).toBeLessThanOrEqual(p.speed * Math.min(.1, delta) + 1e-6);
    expect([next.pose.x, next.pose.y, next.pose.z, next.pose.yaw, next.pose.tilt, next.pose.scale].every(Number.isFinite)).toBe(true);
  }
  return p;
}
function finish(c: Controller, ctx: JourneyContext) {
  const portals: JourneyProposal[] = [];
  for (let i = 0; i < 1300 && c.get(1)!.active; i++) { const p = tick(c, ctx); if (p?.phase === 'portal') portals.push(p); }
  expect(c.get(1)!.active, JSON.stringify(c.get(1))).toBe(false);
  return portals;
}
function mappedPortals(map: (p: NavPoint) => NavPoint): JourneyPortalConfiguration {
  return { main: { door: HOME_JOURNEY_PORTALS.main.door, before: map(HOME_JOURNEY_PORTALS.main.before), elbow: map(HOME_JOURNEY_PORTALS.main.elbow), after: map(HOME_JOURNEY_PORTALS.main.after) },
    bedroom: { door: HOME_JOURNEY_PORTALS.bedroom.door, before: map(HOME_JOURNEY_PORTALS.bedroom.before), after: map(HOME_JOURNEY_PORTALS.bedroom.after) } };
}
function onSegment(p: NavPoint, a: NavPoint, b: NavPoint) {
  const dx = b.x - a.x, dz = b.z - a.z, t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz);
  return t >= -1e-6 && t <= 1 + 1e-6 && distance(p, { x: a.x + dx * t, z: a.z + dz * t }) < 1e-6;
}

describe('configurable exact doorway journeys', () => {
  it('retains frame-for-frame default home behavior for an explicit default configuration', () => {
    const a = createHomeJourneyController(), b = createHomeJourneyController(HOME_JOURNEY_PORTALS), ctx = context(), actual = pose(-4, 4), end = target('bed', pose(5, -4, 'bedroom', 'sleep'), { x: 4, z: -4 });
    for (const c of [a, b]) { c.reconcile(1, target('initial', actual), actual); c.reconcile(1, end, actual); }
    for (let i = 0; i < 800 && a.get(1)!.active; i++) { tick(a, ctx); tick(b, ctx); expect(a.get(1)).toEqual(b.get(1)); }
    expect(a.get(1)).toMatchObject({ active: false, pose: end.pose });
  });

  for (const [name, map] of [
    ['translated forest', (p: NavPoint) => ({ x: p.x + 17, z: p.z + 8 })],
    ['rotated desert', (p: NavPoint) => ({ x: -18 - p.z, z: -11 + p.x })],
  ] as const) it('walks, docks and returns only through configured ' + name + ' portals', () => {
    const portals = mappedPortals(map), c = createHomeJourneyController(portals), ctx = context();
    const mappedPose = (x: number, z: number, area: JourneyArea = 'outdoor', contact: JourneyPose['contact'] = null): JourneyPose => ({ ...pose(x, z, area, contact), ...map({ x, z }) });
    const original = mappedPose(-4, 4); c.reconcile(1, target('initial', original), original);
    const trips = [target('rest', mappedPose(-5, -4, 'indoor', 'rest'), map({ x: -5, z: -3 })), target('sleep', mappedPose(5, -4, 'bedroom', 'sleep'), map({ x: 4, z: -4 })), target('walk', mappedPose(-4, 5))];
    const seen: JourneyDoorId[] = [];
    for (const end of trips) {
      c.reconcile(1, end, c.get(1)!.pose);
      for (const step of finish(c, ctx)) {
        const portal = step.portal === portals.main.door ? portals.main : portals.bedroom;
        const points = 'elbow' in portal && portal.elbow ? [portal.before, portal.elbow, portal.after] : [portal.before, portal.after];
        expect(points.slice(1).some((p, i) => onSegment(step.position, points[i], p) && onSegment(step.desired, points[i], p))).toBe(true);
        if (seen.at(-1) !== step.portal) seen.push(step.portal!);
      }
      expect(c.get(1)!.pose).toEqual(end.pose);
      expect(c.get(1)!.contactBlend).toBe(end.pose.contact ? 1 : 0);
    }
    expect(seen).toEqual([portals.main.door, portals.bedroom.door, portals.main.door]);
    expect(c.occupiesDoor(portals.main.door)).toBe(false);
  });

  it('supports a straight main portal with no elbow and crosses the configured threshold', () => {
    const portals: JourneyPortalConfiguration = { main: { door: 'home-main-entry-door', before: { x: 10, z: 10 }, after: { x: 10, z: 6 } }, bedroom: { door: 'home-room-connection-door', before: { x: 10, z: 5 }, after: { x: 14, z: 5 } } };
    const c = createHomeJourneyController(portals), ctx = context(), actual = pose(10, 10), end = target('indoor', pose(8, 4, 'indoor'));
    c.reconcile(1, target('initial', actual), actual); c.reconcile(1, end, actual);
    const steps = finish(c, ctx); expect(steps.length).toBeGreaterThan(20);
    expect(steps.every(p => p.position.x === 10 && p.desired.x === 10 && p.desired.z <= 10 && p.desired.z >= 6)).toBe(true);
    expect(c.get(1)!.pose).toEqual(end.pose);
  });

  it('copies nested caller points and keeps its route when the input is later changed', () => {
    const input = { main: { door: 'home-main-entry-door' as const, before: { x: 10, z: 10 }, elbow: { x: 10, z: 8 }, after: { x: 12, z: 8 } }, bedroom: { door: 'home-room-connection-door' as const, before: { x: 13, z: 8 }, after: { x: 15, z: 8 } } };
    const original = structuredClone(input), c = createHomeJourneyController(input), ctx = context(), actual = pose(10, 10);
    input.main.before.x = 40; input.main.elbow.z = -40; input.main.after.x = NaN; input.bedroom.before.z = Infinity;
    c.reconcile(1, target('initial', actual), actual); c.reconcile(1, target('bed', pose(18, 6, 'bedroom')), actual);
    const steps = finish(c, ctx);
    expect(steps.some(p => distance(p.position, original.main.elbow) < 1e-6)).toBe(true);
    expect(steps.some(p => distance(p.desired, original.bedroom.after) < 1e-6)).toBe(true);
    expect(Object.isFrozen(HOME_JOURNEY_PORTALS)).toBe(true); expect(Object.isFrozen(HOME_JOURNEY_PORTALS.main.before)).toBe(true);
  });

  it('rejects missing, invalid-door, nonfinite, overflow and zero-length geometry at construction', () => {
    const changed = (edit: (config: { main: { door: string; before: { x: number; z: number }; elbow?: { x: number; z: number }; after: { x: number; z: number } }; bedroom: { door: string; before: { x: number; z: number }; after: { x: number; z: number } } }) => void) => { const config = structuredClone(HOME_JOURNEY_PORTALS); edit(config); return config; };
    const bad: unknown[] = [null, {}, changed(p => { p.main.door = p.bedroom.door; }), changed(p => { p.main.before.x = NaN; }), changed(p => { p.bedroom.after.z = Infinity; }),
      changed(p => { p.main.elbow = { ...p.main.before }; }), changed(p => { p.main.after = { ...p.main.before }; }), changed(p => { p.bedroom.after = { ...p.bedroom.before }; }),
      changed(p => { p.main.before.x = -1e308; p.main.after.x = 1e308; })];
    for (const config of bad) expect(() => createHomeJourneyController(config as JourneyPortalConfiguration)).toThrow();
  });

  it('pauses mid-portal without releasing ownership, drifting, or catching up', () => {
    const portals = mappedPortals(p => ({ x: p.x + 17, z: p.z + 8 })), c = createHomeJourneyController(portals), ctx = context(), actual = pose(portals.main.before.x, portals.main.before.z);
    c.reconcile(1, target('initial', actual), actual); c.reconcile(1, target('inside', pose(12, 4, 'indoor')), actual);
    for (let i = 0; i < 100 && !c.occupiesDoor(portals.main.door); i++) tick(c, ctx);
    expect(c.occupiesDoor(portals.main.door)).toBe(true); const before = c.get(1);
    for (const delta of [0, -1, NaN, Infinity]) { expect(c.prepare(1, delta, ctx)).toBeNull(); expect(c.commit(1, { x: 50, z: 50 }, delta)).toBe(before); }
    expect(c.occupiesDoor(portals.main.door)).toBe(true);
    const p = tick(c, ctx, 1, 1000)!; expect(distance(before!.pose, c.get(1)!.pose)).toBeLessThanOrEqual(p.speed * .1 + 1e-6);
    finish(c, ctx); expect(c.occupiesDoor(portals.main.door)).toBe(false);
  });

  it('serializes opposing bodies at a configured door, waits outside it, and finishes both trips', () => {
    const portals: JourneyPortalConfiguration = { main: { door: 'home-main-entry-door', before: { x: 10, z: 10 }, after: { x: 10, z: 6 } }, bedroom: { door: 'home-room-connection-door', before: { x: 10, z: 5 }, after: { x: 14, z: 5 } } };
    const c = createHomeJourneyController(portals), ctx = context(), traffic = createLivingPedestrianTraffic(), seenWait = new Set<number>();
    for (const [id, actual, end] of [[1, pose(10, 10), pose(5, 3, 'indoor')], [2, pose(10, 6, 'indoor'), pose(5, 14)]] as const) {
      c.reconcile(id, target('initial-' + id, actual), actual); c.reconcile(id, target('end-' + id, end), actual);
    }
    for (let frame = 0; frame < 1200 && (c.get(1)!.active || c.get(2)!.active); frame++) {
      const before = [c.get(1)!.pose, c.get(2)!.pose], proposals = new Map<number, JourneyProposal>();
      for (const id of [2, 1]) { const p = c.prepare(id, .1, { ...ctx, yaw: c.get(id)!.pose.yaw }); if (p) { proposals.set(id, p); if (p.waitingFor) seenWait.add(id); } }
      expect([...proposals.values()].filter(p => p.phase === 'portal').length).toBeLessThanOrEqual(1);
      const output = traffic.step([1, 2].map(id => { const current = c.get(id)!.pose, p = proposals.get(id); return { id, position: current, desired: p?.desired ?? current, region: 'configured', radius: .9, speed: p?.speed ?? 0,
        walking: !!p && distance(p.position, p.desired) > 1e-6, canTraverse: p?.canTraverse ?? (() => false) }; }), .1);
      for (const id of [1, 2]) if (proposals.has(id)) c.commit(id, output.get(id)!.position, .1);
      const after = [c.get(1)!.pose, c.get(2)!.pose];
      for (let i = 0; i <= 10; i++) expect(distance({ x: before[0].x + (after[0].x - before[0].x) * i / 10, z: before[0].z + (after[0].z - before[0].z) * i / 10 }, { x: before[1].x + (after[1].x - before[1].x) * i / 10, z: before[1].z + (after[1].z - before[1].z) * i / 10 })).toBeGreaterThanOrEqual(1.8 - 1e-6);
    }
    expect(seenWait.has(2)).toBe(true);
    expect(c.get(1)).toMatchObject({ active: false, pose: { x: 5, z: 3, area: 'indoor' } }); expect(c.get(2)).toMatchObject({ active: false, pose: { x: 5, z: 14, area: 'outdoor' } });
    expect(c.occupiesDoor(portals.main.door)).toBe(false);
  });
});
