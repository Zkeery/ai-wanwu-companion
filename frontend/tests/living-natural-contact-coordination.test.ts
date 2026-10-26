import { describe, expect, it } from 'vitest';
import { createHomeJourneyController, type JourneyContext, type JourneyPose, type JourneyProposal, type JourneyTarget } from '../lib/living-home-journey';
import { createLivingNavigation, type NavPoint } from '../lib/living-navigation';
import { createLivingPedestrianTraffic, type LivingPedestrianActor } from '../lib/living-pedestrian-traffic';
const dist = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const standing = (x: number, z: number): JourneyPose => ({ x, y: 0, z, yaw: 0, tilt: 0, scale: 1, area: 'outdoor', contact: null });
const sitting = (x: number, z: number): JourneyPose => ({ ...standing(x, z), y: .1, scale: .9, contact: 'rest' });
const target = (key: string, p: JourneyPose, approach: NavPoint = p): JourneyTarget => ({ key, pose: p, approach });
function context(radius: number, coordinateContacts = true): JourneyContext {
  const graph = createLivingNavigation({ bounds: { minX: -8, maxX: 8, minZ: -6, maxZ: 6 }, clearance: radius, blocked: [] });
  return { coordinateContacts, recoverYieldingRoute: true, radius, revision: 'fixed-real-clearance', plan: (from, to, area, avoid) => graph.planTo({ from, to, id: 1, avoid }), isClear: graph.isSegmentClear, portalClear: () => false, doorOpen: () => false };
}
function oneHolder(coordinateContacts = true) {
  const c = createHomeJourneyController(), start = sitting(0, 0), ctx = context(.4, coordinateContacts);
  c.reconcile(10, target('seat', start, { x: 2, z: 0 }), start); c.reconcile(10, target('depart', standing(4, 0)), start);
  return { c, ctx, start };
}

