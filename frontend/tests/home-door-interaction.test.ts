import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHomeWorldEnvironment, setHomeWorldDoorOpenness, type HomeWorldDoorId } from '@/lib/living-home-world-meshes';
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
function setup() {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
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

describe('physical door-leaf openness without replacing geometry', () => {
  it.each([ENTRY, ROOM])('closes the actual %s aperture and restores its open route by rotating only its existing leaf', id => {
    const root = geometry(), door = root.getObjectByName(id)!, target = leaf(root, id), before = resources(root);
    const fixed = [door.position.clone(), door.scale.clone(), door.getObjectByName(id + '-frame')!.matrixWorld.clone()];
    const origin = id === ENTRY ? new THREE.Vector3(-2.4, 1.2, .7) : new THREE.Vector3(-.7, 1.2, -1.525);
    const finish = id === ENTRY ? new THREE.Vector3(-2.4, 1.2, -.7) : new THREE.Vector3(.7, 1.2, -1.525);
    const direction = finish.clone().sub(origin), ray = new THREE.Raycaster(origin, direction.clone().normalize(), 0, direction.length());
    expect(door.userData.homeDoorId).toBe(id); expect(door.userData.homeDoorOpenness).toBe(1);
    setHomeWorldDoorOpenness(root, id, 0); expect(target.rotation.y).toBeCloseTo(0, 10);
    expect(ray.intersectObject(target, true).some(hit => hit.object.name === id + '-panel')).toBe(true);
    setHomeWorldDoorOpenness(root, id, .5); expect(target.rotation.y).toBeCloseTo(-68 * Math.PI / 180 * .5, 10);
    setHomeWorldDoorOpenness(root, id, 1); expect(ray.intersectObject(root.getObjectByName('home-world-architecture')!, true)).toHaveLength(0);
    expect(door.position.equals(fixed[0] as THREE.Vector3)).toBe(true); expect(door.scale.equals(fixed[1] as THREE.Vector3)).toBe(true);
    expect(door.getObjectByName(id + '-frame')!.matrixWorld.equals(fixed[2] as THREE.Matrix4)).toBe(true);
    expect(resources(root)).toEqual(before);
  });

  it('bounds numeric openness and ignores a missing leaf without allocating or disposing resources', () => {
    const root = geometry(), target = leaf(root, ENTRY), live = resources(root);
    const releases = [...live.geometries, ...live.materials].map(resource => vi.spyOn(resource, 'dispose'));
    for (const [input, value] of [[-2, 0], [2, 1], [Number.NaN, 0], [Infinity, 1], [-Infinity, 0]] as const) {
      setHomeWorldDoorOpenness(root, ENTRY, input); expect(root.getObjectByName(ENTRY)!.userData.homeDoorOpenness).toBe(value);
      expect(target.rotation.y).toBeCloseTo(-68 * Math.PI / 180 * value);
    }
    setHomeWorldDoorOpenness(new THREE.Group(), ROOM, .5);
    expect(resources(root)).toEqual(live); for (const release of releases) expect(release).not.toHaveBeenCalled();
    geometryRoots.splice(geometryRoots.indexOf(root), 1); disposeLivingObject(root);
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
  });
});

describe('local scene door interaction and animation', () => {
  it('retains door targets across snapshots, room focus and environment rebuilds while a fresh instance defaults open', () => {
    const { world, renderer, changed, group } = setup(), before = JSON.stringify(group);
    world.setDoorOpen(ENTRY, false); world.setDoorOpen(ROOM, false);
    expect(leaf(renderer.scene!, ENTRY).rotation.y).toBeCloseTo(0); expect(leaf(renderer.scene!, ROOM).rotation.y).toBeCloseTo(0);
    const count = changed.mock.calls.length;
    world.update({ ...group, revision: 4 }, null, 'bedroom'); world.rotate(.3); world.zoom(.9); world.reset();
    world.update({ ...group, revision: 5, season: 'winter' }, null, 'overview');
    expect(leaf(renderer.scene!, ENTRY).rotation.y).toBeCloseTo(0); expect(leaf(renderer.scene!, ROOM).rotation.y).toBeCloseTo(0);
    expect(changed).toHaveBeenCalledTimes(count); expect(JSON.stringify(group)).toBe(before);
    const reopened = setup(); expect(leaf(reopened.renderer.scene!, ENTRY).rotation.y).toBeCloseTo(-68 * Math.PI / 180);
  });

  it('eases the existing leaf while motion runs, then immediately applies its target on pause and static commands', () => {
    vi.useFakeTimers(); const { world, renderer, changed } = setup(); world.setMotion(true);
    const target = leaf(renderer.scene!, ENTRY), openAngle = target.rotation.y; world.setDoorOpen(ENTRY, false);
    expect(target.rotation.y).toBeCloseTo(openAngle, 4); expect(changed).toHaveBeenLastCalledWith(ENTRY, false);
    vi.advanceTimersByTime(80); renderer.loop?.(80);
    expect(target.rotation.y).toBeGreaterThan(openAngle); expect(target.rotation.y).toBeLessThan(0);
    world.setMotion(false); expect(target.rotation.y).toBeCloseTo(0, 6); expect(renderer.loop).toBeNull();
    world.setDoorOpen(ENTRY, true); expect(target.rotation.y).toBeCloseTo(openAngle, 6);
  });

  it.each([ENTRY, ROOM])('toggles visible %s by raycast but ignores dragging, cancellation and disposed canvases', id => {
    const { world, renderer, changed, selected, group } = setup();
    if (id === ROOM) world.update(group, null, 'indoor');
    world.setDoorOpen(id, false); changed.mockClear();
    let point = pointOnPanel(renderer, id); pointer(renderer, point, 'pointerdown'); pointer(renderer, point, 'pointerup');
    expect(changed).toHaveBeenCalledOnce(); expect(changed).toHaveBeenLastCalledWith(id, true); expect(selected).not.toHaveBeenCalled();
    changed.mockClear(); point = pointOnPanel(renderer, id);
    pointer(renderer, point, 'pointerdown'); pointer(renderer, point, 'pointerup', 0, 30);
    pointer(renderer, point, 'pointerdown'); pointer(renderer, point, 'pointercancel'); pointer(renderer, point, 'pointerup');
    expect(changed).not.toHaveBeenCalled(); world.dispose();
    pointer(renderer, point, 'pointerdown'); pointer(renderer, point, 'pointerup'); world.toggleDoor(id); expect(changed).not.toHaveBeenCalled();
  });

  it('emits exactly one change per new valid target and ignores invalid values or a different scene', () => {
    const { world, changed, group } = setup();
    world.setDoorOpen(ENTRY, false); world.setDoorOpen(ENTRY, false);
    world.setDoorOpen('not-a-home-door' as HomeWorldDoorId, true); world.toggleDoor('not-a-home-door' as HomeWorldDoorId);
    world.setDoorOpen(ENTRY, 1 as unknown as boolean);
    expect(changed).toHaveBeenCalledOnce(); expect(changed).toHaveBeenLastCalledWith(ENTRY, false);
    world.update({ ...group, scene_type: 'forest' }, null); world.setDoorOpen(ENTRY, true); world.toggleDoor(ROOM);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('blocks the hidden room door and any exterior door ray occluded by the real roof or back wall', () => {
    const { world, renderer, changed } = setup(); world.setDoorOpen(ENTRY, false); changed.mockClear(); world.setHouseView('exterior');
    world.toggleDoor(ROOM); world.setDoorOpen(ROOM, false); expect(changed).not.toHaveBeenCalled();
    let point = pointOnPanel(renderer, ROOM); pointer(renderer, point, 'pointerdown'); pointer(renderer, point, 'pointerup'); expect(changed).not.toHaveBeenCalled();
    world.rotate(Math.PI); point = pointOnPanel(renderer, ENTRY);
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(point.x, point.y), renderer.camera!);
    const hits = ray.intersectObject(renderer.scene!.getObjectByName('home-world-architecture')!, true).filter(hit => {
      for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) if (!object.visible) return false;
      return true;
    });
    expect(hits.length).toBeGreaterThan(0); expect(hits[0].object.name).not.toBe(ENTRY + '-panel');
    pointer(renderer, point, 'pointerdown'); pointer(renderer, point, 'pointerup'); expect(changed).not.toHaveBeenCalled();
  });

  it('creates no resources on repeated commands and releases every live scene resource once', () => {
    const { world, renderer } = setup(), live = resources(renderer.scene!);
    const releases = [...live.geometries, ...live.materials].map(resource => vi.spyOn(resource, 'dispose'));
    for (let index = 0; index < 12; index++) { world.toggleDoor(ENTRY); world.toggleDoor(ROOM); }
    expect(resources(renderer.scene!)).toEqual(live); for (const release of releases) expect(release).not.toHaveBeenCalled();
    world.dispose(); world.dispose(); for (const release of releases) expect(release).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce(); expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
  });
});
