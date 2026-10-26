import * as THREE from 'three';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { naturalHousePlan } from '@/lib/living-natural-house';
import { createLivingNavigation } from '@/lib/living-navigation';
import { collectNaturalNavigationObstacles } from '@/lib/living-natural-navigation';

const ENTRY = 'home-main-entry-door', ROOM = 'home-room-connection-door', DOORS = [ENTRY, ROOM] as const;
const gpu = vi.hoisted(() => ({ instances: [] as Array<{ scene: THREE.Scene | null; loop: ((time: number) => void) | null }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; });
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});
type SceneKind = 'forest' | 'desert';
type Area = 'outdoor' | 'indoor' | 'bedroom';
type Activity = Gathering['companions'][number]['activity'];
type Flags = NonNullable<Parameters<typeof createLivingWorld>[5]>;
type Resource = THREE.BufferGeometry | THREE.Material | THREE.Texture;
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  if (continuedExchange) return;
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  for (const name of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(name, vi.fn(() => { throw new Error('natural indoor acceptance must remain local and silent'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
function cleanup() {
  worlds.splice(0).forEach(world => world.dispose());
  expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}
afterEach(context => {
  if (continuedExchange && context.task.result?.state !== 'fail') return;
  continuedExchange = null; cleanup();
});
afterAll(() => { if (continuedExchange) { continuedExchange = null; cleanup(); } });
function snapshot(scene: SceneKind): Gathering {
  const kinds = ['cup', 'plant', 'bouquet'];
  return parseGathering({ id: 'synthetic-natural-indoor-' + scene, title: '本地自然住处连续生活', scene_type: scene, revision: 1, closed: false, is_manager: true, me: 'owner',
    members: [{ id: 'owner', name: '合成成员', manager: true }],
    companions: Array.from({ length: 3 }, (_, i) => ({ id: i + 4, owner_id: 'owner', name: '合成伙伴' + (i + 1), activity: i ? 'walk' : 'observe', area: 'outdoor', x: .3 + i * .2, y: .76,
      avatar3d: { version: 1, kind: kinds[i], body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: i + 4, source: 'procedural_existing_features' } })),
    items: [{ id: 'natural-saved-bench', kind: 'bench', x: .76, y: .7, mine: true, contributor_name: '合成成员', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function intent(group: Gathering, id: number, activity: Activity, area: Area): Gathering {
  return { ...group, revision: group.revision + 1, companions: group.companions.map(c => c.id === id ? { ...c, activity, area } : c) };
}
function setup(group = snapshot('forest'), flags: Flags = {}) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const events: Array<{ id: string; open: boolean; source?: string }> = [];
  const world = createLivingWorld(host, labels, group, vi.fn(), (id, open, source) => events.push({ id, open, source }),
    { realistic: true, localNaturalWorld: true, localRoomTransitions: true, localCompanionDoors: true, ...flags }); worlds.push(world);
  const renderer = gpu.instances.at(-1)!, standingScales = new Map<number, number[]>();
  for (const root of renderer.scene!.children) if (typeof root.userData.characterId === 'number') { const factor = root.userData.sleepingBed || root.userData.roomRestSeat ? .9 : 1; standingScales.set(root.userData.characterId, root.scale.toArray().map(value => value / factor)); }
  return { world, host, labels, group, events, renderer, standingScales };
}
type Fixture = ReturnType<typeof setup>;
function actor(f: Fixture, id = 4) { const root = f.renderer.scene!.children.find(o => o.userData.characterId === id); expect(root, 'real avatar ' + id).toBeDefined(); return root!; }
function step(f: Fixture, delta = 100) { vi.setSystemTime(Date.now() + delta); expect(f.renderer.loop).toBeTypeOf('function'); f.renderer.loop!(Date.now()); }
function vertices(root: THREE.Object3D, visit: (point: THREE.Vector3) => void, visibleOnly = false) {
  const point = new THREE.Vector3(), matrix = new THREE.Matrix4(), instance = new THREE.Matrix4();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    if (visibleOnly) for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return;
    const points = object.geometry.getAttribute('position');
    for (let j = 0; j < (object instanceof THREE.InstancedMesh ? object.count : 1); j++) {
      matrix.copy(object.matrixWorld); if (object instanceof THREE.InstancedMesh) { object.getMatrixAt(j, instance); matrix.multiply(instance); }
      for (let i = 0; i < points.count; i++) visit(point.fromBufferAttribute(points, i).applyMatrix4(matrix));
    }
  });
}
function box(root: THREE.Object3D, visibleOnly = false) { const value = new THREE.Box3(); vertices(root, point => value.expandByPoint(point), visibleOnly); expect(value.isEmpty()).toBe(false); return value; }
function triangleContact(root: THREE.Object3D, volume: THREE.Box3) {
  const inner = volume.clone().expandByScalar(-.006);
  // Exact broadphase: a triangle cannot strike a box outside the complete leaf bounds.
  if (!new THREE.Box3().setFromObject(root, true).intersectsBox(inner)) return false;
  const triangle = new THREE.Triangle(), vertex = new THREE.Vector3(); let hit = false;
  root.traverse(object => {
    if (hit || !(object instanceof THREE.Mesh)) return; const positions = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
      for (const [offset, point] of [[0, triangle.a], [1, triangle.b], [2, triangle.c]] as const) point.copy(vertex.fromBufferAttribute(positions, indices ? indices.getX(i + offset) : i + offset).applyMatrix4(object.matrixWorld));
      if (inner.intersectsTriangle(triangle)) { hit = true; break; }
    }
  }); return hit;
}
function geometryVersion(mesh: THREE.Mesh) { const position = mesh.geometry.getAttribute('position'); return position instanceof THREE.InterleavedBufferAttribute ? position.data.version : position.version; }
function structuralMeshes(f: Fixture) {
  const result: THREE.Mesh[] = [];
  f.renderer.scene!.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
      const role = parent.userData.architectureRole;
      if (typeof role === 'string' && (role.includes('wall') || role === 'interior-partition')) { result.push(object); return; }
    }
  });
  expect(result.length, 'physical natural-house walls cannot be empty').toBeGreaterThan(4); return result;
}
function door(f: Fixture, id: typeof DOORS[number]) { const value = f.renderer.scene!.getObjectByName(id); expect(value, 'real door ' + id).toBeDefined(); return value!; }
function originals(f: Fixture) {
  const before = JSON.stringify(f.group), items: Array<{ object: THREE.Object3D; matrix: number[] }> = [];
  f.renderer.scene!.traverse(object => { if (object.userData.homeItemId) items.push({ object, matrix: object.matrixWorld.toArray() }); });
  expect(items.length).toBe(f.group.items.length);
  return () => { expect(JSON.stringify(f.group)).toBe(before); for (const row of items) expect(row.object.matrixWorld.toArray()).toEqual(row.matrix); };
}
function travel(f: Fixture, ids = [4]) {
  let previous = ids.map(id => actor(f, id).position.clone()), frames = 0;
  const crossed = new Map(ids.map(id => [id, [] as string[]])), sides = new Map<string, number>();
  const scale = f.standingScales, tail: unknown[] = [];
  const walls = structuralMeshes(f), fixedWalls = walls.map(object => ({ object, bounds: box(object), matrix: object.matrixWorld.elements.slice(), version: geometryVersion(object) }));
  return {
    crossed,
    next(delta = 100) {
      step(f, delta); frames++;
      // A cached wall bound is equivalent only while every actual wall transform and geometry version remains unchanged.
      for (const wall of fixedWalls) if (wall.object.matrixWorld.elements.some((value, index) => value !== wall.matrix[index]) || geometryVersion(wall.object) !== wall.version) throw new Error('structural wall changed during physical trace: ' + wall.object.name);
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index], root = actor(f, id), point = root.position.clone(), phase = root.userData.homeJourney?.phase;
        tail.push({ frame: frames, id, point: point.toArray(), phase, area: root.userData.homeRegion }); if (tail.length > 8) tail.shift();
        expect(root.visible, 'actors must not disappear while travelling').toBe(true);
        expect(point.distanceTo(previous[index]), JSON.stringify(tail)).toBeLessThan(.2);
        const body = box(root, true);
        if (['walk', 'turn', 'portal', 'wait-door', 'blocked'].includes(phase)) {
          root.scale.toArray().forEach((value, axis) => expect(value, 'portal travel restores the original full standing body').toBeCloseTo(scale.get(id)![axis], 12)); expect(root.userData.roomRestSeat).toBeUndefined(); expect(root.userData.sleepingBed).toBeUndefined();
        }
        for (const solid of fixedWalls) {
          const wall = solid.bounds, overlaps = Math.min(body.max.x, wall.max.x) - Math.max(body.min.x, wall.min.x) > .006 && Math.min(body.max.y, wall.max.y) - Math.max(body.min.y, wall.min.y) > .006 && Math.min(body.max.z, wall.max.z) - Math.max(body.min.z, wall.min.z) > .006;
          if (overlaps) throw new Error('body intersects wall ' + solid.object.name + JSON.stringify(tail));
        }
        for (const doorId of DOORS) {
          const leaf = door(f, doorId), opening = leaf.userData.opening as { along: 'x' | 'z'; center: { x: number; z: number }; min: number; max: number };
          if (triangleContact(leaf.getObjectByName(doorId + '-leaf')!, body)) throw new Error('actual moving door triangles strike the waiting/walking body ' + doorId + JSON.stringify(tail));
          expect(opening).toBeDefined(); const along = opening.along, normal = along === 'x' ? 'z' : 'x', plane = opening.center[normal];
          const was = previous[index][normal] - plane, now = point[normal] - plane, fraction = was === now ? 0 : was / (was - now), across = THREE.MathUtils.lerp(previous[index][along], point[along], fraction);
          const key = id + '/' + doorId, prior = sides.get(key) ?? (Math.abs(was) > 1e-6 ? Math.sign(was) : 0), side = Math.abs(now) > 1e-6 ? Math.sign(now) : 0;
          if (prior && side && side !== prior && across >= opening.min && across <= opening.max) {
            crossed.get(id)!.push(doorId); expect(leaf.userData.homeDoorOpenness, 'crossing requires a fully open actual leaf').toBeCloseTo(1, 6);
          }
          if (side) sides.set(key, side);
          if (body.min[normal] < plane - .015 && body.max[normal] > plane + .015 && body.max[along] > opening.min && body.min[along] < opening.max) {
            expect(leaf.userData.homeDoorOpenness).toBeCloseTo(1, 6);
            expect(body.min[along], 'whole body fits aperture').toBeGreaterThanOrEqual(opening.min - .002);
            expect(body.max[along], 'whole body fits aperture').toBeLessThanOrEqual(opening.max + .002);
          }
        }
        const origin = previous[index].clone().add(new THREE.Vector3(0, .8, 0)), target = point.clone().add(new THREE.Vector3(0, .8, 0)), direction = target.clone().sub(origin), length = direction.length();
        if (length > 1e-6) for (const [from, vector] of [[origin, direction], [target, direction.clone().negate()]] as const) {
          const ray = new THREE.Raycaster(from, vector.clone().normalize(), 1e-5, Math.max(1e-5, length - 1e-5));
          expect(ray.intersectObjects([...walls, ...DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!)], true).map(hit => hit.object.name), 'actual root swept through wall/leaf').toEqual([]);
        }
      }
      previous = ids.map(id => actor(f, id).position.clone());
    },
    until(predicate: () => boolean, limit = 1200) { for (let i = 0; i < limit; i++) { this.next(); if (predicate()) return; } const root = actor(f), plan = naturalHousePlan(f.group.scene_type as SceneKind), obstacles = collectNaturalNavigationObstacles(f.renderer.scene, null), a = plan.bounds.indoor, b = plan.bounds.bedroom;
      const fixed = [...obstacles, { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ), source: 'natural-house-outdoor-boundary' }], radius = root.userData.navigationClearance as number;
      const graph = createLivingNavigation({ bounds: plan.bounds.outdoor, blocked: fixed, clearance: radius, step: .16 }), from = { x: root.position.x, z: root.position.z }, goal = plan.portals.main.before;
      throw new Error('natural indoor journey did not finish ' + JSON.stringify({ tail, journey: root.userData.homeJourney, radius, from, goal, route: graph.planTo({ from, to: goal, id: 4 }), nearest: fixed.filter(o => goal.x > o.minX - radius && goal.x < o.maxX + radius && goal.z > o.minZ - radius && goal.z < o.maxZ + radius), doors: DOORS.map(id => ({ id, open: door(f, id).userData.homeDoorOpenness })) })); },
  };
}
function support(f: Fixture, activity: 'rest' | 'sleep', id = 4) {
  const root = actor(f, id), metadata = activity === 'sleep' ? root.userData.sleepingBed : root.userData.roomRestSeat;
  expect(metadata?.characterId).toBe(id); expect(root.userData.homeRegion).toBe(activity === 'sleep' ? 'bedroom' : 'indoor');
  const plan = naturalHousePlan(f.group.scene_type as SceneKind), assigned = activity === 'sleep' ? plan.beds.find(row => row.id === metadata.id || row.id === metadata.bedId) ?? plan.beds[0] : plan.restSeats.find(row => row.id === metadata.id || row.id === metadata.seatId || row.index === metadata.index);
  expect(assigned, 'contact metadata resolves to an actual furniture position').toBeDefined();
  const supportNames = assigned!.support, supportObjects = supportNames.map(name => { const value = f.renderer.scene!.getObjectByName(name); expect(value, name).toBeDefined(); return value!; });
  const plane = new THREE.Box3(); for (const value of supportObjects) plane.union(box(value));
  const surfaceRay = new THREE.Raycaster(new THREE.Vector3(assigned!.x, plane.max.y + 2, assigned!.z), new THREE.Vector3(0, -1, 0));
  const hits = surfaceRay.intersectObjects(supportObjects, true); expect(hits.length, 'actual contact point needs a real supporting furniture triangle').toBeGreaterThan(0); const surfaceY = hits[0].point.y;
  expect(root.position.x).toBeGreaterThanOrEqual(plane.min.x - .01); expect(root.position.x).toBeLessThanOrEqual(plane.max.x + .01);
  expect(root.position.z).toBeGreaterThanOrEqual(plane.min.z - .01); expect(root.position.z).toBeLessThanOrEqual(plane.max.z + .01);
  if (activity === 'sleep') {
    expect(root.userData.roomRestSeat).toBeUndefined(); const torso = new THREE.Box3();
    root.traverse(object => { if (object instanceof THREE.Mesh && object.userData.sleepBodySupport === true) vertices(object, p => torso.expandByPoint(p), true); });
    expect(torso.isEmpty()).toBe(false); expect(torso.min.y, 'torso touches actual mattress triangles').toBeCloseTo(surfaceY, 5);
    for (const side of ['left-knee', 'right-knee']) {
      const knee = root.getObjectByName(side); expect(knee).toBeDefined(); const foot = knee!.children.find(o => o instanceof THREE.Mesh && o.geometry instanceof THREE.SphereGeometry); expect(foot).toBeDefined();
      const feet = box(foot!), mattress = f.renderer.scene!.getObjectByName('natural-' + f.group.scene_type + '-bed-mattress'); expect(mattress).toBeDefined(); const footprint = box(mattress!);
      expect(feet.min.y, 'sleeping feet cannot float above mattress').toBeCloseTo(surfaceY, 5);
      for (const axis of ['x', 'z'] as const) { expect(feet.min[axis], 'feet stay on actual mattress footprint').toBeGreaterThanOrEqual(footprint.min[axis] - .002); expect(feet.max[axis]).toBeLessThanOrEqual(footprint.max[axis] + .002); }
    }
    expect(box(root, true).min.y).toBeGreaterThanOrEqual(surfaceY - .002);
  } else {
    expect(root.userData.sleepingBed).toBeUndefined(); const torso = root.getObjectByName('body'); expect(torso).toBeDefined();
    expect(box(torso!).min.y, 'sitting body is supported by actual seat').toBeCloseTo(surfaceY, 4);
  }
}
function resources(roots: THREE.Object3D[]) {
  const values = new Set<Resource>();
  for (const root of roots) root.traverse(object => { if (!(object instanceof THREE.Mesh)) return; values.add(object.geometry); for (const m of Array.isArray(object.material) ? object.material : [object.material]) { values.add(m); for (const t of Object.values(m)) if (t instanceof THREE.Texture) values.add(t); } }); return values;
}