describe('opt-in atomic contact corridors', () => {
  it('serializes two intersecting real undocking lanes and then walks both companions to their original destinations', () => {
    const c = createHomeJourneyController(), traffic = createLivingPedestrianTraffic(), radii = new Map([[1, .85], [2, .8]]), contexts = new Map([...radii].map(([id, r]) => [id, context(r)]));
    const seats = [sitting(.55, 2.7), sitting(2, .94)], approaches = [{ x: 1.95, z: 2.7 }, { x: 2, z: 2.34 }], goals = [standing(4.5, 2.7), standing(-3, -2.5)];
    // This controller-only fixture has no bench mesh: the first exit goes away
    // from the occupied bench rather than asking the unrelated local Traffic
    // detour to discover a missing physical furniture boundary. The shared
    // contact lanes, full standing radii, gap and all collision checks stay exact.
    for (const id of [1, 2]) { c.reconcile(id, target('seat-' + id, seats[id - 1], approaches[id - 1]), seats[id - 1]); c.prepare(id, .1, contexts.get(id)!); }
    for (const id of [1, 2]) c.reconcile(id, target('floor-' + id, goals[id - 1]), seats[id - 1]);
    const firstMotion = new Map<number, number>(); let firstFinished = -1, heldAtSource = 0;
    for (let frame = 0; frame < 600 && [1, 2].some(id => c.get(id)?.active); frame++) {
      const proposals = new Map<number, JourneyProposal>(), previous = new Map([1, 2].map(id => [id, c.get(id)!.pose]));
      for (const id of [1, 2]) { const p = c.prepare(id, .1, { ...contexts.get(id)!, yaw: c.get(id)!.pose.yaw }); if (p) proposals.set(id, p); }
      const actors: LivingPedestrianActor[] = [1, 2].map(id => { const p = proposals.get(id), position = c.get(id)!.pose, radius = radii.get(id)!; return { id, region: 'one-floor', position, desired: p?.desired ?? position, radius, walking: !!p && dist(p.position, p.desired) > 1e-7, speed: p?.speed ?? 0, canTraverse: (from, to) => c.canCrossContact(id, from, to, radius) && (p ? p.canTraverse(from, to) : dist(from, to) < 1e-6) }; });
      const resolved = traffic.step(actors, .1);
      for (const id of [1, 2]) { const p = proposals.get(id); if (!p) continue; const accepted = resolved.get(id)!.position, after = c.commit(id, accepted, .1)!; expect(dist(previous.get(id)!, after.pose)).toBeLessThanOrEqual(p.speed * .1 + 1e-6); if (p.contactTransition === 'undock' && dist(previous.get(id)!, after.pose) > 1e-6 && !firstMotion.has(id)) firstMotion.set(id, frame); }
      if (firstFinished < 0 && c.get(1)!.pose.contact === null && c.get(1)!.phase !== 'undock') firstFinished = frame;
      if (!firstMotion.has(2)) { expect(c.get(2)!.pose).toEqual(seats[1]); expect(c.get(2)!.contactBlend).toBe(1); heldAtSource++; }
      expect(dist(c.get(1)!.pose, c.get(2)!.pose)).toBeGreaterThanOrEqual(.85 + .8 + .035 - 1e-6);
    }
    expect(heldAtSource).toBeGreaterThan(1); expect(firstMotion.get(1)).toBeDefined(); expect(firstMotion.get(2), JSON.stringify({ states: [c.get(1), c.get(2)], firstFinished, firstMotion: [...firstMotion] })).toBeDefined(); expect(firstFinished).toBeGreaterThanOrEqual(0); expect(firstMotion.get(2)).toBeGreaterThan(firstFinished);
    for (const id of [1, 2]) expect(c.get(id)).toMatchObject({ active: false, phase: 'idle', targetKey: 'floor-' + id, pose: goals[id - 1] });
    expect(c.canCrossContact(3, { x: -.5, z: 2.7 }, { x: 3, z: 2.7 }, .4)).toBe(true);
  });
  it('reserves the whole future capsule before its first step and prevents an outsider from entering it', () => {
    const { c, ctx } = oneHolder(); const p = c.prepare(10, .1, ctx)!; expect(p.speed).toBeGreaterThan(0);
    expect(c.canCrossContact(20, { x: 1, z: 2 }, { x: 1, z: -2 }, .2)).toBe(false);
    expect(c.canCrossContact(20, { x: 1.9, z: .5 }, { x: 1.9, z: -.5 }, .2)).toBe(false);
    expect(c.canCrossContact(20, { x: -1, z: .7 }, { x: 3, z: .7 }, .2)).toBe(true);
    expect(c.canCrossContact(10, { x: 0, z: 0 }, { x: 2, z: 0 }, .4)).toBe(true);
    expect(c.canCrossContact(20, { x: NaN, z: 0 }, { x: 1, z: 0 }, .2)).toBe(false);
    const traffic = createLivingPedestrianTraffic(), other = { x: 1, z: .7 };
    const result = traffic.step([{ id: 10, region: 'floor', position: p.position, desired: p.desired, radius: .4, walking: true, speed: p.speed, canTraverse: (a, b) => p.canTraverse(a, b) && c.canCrossContact(10, a, b, .4) }, { id: 20, region: 'floor', position: other, desired: { x: 1, z: -.7 }, radius: .2, walking: true, speed: 1, canTraverse: (a, b) => c.canCrossContact(20, a, b, .2) }], .1);
    expect(c.canCrossContact(20, other, result.get(20)!.position, .2)).toBe(true); expect(result.get(20)!.position.z).toBeGreaterThanOrEqual(.635 - 1e-6);
  });
  it('never lets a later lower-id request steal an already entered corridor, then releases it on removal', () => {
    const { c, ctx } = oneHolder(), waiting = sitting(.5, 1.5); c.reconcile(1, target('other-seat', waiting, { x: .5, z: -1.5 }), waiting); c.prepare(1, .1, ctx);
    const first = c.prepare(10, .1, ctx)!; c.commit(10, first.desired, .1); const entered = c.get(10)!.pose; expect(entered.x).toBeGreaterThan(0);
    c.reconcile(1, target('other-depart', standing(-3, 0)), waiting); const denied = c.prepare(1, .1, ctx)!; expect(denied.speed).toBe(0); c.commit(1, denied.position, .1); expect(c.get(1)!.pose).toEqual(waiting);
    expect(c.prepare(10, .1, ctx)!.speed).toBeGreaterThan(0); expect(c.canCrossContact(1, { x: .5, z: 1.5 }, { x: .5, z: -1.5 }, .4)).toBe(false);
    c.remove(10); expect(c.canCrossContact(1, { x: .5, z: 1.5 }, { x: .5, z: -1.5 }, .4)).toBe(true); expect(c.prepare(1, .1, ctx)!.speed).toBeGreaterThan(0);
  });
  it('releases cancelled and reset corridors and leaves the original default behavior opt-out', () => {
    const { c, ctx } = oneHolder(); const first = c.prepare(10, .1, ctx)!; c.commit(10, first.desired, .1); c.reconcile(10, target('changed-activity', standing(-4, 0)), c.get(10)!.pose);
    expect(c.canCrossContact(20, { x: 1, z: 2 }, { x: 1, z: -2 }, .2)).toBe(true); c.prepare(10, .1, ctx); expect(c.canCrossContact(20, { x: 1, z: 2 }, { x: 1, z: -2 }, .2)).toBe(false);
    c.reset(10); expect(c.canCrossContact(20, { x: 1, z: 2 }, { x: 1, z: -2 }, .2)).toBe(true);
    const all = oneHolder(); all.c.prepare(10, .1, all.ctx); all.c.reset(); expect(all.c.canCrossContact(20, { x: 1, z: 2 }, { x: 1, z: -2 }, .2)).toBe(true);
    const original = oneHolder(false); expect(original.c.prepare(10, .1, original.ctx)!.speed).toBeGreaterThan(0); expect(original.c.canCrossContact(20, { x: 1, z: 2 }, { x: 1, z: -2 }, .2)).toBe(true);
  });
});
