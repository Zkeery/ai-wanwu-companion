import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { createLivingNavigation } from '@/lib/living-navigation';
import { naturalNavigationBounds } from '@/lib/living-natural-navigation';

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

const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  for (const name of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(name, vi.fn(() => { throw new Error('natural-world validation must stay local and silent'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose());
  expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

type SceneKind = 'forest' | 'desert';
type Flags = NonNullable<Parameters<typeof createLivingWorld>[5]>;
function snapshot(scene: SceneKind = 'forest', count = 3): Gathering {
  const saved = scene === 'forest'
    ? [{ id: 'saved-tree', kind: 'tree', x: .23, y: .30 }, { id: 'saved-bench', kind: 'bench', x: .76, y: .72 }, { id: 'saved-fire', kind: 'campfire', x: .5, y: .78 }]
    : [{ id: 'saved-low-water', kind: 'pond', x: .31, y: .36 }, { id: 'saved-palm', kind: 'palm', x: .78, y: .27 }, { id: 'saved-bench', kind: 'bench', x: .72, y: .77 }];
  return parseGathering({ id: 'synthetic-natural-world-' + scene, title: '本地自然场景实际导航', scene_type: scene, revision: 1, closed: false, is_manager: true, me: 'owner', members: [{ id: 'owner', name: '合成成员', manager: true }],
    companions: Array.from({ length: count }, (_, i) => ({ id: i + 4, owner_id: 'owner', name: '散步伙伴' + i, activity: 'walk', area: i % 2 ? 'bedroom' : 'outdoor', x: .31, y: .36,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: i + 4, source: 'procedural_existing_features' } })),
    items: saved.map(item => ({ ...item, mine: true, contributor_name: '合成成员', growth_status: null })), votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function setup(group = snapshot(), flags: Flags = {}) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), { realistic: true, localNaturalWorld: true, ...flags }); worlds.push(world);
  const f = { world, host, labels, group, renderer: gpu.instances.at(-1)! };
  if (host.dataset.naturalWorld) {
    const bounds = naturalNavigationBounds(host.dataset.naturalWorld as SceneKind);
    for (const x of [bounds.minX, bounds.maxX]) for (const z of [bounds.minZ, bounds.maxZ]) expect(floorHeight(f, x, z), 'the whole navigation rectangle has real flat ground at each corner').toBeCloseTo(0, 5);
  }
  return f;
}
type Fixture = ReturnType<typeof setup>;
function step(f: Fixture, delta = 100) { vi.setSystemTime(Date.now() + delta); expect(f.renderer.loop).toBeTypeOf('function'); f.renderer.loop!(Date.now()); }
function actor(f: Fixture, id: number) { const root = f.renderer.scene!.children.find(value => value.userData.characterId === id); expect(root).toBeDefined(); return root!; }
function environment(f: Fixture) { const root = f.renderer.scene!.children.find(value => value.userData.naturalScene === f.host.dataset.naturalWorld && value.userData.homeMaterialLibrary); expect(root).toBeDefined(); return root!; }
function savedItem(f: Fixture, id: string) { let value: THREE.Object3D | undefined; f.renderer.scene!.traverse(object => { if (object.userData.homeItemId === id) value = object; }); expect(value).toBeDefined(); return value!; }
function exact(object: THREE.Object3D) { return { parent: object.parent, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrix: object.matrix.toArray(), auto: object.matrixAutoUpdate }; }
const down = new THREE.Vector3(0, -1, 0), supportRay = new THREE.Raycaster();
function floorHeight(f: Fixture, x: number, z: number) {
  const ground = f.renderer.scene!.getObjectByName(f.host.dataset.naturalWorld === 'desert' ? 'desert-continuous-sand-ground' : 'forest-ground'); expect(ground).toBeDefined();
  supportRay.set(new THREE.Vector3(x, 10, z), down); const hit = supportRay.intersectObject(ground!, false)[0];
  expect(hit, 'real floor triangles must support ' + JSON.stringify({ x, z })).toBeDefined(); return hit.point.y;
}
function meshVertices(root: THREE.Object3D, visibleOnly: boolean, visit: (point: THREE.Vector3) => void) {
  const point = new THREE.Vector3(), matrix = new THREE.Matrix4(), instance = new THREE.Matrix4();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    if (visibleOnly) for (let p: THREE.Object3D | null = object; p; p = p.parent) if (!p.visible) return;
    const positions = object.geometry.getAttribute('position');
    const count = object instanceof THREE.InstancedMesh ? object.count : 1;
    for (let j = 0; j < count; j++) {
      matrix.copy(object.matrixWorld); if (object instanceof THREE.InstancedMesh) { object.getMatrixAt(j, instance); matrix.multiply(instance); }
      for (let i = 0; i < positions.count; i++) visit(point.fromBufferAttribute(positions, i).applyMatrix4(matrix));
    }
  });
}
function geometryBounds(root: THREE.Object3D, visibleOnly = false) { const box = new THREE.Box3(); meshVertices(root, visibleOnly, point => box.expandByPoint(point)); return box; }
type Body = { id: number; x: number; z: number; radius: number; box: THREE.Box3 };
function body(f: Fixture, id: number): Body {
  const root = actor(f, id), box = new THREE.Box3(); let radius = 0;
  expect(root.visible, 'actor ' + id + ' must remain physically rendered').toBe(true);
  meshVertices(root, true, point => { box.expandByPoint(point); radius = Math.max(radius, Math.hypot(point.x - root.position.x, point.z - root.position.z)); });
  expect(box.isEmpty()).toBe(false); expect(radius).toBeGreaterThan(.2);
  expect(root.userData.homeNavigation?.position?.x).toBeCloseTo(root.position.x, 8); expect(root.userData.homeNavigation?.position?.z).toBeCloseTo(root.position.z, 8);
  expect(root.userData.homeNavigation?.region).toBe('outdoor'); expect(root.userData.homeNavigation?.blocked).toBeNull();
  const groundY = floorHeight(f, root.position.x, root.position.z), bounds = naturalNavigationBounds(f.host.dataset.naturalWorld as SceneKind);
  expect(groundY).toBeCloseTo(0, 5); expect(box.min.y, 'actual feet remain on the raycast ground').toBeGreaterThanOrEqual(groundY - .04); expect(root.position.y).toBeGreaterThanOrEqual(groundY - 1e-6); expect(root.position.y).toBeLessThan(groundY + .1);
  expect(box.min.x).toBeGreaterThan(bounds.minX); expect(box.max.x).toBeLessThan(bounds.maxX); expect(box.min.z).toBeGreaterThan(bounds.minZ); expect(box.max.z).toBeLessThan(bounds.maxZ);
  return { id, x: root.position.x, z: root.position.z, radius, box };
}
function obstacles(f: Fixture) {
  const marked: THREE.Object3D[] = []; f.renderer.scene!.traverse(object => { if (object.userData.naturalNavObstacle === true) marked.push(object); });
  return marked.filter(object => { for (let p = object.parent; p; p = p.parent) if (p.userData.naturalNavObstacle === true) return false; return true; })
    .map(object => ({ object, box: geometryBounds(object) })).filter(row => !row.box.isEmpty());
}
function sweptDistance(a0: Body, a1: Body, b0: Body, b1: Body) {
  const x = a0.x - b0.x, z = a0.z - b0.z, dx = a1.x - a0.x - b1.x + b0.x, dz = a1.z - a0.z - b1.z + b0.z, length = dx * dx + dz * dz;
  const t = length < 1e-14 ? 0 : Math.max(0, Math.min(1, -(x * dx + z * dz) / length)); return Math.hypot(x + t * dx, z + t * dz);
}
function segmentHitsExpandedBox(a: Body, b: Body, box: THREE.Box3, radius: number) {
  let low = 0, high = 1;
  for (const axis of ['x', 'z'] as const) {
    const delta = b[axis] - a[axis], min = box.min[axis] - radius + 1e-5, max = box.max[axis] + radius - 1e-5;
    if (Math.abs(delta) < 1e-12) { if (a[axis] <= min || a[axis] >= max) return false; continue; }
    const s = (min - a[axis]) / delta, t = (max - a[axis]) / delta; low = Math.max(low, Math.min(s, t)); high = Math.min(high, Math.max(s, t)); if (low > high) return false;
  }
  return low <= high;
}
function savedState(f: Fixture, g = f.group) {
  return g.items.map(item => {
    const object = savedItem(f, item.id), bounds = geometryBounds(object); expect(bounds.isEmpty(), 'saved ' + item.kind + ' needs actual geometry').toBe(false);
    expect(object.position.toArray()).toEqual([(item.x - .5) * 8, 0, (item.y - .5) * 5.2]); expect(object.scale.toArray()).toEqual([1, 1, 1]);
    return { object, state: exact(object), world: object.matrixWorld.toArray() };
  });
}
type Resource = THREE.BufferGeometry | THREE.Material | THREE.Texture;
function resources(roots: THREE.Object3D[]) {
  const set = new Set<Resource>(); for (const root of roots) root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return; set.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) { set.add(material); for (const value of Object.values(material)) if (value instanceof THREE.Texture) set.add(value); }
  }); return set;
}
function spyResources(values: Iterable<Resource>) { return new Map([...values].map(value => [value, vi.spyOn(value, 'dispose')])); }

