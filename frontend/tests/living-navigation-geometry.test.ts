import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHomeWorldEnvironment, setHomeWorldDoorOpenness, type HomeWorldDoorId } from '@/lib/living-home-world-meshes';
import { buildRealisticHomeItem } from '@/lib/living-home-realistic-details';
import { collectHomeNavigationObstacles, homeNavigationBounds } from '@/lib/living-home-navigation';
import { createLivingNavigation, sampleLivingNavigation, type NavBounds, type NavPoint } from '@/lib/living-navigation';
import { disposeLivingObject } from '@/lib/living-world-engine';
import type { HomeMaterialLibrary } from '@/lib/living-home-materials';

const roots: THREE.Group[] = [];
beforeEach(() => { vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>()); });
afterEach(() => { roots.splice(0).forEach(root => disposeLivingObject(root)); vi.restoreAllMocks(); });

function geometry(season: string = 'summer') {
  const stage = new THREE.Group(), environment = buildHomeWorldEnvironment(season, { resting: 10, sleeping: 10 }, { realistic: true }), items = new THREE.Group();
  const library = environment.userData.homeMaterialLibrary as HomeMaterialLibrary;
  const bench = buildRealisticHomeItem('bench', season, library); bench.position.set(0, 0, 4.42396); items.add(bench);
  const tree = buildRealisticHomeItem('tree', season, library); tree.position.set(-2, 0, 5.4); items.add(tree);
  const shade = buildRealisticHomeItem('shade', season, library); shade.position.set(2.2, 0, 4.5); items.add(shade);
  stage.add(environment, items); stage.updateWorldMatrix(true, true); roots.push(stage); return { stage, environment, items, bench };
}
function rect(box: THREE.Box3): NavBounds { return { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z }; }
function containsRect(outer: NavBounds, inner: NavBounds) { return outer.minX <= inner.minX + 1e-5 && outer.maxX >= inner.maxX - 1e-5 && outer.minZ <= inner.minZ + 1e-5 && outer.maxZ >= inner.maxZ - 1e-5; }
function solidBounds(root: THREE.Object3D) {
  const bounds: Array<{ name: string; box: THREE.Box3 }> = [];
  function visit(object: THREE.Object3D) {
    // Independent oracle: derive actual physical projections from tagged roots
    // and architecture meshes, never planner cells or helper-returned constants.
    let architecture: string | undefined;
    for (let p: THREE.Object3D | null = object; p; p = p.parent) if (typeof p.userData.architectureRole === 'string') { architecture = p.userData.architectureRole; break; }
    if (object.userData.homeNavObstacle || object instanceof THREE.Mesh && (architecture?.startsWith('exterior-wall') || ['interior-partition', 'door', 'courtyard-wall'].includes(architecture ?? ''))) {
      const box = new THREE.Box3().setFromObject(object, true);
      if (!box.isEmpty() && box.max.y >= .05 && box.min.y <= 1.6) bounds.push({ name: object.name || 'physical mesh', box });
      if (object.userData.homeNavObstacle) return;
    }
    object.children.forEach(visit);
  }
  visit(root); return bounds;
}
function segmentHits(box: THREE.Box3, a: NavPoint, b: NavPoint, clearance: number) {
  const expanded = new THREE.Box3(new THREE.Vector3(box.min.x - clearance, -1, box.min.z - clearance), new THREE.Vector3(box.max.x + clearance, 1, box.max.z + clearance));
  const from = new THREE.Vector3(a.x, 0, a.z), to = new THREE.Vector3(b.x, 0, b.z);
  if (expanded.containsPoint(from) || expanded.containsPoint(to)) return true;
  const distance = from.distanceTo(to); if (distance < 1e-10) return false;
  const hit = new THREE.Ray(from, to.clone().sub(from).normalize()).intersectBox(expanded, new THREE.Vector3());
  return !!hit && hit.distanceTo(from) <= distance + 1e-8;
}

