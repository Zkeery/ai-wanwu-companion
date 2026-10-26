import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectNaturalNavigationObstacles, naturalNavigationBounds } from '@/lib/living-natural-navigation';
import { createLivingNavigation, sampleLivingNavigation, type NavBounds, type NavPoint } from '@/lib/living-navigation';

const roots: THREE.Object3D[] = [];
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('natural navigation must stay offline'); })); });
afterEach(() => {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  roots.splice(0).forEach(root => root.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } }));
  geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function group() { const root = new THREE.Group(); roots.push(root); return root; }
function box(name: string, width = 1, height = 1, depth = 1) { const value = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial()); value.name = name; value.userData.naturalNavObstacle = true; return value; }
function localMatrix(object: THREE.Object3D) { return object.matrixAutoUpdate ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale) : object.matrix.clone(); }
function independentWorldMatrix(object: THREE.Object3D): THREE.Matrix4 { const local = localMatrix(object); return object.parent ? independentWorldMatrix(object.parent).multiply(local) : local; }
// Read raw vertices and independently composed transforms, without Box3 or cached bounds.
function expectedBounds(root: THREE.Object3D) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  root.traverse(object => { if (!(object instanceof THREE.Mesh)) return; const positions = object.geometry.getAttribute('position'), e = independentWorldMatrix(object).elements;
    for (let i = 0; i < positions.count; i++) { const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i), wx = e[0] * x + e[4] * y + e[8] * z + e[12], wz = e[2] * x + e[6] * y + e[10] * z + e[14]; minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz); }
  }); return { minX: minX - .002, maxX: maxX + .002, minZ: minZ - .002, maxZ: maxZ + .002 };
}
function expectBounds(actual: NavBounds, expected: NavBounds) { for (const key of ['minX', 'maxX', 'minZ', 'maxZ'] as const) expect(actual[key]).toBeCloseTo(expected[key], 10); }
function snapshot(root: THREE.Object3D) { const values: unknown[] = []; root.traverse(object => values.push({ object, parent: object.parent, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrix: object.matrix.toArray(), auto: object.matrixAutoUpdate, visible: object.visible, data: JSON.stringify(object.userData), geometry: object instanceof THREE.Mesh ? { boundingBox: object.geometry.boundingBox, attributes: Array.from(object.geometry.getAttribute('position').array) } : null })); return values; }
function segmentHits(a: NavPoint, b: NavPoint, obstacle: NavBounds, radius: number) {
  let enter = 0, exit = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, obstacle.minX - radius, obstacle.maxX + radius], [a.z, b.z - a.z, obstacle.minZ - radius, obstacle.maxZ + radius]]) {
    if (Math.abs(delta) < 1e-12) { if (start < min || start > max) return false; }
    else { const first = (min - start) / delta, second = (max - start) / delta; enter = Math.max(enter, Math.min(first, second)); exit = Math.min(exit, Math.max(first, second)); if (enter > exit) return false; }
  } return true;
}

