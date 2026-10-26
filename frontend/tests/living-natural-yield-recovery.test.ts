import { describe, expect, it } from 'vitest';
import { createHomeJourneyController, type JourneyContext, type JourneyPose, type JourneyProposal, type JourneyTarget } from '../lib/living-home-journey';
import { createLivingNavigation, type NavPoint } from '../lib/living-navigation';
const radius = .45, gap = .035;
const distance = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const pose = (x: number, z: number): JourneyPose => ({ x, y: 0, z, yaw: 0, tilt: 0, scale: 1, area: 'outdoor', contact: null });
const target = (key: string, p: JourneyPose): JourneyTarget => ({ key, pose: p, approach: p });
function segmentDistance(a: NavPoint, b: NavPoint, p: NavPoint) { const dx = b.x - a.x, dz = b.z - a.z, squared = dx * dx + dz * dz, t = squared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / squared)) : 0; return Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z); }
function scenario(recover: boolean | undefined, mode: 'normal' | 'blocked' | 'unsafe-plan' = 'normal') {
  const c = createHomeJourneyController(), end = pose(3, 0), bay = { x: -2, z: 2.5 }, peers = new Map([[2, pose(0, 0)], [3, pose(-4, -3)]]);
  let retreatCreated = false, changed = false, recoveryCalls = 0, returnedFromBay = false;
  const graph = () => createLivingNavigation({ bounds: { minX: -5, maxX: 5, minZ: -4, maxZ: 4 }, clearance: radius,
    blocked: [{ minX: -.08, maxX: .08, minZ: -4, maxZ: -.8 }, { minX: -.08, maxX: .08, minZ: .8, maxZ: 4 }, ...(changed && mode === 'blocked' ? [{ minX: 2.3, maxX: 3.7, minZ: -.7, maxZ: .7 }] : [])] });
  c.reconcile(1, target('origin', pose(-2, 0)), pose(-2, 0)); c.reconcile(1, target('real-destination', end), pose(-2, 0));
  for (const [id, p] of peers) c.reconcile(id, target('idle-' + id, p), p);
  const ctx: JourneyContext = { recoverYieldingRoute: recover, radius, revision: 'same-real-geometry',
    plan: (from, to, area, avoid) => { if (changed && avoid && distance(to, end) < 1e-6) recoveryCalls++; return graph().planTo({ from, to, id: 1, avoid: changed && mode === 'unsafe-plan' ? [] : avoid?.map(o => ({ ...o, radius: o.radius + gap })) }); },
    isClear: (from, to) => graph().isSegmentClear(from, to), portalClear: () => false, doorOpen: () => false,
    yieldPlan: (from, area, avoid) => { const route = graph().planTo({ from, to: bay, id: 'real-retreat', avoid: avoid.map(o => ({ ...o, radius: o.radius + gap })) }); if (!route.blocked) retreatCreated = true; return route; },
  };
  const samples: NavPoint[] = [], rejected: JourneyProposal[] = [];
  for (let frame = 0; frame < 350 && c.get(1)?.active; frame++) {
    const before = c.get(1)!.pose;
    if (retreatCreated && !changed && before.z > .5) {
      changed = true; peers.set(2, mode === 'unsafe-plan' ? pose(1, 0) : pose(2.5, -2)); peers.set(3, pose(bay.x, bay.z));
      for (const [id, p] of peers) c.reconcile(id, target('idle-' + id, p), p);
    }
    for (const id of peers.keys()) c.prepare(id, .1, ctx);
    const proposal = c.prepare(1, .1, { ...ctx, yaw: before.yaw }); if (!proposal) { samples.push({ x: before.x, z: before.z }); continue; }
    const clearPeers = [...peers.values()].every(peer => segmentDistance(proposal.position, proposal.desired, peer) >= radius * 2 + gap - 1e-6);
    const accepted = clearPeers && proposal.canTraverse(proposal.position, proposal.desired) ? proposal.desired : proposal.position;
    if (!clearPeers) rejected.push(proposal);
    const after = c.commit(1, accepted, .1)!; expect(distance(before, after.pose)).toBeLessThanOrEqual(proposal.speed * .1 + 1e-6);
    expect(graph().isSegmentClear(before, after.pose)).toBe(true); for (const peer of peers.values()) expect(segmentDistance(before, after.pose, peer)).toBeGreaterThanOrEqual(radius * 2 + gap - 1e-6);
    if (changed && after.pose.x > .3) returnedFromBay = true;
    samples.push({ x: after.pose.x, z: after.pose.z });
  }
  return { c, end, bay, samples, rejected, retreatCreated, changed, recoveryCalls, returnedFromBay };
}
describe('opt-in stale temporary retreat recovery', () => {
  it('abandons an obstructed old bay and physically follows a valid route to the unchanged original goal', () => {
    const r = scenario(true); expect(r.retreatCreated).toBe(true); expect(r.changed).toBe(true); expect(r.rejected.length).toBeGreaterThan(0); expect(r.recoveryCalls).toBeGreaterThan(0);
    expect(r.c.get(1)).toMatchObject({ active: false, phase: 'idle', targetKey: 'real-destination', pose: r.end }); expect(r.returnedFromBay).toBe(true);
    expect(r.samples.every(p => distance(p, r.bay) > radius * 2 + gap - 1e-6)).toBe(true);
  });
  it('preserves the original home-default behavior when the new recovery option is absent', () => {
    const r = scenario(undefined); expect(r.retreatCreated).toBe(true); expect(r.changed).toBe(true); expect(r.recoveryCalls).toBe(0); expect(r.c.get(1)?.active).toBe(true); expect(distance(r.c.get(1)!.pose, r.end)).toBeGreaterThan(1);
  });
  it('keeps safely waiting when the original destination is now physically blocked', () => {
    const r = scenario(true, 'blocked'); expect(r.retreatCreated).toBe(true); expect(r.changed).toBe(true); expect(r.recoveryCalls).toBeGreaterThan(0); expect(r.c.get(1)?.active).toBe(true); expect(distance(r.c.get(1)!.pose, r.end)).toBeGreaterThan(1);
  });
  it('rejects an unsafe replacement route that ignores a real peer rather than forcing passage', () => {
    const r = scenario(true, 'unsafe-plan'); expect(r.retreatCreated).toBe(true); expect(r.changed).toBe(true); expect(r.recoveryCalls).toBeGreaterThan(0); expect(r.c.get(1)?.active).toBe(true); expect(r.returnedFromBay).toBe(false);
  });
});

