import * as THREE from 'three';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createLivingWorld} from '@/lib/living-world-engine';
import {parseGathering} from '@/lib/gatherings';

const gpu = vi.hoisted(() => ({instances: [] as Array<{scene: THREE.Scene | null}>}));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = {enabled: false, type: 0}; outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn(); setAnimationLoop = vi.fn();
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => {scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene;});
    constructor() {gpu.instances.push(this);}
  }
  return {...actual, WebGLRenderer: OfflineRenderer};
});
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  gpu.instances = []; vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
  for (const key of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(key, vi.fn(() => {throw new Error('OFFLINE_ONLY');}));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function points(part: THREE.Object3D) {
  const values: THREE.Vector3[] = [];
  part.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) values.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld));
  });
  return values;
}
/** Signed height above the real surface triangles, including the quilt's curved top. */
function contact(part: THREE.Object3D, surface: THREE.Object3D) {
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), heights: number[] = [];
  for (const point of points(part)) {
    ray.set(point.clone().addScaledVector(down, -2), down); ray.far = 4;
    const hit = ray.intersectObject(surface, true)[0]; if (hit) heights.push(point.y - hit.point.y);
  }
  return {projectedVertices: heights.length, minimumClearance: Math.min(...heights), minimumGap: Math.min(...heights.map(Math.abs))};
}
function triangles(part: THREE.Object3D) {
  const result: Array<{triangle: THREE.Triangle; bounds: THREE.Box3}> = [];
  part.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let index = 0; index < (indices?.count ?? positions.count); index += 3) {
      const [a, b, c] = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(index + offset) : index + offset).applyMatrix4(object.matrixWorld));
      result.push({triangle: new THREE.Triangle(a, b, c), bounds: new THREE.Box3().setFromPoints([a, b, c])});
    }
  }); return result;
}
/** True surface distance, including contact at a face interior rather than only render vertices. */
function surfaceDistance(first: THREE.Object3D, second: THREE.Object3D) {
  const a = triangles(first), b = triangles(second), closest = new THREE.Vector3(), ray = new THREE.Ray(), direction = new THREE.Vector3(), hit = new THREE.Vector3();
  const d1 = new THREE.Vector3(), d2 = new THREE.Vector3(), r = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const segmentDistanceSq = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    d1.subVectors(b, a); d2.subVectors(d, c); r.subVectors(a, c);
    const lengthA = d1.lengthSq(), lengthB = d2.lengthSq(), f = d2.dot(r); let s = 0, t = 0;
    if (lengthA <= 1e-16 && lengthB <= 1e-16) return a.distanceToSquared(c);
    if (lengthA <= 1e-16) t = clamp(f / lengthB);
    else {
      const e = d1.dot(r);
      if (lengthB <= 1e-16) s = clamp(-e / lengthA);
      else {
        const cross = d1.dot(d2), denominator = lengthA * lengthB - cross * cross;
        s = denominator > 1e-16 ? clamp((cross * f - e * lengthB) / denominator) : 0; t = (cross * s + f) / lengthB;
        if (t < 0) {t = 0; s = clamp(-e / lengthA);} else if (t > 1) {t = 1; s = clamp((cross - e) / lengthA);}
      }
    }
    return p.copy(a).addScaledVector(d1, s).distanceToSquared(q.copy(c).addScaledVector(d2, t));
  };
  let minimumSq = Infinity;
  for (const first of a) for (const second of b) {
    const separations = (['x', 'y', 'z'] as const).map(axis => Math.max(0, first.bounds.min[axis] - second.bounds.max[axis], second.bounds.min[axis] - first.bounds.max[axis]));
    if (separations.reduce((sum, value) => sum + value * value, 0) >= minimumSq) continue;
    const x = first.triangle, y = second.triangle, firstEdges = [[x.a, x.b], [x.b, x.c], [x.c, x.a]], secondEdges = [[y.a, y.b], [y.b, y.c], [y.c, y.a]];
    for (const [edges, face] of [[firstEdges, y], [secondEdges, x]] as const) for (const [from, to] of edges) {
      const length = direction.subVectors(to, from).length(); if (length < 1e-12) continue;
      ray.set(from, direction.multiplyScalar(1 / length));
      if (ray.intersectTriangle(face.a, face.b, face.c, false, hit) && hit.distanceTo(from) <= length + 1e-9) return 0;
    }
    for (const point of [x.a, x.b, x.c]) minimumSq = Math.min(minimumSq, y.closestPointToPoint(point, closest).distanceToSquared(point));
    for (const point of [y.a, y.b, y.c]) minimumSq = Math.min(minimumSq, x.closestPointToPoint(point, closest).distanceToSquared(point));
    for (const [from, to] of firstEdges) for (const [otherFrom, otherTo] of secondEdges) minimumSq = Math.min(minimumSq, segmentDistanceSq(from, to, otherFrom, otherTo));
  }
  return Math.sqrt(minimumSq);
}