type Exchange = { scene: SceneKind; f: Fixture; path: ReturnType<typeof travel>; previous: Array<{ position: THREE.Vector3; box: THREE.Box3 }>; frames: number; unchanged: () => void; roots: THREE.Object3D[] };
let continuedExchange: Exchange | null = null;
function advanceExchange(exchange: Exchange) {
  const { f, previous } = exchange; exchange.path.next(); const current = [4, 5].map(id => ({ position: actor(f, id).position.clone(), box: box(actor(f, id), true) }));
  const overlap = current[0].box.clone().intersect(current[1].box), size = overlap.getSize(new THREE.Vector3());
  expect(!overlap.isEmpty() && Math.min(size.x, size.y, size.z) > .006, 'two physical bodies overlap ' + JSON.stringify({ scene: exchange.scene, frame: exchange.frames, a: current[0].position.toArray(), b: current[1].position.toArray() })).toBe(false);
  const standing = [4, 5].every(id => ['walk', 'turn', 'portal', 'wait-door', 'blocked'].includes(actor(f, id).userData.homeJourney?.phase));
  if (standing) {
    const relative = previous[0].position.clone().sub(previous[1].position), delta = current[0].position.clone().sub(previous[0].position).sub(current[1].position.clone().sub(previous[1].position));
    const length = delta.x * delta.x + delta.z * delta.z, t = length < 1e-12 ? 0 : THREE.MathUtils.clamp(-(relative.x * delta.x + relative.z * delta.z) / length, 0, 1);
    const halfWidth = (row: typeof current[number]) => Math.min(row.box.max.x - row.box.min.x, row.box.max.z - row.box.min.z) / 2;
    const separation = Math.hypot(relative.x + t * delta.x, relative.z + t * delta.z);
    expect(separation, 'continuous opposing bodies cannot swap through each other').toBeGreaterThanOrEqual(Math.min(halfWidth(previous[0]), halfWidth(current[0])) + Math.min(halfWidth(previous[1]), halfWidth(current[1])) - .006);
  }
  exchange.previous = current; exchange.frames++;
}