describe('actual natural-world engine physical navigation', () => {
  it('requires realistic, explicit opt-in, synthetic id and a supported natural scene before allocating new environments or navigation', () => {
    const group = snapshot(), cases = [{ group, flags: { realistic: false } }, { group, flags: { localNaturalWorld: false } }, { group: { ...group, id: 'production-forest' }, flags: {} }, { group: { ...group, scene_type: 'home' }, flags: {} }];
    for (const row of cases) {
      const original = JSON.stringify(row.group), f = setup(row.group, row.flags); f.world.setMotion(true); for (let i = 0; i < 5; i++) step(f);
      expect(f.host.dataset.naturalWorld).toBeUndefined(); expect(f.host.dataset.naturalObstacleCount).toBeUndefined();
      expect(f.renderer.scene!.getObjectByName('natural-forest-world')).toBeUndefined(); expect(f.renderer.scene!.getObjectByName('realistic-desert-oasis')).toBeUndefined();
      if (row.group.scene_type !== 'home') expect(actor(f, 4).userData.homeNavigation).toBeUndefined();
      expect(JSON.stringify(row.group)).toBe(original); f.world.dispose();
    }
  });

  it.each([{ scene: 'forest' as const, count: 3 }, { scene: 'forest' as const, count: 10 }, { scene: 'desert' as const, count: 3 }, { scene: 'desert' as const, count: 10 }])
    ('keeps $count actual $scene walkers on safe ground throughout continuous sweeps past original saved props and each other', ({ scene, count }) => {
      const group = snapshot(scene, count), original = JSON.stringify(group), f = setup(group), ids = group.companions.map(value => value.id), fixed = obstacles(f), items = savedState(f);
      expect(f.host.dataset.naturalWorld).toBe(scene); expect(Number(f.host.dataset.naturalObstacleCount)).toBe(fixed.length); expect(fixed.length).toBeGreaterThan(10);
      expect(fixed.some(row => /trunk|palm/.test(row.object.name))).toBe(true); expect(fixed.some(row => /cabin|house/.test(row.object.name))).toBe(true);
      if (scene === 'desert') { const water = fixed.filter(row => row.object.name === 'desert-pond-water'); expect(water.length).toBeGreaterThanOrEqual(2); expect(water.every(row => row.box.max.y < .05)).toBe(true); expect(water.some(row => row.object.parent === savedItem(f, 'saved-low-water'))).toBe(true); }
      const travelled = new Map(ids.map(id => [id, 0])), late = new Map(ids.map(id => [id, 0])); let previous = ids.map(id => body(f, id)), minGap = Infinity;
      f.world.setMotion(true);
      for (let frame = 0; frame < 450; frame++) {
        step(f); const current = ids.map(id => body(f, id));
        for (let i = 0; i < ids.length; i++) {
          const d = Math.hypot(current[i].x - previous[i].x, current[i].z - previous[i].z); expect(d, JSON.stringify({ scene, count, frame, id: ids[i], previous: previous[i], current: current[i] })).toBeLessThan(.2);
          travelled.set(ids[i], travelled.get(ids[i])! + d); if (frame >= 300) late.set(ids[i], late.get(ids[i])! + d);
          const radius = Math.max(previous[i].radius, current[i].radius);
          for (const obstacle of fixed) expect(segmentHitsExpandedBox(previous[i], current[i], obstacle.box, radius), JSON.stringify({ scene, count, frame, id: ids[i], obstacle: obstacle.object.name, from: [previous[i].x, previous[i].z], to: [current[i].x, current[i].z], radius, bounds: obstacle.box })).toBe(false);
          for (let j = i + 1; j < ids.length; j++) {
            const gap = sweptDistance(previous[i], current[i], previous[j], current[j]) - radius - Math.max(previous[j].radius, current[j].radius); minGap = Math.min(minGap, gap);
            expect(gap, JSON.stringify({ scene, count, frame, actors: [ids[i], ids[j]], positions: [current[i], current[j]] })).toBeGreaterThanOrEqual(-1e-4);
            expect(current[i].box.intersectsBox(current[j].box), 'actual body boxes must not overlap').toBe(false);
          }
        }
        previous = current;
      }
      const deadlocks = ids.filter(id => late.get(id)! <= .2).map(id => {
        const root = actor(f, id), point = { x: root.position.x, z: root.position.z }, radius = root.userData.navigationClearance as number;
        const peers = ids.filter(other => other !== id).map(other => { const p = actor(f, other).position; return { id: other, position: { x: p.x, z: p.z }, radius: actor(f, other).userData.navigationClearance as number, distance: Math.hypot(p.x - point.x, p.z - point.z) }; }).sort((a, b) => a.distance - b.distance);
        const blocked = fixed.map(row => ({ minX: row.box.min.x - .002, maxX: row.box.max.x + .002, minZ: row.box.min.z - .002, maxZ: row.box.max.z + .002 }));
        const graph = createLivingNavigation({ bounds: naturalNavigationBounds(scene), blocked, clearance: radius });
        const summarize = (route: ReturnType<typeof graph.plan>) => ({ blocked: route.blocked, safeAnchor: route.safeAnchor, diagnostics: route.diagnostics, points: route.points, length: route.length });
        const nearest = fixed.map(row => ({ name: row.object.name, bounds: row.box, expanded: { minX: row.box.min.x - radius - .002, maxX: row.box.max.x + radius + .002, minZ: row.box.min.z - radius - .002, maxZ: row.box.max.z + radius + .002 }, distance: Math.hypot(Math.max(0, row.box.min.x - point.x, point.x - row.box.max.x), Math.max(0, row.box.min.z - point.z, point.z - row.box.max.z)) })).sort((a, b) => a.distance - b.distance).slice(0, 8);
        const ground = f.renderer.scene!.getObjectByName(scene === 'desert' ? 'desert-continuous-sand-ground' : 'forest-ground');
        return { id, point, radius, ground: ground ? geometryBounds(ground) : null, bounds: naturalNavigationBounds(scene), peers, nearest, independentStaticPlan: summarize(graph.plan({ anchor: point, id })), independentPeerPlan: summarize(graph.plan({ anchor: point, id, avoid: peers.filter(peer => peer.distance < radius + peer.radius + 1.2) })) };
      });
      const terminal = JSON.stringify({ scene, count, travelled: Object.fromEntries(travelled), late: Object.fromEntries(late), deadlocks, actors: ids.map(id => ({ id, position: actor(f, id).position.toArray(), clearance: actor(f, id).userData.navigationClearance, navigation: actor(f, id).userData.homeNavigation })) });
      for (const id of ids) { expect(travelled.get(id), 'actor ' + id + ' moves through actual navigation ' + terminal).toBeGreaterThan(1); expect(late.get(id), 'actor ' + id + ' does not remain deadlocked ' + terminal).toBeGreaterThan(.2); }
      for (const row of items) { expect(exact(row.object)).toEqual(row.state); expect(row.object.matrixWorld.toArray()).toEqual(row.world); }
      expect(JSON.stringify(group)).toBe(original); expect(minGap).toBeGreaterThanOrEqual(-1e-4);
    }, 30_000);

  it.each(['forest', 'desert'] as const)('freezes real %s body matrices across a long pause and repeated unchanged updates, then resumes continuously', scene => {
    const group = snapshot(scene), original = JSON.stringify(group), f = setup(group); f.world.setMotion(true); for (let i = 0; i < 80; i++) step(f);
    f.world.setMotion(false); const before = group.companions.map(c => ({ root: actor(f, c.id), matrix: actor(f, c.id).matrixWorld.toArray(), meshes: [] as Array<{ object: THREE.Mesh; matrix: number[] }> })), props = savedState(f), env = environment(f);
    before.forEach(row => row.root.traverse(object => { if (object instanceof THREE.Mesh) row.meshes.push({ object, matrix: object.matrixWorld.toArray() }); }));
    vi.setSystemTime(Date.now() + 3_600_000);
    for (let i = 0; i < 4; i++) { f.world.update(group, null, 'outdoor'); f.world.reset(); for (const row of before) { expect(row.root.matrixWorld.toArray()).toEqual(row.matrix); row.meshes.forEach(mesh => expect(mesh.object.matrixWorld.toArray()).toEqual(mesh.matrix)); } }
    expect(environment(f)).toBe(env); props.forEach(row => expect(exact(row.object)).toEqual(row.state));
    const positions = before.map(row => row.root.position.clone()); f.world.setMotion(true); step(f, 50);
    before.forEach((row, i) => expect(row.root.position.distanceTo(positions[i])).toBeLessThan(.15)); expect(JSON.stringify(group)).toBe(original);
  });

  it('retains shared live resources during same-library item updates, releases old environment and actor resources once, and clears natural datasets on scope exit and dispose', () => {
    const group = snapshot('forest'), original = JSON.stringify(group), f = setup(group), oldEnvironment = environment(f), oldItems = group.items.map(item => savedItem(f, item.id)), oldResources = resources([oldEnvironment, ...oldItems]), oldSpies = spyResources(oldResources), itemGeometry = oldItems.flatMap(root => [...resources([root])].filter(value => value instanceof THREE.BufferGeometry));
    const moved = { ...group, revision: 2, items: group.items.map(item => item.id === 'saved-bench' ? { ...item, x: .80 } : item) }; f.world.update(moved, null, 'outdoor');
    expect(environment(f)).toBe(oldEnvironment); savedState(f, moved); const live = resources([oldEnvironment, ...moved.items.map(item => savedItem(f, item.id))]);
    for (const [resource, spy] of oldSpies) {
      const refs: string[] = []; for (const root of [oldEnvironment, ...moved.items.map(item => savedItem(f, item.id))]) root.traverse(object => { if (!(object instanceof THREE.Mesh)) return; const materials = Array.isArray(object.material) ? object.material : [object.material]; if (object.geometry === resource || materials.some(material => material === resource || Object.values(material).includes(resource))) refs.push(object.name); });
      expect(spy, 'a resource still used by the shared library cannot be released ' + JSON.stringify({ type: resource.type, uuid: resource.uuid, refs })).toHaveBeenCalledTimes(live.has(resource) ? 0 : 1);
    }
    itemGeometry.forEach(geometry => expect(oldSpies.get(geometry)).toHaveBeenCalledTimes(1));
    const allForest = resources([oldEnvironment, ...moved.items.map(item => savedItem(f, item.id))]); for (const value of allForest) if (!oldSpies.has(value)) oldSpies.set(value, vi.spyOn(value, 'dispose'));
    const winter = { ...moved, revision: 3, season: 'winter' as const }; f.world.update(winter, null, 'outdoor'); expect(environment(f)).not.toBe(oldEnvironment); expect(oldEnvironment.parent).toBeNull(); oldSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    const removed = actor(f, 6), removedSpies = spyResources(resources([removed])), two = { ...winter, revision: 4, companions: winter.companions.filter(c => c.id !== 6) }; f.world.update(two, null, 'outdoor'); expect(removed.parent).toBeNull(); removedSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    const desert = { ...snapshot('desert', 2), revision: 5 }; f.world.update(desert, null, 'outdoor'); expect(f.host.dataset.naturalWorld).toBe('desert'); const desertEnvironment = environment(f), desertSpies = spyResources(resources([desertEnvironment, ...desert.items.map(item => savedItem(f, item.id))]));
    const viewer = { ...desert, revision: 6, me: 'viewer' }; f.world.update(viewer, null, 'outdoor'); expect(environment(f)).toBe(desertEnvironment); desertSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    const production = { ...viewer, revision: 7, id: 'production-natural-world' }; f.world.update(production, null, 'outdoor'); expect(f.host.dataset.naturalWorld).toBeUndefined(); expect(f.host.dataset.naturalObstacleCount).toBeUndefined(); expect(desertEnvironment.parent).toBeNull(); desertSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    expect(f.renderer.scene!.getObjectByName('realistic-desert-oasis')).toBeUndefined(); expect(actor(f, 4).userData.homeNavigation).toBeUndefined();
    const stale = f.renderer.loop; f.world.dispose(); f.world.dispose(); stale?.(Date.now() + 100); expect(f.host.dataset.naturalWorld).toBeUndefined(); expect(f.host.dataset.naturalObstacleCount).toBeUndefined(); oldSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1)); desertSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1)); removedSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1)); expect(JSON.stringify(group)).toBe(original);
  }, 20_000);
});
