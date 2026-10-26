import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateLivingNavigationAnchors, createLivingNavigation, sampleLivingNavigation, type NavBounds, type NavOccupied, type NavPoint } from '../lib/living-navigation';
import { buildHomeWorldEnvironment, setHomeWorldDoorOpenness } from '../lib/living-home-world-meshes';
import { buildRealisticHomeItem } from '../lib/living-home-realistic-details';
import { collectHomeNavigationObstacles, homeNavigationBounds } from '../lib/living-home-navigation';
import { homeWorldPoint } from '../lib/living-home-world';

const roots: THREE.Object3D[] = [];
beforeEach(() => {
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('navigation tests stay offline'); }));
});
afterEach(() => {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  roots.splice(0).forEach(root => root.traverse(o => { if (o instanceof THREE.Mesh) { geometries.add(o.geometry); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m)); } }));
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const gap = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
// Independent continuous circle oracle: test interiors of smoothed segments, not just graph nodes.
function circleDistance(a: NavPoint, b: NavPoint, p: NavPoint) {
  const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
  const fraction = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length)) : 0;
  return Math.hypot(a.x + fraction * dx - p.x, a.z + fraction * dz - p.z);
}
function rectangleHit(a: NavPoint, b: NavPoint, box: NavBounds, radius: number) {
  let low = 0, high = 1;
  for (const axis of ['x', 'z'] as const) {
    const origin = a[axis], delta = b[axis] - origin, min = (axis === 'x' ? box.minX : box.minZ) - radius, max = (axis === 'x' ? box.maxX : box.maxZ) + radius;
    if (Math.abs(delta) < 1e-12) { if (origin < min || origin > max) return false; }
    else { const t1 = (min - origin) / delta, t2 = (max - origin) / delta; low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2)); if (low > high) return false; }
  }
  return true;
}
function homeGraph() {
  const environment = buildHomeWorldEnvironment('summer', { resting: 0, sleeping: 0 }, { realistic: true }), items = new THREE.Group(); roots.push(environment, items);
  const doorIds = ['home-main-entry-door', 'home-room-connection-door', 'home-courtyard-gate'] as const;
  doorIds.forEach(id => setHomeWorldDoorOpenness(environment, id, 1));
  const bench = buildRealisticHomeItem('bench', 'summer', environment.userData.homeMaterialLibrary), p = homeWorldPoint('outdoor', { x: (.2 - .5) * 8, y: 0, z: (.7 - .5) * 5.2 });
  bench.position.set(p.x, p.y, p.z); items.add(bench);
  const blocked = collectHomeNavigationObstacles(environment, items, doorIds), bounds = homeNavigationBounds('outdoor');
  return { blocked, bounds, graph: createLivingNavigation({ bounds, blocked, clearance: .9 }) };
}

