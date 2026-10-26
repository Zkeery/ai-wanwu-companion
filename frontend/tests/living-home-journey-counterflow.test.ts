import { describe, expect, it } from 'vitest';
import { createLivingNavigation, type NavOccupied, type NavPoint } from '../lib/living-navigation';
import { createHomeJourneyController, type JourneyArea, type JourneyContext, type JourneyPose, type JourneyProposal, type JourneyTarget } from '../lib/living-home-journey';
import { createLivingPedestrianTraffic } from '../lib/living-pedestrian-traffic';

const wall = { minX: -11, maxX: 11, minZ: -.15, maxZ: .15 };
const graph = createLivingNavigation({ bounds: { minX: -11, maxX: 11, minZ: -9, maxZ: 9 }, blocked: [wall], clearance: .9 });
const distance = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const pose = (x: number, z: number, area: JourneyArea = 'indoor', contact: JourneyPose['contact'] = null): JourneyPose => ({ x, z, y: contact ? .6 : 0, yaw: 0, tilt: 0, scale: contact ? .9 : 1, area, contact });
const target = (key: string, end: JourneyPose, approach: NavPoint = end): JourneyTarget => ({ key, pose: end, approach });

function fixture() {
  const c = createHomeJourneyController(), plans: Array<{ from: NavPoint; to: NavPoint; avoid: readonly NavOccupied[] }> = [];
  const ctx: JourneyContext = { radius: .9, revision: 1, doorOpen: () => true, portalClear: () => true, turnClear: () => true,
    isClear: (a, b) => graph.isSegmentClear(a, b),
    plan: (a, b, _area, avoid) => { plans.push({ from: a, to: b, avoid: avoid ?? [] }); return graph.planTo({ from: a, to: b, id: 1, avoid }); } };
  const register = (id: number, actual: JourneyPose, next: JourneyTarget) => { c.reconcile(id, target('initial-'+id, actual), actual); c.reconcile(id, next, actual); };
  return { c, ctx, plans, register };
}

