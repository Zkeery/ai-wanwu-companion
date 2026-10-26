import { describe, expect, it } from 'vitest';
import { createLivingNavigation, type LivingNavigationRoute, type NavPoint } from '../lib/living-navigation';
import { createHomeJourneyController, HOME_JOURNEY_PORTALS, type JourneyArea, type JourneyContext, type JourneyDoorId, type JourneyFrame, type JourneyPose, type JourneyProposal, type JourneyTarget } from '../lib/living-home-journey';
import { createLivingPedestrianTraffic } from '../lib/living-pedestrian-traffic';

const graph = createLivingNavigation({ bounds: { minX: -12, maxX: 12, minZ: -10, maxZ: 10 }, blocked: [], clearance: .3 });
const distance = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const pose = (x: number, z: number, area: JourneyArea = 'outdoor', contact: JourneyPose['contact'] = null): JourneyPose => ({ x, z, y: contact ? .6 : 0, yaw: 0, tilt: contact === 'sleep' ? Math.PI / 2 : 0, scale: 1, area, contact });
const target = (key: string, end: JourneyPose, approach: NavPoint = end): JourneyTarget => ({ key, pose: end, approach });
function context() {
  const doors = new Map<JourneyDoorId, boolean>([[HOME_JOURNEY_PORTALS.main.door, true], [HOME_JOURNEY_PORTALS.bedroom.door, true]]);
  const ctx: JourneyContext = { plan: (a, b) => graph.planTo({ from: a, to: b, id: 1 }), isClear: () => true, portalClear: () => true, doorOpen: door => doors.get(door) === true };
  return { doors, ctx };
}
function start(actual: JourneyPose, next: JourneyTarget) {
  const controller = createHomeJourneyController(); controller.reconcile(1, target('original', actual), actual); controller.reconcile(1, next, actual); return controller;
}
function tick(controller: ReturnType<typeof createHomeJourneyController>, ctx: JourneyContext, accept?: (p: JourneyProposal) => NavPoint) {
  const before = controller.get(1)!, p = controller.prepare(1, .1, { ...ctx, yaw: before.pose.yaw });
  if (!p) return { p, frame: controller.get(1)! };
  const accepted = accept?.(p) ?? p.desired;
  const frame = controller.commit(1, accepted, .1)!;
  expect(distance(before.pose, frame.pose)).toBeLessThanOrEqual(p.speed * .1 + 1e-6);
  return { p, frame };
}
function complete(controller: ReturnType<typeof createHomeJourneyController>, ctx: JourneyContext, limit = 700) {
  const frames: JourneyFrame[] = [], proposals: JourneyProposal[] = [];
  for (let i = 0; i < limit && controller.get(1)?.active; i++) {
    const t = tick(controller, ctx); frames.push(t.frame); if (t.p) proposals.push(t.p);
  }
  expect(controller.get(1)?.active, JSON.stringify(controller.get(1))).toBe(false);
  return { frames, proposals, frame: controller.get(1)! };
}