describe('actual natural-house room travel and contact', () => {
  it.each(['forest', 'desert'] as const)('keeps every %s indoor gate explicit and default production behavior unchanged', scene => {
    const cases: Array<{ flags: Flags; production?: boolean }> = [{ flags: { realistic: false } }, { flags: { localNaturalWorld: false } }, { flags: { localRoomTransitions: false } }, { flags: { localCompanionDoors: false } }, { flags: {}, production: true }];
    for (const row of cases) {
      const group = snapshot(scene); if (row.production) group.id = 'ordinary-production-' + scene; const f = setup(group, row.flags), next = intent(group, 4, 'sleep', 'bedroom'); f.world.update(next, null);
      expect(f.host.dataset.naturalIndoor).toBeUndefined(); expect(actor(f).userData.homeJourney).toBeUndefined(); expect(actor(f).userData.sleepingBed).toBeUndefined(); f.world.dispose();
    }
  });
  it('retains the existing home scene rather than applying natural-house allocation or portals', () => {
    const group = intent({ ...snapshot('forest'), scene_type: 'home' }, 4, 'sleep', 'bedroom'); const original = JSON.stringify(group);
    const control = setup(group, { localNaturalWorld: false }), candidate = setup(group);
    expect(candidate.host.dataset.naturalIndoor).toBeUndefined(); expect(candidate.host.dataset.naturalWorld).toBeUndefined();
    expect(actor(candidate).position.toArray()).toEqual(actor(control).position.toArray()); expect(actor(candidate).quaternion.toArray()).toEqual(actor(control).quaternion.toArray());
    for (const f of [control, candidate]) { expect(f.renderer.scene!.getObjectByName('natural-forest-house-floor')).toBeUndefined(); expect(f.renderer.scene!.getObjectByName('natural-desert-house-floor')).toBeUndefined(); }
    expect(JSON.stringify(group)).toBe(original);
  });
  const contactCases = [{ scene: 'forest' as const, activity: 'rest' as const }, { scene: 'forest' as const, activity: 'sleep' as const }, { scene: 'desert' as const, activity: 'rest' as const }, { scene: 'desert' as const, activity: 'sleep' as const }];
  it.each(contactCases)('enters actual $scene $activity contact through real open apertures without moving saved props', ({ scene, activity }) => {
    const group = snapshot(scene), f = setup(group), unchanged = originals(f), initial = actor(f).position.toArray(), next = intent(group, 4, activity, activity === 'sleep' ? 'bedroom' : 'indoor');
    expect(f.host.dataset.naturalIndoor).toBe('true'); expect(DOORS.every(id => door(f, id).userData.homeDoorOpenness === 0)).toBe(true); expect(f.events).toEqual([]); f.world.update(next, null); expect(actor(f).position.toArray()).toEqual(initial); expect(actor(f).userData.sleepingBed).toBeUndefined(); expect(actor(f).userData.roomRestSeat).toBeUndefined();
    f.world.setMotion(true); const inbound = travel(f); inbound.until(() => !!actor(f).userData[activity === 'sleep' ? 'sleepingBed' : 'roomRestSeat']);
    expect(inbound.crossed.get(4)).toEqual(activity === 'sleep' ? [ENTRY, ROOM] : [ENTRY]); support(f, activity); unchanged();
  });
  it.each(contactCases)('returns from actual cold-restored $scene $activity furniture through real open apertures and shuts doors', ({ scene, activity }) => {
    const group = intent(snapshot(scene), 4, activity, activity === 'sleep' ? 'bedroom' : 'indoor'), f = setup(group), unchanged = originals(f); support(f, activity);
    const contact = actor(f).position.toArray(), outbound = intent(group, 4, 'walk', 'outdoor'); f.world.update(outbound, null); expect(actor(f).position.toArray()).toEqual(contact); f.world.setMotion(true);
    const returning = travel(f); returning.until(() => actor(f).userData.homeRegion === 'outdoor' && !actor(f).userData.homeJourney?.active);
    expect(returning.crossed.get(4)).toEqual(activity === 'sleep' ? [ROOM, ENTRY] : [ENTRY]); expect(actor(f).userData.sleepingBed).toBeUndefined(); expect(actor(f).userData.roomRestSeat).toBeUndefined(); unchanged();
    returning.until(() => DOORS.every(id => door(f, id).userData.homeDoorOpenness === 0), 100); expect(f.events.some(event => event.open && event.source === 'companion')).toBe(true);
  });
  it.each(['forest', 'desert'] as const)('cold-restores %s real furniture contact and enforces unique two-seat/one-bed capacity', scene => {
    const resting = snapshot(scene); resting.companions = [...resting.companions].reverse().map(c => ({ ...c, activity: 'rest', area: 'indoor' }));
    const f = setup(resting), unchanged = originals(f); support(f, 'rest', 4); support(f, 'rest', 5); expect(actor(f, 6).userData.roomRestSeat).toBeUndefined(); expect(actor(f, 6).userData.homeRegion).toBe('outdoor');
    expect(f.host.dataset.naturalCapacityBlocked).toBe('1'); expect(actor(f, 4).userData.roomRestSeat.id ?? actor(f, 4).userData.roomRestSeat.seatId).not.toBe(actor(f, 5).userData.roomRestSeat.id ?? actor(f, 5).userData.roomRestSeat.seatId);
    const a = box(actor(f, 4), true), b = box(actor(f, 5), true); expect(a.intersectsBox(b), 'two resting bodies must not share a seat').toBe(false); unchanged(); f.world.dispose();
    const sleeping = snapshot(scene); sleeping.companions = [...sleeping.companions].reverse().map(c => ({ ...c, activity: 'sleep', area: 'bedroom' })); const g = setup(sleeping); support(g, 'sleep', 4);
    for (const id of [5, 6]) { expect(actor(g, id).visible).toBe(true); expect(actor(g, id).userData.sleepingBed).toBeUndefined(); expect(actor(g, id).userData.homeRegion).toBe('outdoor'); }
    expect(g.host.dataset.naturalCapacityBlocked).toBe('2'); const point = actor(g).position.clone(); g.world.setMotion(true); for (let i = 0; i < 20; i++) step(g); expect(actor(g).position.distanceTo(point)).toBeLessThan(.01); support(g, 'sleep');
  });
  it.each(['forest', 'desert'] as const)('freezes %s actor and automatic door leaf through pause and hidden time, then completes its interrupted trip', scene => {
    const group = snapshot(scene), f = setup(group), next = intent(group, 4, 'sleep', 'bedroom'); f.world.update(next, null); f.world.setMotion(true); const path = travel(f);
    path.until(() => DOORS.some(id => { const n = door(f, id).userData.homeDoorOpenness; return n > 0 && n < 1; }));
    const activeLoop = f.renderer.loop!; expect(activeLoop).toBeTypeOf('function'); f.world.setMotion(false); const matrix = actor(f).matrixWorld.toArray(), angles = DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!.rotation.y), leafPositions = DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!.position.toArray()), leafMatrices = DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!.matrixWorld.toArray()), eventCount = f.events.length;
    for (const delta of [3_600_000, 500]) { vi.setSystemTime(Date.now() + delta); activeLoop(Date.now()); }
    const journeyBefore = JSON.stringify(actor(f).userData.homeJourney);
    for (const view of ['outdoor', 'indoor', 'bedroom', 'overview'] as const) { f.world.update({ ...next, revision: next.revision + 1 }, null, view); f.world.reset(); expect(JSON.stringify(actor(f).userData.homeJourney)).toBe(journeyBefore); expect(actor(f).matrixWorld.toArray()).toEqual(matrix); }
    expect(actor(f).matrixWorld.toArray()).toEqual(matrix); expect(DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!.rotation.y)).toEqual(angles); expect(DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!.position.toArray())).toEqual(leafPositions); expect(DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!.matrixWorld.toArray())).toEqual(leafMatrices); expect(f.events.length).toBe(eventCount);
    f.world.setMotion(true); const visibleLoop = f.renderer.loop!; const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); vi.setSystemTime(Date.now() + 3_600_000); visibleLoop(Date.now()); expect(actor(f).matrixWorld.toArray()).toEqual(matrix); expect(DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!.rotation.y)).toEqual(angles); expect(DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!.position.toArray())).toEqual(leafPositions); expect(DOORS.map(id => door(f, id).getObjectByName(id + '-leaf')!.matrixWorld.toArray())).toEqual(leafMatrices); hidden.mockRestore(); document.dispatchEvent(new Event('visibilitychange')); f.world.setMotion(true);
    const before = actor(f).position.clone(); step(f); expect(actor(f).position.distanceTo(before)).toBeLessThan(.2); const rest = travel(f); rest.until(() => !!actor(f).userData.sleepingBed); support(f, 'sleep');
  });
  for (const scene of ['forest', 'desert'] as const) describe(scene + ' opposing real-door exchange, one continuous engine session', { concurrent: false, shuffle: false }, () => {
    it('crosses the bedroom doorway while retaining every continuous body and peer sweep', () => {
      const group = intent(snapshot(scene), 4, 'sleep', 'bedroom'), f = setup(group); support(f, 'sleep', 4);
      const next = intent(intent(group, 4, 'walk', 'outdoor'), 5, 'sleep', 'bedroom'), before = [4, 5].map(id => actor(f, id).position.toArray()); f.world.update(next, null);
      expect([4, 5].map(id => actor(f, id).position.toArray())).toEqual(before); f.world.setMotion(true);
      const exchange: Exchange = { scene, f, path: travel(f, [4, 5]), previous: [4, 5].map(id => ({ position: actor(f, id).position.clone(), box: box(actor(f, id), true) })), frames: 0, unchanged: originals(f), roots: [4, 5].map(id => actor(f, id)) };
      for (; exchange.frames < 900;) { advanceExchange(exchange); if (actor(f, 4).userData.homeRegion === 'indoor' && !['portal', 'wait-door'].includes(actor(f, 4).userData.homeJourney?.phase)) break; }
      expect(actor(f, 4).userData.homeRegion, 'first phase must actually cross the bedroom doorway').toBe('indoor'); expect(exchange.path.crossed.get(4)).toEqual([ROOM]); exchange.unchanged();
      // Only this successful phase retains the SAME engine, roots, fake clock, path, peer history and frame counter.
      continuedExchange = exchange;
    });
    it('finishes that same exchange within the original cumulative 1800-frame window', () => {
      const exchange = continuedExchange; expect(exchange?.scene, 'requires the preceding successful physical doorway trace').toBe(scene); if (!exchange) throw new Error('continuous exchange phase is absent');
      try {
        const { f, path } = exchange; expect([4, 5].map(id => actor(f, id))).toEqual(exchange.roots); let arrived = false;
        for (; exchange.frames < 1800;) { advanceExchange(exchange); if (actor(f, 4).userData.homeRegion === 'outdoor' && !actor(f, 4).userData.homeJourney?.active && !!actor(f, 5).userData.sleepingBed) { arrived = true; break; } }
        expect(arrived, 'both real actors must complete their requested opposite trips').toBe(true); expect(path.crossed.get(4)).toEqual([ROOM, ENTRY]); expect(path.crossed.get(5)).toEqual([ENTRY, ROOM]); support(f, 'sleep', 5); exchange.unchanged();
      } finally { continuedExchange = null; }
    });
  });
  it.each(['forest', 'desert'] as const)('keeps all ordinary %s walkers outside an opening/closing real door swing while one observer remains in the yard', scene => {
    const f = setup(snapshot(scene)), ids = [4, 5, 6], unchanged = originals(f); f.world.setMotion(true); const path = travel(f, ids);
    const distance = new Map([5, 6].map(id => [id, 0])), late = new Map([5, 6].map(id => [id, 0])); let old = new Map(ids.map(id => [id, actor(f, id).position.clone()]));
    for (let frame = 0; frame < 500; frame++) {
      if ([30, 220, 400].includes(frame)) f.world.setDoorOpen(ENTRY, true); if ([150, 340].includes(frame)) f.world.setDoorOpen(ENTRY, false);
      path.next();
      for (const id of ids) {
        const root = actor(f, id), amount = Math.hypot(root.position.x - old.get(id)!.x, root.position.z - old.get(id)!.z); expect(root.userData.homeRegion).toBe('outdoor');
        if (id !== 4) { distance.set(id, distance.get(id)! + amount); if (frame >= 300) late.set(id, late.get(id)! + amount); }
      }
      old = new Map(ids.map(id => [id, actor(f, id).position.clone()]));
    }
    for (const id of [5, 6]) { expect(distance.get(id), 'ordinary walkers must not be frozen by the door control').toBeGreaterThan(2); expect(late.get(id), 'each ordinary walker keeps making progress after several door changes').toBeGreaterThan(.2); }
    for (const id of ids) expect(path.crossed.get(id)).toEqual([]); unchanged();
  });
  it('clears natural contact, journey, labels and old resources on scene/scope exit and disposal, retaining replacement resources', () => {
    const group = snapshot('forest'), f = setup(group); f.world.update(intent(group, 4, 'sleep', 'bedroom'), null); f.world.setMotion(true); for (let i = 0; i < 4; i++) step(f);
    const oldScene = f.renderer.scene!, oldRoots = oldScene.children.filter(o => o.userData.naturalScene || typeof o.userData.characterId === 'number'), oldResources = resources(oldRoots), disposal = new Map([...oldResources].map(r => [r, vi.spyOn(r, 'dispose')]));
    const replacement = snapshot('desert'); f.world.update(replacement, null); expect(f.host.dataset.naturalWorld).toBe('desert'); expect(f.host.dataset.naturalIndoor).toBe('true');
    for (const id of [4, 5, 6]) { expect(actor(f, id).userData.sleepingBed).toBeUndefined(); expect(actor(f, id).userData.roomRestSeat).toBeUndefined(); }
    const newResources = resources(f.renderer.scene!.children), live = [...newResources].map(r => vi.spyOn(r, 'dispose'));
    for (const [value, spy] of disposal) if (!newResources.has(value)) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of live) expect(spy).not.toHaveBeenCalled();
    const fresh = { ...replacement, id: 'synthetic-natural-fresh-scope' }; f.world.update(fresh, null); expect(actor(f).userData.sleepingBed).toBeUndefined(); expect(actor(f).userData.homeJourney?.active).not.toBe(true);
    const loop = f.renderer.loop!, oldActor = actor(f); f.world.dispose(); const matrix = oldActor.matrixWorld.toArray(); vi.setSystemTime(Date.now() + 500_000); loop(Date.now()); expect(oldActor.matrixWorld.toArray()).toEqual(matrix);
    expect(f.renderer.loop).toBeNull(); expect(f.host.querySelector('canvas')).toBeNull(); expect(f.host.dataset.naturalIndoor).toBeUndefined(); expect(f.labels.childElementCount).toBe(0);
  });
});