it('cold legacy cup bears on its original mattress and quilt with the minimal fitted offset and foot lift', () => {
  // Same public fixture as living-home-transition-engine.test.ts, not a changed body or layout.
  const group = parseGathering({id: 'synthetic-room-transition', title: '本地连续进屋休息', scene_type: 'home', revision: 1,
    closed: false, is_manager: true, me: 'owner', members: [{id: 'owner', name: '合成成员', manager: true}],
    companions: [{id: 4, owner_id: 'owner', name: '合成杯子伙伴', activity: 'sleep', area: 'bedroom', x: .62, y: .68,
      avatar3d: {version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features'}}],
    items: [{id: 'transition-saved-bench', kind: 'bench', x: .2, y: .7, mine: true, contributor_name: '合成成员', growth_status: null}],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: {current_season: 'summer'}});
  const original = JSON.stringify(group), host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, {clientWidth: {value: 800}, clientHeight: {value: 500}}); document.body.append(host, labels);
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), {realistic: true, localLeisurePreview: true, localRoomTransitions: true}); worlds.push(world);
  world.setHouseView('interior');
  const scene = gpu.instances.at(-1)!.scene!, root = scene.children.find(object => object.userData.characterId === 4)!, bed = scene.getObjectByName('room-bed-0')!;
  const mattress = bed.getObjectByName('room-bed-0-mattress')!, quilt = bed.getObjectByName('room-bed-0-foot-quilt')!;
  expect(root.userData.sleepingBed).toBeTruthy();
  const core: THREE.Mesh[] = []; root.getObjectByName('body')!.traverse(object => {if (object instanceof THREE.Mesh && object.userData.sleepBodySupport) core.push(object);});
  expect(core).not.toHaveLength(0);
  const torso = core.map(part => contact(part, mattress)), feet = ['left-knee', 'right-knee'].map(name => {
    const knee = root.getObjectByName(name)!, foot = knee.children.find(object => object instanceof THREE.Mesh && object.geometry instanceof THREE.SphereGeometry)!;
    expect(foot).toBeInstanceOf(THREE.Mesh); return {...contact(foot, quilt), surfaceGap: surfaceDistance(foot, quilt)};
  });
  const legParts: unknown[] = [];
  for (const side of ['left-leg', 'right-leg']) root.getObjectByName(side)!.traverse(object => {if (object instanceof THREE.Mesh) legParts.push({side, geometry: object.geometry.type, localPosition: object.position.toArray(), contact: contact(object, quilt)});});
  const metrics = {legParts, offset: root.userData.sleepContactOffset, legLift: root.userData.sleepLegLift, root: root.position.toArray(), torso, feet,
    mattressBounds: new THREE.Box3().setFromObject(mattress, true), quiltBounds: new THREE.Box3().setFromObject(quilt, true), rendererCount: gpu.instances.length};
  if (process.env.BED_EXIT_METRICS_DIR) {mkdirSync(process.env.BED_EXIT_METRICS_DIR, {recursive: true}); writeFileSync(join(process.env.BED_EXIT_METRICS_DIR, 'cup-cold-contact.json'), JSON.stringify(metrics, null, 2) + '\n');}
  for (const measurement of torso) {
    expect(measurement.projectedVertices).toBeGreaterThan(0); expect(measurement.minimumClearance).toBeGreaterThanOrEqual(-.006); expect(measurement.minimumGap).toBeLessThanOrEqual(.006);
  }
  for (const measurement of feet) {expect(measurement.projectedVertices).toBeGreaterThan(0); expect(measurement.minimumClearance).toBeGreaterThanOrEqual(-.006); expect(measurement.surfaceGap).toBeLessThanOrEqual(.006);}
  expect(metrics.offset).toBeGreaterThan(0); expect(metrics.legLift).toBeGreaterThan(0); expect(gpu.instances).toHaveLength(1); expect(JSON.stringify(group)).toBe(original);
});