describe('dynamic partner envelopes on the cached static navigation grid', () => {
  it('preserves the static route and disperses seeded points deterministically', () => {
    const graph = createLivingNavigation({ bounds: { minX: -4, maxX: 4, minZ: -3, maxZ: 3 }, blocked: [], clearance: .5 });
    const anchor = { x: 0, z: 0 };
    expect(graph.findSafePoint(anchor, [])).toEqual(anchor);
    expect(graph.findSafePoint(anchor, [], 1)).toEqual(graph.findSafePoint(anchor, [], 1));
    expect(new Set(Array.from({ length: 16 }, (_, i) => JSON.stringify(graph.findSafePoint(anchor, [], i + 1)))).size).toBeGreaterThan(8);
    expect(graph.plan({ anchor, id: 1 })).toBe(graph.plan({ anchor, id: 1, avoid: [] }));
  });
  it('finds another tour around circular partners and checks every smoothed segment continuously', () => {
    const radius = .4, bounds = { minX: -5, maxX: 5, minZ: -4, maxZ: 4 }, blocked = [{ minX: -.5, maxX: .5, minZ: -.7, maxZ: .7 }];
    const graph = createLivingNavigation({ bounds, blocked, clearance: radius }), anchor = { x: -3, z: -2 }, original = graph.plan({ anchor, id: 17 });
    const a = original.points[0], b = original.points[1], peers: NavOccupied[] = [{ position: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, radius: .55 }];
    const route = graph.plan({ anchor, id: 17, avoid: peers });
    expect(route.blocked).toBeNull(); expect(route.points[0]).toEqual(anchor); expect(route.safeAnchor).toEqual(anchor); expect(route.anchorCorrected).toBe(false);
    expect(route.points).not.toEqual(original.points); expect(route.length).toBeGreaterThan(2);
    for (let i = 1; i < route.points.length; i++) {
      expect(circleDistance(route.points[i - 1], route.points[i], peers[0].position)).toBeGreaterThanOrEqual(radius + peers[0].radius + .035 - 1e-6);
      blocked.forEach(box => expect(rectangleHit(route.points[i - 1], route.points[i], box, radius)).toBe(false));
    }
    expect(sampleLivingNavigation(route, 0).position).toEqual(anchor);
  });
  it('can replan away from the solver contact band without relocating or penetrating the start', () => {
    const graph = createLivingNavigation({ bounds: { minX: -5, maxX: 5, minZ: -4, maxZ: 4 }, blocked: [], clearance: .9 });
    const avoid = [{ position: { x: 0, z: 0 }, radius: .9 }];
    for (const separation of [1.835, 1.8375, 1.838776779, 1.839999]) {
      const anchor = { x: separation, z: 0 }, route = graph.plan({ anchor, id: 'solver-contact', avoid });
      expect(route.blocked).toBeNull(); expect(route.safeAnchor).toEqual(anchor); expect(route.anchorCorrected).toBe(false);
      expect(route.points[0]).toEqual(anchor); expect(sampleLivingNavigation(route, 0).position).toEqual(anchor);
      expect(route.length).toBeGreaterThan(1);
      for (let i = 1; i < route.points.length; i++) {
        const clearance = circleDistance(route.points[i - 1], route.points[i], avoid[0].position);
        expect(clearance).toBeGreaterThanOrEqual(1.835 - 1e-6);
        expect(clearance).toBeGreaterThanOrEqual(1.8);
      }
      expect(sampleLivingNavigation(route, .1).position).not.toEqual(anchor);
    }
  });
  it('never relocates the current anchor when dynamically blocked or completely surrounded', () => {
    const anchor = { x: .123, z: -.234 }, graph = createLivingNavigation({ bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, blocked: [], clearance: .3 });
    for (const radius of [.1, 10]) {
      const route = graph.plan({ anchor, id: 'blocked', avoid: [{ position: anchor, radius }] });
      expect(route.blocked).toBe('no-path'); expect(route.safeAnchor).toEqual(anchor); expect(route.anchorCorrected).toBe(false);
      for (const time of [0, 1, 100]) { const sample = sampleLivingNavigation(route, time); expect(sample.position).toEqual(anchor); expect(sample.moving).toBe(false); }
    }
  });
  it('does not connect disconnected reachable components across an impassable circle barrier', () => {
    const graph = createLivingNavigation({ bounds: { minX: -4, maxX: 4, minZ: -1.3, maxZ: 1.3 }, blocked: [], clearance: .3 }), anchor = { x: -3, z: 0 }, avoid = [{ position: { x: 0, z: 0 }, radius: 1.05 }];
    const route = graph.plan({ anchor, id: 'left-only', avoid });
    expect(route.blocked).toBeNull(); expect(route.diagnostics.componentSize).toBeLessThan(route.diagnostics.nodeCount);
    for (const p of route.points) expect(p.x).toBeLessThan(0);
    for (let i = 1; i < route.points.length; i++) expect(circleDistance(route.points[i - 1], route.points[i], avoid[0].position)).toBeGreaterThanOrEqual(1.385 - 1e-6);
  });
  it('uses stable peer values in the cache and rejects invalid envelopes without a fallback route', () => {
    const graph = createLivingNavigation({ bounds: { minX: -5, maxX: 5, minZ: -4, maxZ: 4 }, blocked: [], clearance: .4 }), anchor = { x: -3, z: -2 };
    const avoid = [{ position: { x: 0, z: 0 }, radius: .5 }, { position: { x: 2, z: 1 }, radius: .6 }];
    expect(graph.plan({ anchor, id: 1, avoid })).toBe(graph.plan({ anchor, id: 1, avoid: [...avoid].reverse() }));
    expect(graph.plan({ anchor, id: 1, avoid })).not.toBe(graph.plan({ anchor, id: 1, avoid: [{ position: { x: .2, z: 0 }, radius: .5 }] }));
    const bad = graph.plan({ anchor, id: 1, avoid: [{ position: { x: NaN, z: 0 }, radius: 1 }] });
    expect(bad.blocked).toBe('no-path'); expect(bad.safeAnchor).toEqual(anchor);
  });
  it('packs ten same-anchor actors at radius .9 in the actual farmhouse static geometry, independent of actor input order', () => {
    const { graph, blocked, bounds } = homeGraph(), anchor = { x: -.8, z: 6.8 };
    // Enlarged physical chairs and the north tea stool reduce free grid nodes;
    // the ten-body allocation and independent continuous collision checks below remain strict.
    expect(graph.plan({ anchor, id: 4 }).diagnostics.nodeCount).toBe(455);
    const actors = Array.from({ length: 10 }, (_, i) => ({ id: i + 4, anchor, radius: .9, graph })), allocated = allocateLivingNavigationAnchors(actors), reversed = allocateLivingNavigationAnchors([...actors].reverse());
    expect([...allocated.values()].filter(Boolean)).toHaveLength(10); expect([...allocated]).toEqual([...reversed]);
    const points = [...allocated.values()] as NavPoint[];
    points.forEach((p, i) => {
      expect(p.x - .9).toBeGreaterThanOrEqual(bounds.minX); expect(p.x + .9).toBeLessThanOrEqual(bounds.maxX);
      expect(p.z - .9).toBeGreaterThanOrEqual(bounds.minZ); expect(p.z + .9).toBeLessThanOrEqual(bounds.maxZ);
      blocked.forEach(box => expect(rectangleHit(p, p, box, .9)).toBe(false));
      points.slice(i + 1).forEach(q => expect(gap(p, q)).toBeGreaterThanOrEqual(1.84 - 1e-6));
    });
  }, 15000);
  it('keeps fixed occupied actors clear and returns null for unplaceable actors rather than shrinking or overlapping', () => {
    const graph = createLivingNavigation({ bounds: { minX: -1.1, maxX: 1.1, minZ: -1.1, maxZ: 1.1 }, blocked: [], clearance: .9 }), anchor = { x: 0, z: 0 };
    const actors = Array.from({ length: 3 }, (_, id) => ({ id, anchor, radius: .9, graph }));
    expect([...allocateLivingNavigationAnchors(actors).values()].filter(Boolean)).toHaveLength(1);
    expect([...allocateLivingNavigationAnchors(actors, [{ position: anchor, radius: .9 }]).values()]).toEqual([null, null, null]);
    expect(allocateLivingNavigationAnchors([{ id: 4, anchor, radius: 1, graph }]).get(4)).toBeNull();
  });
});