function blockedPeerScenario(enabled: boolean) {
  const c = createHomeJourneyController(), origin = pose(-3, 0), end = pose(3, 0);
  let peer = pose(0, 0), peerRadius = .45, plans = 0;
  const graph = createLivingNavigation({ bounds: { minX: -4, maxX: 4, minZ: -.9, maxZ: .9 }, clearance: .3, blocked: [] });
  c.reconcile(1, target('initial-floor', origin), origin); c.reconcile(1, target('unchanged-destination', end), origin); c.reconcile(2, target('unchanged-peer', peer), peer);
  const ctx: JourneyContext = { radius: .3, recoverYieldingRoute: enabled, revision: 'unchanged-fixed-world',
    plan: (from, to, area, avoid) => { plans++; return graph.planTo({ from, to, id: 1, avoid: avoid ?? [{ position: peer, radius: peerRadius }] }); },
    isClear: (from, to) => graph.isSegmentClear(from, to), portalClear: () => false, doorOpen: () => false,
  };
  function tick() {
    c.prepare(2, .1, { ...ctx, radius: peerRadius });
    const before = c.get(1)!.pose, p = c.prepare(1, .1, { ...ctx, yaw: before.yaw });
    if (p) {
      expect(segmentDistance(p.position, p.desired, peer)).toBeGreaterThanOrEqual(.3 + peerRadius + gap - 1e-6);
      const after = c.commit(1, p.desired, .1)!; expect(distance(before, after.pose)).toBeLessThanOrEqual(p.speed * .1 + 1e-6); expect(graph.isSegmentClear(before, after.pose)).toBe(true);
    }
  }
  return { c, end, tick, calls: () => plans, movePeer: () => { peer = pose(0, 3); c.reconcile(2, target('unchanged-peer', peer), peer); }, shrinkPeerRadius: () => { peerRadius = .1; } };
}
describe('opt-in ordinary blocked walking recovery', () => {
  it('retries the first blocked episode once, waits without repeated work, then walks when only the real peer position changes', () => {
    const r = blockedPeerScenario(true); r.tick(); expect(r.c.get(1)?.phase).toBe('blocked'); expect(r.calls()).toBe(1);
    r.tick(); expect(r.c.get(1)?.phase).toBe('blocked'); expect(r.calls()).toBe(2); for (let i = 0; i < 40; i++) r.tick(); expect(r.calls()).toBe(2);
    r.movePeer(); for (let i = 0; i < 160 && r.c.get(1)?.active; i++) r.tick(); expect(r.calls()).toBe(3); expect(r.c.get(1)).toMatchObject({ active: false, targetKey: 'unchanged-destination', pose: r.end });
    const original = blockedPeerScenario(false); for (let i = 0; i < 5; i++) original.tick(); original.movePeer(); for (let i = 0; i < 5; i++) original.tick(); expect(original.calls()).toBe(1); expect(original.c.get(1)?.phase).toBe('blocked');
  });
  it('replans once when only a real peer radius changes and follows the full collision-safe route', () => {
    const r = blockedPeerScenario(true); for (let i = 0; i < 10; i++) r.tick(); expect(r.calls()).toBe(2); expect(r.c.get(1)?.phase).toBe('blocked');
    r.shrinkPeerRadius(); for (let i = 0; i < 160 && r.c.get(1)?.active; i++) r.tick(); expect(r.calls()).toBe(3); expect(r.c.get(1)).toMatchObject({ active: false, targetKey: 'unchanged-destination', pose: r.end });
  });
});
