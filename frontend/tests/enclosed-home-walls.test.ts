import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHomeWorldArchitectureView, buildHomeWorldEnvironment, setHomeWorldDoorOpenness, type HomeWorldDoorId } from '@/lib/living-home-world-meshes';
import { createLivingWorld, disposeLivingObject } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';

const ENTRY: HomeWorldDoorId = 'home-main-entry-door', ROOM: HomeWorldDoorId = 'home-room-connection-door';
const gpu = vi.hoisted(() => ({ instances: [] as Array<{ domElement: HTMLCanvasElement; scene: THREE.Scene | null; camera: THREE.Camera | null;
  loop: ((time: number) => void) | null; dispose: ReturnType<typeof vi.fn>; forceContextLoss: ReturnType<typeof vi.fn> }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class Renderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 }; outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; camera: THREE.Camera | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((callback: ((time: number) => void) | null) => { this.loop = callback; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; this.camera = camera; });
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: Renderer };
});

const geometryRoots: THREE.Group[] = [], worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => { gpu.instances.length = 0; vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { worlds.splice(0).forEach(world => world.dispose()); geometryRoots.splice(0).forEach(disposeLivingObject); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function geometry() { const root = buildHomeWorldEnvironment('summer', { resting: 10, sleeping: 10 }); geometryRoots.push(root); return root; }
function leaf(root: THREE.Object3D, id: HomeWorldDoorId) { return root.getObjectByName(id + '-leaf')!; }
function resources(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  root.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
  return { geometries, materials };
}
function snapshot() {
  return parseGathering({ id: 'synthetic-door-world', title: '合成可交互房门', scene_type: 'home', revision: 3, closed: false, is_manager: true, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '合成成员', manager: true }],
    companions: [{ id: 4, name: '合成伙伴', owner_id: 'owner', activity: 'walk', area: 'outdoor', x: .8, y: .7,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [{ id: 'saved-bench', kind: 'bench', x: .8, y: .5, mine: true, contributor_name: '合成成员', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function setup(width = 800, height = 500) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: width }, clientHeight: { value: height } }); document.body.append(host, labels);
  const changed = vi.fn(), selected = vi.fn(), group = snapshot();
  const world = createLivingWorld(host, labels, group, selected, changed); worlds.push(world);
  const renderer = gpu.instances[gpu.instances.length - 1], canvas = renderer.domElement;
  canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn(); canvas.hasPointerCapture = vi.fn(() => false);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, toJSON: () => ({}) });
  return { host, world, renderer, changed, selected, group };
}
function pointOnPanel(renderer: typeof gpu.instances[number], id: HomeWorldDoorId) {
  return new THREE.Box3().setFromObject(renderer.scene!.getObjectByName(id + '-panel')!).getCenter(new THREE.Vector3()).project(renderer.camera!);
}
function pointer(renderer: typeof gpu.instances[number], point: THREE.Vector3, kind: string, dx = 0, dy = 0) {
  renderer.domElement.dispatchEvent(new MouseEvent(kind, { bubbles: true, clientX: (point.x + 1) * 400 + dx, clientY: (1 - point.y) * 250 + dy }));
}


const GATE: HomeWorldDoorId = 'home-courtyard-gate';

function byRole(root: THREE.Object3D, role: string) {
  const found: THREE.Object3D[] = []; root.traverse(object => { if (object.userData.architectureRole === role) found.push(object); }); return found;
}
function materials(root: THREE.Object3D) { return [...resources(root).materials] as THREE.MeshStandardMaterial[]; }
function ghost(object: THREE.Object3D) { for (let node: THREE.Object3D | null = object; node; node = node.parent) if (node.userData.homeWallGhost) return true; return false; }
function visible(object: THREE.Object3D) { for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false; return true; }
function ray(from: THREE.Vector3, to: THREE.Vector3) { const delta = to.clone().sub(from); return new THREE.Raycaster(from, delta.clone().normalize(), 0, delta.length()); }

describe('a fully enclosed home with visible, independent wall materials', () => {
  it.each([
    ['overview', 1088, 550], ['overview', 390, 360], ['outdoor', 1088, 550], ['outdoor', 390, 360],
  ] as const)('fits the real overview or courtyard outline in %s at %s×%s without clipping any relevant modeled vertex', (view, width, height) => {
    const { world, renderer, group } = setup(width, height); world.update(group, null, view);
    const root = renderer.scene!.getObjectByName('home-world-environment')!, camera = renderer.camera!;
    expect(camera).toBeInstanceOf(THREE.PerspectiveCamera); expect((camera as THREE.PerspectiveCamera).aspect).toBeCloseTo(width / height);
    const bounds = new THREE.Box3(), point = new THREE.Vector3(); let count = 0;
    const outlines = view === 'overview' ? [root] : ['home-environment-outdoor', 'home-courtyard-enclosure', 'home-courtyard-entry-pad', GATE].map(name => root.getObjectByName(name)!);
    const seen = new Set<THREE.Object3D>();
    for (const outline of outlines) { expect(outline).toBeDefined(); outline.traverse(object => {
      if (!(object instanceof THREE.Mesh) || seen.has(object)) return; seen.add(object); const positions = object.geometry.attributes.position;
      for (let index = 0; index < positions.count; index++) { point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).project(camera); bounds.expandByPoint(point); count++; }
    }); }
    const observed = JSON.stringify({ min: bounds.min.toArray(), max: bounds.max.toArray() });
    expect(count).toBeGreaterThan(1000);
    for (const axis of ['x', 'y', 'z'] as const) { expect(bounds.min[axis], observed).toBeGreaterThan(-1); expect(bounds.max[axis], observed).toBeLessThan(1); }
  });

  it('keeps near upper walls visible and translucent while far walls, lower walls, partition and all doors stay solid', () => {
    const root = geometry(), upper = byRole(root, 'exterior-wall-upper'); expect(upper).toHaveLength(4);
    applyHomeWorldArchitectureView(root, 'interior', { x: 18, y: 10, z: 20 });
    const near = upper.filter(wall => wall.userData.homeWallGhost), far = upper.filter(wall => !wall.userData.homeWallGhost);
    expect(near.length).toBeGreaterThan(0); expect(far.length).toBeGreaterThan(0);
    for (const wall of upper) expect(wall.visible).toBe(true);
    for (const wall of near) for (const material of materials(wall)) { expect(material.transparent).toBe(true); expect(material.opacity).toBeGreaterThan(0); expect(material.opacity).toBeLessThan(1); expect(material.depthWrite).toBe(false); }
    for (const wall of near) wall.traverse(object => { if (object instanceof THREE.Mesh) expect(object.castShadow).toBe(false); });
    const solid = [...far, ...byRole(root, 'exterior-wall-low'), ...byRole(root, 'interior-partition'), ...byRole(root, 'door'), root.getObjectByName('home-courtyard-enclosure')!];
    expect(solid.every(Boolean)).toBe(true);
    for (const object of solid) { expect(ghost(object)).toBe(false); for (const material of materials(object)) { expect(material.transparent).toBe(false); expect(material.opacity).toBe(1); expect(material.depthWrite).toBe(true); } }
    const nearMaterials = new Set(near.flatMap(materials));
    for (const object of solid) for (const material of materials(object)) expect(nearMaterials.has(material)).toBe(false);
    const firstNear = near.map(wall => wall.uuid);
    applyHomeWorldArchitectureView(root, 'interior', { x: -18, y: 10, z: -20 });
    expect(upper.filter(wall => wall.userData.homeWallGhost).map(wall => wall.uuid)).not.toEqual(firstNear);
    applyHomeWorldArchitectureView(root, 'exterior', { x: -18, y: 10, z: -20 });
    for (const wall of upper) { expect(wall.visible).toBe(true); expect(ghost(wall)).toBe(false); for (const material of materials(wall)) { expect(material.transparent).toBe(false); expect(material.opacity).toBe(1); expect(material.depthWrite).toBe(true); } }
    for (const wall of upper) wall.traverse(object => { if (object instanceof THREE.Mesh) expect(object.castShadow).toBe(true); });
  });

  it('physically encloses both courtyard sides and front while the real wooden gate closes and opens its actual entrance', () => {
    const root = geometry(), enclosure = root.getObjectByName('home-courtyard-enclosure')!;
    expect(enclosure).toBeDefined();
    for (const side of [-1, 1]) for (const z of [.5, 3, 6, 7.7]) {
      const hit = ray(new THREE.Vector3(side * 6.1, .45, z), new THREE.Vector3(side * 4.8, .45, z)).intersectObject(enclosure, true)[0];
      expect(hit, `missing side enclosure at ${side},${z}`).toBeDefined(); expect(Math.abs(Math.abs(hit.point.x) - 5.45)).toBeLessThan(.3);
    }
    for (const x of [-4.5, -2, 2, 4.5]) expect(ray(new THREE.Vector3(x, .45, 9), new THREE.Vector3(x, .45, 7.5)).intersectObject(enclosure, true).length).toBeGreaterThan(0);
    const gate = root.getObjectByName(GATE)!, crossing = ray(new THREE.Vector3(0, .55, 9.1), new THREE.Vector3(0, .55, 7.4));
    expect(gate.userData.homeDoorId).toBe(GATE); expect(gate.getObjectByName(GATE + '-panel')).toBeInstanceOf(THREE.Mesh);
    setHomeWorldDoorOpenness(root, GATE, 0); expect(crossing.intersectObject(leaf(root, GATE), true).length).toBeGreaterThan(0);
    setHomeWorldDoorOpenness(root, GATE, 1); expect(crossing.intersectObject(root, true)).toHaveLength(0);
    for (let z = 3.5; z <= 10.05; z += .25) {
      const floor = new THREE.Raycaster(new THREE.Vector3(0, 1.8, z), new THREE.Vector3(0, -1, 0), 0, 2).intersectObject(root, true)[0];
      expect(floor, `missing gate approach floor at ${z}`).toBeDefined(); expect(floor.point.y).toBeLessThanOrEqual(.065); expect(floor.point.y).toBeGreaterThanOrEqual(-.025);
    }
  });

  it('changes neither material identities nor geometry across repeated modes and disposes each live resource exactly once', () => {
    const root = geometry(), live = resources(root), releases = [...live.geometries, ...live.materials].map(resource => vi.spyOn(resource, 'dispose'));
    const transforms = new Map<THREE.Object3D, string>(); root.traverse(object => transforms.set(object, JSON.stringify([object.position.toArray(), object.quaternion.toArray(), object.scale.toArray()])));
    for (let index = 0; index < 12; index++) applyHomeWorldArchitectureView(root, index % 2 ? 'exterior' : 'interior', { x: index % 3 ? 18 : -18, y: 10, z: index % 3 ? 20 : -20 });
    expect(resources(root)).toEqual(live);
    root.traverse(object => expect(JSON.stringify([object.position.toArray(), object.quaternion.toArray(), object.scale.toArray()])).toBe(transforms.get(object)));
    for (const release of releases) expect(release).not.toHaveBeenCalled();
    geometryRoots.splice(geometryRoots.indexOf(root), 1); disposeLivingObject(root); for (const release of releases) expect(release).toHaveBeenCalledOnce();
  });
});