describe('free exact home journeys', () => {
  it('records the first snapshot without creating a trip, and repeated keys never restart it', () => {
    const c = createHomeJourneyController(), actual = pose(-4, 3), next = target('first', actual), { ctx } = context();
    const first = c.reconcile(1, next, actual);
    expect(first).toMatchObject({ active: false, phase: 'idle', pose: actual, targetKey: 'first' }); expect(c.prepare(1, .1, ctx)).toBeNull();
    c.reconcile(1, target('second', pose(-1, 3)), actual); tick(c, ctx); const progressing = c.get(1);
    expect(c.reconcile(1, target('second', pose(-1, 3)), actual)).toBe(progressing);
  });

  it('walks to the front door, aligns, crosses it, then docks in the living room', () => {
    const end = pose(-5, -4, 'indoor', 'rest'), c = start(pose(-4, 4), target('sofa', end, { x: -5, z: -3 })), { ctx } = context();
    const r = complete(c, ctx);
    expect(r.frame.pose).toEqual(end); expect(r.frame.contactBlend).toBe(1);
    expect(r.proposals.some(p => p.phase === 'turn')).toBe(true); expect(r.proposals.some(p => p.phase === 'portal')).toBe(true);
    expect(r.proposals.filter(p => p.phase === 'portal').every(p => p.portal === HOME_JOURNEY_PORTALS.main.door)).toBe(true);
    const main = HOME_JOURNEY_PORTALS.main, portalSteps = r.proposals.filter(p => p.phase === 'portal');
    expect(portalSteps.some(p => Math.abs(p.position.z - main.before.z) < 1e-6 && Math.abs(p.desired.x - p.position.x) > .01)).toBe(true);
    expect(portalSteps.some(p => Math.abs(p.position.x - main.elbow.x) < 1e-6 && Math.abs(p.desired.z - p.position.z) > .01)).toBe(true);
    expect(portalSteps.every(p => Math.abs(p.desired.x - p.position.x) < 1e-6 || Math.abs(p.desired.z - p.position.z) < 1e-6)).toBe(true);
    expect(r.frames.some(f => distance(f.pose, main.elbow) < 1e-6 && f.phase === 'turn' && f.pose.area === 'outdoor')).toBe(true);
    const firstInside = r.frames.findIndex(f => f.pose.area === 'indoor');
    expect(firstInside).toBeGreaterThan(0); expect(r.frames[firstInside].pose.x).toBeCloseTo(HOME_JOURNEY_PORTALS.main.after.x, 8);
    expect(r.frames[firstInside].pose.z).toBeCloseTo(HOME_JOURNEY_PORTALS.main.after.z, 8);
  });

  it('leaves a bedroom through the room door and then the front door instead of crossing a wall', () => {
    const end = pose(-4, 5), c = start(pose(5, -4, 'bedroom'), target('yard', end)), { ctx } = context();
    const r = complete(c, ctx), seen = r.proposals.filter(p => p.phase === 'portal').map(p => p.portal);
    expect(seen.indexOf(HOME_JOURNEY_PORTALS.bedroom.door)).toBe(0);
    expect(seen.indexOf(HOME_JOURNEY_PORTALS.main.door)).toBeGreaterThan(0);
    expect(r.frame.pose).toEqual(end);
  });

  it('waits at a closed door without moving, then continues only after it opens', () => {
    const entry = HOME_JOURNEY_PORTALS.main, { ctx, doors } = context(); doors.set(entry.door, false);
    const c = start({ ...pose(entry.before.x, entry.before.z), yaw: Math.PI }, target('inside', pose(-5, -3, 'indoor')));
    for (let i = 0; i < 40; i++) tick(c, ctx);
    expect(c.get(1)).toMatchObject({ active: true, phase: 'wait-door', waitingFor: entry.door, pose: entry.before });
    expect(c.occupiesDoor(entry.door)).toBe(false);
    doors.set(entry.door, true); expect(complete(c, ctx).frame.pose.area).toBe('indoor');
  });

  it('reports a doorway occupied during crossing and freezes if the doorway becomes unavailable', () => {
    const entry = HOME_JOURNEY_PORTALS.main, { ctx, doors } = context();
    const c = start({ ...pose(entry.before.x, entry.before.z), yaw: Math.PI }, target('inside', pose(-5, -3, 'indoor')));
    for (let i = 0; i < 7; i++) tick(c, ctx);
    expect(c.occupiesDoor(entry.door)).toBe(true); const stopped = c.get(1)!.pose;
    doors.set(entry.door, false); for (let i = 0; i < 10; i++) tick(c, ctx);
    expect(c.get(1)!.pose).toEqual(stopped); expect(c.occupiesDoor(entry.door)).toBe(true);
    doors.set(entry.door, true); complete(c, ctx); expect(c.occupiesDoor(entry.door)).toBe(false);
  });

  it('keeps a blocked route at its real point and retries on a door-state revision without teleporting', () => {
    const original = pose(-5, 4), c = start(original, target('yard-other', pose(-1, 4))), { ctx, doors } = context();
    let blocked = true, calls = 0;
    const dynamic: JourneyContext = { ...ctx, plan: (a, b, area) => { calls++; return blocked ? { ...ctx.plan(a, b, area), blocked: 'no-path', points: [] } : ctx.plan(a, b, area); } };
    expect(c.prepare(1, .1, dynamic)).toBeNull(); expect(c.get(1)).toMatchObject({ phase: 'blocked', pose: original });
    for (let i = 0; i < 10; i++) expect(c.prepare(1, .1, dynamic)).toBeNull(); expect(calls).toBe(1);
    blocked = false; doors.set(HOME_JOURNEY_PORTALS.bedroom.door, false);
    expect(complete(c, dynamic).frame.pose.x).toBe(-1); expect(calls).toBe(2);
  });

  it('does not advance a journey on rejected traffic proposals and can resume from the accepted point', () => {
    const original = pose(-5, 4), c = start(original, target('other', pose(-2, 4))), { ctx } = context();
    for (let i = 0; i < 30; i++) tick(c, ctx, p => p.position);
    expect(c.get(1)!.pose).toEqual(original); expect(c.get(1)!.phase).toBe('walk');
    const r = complete(c, ctx); expect(r.frame.pose.x).toBe(-2);
  });

  it('undocks and docks with accepted-distance contact blending, and cannot rise or sit while blocked', () => {
    const old = { ...pose(-5, -4, 'indoor', 'rest'), scale: .9 }, c = createHomeJourneyController(), { ctx } = context();
    c.reconcile(1, target('old-seat', old, { x: -5, z: -3 }), old);
    const end = { ...pose(5, -4, 'bedroom', 'sleep'), scale: .9 }; c.reconcile(1, target('new-bed', end, { x: 4, z: -4 }), old);
    for (let i = 0; i < 10; i++) tick(c, ctx, p => p.position);
    expect(c.get(1)).toMatchObject({ phase: 'undock', contactBlend: 1, pose: old });
    const first = tick(c, ctx); expect(first.frame.contactBlend).toBeLessThan(1); expect(first.frame.contactBlend).toBeGreaterThan(0);
    const r = complete(c, ctx); expect(r.frame.pose).toEqual(end); expect(r.frame.contactBlend).toBe(1);
    expect(r.frames.some(f => f.phase === 'walk' && f.pose.contact === null && f.contactBlend === 0)).toBe(true);
    expect(r.frames.filter(f => ['walk', 'portal'].includes(f.phase)).every(f => f.pose.scale === 1)).toBe(true);
    expect(r.frames.some(f => f.phase === 'dock' && f.pose.scale > .9 && f.pose.scale < 1)).toBe(true);
    expect(r.frames.some(f => f.phase === 'dock' && f.contactBlend > 0 && f.contactBlend < 1)).toBe(true);
  });

  it('pauses without position, yaw, contact, or stage progress and never catches up after resume', () => {
    const c = start(pose(-5, 4), target('other', pose(-2, 4))), { ctx } = context(); tick(c, ctx); const before = c.get(1);
    for (const dt of [0, -1, NaN, Infinity]) {
      expect(c.prepare(1, dt, ctx)).toBeNull(); expect(c.commit(1, { x: 100, z: 100 }, dt)).toBe(before);
    }
    const next = tick(c, ctx).frame; expect(distance(before!.pose, next.pose)).toBeLessThanOrEqual(.1 + 1e-6);
  });

  it('retargets in a doorway only after reaching its safe exit and never resurrects the old bedroom target', () => {
    const entry = HOME_JOURNEY_PORTALS.main, { ctx } = context();
    const c = start({ ...pose(entry.before.x, entry.before.z), yaw: Math.PI }, target('old-bed', pose(5, -4, 'bedroom', 'sleep'), { x: 4, z: -4 }));
    for (let i = 0; i < 7; i++) tick(c, ctx);
    const actual = c.get(1)!.pose; expect(c.occupiesDoor(entry.door)).toBe(true);
    const end = pose(-4, 5); c.reconcile(1, target('new-yard', end), actual);
    const r = complete(c, ctx);
    expect(r.frame.pose).toEqual(end); expect(r.frames.some(f => f.pose.area === 'indoor')).toBe(true);
    expect(r.proposals.every(p => p.portal !== HOME_JOURNEY_PORTALS.bedroom.door)).toBe(true);
    expect(r.frames.every(f => f.targetKey === 'new-yard')).toBe(true);
  });

  it('retargets an ordinary walk from its current actual position without resetting to its old anchor', () => {
    const c = start(pose(-5, 4), target('old', pose(-1, 4))), { ctx } = context();
    for (let i = 0; i < 12; i++) tick(c, ctx); const actual = c.get(1)!.pose;
    c.reconcile(1, target('new', pose(-4, 5)), actual); expect(c.get(1)!.pose).toEqual(actual);
    expect(complete(c, ctx).frame.pose).toEqual(pose(-4, 5));
  });

  it('rejects over-budget or invalid accepted positions and invalid new targets', () => {
    const c = start(pose(-5, 4), target('end', pose(-1, 4))), { ctx } = context();
    for (const bad of [{ x: 100, z: 100 }, { x: NaN, z: 0 }]) { const before = c.get(1); c.prepare(1, .1, ctx); expect(c.commit(1, bad, .1)).toBe(before); }
    const before = c.get(1); expect(c.reconcile(1, target('invalid', { ...pose(0, 0), scale: NaN }), before!.pose)).toBe(before);
    expect(c.get(1)!.targetKey).toBe('end');
  });

  it('lets two opposing bodies yield outside the portal, pass without overlap, and clean up on remove/reset', () => {
    const entry = HOME_JOURNEY_PORTALS.main, pair = createHomeJourneyController(), { ctx: pairCtx } = context(), traffic = createLivingPedestrianTraffic();
    const first = { ...pose(entry.before.x, entry.before.z), yaw: Math.PI }, second = pose(entry.after.x, entry.after.z, 'indoor');
    pair.reconcile(1, target('one-initial', first), first); pair.reconcile(2, target('two-initial', second), second);
    pair.reconcile(1, target('one-inside', pose(-6, -5, 'indoor')), first); pair.reconcile(2, target('two-outside', pose(-6, 5)), second);
    for (let i = 0; i < 1000 && (pair.get(1)!.active || pair.get(2)!.active); i++) {
      const before = [pair.get(1)!.pose, pair.get(2)!.pose], proposals = new Map<number, JourneyProposal>();
      // Reverse caller order still elects the lower id when both are ready.
      for (const id of [2, 1]) { const p = pair.prepare(id, .1, { ...pairCtx, revision: i < 35 ? 0 : 1, yaw: pair.get(id)!.pose.yaw }); if (p) proposals.set(id, p); }
      const output = traffic.step([1, 2].map(id => { const current = pair.get(id)!.pose, p = proposals.get(id); return { id, position: current, desired: p?.desired ?? current, region: 'home',
        radius: .9, speed: p?.speed ?? 0, walking: !!p && distance(p.position, p.desired) > 1e-6, canTraverse: p?.canTraverse ?? (() => false) }; }), .1);
      for (const id of [1, 2]) if (proposals.has(id)) pair.commit(id, output.get(id)!.position, .1);
      const after = [pair.get(1)!.pose, pair.get(2)!.pose];
      for (let t = 0; t <= 20; t++) {
        const a = { x: before[0].x + (after[0].x - before[0].x) * t / 20, z: before[0].z + (after[0].z - before[0].z) * t / 20 };
        const b = { x: before[1].x + (after[1].x - before[1].x) * t / 20, z: before[1].z + (after[1].z - before[1].z) * t / 20 };
        expect(distance(a, b)).toBeGreaterThanOrEqual(1.8 - 1e-6);
      }
    }
    expect(pair.get(1)).toMatchObject({ active: false, pose: { area: 'indoor' } });
    expect(pair.get(2)).toMatchObject({ active: false, pose: { area: 'outdoor' } });
    expect(pair.occupiesDoor(entry.door)).toBe(false);
    pair.remove(1); expect(pair.get(1)).toBeNull(); expect(pair.get(2)).not.toBeNull(); pair.reset(); expect(pair.get(2)).toBeNull();
    const c = start(pose(-5, 4), target('end', pose(-1, 4))), { ctx } = context(); tick(c, ctx);
    c.reconcile(2, target('second', pose(4, 4)), pose(4, 4));
    c.remove(1); expect(c.get(1)).toBeNull(); expect(c.get(2)).not.toBeNull(); expect(c.prepare(1, .1, ctx)).toBeNull();
    c.reset(); expect(c.get(2)).toBeNull(); expect(c.occupiesDoor(HOME_JOURNEY_PORTALS.main.door)).toBe(false);
  });

  it('waits for the real swept portal opening even when a logical door flag already says open', () => {
    const entry = HOME_JOURNEY_PORTALS.main, { ctx } = context(); let physicalClear = false;
    const physical: JourneyContext = { ...ctx, portalClear: () => physicalClear };
    const c = start({ ...pose(entry.before.x, entry.before.z), yaw: Math.PI }, target('inside', pose(-4, -3, 'indoor')));
    for (let i = 0; i < 10; i++) tick(c, physical); expect(c.get(1)!.phase).toBe('wait-door'); expect(c.get(1)!.pose.z).toBe(entry.before.z);
    physicalClear = true; expect(complete(c, physical).frame.pose.area).toBe('indoor');
  });

  it('rejects a planner that shifts the start or destination instead of silently teleporting', () => {
    const actual = pose(-5, 4), c = start(actual, target('end', pose(-1, 4))), { ctx } = context();
    const shifted: JourneyContext = { ...ctx, plan: (a, b, area): LivingNavigationRoute => { const route = ctx.plan(a, b, area); return { ...route, points: [{ x: a.x + .3, z: a.z }, b] }; } };
    expect(c.prepare(1, .1, shifted)).toBeNull(); expect(c.get(1)).toMatchObject({ phase: 'blocked', pose: actual });
  });

  it('retries the same blocked target on a geometry revision and invalidates an already walking stale route', () => {
    const actual = pose(-5, 4), end = target('unchanged', pose(-1, 4)), c = start(actual, end), { ctx } = context();
    let obstructed = true, revision = 1, calls = 0;
    const revised = (): JourneyContext => ({ ...ctx, revision, plan: (a, b, area) => { calls++; const route = ctx.plan(a, b, area); return obstructed ? { ...route, blocked: 'no-path', points: [] } : route; } });
    expect(c.prepare(1, .1, revised())).toBeNull(); expect(c.get(1)!.phase).toBe('blocked');
    obstructed = false; expect(c.prepare(1, .1, revised())).toBeNull(); expect(calls).toBe(1);
    revision = 2; const next = c.prepare(1, .1, revised()); expect(next).not.toBeNull(); expect(c.get(1)!.pose).toEqual(actual);
    c.commit(1, next!.desired, .1); expect(complete(c, revised()).frame.targetKey).toBe('unchanged');

    const moving = start(actual, end); for (let i = 0; i < 10; i++) tick(moving, { ...ctx, revision: 0 });
    const before = moving.get(1)!.pose, obstacle = createLivingNavigation({ bounds: { minX: -12, maxX: 12, minZ: -10, maxZ: 10 }, blocked: [{ minX: -3.1, maxX: -2.9, minZ: 3.5, maxZ: 4.5 }], clearance: .3 });
    const changed: JourneyContext = { ...ctx, revision: 1, plan: (a, b) => obstacle.planTo({ from: a, to: b, id: 1 }), isClear: (a, b) => obstacle.isSegmentClear(a, b) };
    const first = tick(moving, changed); expect(distance(before, first.frame.pose)).toBeLessThanOrEqual(.1 + 1e-6);
    expect(complete(moving, changed).frame.pose).toEqual(end.pose);
  });

  it('keeps the whole main-door reservation at the elbow, requires safe turning, and finishes the chain before retargeting', () => {
    const main = HOME_JOURNEY_PORTALS.main, { ctx } = context(); let clear = false;
    const guarded: JourneyContext = { ...ctx, turnClear: p => distance(p, main.elbow) > .01 || clear };
    const actual = { ...pose(main.before.x, main.before.z), yaw: -Math.PI / 2 };
    const c = start(actual, target('old-bedroom', pose(5, -4, 'bedroom', 'sleep'), { x: 4, z: -4 }));
    for (let i = 0; i < 40 && c.get(1)!.phase !== 'wait-door'; i++) tick(c, guarded);
    expect(c.get(1)).toMatchObject({ phase: 'wait-door', pose: main.elbow }); expect(c.occupiesDoor(main.door)).toBe(true);
    const frozen = c.get(1)!.pose; for (let i = 0; i < 10; i++) tick(c, guarded); expect(c.get(1)!.pose).toEqual(frozen);
    const end = pose(-5, 5); c.reconcile(1, target('new-yard', end), frozen); clear = true;
    const r = complete(c, guarded); expect(r.frames.some(f => f.pose.area === 'indoor')).toBe(true);
    expect(r.proposals.every(p => p.portal !== HOME_JOURNEY_PORTALS.bedroom.door)).toBe(true);
    expect(r.frame.pose).toEqual(end); expect(c.occupiesDoor(main.door)).toBe(false);
  });
});