describe('continuous routes against the actual home geometry', () => {
  it('covers real furniture, saved props and physical walls with world-space obstacles independent of cutaway visibility', () => {
    const { stage, environment, items, bench } = geometry(), actual = solidBounds(stage), obstacles = collectHomeNavigationObstacles(environment, items);
    expect(actual.length).toBeGreaterThan(30);
    expect(actual.some(b => b.name.includes('sofa-main'))).toBe(true); expect(actual.some(b => b.name.includes('room-bed-'))).toBe(true);
    expect(actual.some(b => b.name.includes('bench'))).toBe(true);
    for (const { name, box } of actual) expect(obstacles.some(obstacle => containsRect(obstacle, rect(box))), name).toBe(true);
    environment.visible = false;
    expect(collectHomeNavigationObstacles(environment, items)).toEqual(obstacles);
    expect(bench.position.toArray()).toEqual([0, 0, 4.42396]);
  });

  it.each(['spring', 'summer', 'autumn', 'winter'])('keeps every complete route edge and sampled point clear of actual chairs, trees, walls and gate in %s', season => {
    const { stage, environment, items, bench } = geometry(season), clearance = .8, bounds = homeNavigationBounds('outdoor');
    const raw = solidBounds(stage), navigator = createLivingNavigation({ bounds, blocked: collectHomeNavigationObstacles(environment, items), clearance });
    const at = bench.getWorldPosition(new THREE.Vector3()), route = navigator.plan({ anchor: { x: at.x, z: at.z }, id: 'physical-bench-walker' });
    expect(route.anchorCorrected).toBe(true); expect(route.blocked).toBeNull(); expect(route.length).toBeGreaterThan(1);
    expect(route.points.length).toBeGreaterThan(2); expect(route.points.at(-1)).toEqual(route.points[0]);
    for (let i = 1; i < route.points.length; i++) for (const obstacle of raw) expect(segmentHits(obstacle.box, route.points[i - 1], route.points[i], clearance), obstacle.name).toBe(false);
    const period = route.length / route.speed;
    for (const time of [...Array.from({ length: 401 }, (_, i) => period * i / 79), 1e5 + .125]) {
      const sample = sampleLivingNavigation(route, time, true); expect(sample.position).not.toBeNull(); expect(sample.blocked).toBeNull();
      const point = sample.position!;
      expect(point.x - clearance).toBeGreaterThan(bounds.minX); expect(point.x + clearance).toBeLessThan(bounds.maxX);
      expect(point.z - clearance).toBeGreaterThan(bounds.minZ); expect(point.z + clearance).toBeLessThan(bounds.maxZ);
      for (const obstacle of raw) expect(segmentHits(obstacle.box, point, point, clearance), `${obstacle.name} t=${time}`).toBe(false);
    }
    const paused = sampleLivingNavigation(route, period * .371, false);
    expect(paused.position).toEqual(sampleLivingNavigation(route, period * .371, true).position); expect(paused.moving).toBe(false);
  });

  it('contains every actual rotating door leaf in the conservative sweep without changing the hinge or allocating mesh resources', () => {
    const { environment, items } = geometry(), ids: HomeWorldDoorId[] = ['home-main-entry-door', 'home-room-connection-door', 'home-courtyard-gate'];
    const before: THREE.Object3D[] = []; environment.traverse(object => before.push(object));
    for (const id of ids) {
      setHomeWorldDoorOpenness(environment, id, .37); const leaf = environment.getObjectByName(id + '-leaf')!, angle = leaf.rotation.y;
      const obstacles = collectHomeNavigationObstacles(environment, items, [id]); expect(leaf.rotation.y).toBe(angle);
      const swept = obstacles.filter(obstacle => obstacle.source === leaf.name); expect(swept.length).toBeGreaterThan(0);
      for (let i = 0; i <= 128; i++) {
        setHomeWorldDoorOpenness(environment, id, i / 128); const actual = rect(new THREE.Box3().setFromObject(leaf, true));
        expect(swept.some(obstacle => containsRect(obstacle, actual)), `${id} at ${i}`).toBe(true);
      }
    }
    const after: THREE.Object3D[] = []; environment.traverse(object => after.push(object)); expect(after).toEqual(before);
  });

  it('reports no safe point explicitly when the real bench occupies the complete permitted region', () => {
    const { bench } = geometry(), box = new THREE.Box3().setFromObject(bench, true), center = box.getCenter(new THREE.Vector3());
    const route = createLivingNavigation({ bounds: rect(box), blocked: [rect(box)], clearance: .1 }).plan({ anchor: { x: center.x, z: center.z }, id: 4 });
    expect(route.blocked).toBe('no-safe-point'); expect(route.safeAnchor).toBeNull();
    for (const animate of [false, true]) { const sample = sampleLivingNavigation(route, 1e5, animate); expect(sample.position).toBeNull(); expect(sample.moving).toBe(false); expect(sample.blocked).toBe('no-safe-point'); }
  });
});