describe('natural forest and desert navigation geometry', () => {
  it.each(['forest', 'desert'] as const)('%s keeps the legacy anchor rectangle and full .9m body margin inside the shared bounds', scene => {
    const bounds = naturalNavigationBounds(scene); expect(bounds).toEqual({ minX: -7, maxX: 7, minZ: -5.8, maxZ: 5.8 });
    for (const x of [-4, 4]) for (const z of [-2.8, 2.8]) { expect(x - .9).toBeGreaterThan(bounds.minX); expect(x + .9).toBeLessThan(bounds.maxX); expect(z - .9).toBeGreaterThan(bounds.minZ); expect(z + .9).toBeLessThan(bounds.maxZ); }
  });

  it('refreshes nested transforms and uses precise world vertices rather than stale geometry bounds', () => {
    const parent = group(); parent.position.set(2, .3, -.5); parent.rotation.y = .63; parent.scale.set(1.2, .7, .9);
    const structure = group(); structure.name = 'timber-cabin'; structure.userData.naturalNavObstacle = true; structure.position.set(-1, .2, 1.5); structure.rotation.y = -.37; structure.scale.set(.8, 1.1, 1.3); parent.add(structure);
    const triangle = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -.2, 0, .5, 2, .2, .2, .4, 1.4], 3)), new THREE.MeshStandardMaterial()); triangle.position.set(.4, .3, -.6); triangle.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-99, -99, -99), new THREE.Vector3(99, 99, 99)); structure.add(triangle);
    const expected = expectedBounds(structure), result = collectNaturalNavigationObstacles(parent, null); expect(result).toHaveLength(1); expect(result[0].source).toBe('timber-cabin'); expectBounds(result[0], expected); expect(Math.abs(result[0].maxX)).toBeLessThan(10);
  });

  it('collects underwater planes and high tagged solids regardless of hidden roots or transparent materials', () => {
    const environment = group(); environment.visible = false;
    const water = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.6), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0 })); water.name = 'oasis-water'; water.userData.naturalNavObstacle = true; water.rotation.x = -Math.PI / 2; water.position.set(.3, -.2, -.4); water.visible = false; environment.add(water);
    const tall = box('tent-canopy-solid', 1.4, .2, 1.2); tall.position.set(-2, 4, 1); environment.add(tall);
    const result = collectNaturalNavigationObstacles(environment, null); expect(result.map(row => row.source)).toEqual(['oasis-water', 'tent-canopy-solid']); expectBounds(result[0], expectedBounds(water)); expectBounds(result[1], expectedBounds(tall)); expect(water.visible).toBe(false); expect(water.material.opacity).toBe(0);
  });

  it('takes a marked parent once across overlapping roots and does not duplicate its tagged children', () => {
    const environment = group(), tent = group(), child = box('tent-pole'); tent.name = 'canvas-tent'; tent.userData.naturalNavObstacle = true; environment.add(tent); tent.add(child);
    const ignored = box('unmarked-floor', 20, .01, 20); delete ignored.userData.naturalNavObstacle; environment.add(ignored);
    const result = collectNaturalNavigationObstacles(child, environment); expect(result).toHaveLength(1); expect(result[0].source).toBe('canvas-tent'); expectBounds(result[0], expectedBounds(tent)); expect(collectNaturalNavigationObstacles(environment, environment)).toEqual(result);
  });

  it('keeps saved item obstacles, anonymous source identity and exact .002m margins independently of the environment', () => {
    const environment = group(), items = group(), trunk = box('tree-trunk', .4, 2, .4), saved = box('', .6, .5, 1.2); trunk.position.set(-2, 1, 0); saved.position.set(1.7, .25, 1.4); environment.add(trunk); items.add(saved);
    const result = collectNaturalNavigationObstacles(environment, items); expect(result.map(row => row.source)).toEqual(['tree-trunk', saved.uuid]); expectBounds(result[1], expectedBounds(saved)); expect(result[1].minX).toBeCloseTo(1.398, 7); expect(result[1].maxZ).toBeCloseTo(2.002, 7); expect(Object.isFrozen(result)).toBe(true); expect(result.every(Object.isFrozen)).toBe(true);
  });

  it('ignores null roots, empty marked groups, non-finite geometry and non-boolean markers', () => {
    const environment = group(), invalid = box('invalid-transform'), empty = group(), nonFiniteGeometry = box('invalid-vertices'), unmarked = box('string-marker'); invalid.position.x = Infinity; empty.userData.naturalNavObstacle = true; nonFiniteGeometry.geometry.setAttribute('position', new THREE.Float32BufferAttribute([NaN, 0, 0, 1, 1, 1], 3)); unmarked.userData.naturalNavObstacle = 'true'; environment.add(invalid, empty, nonFiniteGeometry, unmarked);
    expect(collectNaturalNavigationObstacles(null, null)).toEqual([]); expect(collectNaturalNavigationObstacles(environment, null)).toEqual([]);
  });

  it('leaves transforms, vertices, user data and visibility intact, yet recomputes subsequent moved item bounds without changing old records', () => {
    const environment = group(), items = group(), object = box('saved-bench', 1.2, .6, .5); object.position.set(.5, .3, -.4); object.rotation.y = .4; object.visible = false; object.userData.saved = { x: .55, y: .42 }; items.add(object); environment.updateWorldMatrix(true, true); items.updateWorldMatrix(true, true);
    const before = snapshot(items), first = collectNaturalNavigationObstacles(environment, items), record = { ...first[0] }; expect(snapshot(items)).toEqual(before); expect(object.geometry.boundingBox).toBeNull();
    object.position.x += 1.25; const second = collectNaturalNavigationObstacles(environment, items); expect(second[0].minX - first[0].minX).toBeCloseTo(1.25, 10); expect(first[0]).toEqual(record); expect(object.userData.saved).toEqual({ x: .55, y: .42 });
  });

  it.each(['forest', 'desert'] as const)('%s feeds real low water and buildings to continuous safe routes, including corrected anchors and a frozen sample', scene => {
    const environment = group(), items = group(), water = box('low-water', 2.4, .01, 1.8), building = box('cabin-or-shelter', 1.4, 2.4, 1.4), prop = box('saved-tree', .5, 2, .5); water.position.set(0, -.15, -.6); building.position.set(2.4, 1.2, 1.6); prop.position.set(-2.8, 1, 1.7); environment.add(water, building); items.add(prop);
    const bounds = naturalNavigationBounds(scene), obstacles = collectNaturalNavigationObstacles(environment, items), clearance = .55, route = createLivingNavigation({ bounds, blocked: obstacles, clearance, step: .2 }).plan({ anchor: { x: 0, z: -.6 }, id: 4 });
    expect(route.blocked).toBeNull(); expect(route.anchorCorrected).toBe(true); expect(route.length).toBeGreaterThan(0); expect(route.points.length).toBeGreaterThan(1);
    for (let index = 1; index < route.points.length; index++) for (const obstacle of obstacles) expect(segmentHits(route.points[index - 1], route.points[index], obstacle, clearance)).toBe(false);
    for (const point of route.points) { expect(point.x).toBeGreaterThanOrEqual(bounds.minX + clearance); expect(point.x).toBeLessThanOrEqual(bounds.maxX - clearance); expect(point.z).toBeGreaterThanOrEqual(bounds.minZ + clearance); expect(point.z).toBeLessThanOrEqual(bounds.maxZ - clearance); }
    const active = sampleLivingNavigation(route, 3.25), paused = sampleLivingNavigation(route, 3.25, false); expect(paused.position).toEqual(active.position); expect(paused.moving).toBe(false);
  });
});