describe('accepted-position journeys through tight counterflow', () => {
  it('replans a real stopped walk-stage encounter around the other body and both finish', () => {
    const { c, ctx, plans, register } = fixture(), traffic = createLivingPedestrianTraffic();
    // Derived from the actual saved-house red trace, rather than ideal doorway endpoints.
    const a = pose(-3.195516850119172, -3.489352519033034), b = pose(-2.560886653392069, -1.718808605581836);
    register(4, a, target('walk-outside', pose(2, 5.395238095238095, 'outdoor')));
    register(5, b, target('rest-inside', pose(-5.65, -5.65, 'indoor', 'rest'), { x: -5.65, z: -4 }));
    for (let frame = 0; frame < 900 && (c.get(4)!.active || c.get(5)!.active); frame++) {
      const proposals = new Map<number, JourneyProposal>(), before = [c.get(4)!.pose, c.get(5)!.pose];
      for (const id of [4, 5]) { const p = c.prepare(id, .1, { ...ctx, yaw: c.get(id)!.pose.yaw }); if (p) proposals.set(id, p); }
      const out = traffic.step([4, 5].map(id => { const current = c.get(id)!.pose, p = proposals.get(id); return { id, region: 'home', position: current, desired: p?.desired ?? current, radius: .9,
        walking: !!p && distance(p.position, p.desired) > 1e-7, speed: p?.speed ?? 0, heading: p ? { x: Math.sin(p.yaw), z: Math.cos(p.yaw) } : undefined, canTraverse: p?.canTraverse ?? (() => false) }; }), .1);
      for (const id of [4, 5]) if (proposals.has(id)) c.commit(id, out.get(id)!.position, .1);
      const after = [c.get(4)!.pose, c.get(5)!.pose];
      for (let t = 0; t <= 20; t++) {
        const a = { x: before[0].x + (after[0].x - before[0].x) * t / 20, z: before[0].z + (after[0].z - before[0].z) * t / 20 };
        const b = { x: before[1].x + (after[1].x - before[1].x) * t / 20, z: before[1].z + (after[1].z - before[1].z) * t / 20 };
        expect(distance(a, b)).toBeGreaterThanOrEqual(1.8 - 1e-6);
      }
    }
    expect(c.get(4)!.active, JSON.stringify(c.get(4))).toBe(false); expect(c.get(5)!.active, JSON.stringify(c.get(5))).toBe(false);
    expect(plans.some(p => p.avoid.length > 0)).toBe(true);
  });

  it('allows a priority walker to request a safe alternative after prolonged actual standstill', () => {
    const { c, ctx, plans, register } = fixture();
    register(4, pose(-5, -2), target('forward', pose(-1, -2)));
    register(5, pose(-3, -2), target('other-forward', pose(-6, -2)));
    // The traffic controller has accepted no forward motion, as in a doorway approach.
    for (let frame = 0; frame < 24; frame++) {
      const p = c.prepare(4, .1, ctx); if (p) c.commit(4, p.position, .1);
    }
    expect(c.get(4)!.pose.x).toBe(-5);
    expect(plans.some(p => p.avoid.some(peer => distance(peer.position, { x: -3, z: -2 }) < 1e-6))).toBe(true);
  });

  it('keeps its exact goal and actual position when the avoidance request has no safe endpoint', () => {
    const { c, ctx, plans, register } = fixture(), actual = pose(-5, -2), end = pose(-3, -2);
    register(5, actual, target('same-goal', end));
    c.reconcile(4, target('stationary', end), end);
    for (let frame = 0; frame < 20; frame++) { const p = c.prepare(5, .1, ctx); if (p) c.commit(5, p.position, .1); }
    expect(c.get(5)!.pose).toEqual(actual); expect(c.get(5)!.targetKey).toBe('same-goal');
    expect(plans.some(p => p.avoid.length > 0 && distance(p.to, end) < 1e-6)).toBe(true);
    expect(c.get(5)!.active).toBe(true);
  });

  it('backs into a safe T-junction bay when neither original goal can be reached around the other body', () => {
    const tight = createLivingNavigation({ bounds: { minX: -6, maxX: 6, minZ: -2, maxZ: 5 },
      blocked: [{ minX: -6, maxX: 6, minZ: -2, maxZ: -1.05 }, { minX: -1, maxX: 6, minZ: 1.05, maxZ: 5 }], clearance: .9, step: .16 });
    const c = createHomeJourneyController(), traffic = createLivingPedestrianTraffic(); let retreats = 0;
    const ctx: JourneyContext = { radius: .9, revision: 1, doorOpen: () => true, portalClear: () => true,
      isClear: (a, b) => tight.isSegmentClear(a, b), plan: (a, b, _area, avoid) => tight.planTo({ from: a, to: b, id: 1, avoid }),
      yieldPlan: (from, _area, avoid, keepFree) => {
        const bay = { x: -4, z: 3 };
        if ([...avoid, ...keepFree].some(p => distance(bay, p.position) < .9 + p.radius + .04)) return null;
        const route = tight.planTo({ from, to: bay, id: 1, avoid }); if (route.blocked) return null;
        retreats++; return route;
      } };
    for (const [id, actual, end] of [[4, pose(-1, 0), pose(4.5, 0)], [5, pose(1, 0), pose(-4.5, 0)]] as const) {
      c.reconcile(id, target('initial-'+id, actual), actual); c.reconcile(id, target('original-goal-'+id, end), actual);
    }
    for (let frame = 0; frame < 900 && (c.get(4)!.active || c.get(5)!.active); frame++) {
      const proposals = new Map<number, JourneyProposal>(), before = [c.get(4)!.pose, c.get(5)!.pose];
      for (const id of [4, 5]) { const p = c.prepare(id, .1, { ...ctx, yaw: c.get(id)!.pose.yaw }); if (p) proposals.set(id, p); }
      const out = traffic.step([4, 5].map(id => { const current = c.get(id)!.pose, p = proposals.get(id); return { id, region: 'home', position: current, desired: p?.desired ?? current, radius: .9,
        walking: !!p && distance(p.position, p.desired) > 1e-7, speed: p?.speed ?? 0, heading: p ? { x: Math.sin(p.yaw), z: Math.cos(p.yaw) } : undefined, canTraverse: p?.canTraverse ?? (() => false) }; }), .1);
      for (const id of [4, 5]) if (proposals.has(id)) c.commit(id, out.get(id)!.position, .1);
      const after = [c.get(4)!.pose, c.get(5)!.pose];
      for (let t = 0; t <= 20; t++) {
        const a = { x: before[0].x + (after[0].x - before[0].x) * t / 20, z: before[0].z + (after[0].z - before[0].z) * t / 20 };
        const b = { x: before[1].x + (after[1].x - before[1].x) * t / 20, z: before[1].z + (after[1].z - before[1].z) * t / 20 };
        expect(distance(a, b)).toBeGreaterThanOrEqual(1.8 - 1e-6);
      }
    }
    expect(retreats).toBe(1); expect(c.get(4)).toMatchObject({ active: false, targetKey: 'original-goal-4', pose: { x: 4.5, z: 0 } });
    expect(c.get(5)).toMatchObject({ active: false, targetKey: 'original-goal-5', pose: { x: -4.5, z: 0 } });
  });

  it('waits for the yielding peer to reach its bay before advancing into its retreat path', () => {
    const { c, ctx, register } = fixture(), bay = { x: -3, z: -5 };
    const retreatContext: JourneyContext = { ...ctx, yieldPlan: (from, _area, avoid) => graph.planTo({ from, to: bay, id: 5, avoid }) };
    register(4, pose(-5, -2), target('priority-goal', pose(-1, -2)));
    register(5, pose(-3, -2), target('original-goal', pose(-6, -2)));
    let retreat: JourneyProposal | null = null;
    for (let i = 0; i < 20; i++) {
      const p = c.prepare(5, .1, retreatContext)!;
      if (p.desired.z < -2 - 1e-6) { retreat = p; break; }
      c.commit(5, p.position, .1);
    }
    expect(retreat).not.toBeNull();
    const waiting = c.prepare(4, .1, retreatContext)!;
    expect(waiting.desired).toEqual(waiting.position);
    c.commit(4, waiting.position, .1); c.commit(5, retreat!.desired, .1);
    for (let i = 0; i < 100 && distance(c.get(5)!.pose, bay) > 1e-6; i++) {
      const p = c.prepare(5, .1, retreatContext)!; c.commit(5, p.desired, .1);
    }
    expect(distance(c.get(5)!.pose, bay)).toBeLessThan(1e-6);
    const resumed = c.prepare(4, .1, retreatContext)!;
    expect(distance(resumed.position, resumed.desired)).toBeGreaterThan(.09);
    expect(c.get(5)!.targetKey).toBe('original-goal');
  });
});