describe('visible ghost wall and courtyard gate interaction', () => {
  it('allows an indoor avatar ray through the visible ghost upper wall while the solid lower wall blocks the same avatar', () => {
    const { world, renderer, selected, changed, group } = setup();
    const inside = { ...group, companions: group.companions.map(c => ({ ...c, activity: 'rest', area: 'indoor' as const })) };
    world.update(inside, null, 'indoor'); const before = JSON.stringify(inside), environment = renderer.scene!.getObjectByName('home-world-environment')!;
    const avatar = renderer.scene!.children.find(object => object.userData.characterId === 4)!;
    const center = new THREE.Box3().setFromObject(avatar).getCenter(new THREE.Vector3()), camera = renderer.camera!;
    for (const [height, passes] of [[.35, false], [2.5, true]] as const) {
      camera.position.set(center.x, height, 2); camera.lookAt(center); camera.updateMatrixWorld(true);
      applyHomeWorldArchitectureView(environment, 'interior', camera.position);
      const blocker = ray(camera.position, center).intersectObject(environment, true).find(hit => visible(hit.object));
      expect(blocker).toBeDefined(); expect(ghost(blocker!.object)).toBe(passes);
      const point = center.clone().project(camera); pointer(renderer, point, 'pointerdown'); pointer(renderer, point, 'pointerup');
      if (passes) expect(selected).toHaveBeenLastCalledWith(4); else expect(selected).not.toHaveBeenCalled();
    }
    expect(changed).not.toHaveBeenCalled(); expect(JSON.stringify(inside)).toBe(before);
  });

  it('toggles the real courtyard gate by pointer, preserves other targets and restores its local closed state after an environment rebuild', () => {
    const { world, renderer, changed, group } = setup(), before = JSON.stringify(group); world.setHouseView('exterior'); world.setDoorOpen(GATE, false); changed.mockClear();
    let point = pointOnPanel(renderer, GATE); pointer(renderer, point, 'pointerdown'); pointer(renderer, point, 'pointerup');
    expect(changed).toHaveBeenCalledOnce(); expect(changed).toHaveBeenLastCalledWith(GATE, true);
    for (const id of [ENTRY, ROOM]) expect(leaf(renderer.scene!, id).rotation.y).toBeCloseTo(-68 * Math.PI / 180);
    world.setMotion(false); world.setDoorOpen(GATE, false); expect(leaf(renderer.scene!, GATE).rotation.y).toBeCloseTo(0);
    const count = changed.mock.calls.length; world.update({ ...group, revision: 4, season: 'winter' }, null, 'overview');
    expect(leaf(renderer.scene!, GATE).rotation.y).toBeCloseTo(0); expect(changed).toHaveBeenCalledTimes(count);
    world.setHouseView('interior'); point = pointOnPanel(renderer, GATE); changed.mockClear();
    pointer(renderer, point, 'pointerdown'); pointer(renderer, point, 'pointerup', 20); expect(changed).not.toHaveBeenCalled();
    expect(JSON.stringify(group)).toBe(before);
  });
});
