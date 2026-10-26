import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Three from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';
import { homeWorldPoint, type HomeWorldView } from '@/lib/living-home-world';

const rendererState = vi.hoisted(() => ({
  failRender: false,
  instances: [] as Array<{
    domElement: HTMLCanvasElement;
    render: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    forceContextLoss: ReturnType<typeof vi.fn>;
    setAnimationLoop: ReturnType<typeof vi.fn>;
    setClearColor: ReturnType<typeof vi.fn>;
    constructionOptions: Three.WebGLRendererParameters;
    lastScene: Three.Scene | null;
    lastCamera: Three.Camera | null;
    meshCountAtFirstRender: number;
    labelsAtFirstRender: number;
  }>,
}));

// Only the GPU boundary is replaced. Scene construction, geometry, materials,
// raycasting and OrbitControls remain the installed Three.js implementations.
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  class RendererWithoutGPU {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    meshCountAtFirstRender = 0;
    labelsAtFirstRender = 0;
    recordedFirstRender = false;
    constructionOptions: Three.WebGLRendererParameters;
    lastScene: Three.Scene | null = null;
    lastCamera: Three.Camera | null = null;
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    setAnimationLoop = vi.fn();
    setClearColor = vi.fn();
    dispose = vi.fn();
    forceContextLoss = vi.fn();
    render = vi.fn((scene: Three.Scene, camera: Three.Camera) => {
      this.lastScene = scene; this.lastCamera = camera;
      if (!this.recordedFirstRender) {
        this.recordedFirstRender = true;
        scene.traverse(object => { if (object instanceof actual.Mesh) this.meshCountAtFirstRender += 1; });
        this.labelsAtFirstRender = document.querySelectorAll('.living3d-name').length;
      }
      if (rendererState.failRender) throw new Error('synthetic first-render failure');
    });
    constructor(options: Three.WebGLRendererParameters) { this.constructionOptions = options; rendererState.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: RendererWithoutGPU };
});

const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
function installResizeObserver() {
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor() { observers.push(this); }
  });
}

function snapshot() {
  return parseGathering({
    id: '11111111-1111-4111-8111-111111111111', title: '合成资源恢复测试', scene_type: 'home',
    revision: 1, closed: false, is_manager: true, me: 'synthetic-owner', invitation: null,
    members: [{ id: 'synthetic-owner', name: '合成成员', manager: true }],
    companions: [{ id: 4, name: '合成杯子', owner_id: 'synthetic-owner', activity: 'walk', x: .5, y: .5,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [{ id: 'synthetic-bench', kind: 'bench', x: .3, y: .4, mine: true, contributor_name: '合成成员', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: null },
  });
}

function layers() {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } });
  document.body.append(host, labels);
  return { host, labels };
}

function character(scene: Three.Scene, id = 4) {
  let value: Three.Object3D | undefined;
  scene.traverse(object => { if (object.userData.characterId === id) value = object; });
  expect(value).toBeDefined();
  return value!;
}

function mixedSnapshot() {
  const group = snapshot(), prototype = group.companions[0];
  group.members.push({ id: 'synthetic-friend', name: '合成朋友', manager: false });
  group.companions = [
    { ...prototype, id: 4, name: '客厅伙伴', activity: 'rest', area: 'indoor' },
    { ...prototype, id: 5, name: '卧室伙伴', activity: 'sleep', area: 'bedroom' },
    { ...prototype, id: 6, name: '院子朋友', owner_id: 'synthetic-friend', activity: 'walk', area: 'outdoor', x: .7, y: .4 },
  ];
  return group;
}

function sceneResources(scene: Three.Scene) {
  const geometries = new Set<Three.BufferGeometry>(), materials = new Set<Three.Material>();
  scene.traverse(object => {
    if (!(object instanceof Three.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  return { geometries, materials };
}

function bedPillows(scene: Three.Scene, slot: { id: number; y: number; length: number }) {
  const bed = scene.getObjectByName(`room-bed-${slot.id}`)!;
  const pillows = bed.children.filter(child => child instanceof Three.Mesh && child.position.y > slot.y
    && child.position.z < -slot.length * .2 && child.position.z > -slot.length * .45);
  expect(pillows.length).toBeGreaterThan(0);
  return pillows.reduce((bounds, pillow) => bounds.union(new Three.Box3().setFromObject(pillow)), new Three.Box3());
}

function indexedVisibleBounds(root: Three.Object3D, coreOnly = false) {
  const bounds = new Three.Box3(), point = new Three.Vector3(); root.updateWorldMatrix(true, true);
  root.traverse(object => {
    if (!(object instanceof Three.Mesh) || coreOnly && object.userData.sleepBodySupport !== true) return;
    for (let parent: Three.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return;
    const positions = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let i = 0; i < (indices?.count ?? positions.count); i++) bounds.expandByPoint(point.fromBufferAttribute(positions, indices ? indices.getX(i) : i).applyMatrix4(object.matrixWorld));
  }); expect(bounds.isEmpty()).toBe(false); return bounds;
}

function expectActualSleepingContact(root: Three.Object3D, top: number) {
  expect(indexedVisibleBounds(root, true).min.y).toBeCloseTo(top, 5);
  expect(indexedVisibleBounds(root).min.y).toBeGreaterThanOrEqual(top - 1e-5);
  let cylinders = 0;
  root.traverse(object => {
    if (!(object instanceof Three.Mesh) || object.userData.sleepBodySupport !== true || object.geometry.type !== 'CylinderGeometry') return;
    cylinders++;
    const positions = object.geometry.getAttribute('position'), indices = object.geometry.index;
    let low = Infinity, high = -Infinity; for (let i = 0; i < positions.count; i++) { low = Math.min(low, positions.getY(i)); high = Math.max(high, positions.getY(i)); }
    let lower = Infinity, upper = Infinity; const point = new Three.Vector3(), middle = (low + high) / 2;
    for (let i = 0; i < (indices?.count ?? positions.count); i++) {
      const vertex = indices ? indices.getX(i) : i, y = positions.getY(vertex);
      point.fromBufferAttribute(positions, vertex).applyMatrix4(object.matrixWorld);
      if (y < middle) lower = Math.min(lower, point.y); if (y > middle) upper = Math.min(upper, point.y);
    }
    // Both real end rings determine the supported taper angle; one touching
    // tip or a cached pre-fold bounding box cannot satisfy this contract.
    expect(lower).toBeCloseTo(top, 5); expect(upper).toBeCloseTo(top, 5);
  });
  if (!cylinders) expect(root.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
  const facing = new Three.Vector3(0, 0, 1).transformDirection(root.matrixWorld), head = new Three.Vector3(0, 1, 0).transformDirection(root.matrixWorld);
  expect(facing.y).toBeGreaterThan(.85); expect(head.z).toBeLessThan(-.85);
}

beforeEach(() => {
  rendererState.failRender = false;
  rendererState.instances.length = 0;
  observers.length = 0;
  installResizeObserver();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('shared living WebGL resource recovery', () => {
  it('renders the real cottage courtyard, saved furniture and volume avatars in the same perspective scene', () => {
    const g = snapshot(), before = JSON.stringify(g), { host, labels } = layers();
    const world = createLivingWorld(host, labels, g, vi.fn());
    const renderer = rendererState.instances[0];
    expect(renderer.constructionOptions.alpha).toBe(true);
    expect(renderer.setClearColor.mock.lastCall?.[1]).toBe(1);
    expect(renderer.lastScene?.background).toBeInstanceOf(Three.Color);
    expect(renderer.lastCamera).toBeInstanceOf(Three.PerspectiveCamera);
    expect(host.dataset.presentation).toBe('home-world');
    expect(host.dataset.camera).toBe('perspective');
    const environment = renderer.lastScene!.getObjectByName('home-environment-outdoor')!;
    expect(environment).toBeDefined();
    expect(renderer.lastScene!.getObjectByName('home-environment-indoor')).toBeDefined();
    expect(renderer.lastScene!.getObjectByName('home-environment-bedroom')).toBeDefined();
    expect(renderer.lastScene!.getObjectByName('home-continuous-veranda')).toBeDefined();
    expect(environment.getObjectByName('courtyard-stone-cottage')).toBeUndefined();
    expect(Number(host.dataset.environmentMeshes)).toBeGreaterThan(100);
    expect(Number(host.dataset.itemMeshes)).toBeGreaterThan(0);
    const avatarGeometry: Three.BufferGeometry[] = [];
    character(renderer.lastScene!).traverse(object => {
      if (!(object instanceof Three.Mesh)) return;
      avatarGeometry.push(object.geometry);
    });
    expect(avatarGeometry.length).toBeGreaterThan(10);
    expect(avatarGeometry.some(geometry => {
      geometry.computeBoundingBox();
      return geometry.boundingBox!.getSize(new Three.Vector3()).z > .05;
    })).toBe(true);
    expect(JSON.stringify(g)).toBe(before);
    world.dispose();
  });

  it('orbits and zooms the actual camera while preserving character scale and all saved anchors', () => {
    const controlsUpdate = vi.spyOn(OrbitControls.prototype, 'update');
    const g = snapshot(), before = JSON.stringify(g), { host, labels } = layers();
    const world = createLivingWorld(host, labels, g, vi.fn());
    world.update(g, 4); world.setMotion(false);
    const renderer = rendererState.instances[0], camera = renderer.lastCamera!;
    const cameraPosition = camera.position.clone(), cameraRotation = camera.quaternion.clone();
    const projection = camera.projectionMatrix.clone();
    const selected = character(renderer.lastScene!);
    const rotationBefore = selected.rotation.clone(), scaleBefore = selected.scale.clone(), positionBefore = selected.position.clone();
    const controls = controlsUpdate.mock.contexts.find((value): value is OrbitControls => value instanceof OrbitControls && value.object === camera)!;
    expect(controls).toBeDefined();
    const target = controls.target.clone(), initialDistance = camera.position.distanceTo(target);
    world.rotate(.4);
    expect(camera.position.equals(cameraPosition)).toBe(false);
    expect(camera.quaternion.equals(cameraRotation)).toBe(false);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(initialDistance, 6);
    world.zoom(.85);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(initialDistance * .85, 6);
    expect(controls.target.equals(target)).toBe(true);
    expect(camera.projectionMatrix.equals(projection)).toBe(true);
    expect(selected.rotation.equals(rotationBefore)).toBe(true);
    expect(selected.scale.equals(scaleBefore)).toBe(true);
    expect(selected.position.equals(positionBefore)).toBe(true);
    world.reset();
    expect(camera.position.distanceTo(cameraPosition)).toBeLessThan(1e-8);
    expect(camera.quaternion.angleTo(cameraRotation)).toBeLessThan(1e-6);
    expect(JSON.stringify(g)).toBe(before);
    world.dispose(); world.dispose();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
  });

  it('releases the forest scene and rebuilds the volumetric courtyard without changing its saved furniture', () => {
    const home = snapshot(), forest = { ...home, scene_type: 'forest' }, before = JSON.stringify(home);
    const { host, labels } = layers();
    const world = createLivingWorld(host, labels, home, vi.fn()), renderer = rendererState.instances[0];
    world.update(forest, 4);
    expect(renderer.lastCamera).toBeInstanceOf(Three.PerspectiveCamera);
    expect(renderer.lastScene?.background).not.toBeNull();
    expect(renderer.setClearColor.mock.lastCall?.[1]).toBe(1);
    const backgroundGeometries = new Set<Three.BufferGeometry>();
    renderer.lastScene!.traverse(object => {
      if (!(object instanceof Three.Mesh)) return;
      let owner: Three.Object3D | null = object;
      while (owner && owner.userData.characterId == null) owner = owner.parent;
      if (!owner) backgroundGeometries.add(object.geometry);
    });
    expect(backgroundGeometries.size).toBeGreaterThan(2);
    const releases = [...backgroundGeometries].map(geometry => vi.spyOn(geometry, 'dispose'));
    world.update(home, 4);
    expect(renderer.lastCamera).toBeInstanceOf(Three.PerspectiveCamera);
    expect(renderer.lastScene?.background).toBeInstanceOf(Three.Color);
    expect(renderer.lastScene!.getObjectByName('home-environment-outdoor')).toBeDefined();
    expect(renderer.setClearColor.mock.lastCall?.[1]).toBe(1);
    expect(Number(host.dataset.itemMeshes)).toBeGreaterThan(0);
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
    world.dispose(); world.dispose();
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(JSON.stringify(home)).toBe(before);
  });

  it('raycasts the volume companion without treating a scroll gesture or a disposed canvas as a selection', () => {
    const g = snapshot(), before = JSON.stringify(g), select = vi.fn(), { host, labels } = layers();
    const world = createLivingWorld(host, labels, g, select), renderer = rendererState.instances[0];
    const canvas = renderer.domElement;
    // jsdom has no pointer capture APIs; real browsers provide these to the
    // installed OrbitControls, including its pointer-cancel cleanup path.
    canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    canvas.hasPointerCapture = vi.fn(() => false);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, toJSON: () => ({}) });
    const avatars: Three.Object3D[] = [];
    renderer.lastScene!.traverse(object => { if (object.userData.characterId === 4) avatars.push(object); });
    const center = new Three.Box3().setFromObject(avatars[0]).getCenter(new Three.Vector3()).project(renderer.lastCamera!);
    const clientX = (center.x + 1) * 400, clientY = (1 - center.y) * 250;
    const pointer = (type: string, x = clientX, y = clientY) => canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    pointer('pointerdown'); pointer('pointerup');
    expect(select).toHaveBeenCalledOnce(); expect(select).toHaveBeenCalledWith(4);
    select.mockClear();
    pointer('pointerdown'); pointer('pointerup', clientX, clientY + 30);
    pointer('pointerdown'); pointer('pointercancel'); pointer('pointerup');
    expect(select).not.toHaveBeenCalled();
    world.dispose(); pointer('pointerdown'); pointer('pointerup');
    expect(select).not.toHaveBeenCalled(); expect(JSON.stringify(g)).toBe(before);
  });

  it('releases a fully constructed scene when the first render fails', () => {
    const geometryDispose = vi.spyOn(Three.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Three.Material.prototype, 'dispose');
    const controlsDispose = vi.spyOn(OrbitControls.prototype, 'dispose');
    const { host, labels } = layers();
    rendererState.failRender = true;
    expect(() => createLivingWorld(host, labels, snapshot(), vi.fn())).toThrow('synthetic first-render failure');
    const renderer = rendererState.instances[0];
    expect(renderer.meshCountAtFirstRender).toBeGreaterThan(10);
    expect(renderer.labelsAtFirstRender).toBe(1);
    expect(host.querySelector('canvas')).toBeNull();
    expect(labels.childElementCount).toBe(0);
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(controlsDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    const resources = sceneResources(renderer.lastScene!);
    expect(resources.geometries.size).toBeGreaterThan(10);
    for (const geometry of resources.geometries) expect(geometryDispose.mock.contexts.filter(value => value === geometry)).toHaveLength(1);
    for (const material of resources.materials) expect(materialDispose.mock.contexts.filter(value => value === material)).toHaveLength(1);
  });

  it('can reopen the same hosts after a failed render and disposes the recovered instance once', () => {
    const { host, labels } = layers();
    rendererState.failRender = true;
    expect(() => createLivingWorld(host, labels, snapshot(), vi.fn())).toThrow();
    rendererState.failRender = false;
    const world = createLivingWorld(host, labels, snapshot(), vi.fn());
    const [failed, recovered] = rendererState.instances;
    const resources = sceneResources(recovered.lastScene!);
    const geometryReleases = [...resources.geometries].map(geometry => vi.spyOn(geometry, 'dispose'));
    const materialReleases = [...resources.materials].map(material => vi.spyOn(material, 'dispose'));
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    expect(labels.querySelectorAll('.living3d-name')).toHaveLength(1);
    world.setMotion(true);
    expect(recovered.setAnimationLoop.mock.lastCall?.[0]).toBeTypeOf('function');
    world.setMotion(false);
    expect(recovered.setAnimationLoop).toHaveBeenLastCalledWith(null);
    const renderedBeforeRotation = recovered.render.mock.calls.length;
    world.rotate(.2);
    expect(recovered.render.mock.calls.length).toBeGreaterThan(renderedBeforeRotation);
    world.dispose();
    world.dispose();
    expect(host.querySelector('canvas')).toBeNull();
    expect(labels.childElementCount).toBe(0);
    for (const renderer of [failed, recovered]) {
      expect(renderer.dispose).toHaveBeenCalledOnce();
      expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    }
    for (const release of [...geometryReleases, ...materialReleases]) expect(release).toHaveBeenCalledOnce();
  });

  it('releases the canvas, context and controls if ResizeObserver is unavailable', () => {
    const controlsDispose = vi.spyOn(OrbitControls.prototype, 'dispose');
    const { host, labels } = layers();
    vi.stubGlobal('ResizeObserver', undefined);
    expect(() => createLivingWorld(host, labels, snapshot(), vi.fn())).toThrow();
    const renderer = rendererState.instances[0];
    expect(host.querySelector('canvas')).toBeNull();
    expect(labels.childElementCount).toBe(0);
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(controlsDispose).toHaveBeenCalledOnce();
  });
});


describe('sofa contact and actual sitting joints', () => {
  it.each([390, 1200])('pins the body to the actual sofa geometry at %ipx and resets when outside', width => {
    const g = snapshot(); g.companions[0].activity = 'rest'; g.companions[0].area = 'indoor';
    const before = JSON.stringify(g), host=document.createElement('div'), labels=document.createElement('div');
    Object.defineProperties(host,{clientWidth:{value:width},clientHeight:{value:width*2/3}});document.body.append(host,labels);
    const world=createLivingWorld(host,labels,g,vi.fn());world.update(g,4,true);world.setMotion(false);
    const renderer=rendererState.instances[0], roots:Three.Object3D[]=[];
    renderer.lastScene!.traverse(o=>{if(o.userData.characterId===4)roots.push(o)});
    const root=roots[0],body=root.getObjectByName('body')!,left=root.getObjectByName('left-leg')!,knee=root.getObjectByName('left-knee')!;
    expect(root.userData.roomRestSeat.characterId).toBe(4);
    expect(left.rotation.x).toBeCloseTo(-1.15);expect(knee.rotation.x).toBeCloseTo(1.15);
    // The body and cushion now share world coordinates rather than a photograph projection.
    const cushion = renderer.lastScene!.getObjectByName('sofa-main-seat')!;
    const cushionBounds = new Three.Box3().setFromObject(cushion);
    body.updateMatrixWorld(true); const bounds=new Three.Box3().setFromObject(body);
    expect(cushionBounds.max.y).toBeCloseTo(.72, 5);
    expect(bounds.min.y).toBeCloseTo(cushionBounds.max.y, 5);
    const seatPoint = homeWorldPoint('indoor', { x: 0, y: .72, z: -1.45 });
    expect(root.position.x).toBeCloseTo(seatPoint.x, 5);expect(root.position.z).toBeCloseTo(seatPoint.z, 5);
    expect(cushionBounds.containsPoint(new Three.Vector3(root.position.x, cushionBounds.max.y - .001, root.position.z))).toBe(true);
    const pose=root.position.clone(),hip=left.position.clone();world.setMotion(true);world.setMotion(false);
    expect(root.position.equals(pose)).toBe(true);expect(left.position.equals(hip)).toBe(true);expect(knee.rotation.x).toBeCloseTo(1.15);
    world.rotate(.2);world.zoom(.9);world.reset();
    expect(root.position.equals(pose)).toBe(true);expect(knee.rotation.x).toBeCloseTo(1.15);
    const outside={...g,companions:g.companions.map(c=>({...c,activity:'walk',area:'outdoor' as const}))};
    world.update(outside,4,false);world.setMotion(false);
    expect(root.userData.roomRestSeat).toBeUndefined();expect(left.position.y).toBeCloseTo(.30);expect(knee.rotation.x).toBe(0);expect(body.rotation.x).toBe(0);
    expect(JSON.stringify(g)).toBe(before);world.dispose();
  });

  it('keeps all ten mixed body types on their assigned real sofa surfaces', () => {
    const g = snapshot(), kinds = ['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature'] as const;
    g.companions = Array.from({ length: 10 }, (_, index) => ({ ...g.companions[0], id: index + 4,
      activity: 'rest', area: 'indoor' as const, avatar3d: { ...g.companions[0].avatar3d!, kind: kinds[index % kinds.length] } }));
    const before = JSON.stringify(g), { host, labels } = layers(), world = createLivingWorld(host, labels, g, vi.fn());
    world.update(g, 4, true); world.setMotion(false);
    const scene = rendererState.instances[0].lastScene!;
    expect(host.dataset.seatedCharacters).toBe('10');
    for (let index = 0; index < 10; index++) {
      const root = character(scene, index + 4), body = root.getObjectByName('body')!;
      const cushion = scene.getObjectByName(index < 3 ? 'sofa-main-seat' : 'sofa-extra-seat')!;
      const bounds = new Three.Box3().setFromObject(cushion);
      expect(new Three.Box3().setFromObject(body).min.y).toBeCloseTo(bounds.max.y, 5);
      expect(bounds.containsPoint(new Three.Vector3(root.position.x, bounds.max.y - .001, root.position.z))).toBe(true);
      expect(root.getObjectByName('left-knee')!.rotation.x).toBeCloseTo(1.15);
      for (const side of ['left', 'right']) {
        const knee = root.getObjectByName(`${side}-knee`)!;
        const shoe = knee.children.find(child => child instanceof Three.Mesh && child.geometry.type === 'SphereGeometry');
        expect(shoe).toBeDefined();
        expect(new Three.Box3().setFromObject(shoe!).min.z).toBeGreaterThanOrEqual(bounds.max.z);
      }
    }
    expect(JSON.stringify(g)).toBe(before); world.dispose();
  });
});

describe('bedroom lying contact and paused pose recovery', () => {
  it.each([390, 1200])('lies face up on the real mattress at %ipx and keeps sleeping stable across paused camera changes', width => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
    const g = snapshot(); g.companions[0].activity = 'sleep'; g.companions[0].area = 'bedroom';
    const before = JSON.stringify(g), host = document.createElement('div'), labels = document.createElement('div');
    Object.defineProperties(host, { clientWidth: { value: width }, clientHeight: { value: width * 2 / 3 } });
    document.body.append(host, labels);
    const world = createLivingWorld(host, labels, g, vi.fn()); world.update(g, 4, 'bedroom'); world.setMotion(false);
    const renderer = rendererState.instances[0], root = character(renderer.lastScene!), body = root.getObjectByName('body')!;
    const mattress = renderer.lastScene!.getObjectByName('room-bed-0-mattress')!, mattressBounds = new Three.Box3().setFromObject(mattress);
    expect(renderer.lastCamera).toBeInstanceOf(Three.PerspectiveCamera);
    expect(host.dataset.presentation).toBe('home-world'); expect(host.dataset.focusView).toBe('bedroom'); expect(host.dataset.sleepingCharacters).toBe('1');
    expect(Number(host.dataset.itemMeshes)).toBeGreaterThan(0);
    expectActualSleepingContact(root, mattressBounds.max.y);
    expect(root.userData.sleepingBed.characterId).toBe(4); expect(root.userData.roomRestSeat).toBeUndefined();
    expect(mattressBounds.max.y).toBeCloseTo(.66, 5);
    const sleepingBounds = indexedVisibleBounds(body), pillows = bedPillows(renderer.lastScene!, root.userData.sleepingBed);
    expect(sleepingBounds.min.y).toBeCloseTo(mattressBounds.max.y, 5);
    expect(sleepingBounds.min.z).toBeGreaterThanOrEqual(pillows.min.z);
    expect(sleepingBounds.min.z).toBeLessThanOrEqual(pillows.max.z);
    const facing = new Three.Vector3(0, 0, 1).transformDirection(root.matrixWorld);
    const head = new Three.Vector3(0, 1, 0).transformDirection(root.matrixWorld);
    expect(facing.y).toBeGreaterThan(.85); expect(head.z).toBeLessThan(-.85);
    const position = root.position.clone(), rotation = root.quaternion.clone();
    world.setMotion(true);
    const loop = renderer.setAnimationLoop.mock.lastCall?.[0] as (time: number) => void;
    expect(loop).toBeTypeOf('function'); now.mockReturnValue(1_790_000_002_000); loop(1000);
    expect(body.scale.z).not.toBe(1);
    expect(root.userData.sleepingBed.characterId).toBe(4); expectActualSleepingContact(root, mattressBounds.max.y);
    world.setMotion(false);
    expect(renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(body.scale.z).toBe(1);
    expectActualSleepingContact(root, mattressBounds.max.y);
    const camera = renderer.lastCamera!, cameraPosition = camera.position.clone();
    now.mockReturnValue(1_790_000_020_000); world.rotate(.35); world.zoom(.9); world.update(g, 4, 'bedroom');
    expect(camera.position.equals(cameraPosition)).toBe(false);
    expect(root.position.equals(position)).toBe(true); expect(root.quaternion.equals(rotation)).toBe(true);
    expect(body.scale.z).toBe(1); expect(root.getObjectByName('left-knee')!.rotation.x).toBe(0);
    const resting = { ...g, companions: g.companions.map(c => ({ ...c, activity: 'rest', area: 'indoor' as const })) };
    world.update(resting, 4, true);
    expect(root.userData.sleepingBed).toBeUndefined(); expect(root.userData.roomRestSeat.characterId).toBe(4);
    expect(root.rotation.x).toBe(0); expect(root.getObjectByName('left-knee')!.rotation.x).toBeCloseTo(1.15);
    const sofaBounds = new Three.Box3().setFromObject(renderer.lastScene!.getObjectByName('sofa-main-seat')!);
    expect(new Three.Box3().setFromObject(body).min.y).toBeCloseTo(sofaBounds.max.y, 5);
    const outside = { ...g, companions: g.companions.map(c => ({ ...c, activity: 'walk', area: 'outdoor' as const })) };
    world.update(outside, 4);
    expect(root.rotation.x).toBe(0); expect(root.userData.sleepingBed).toBeUndefined(); expect(root.userData.roomRestSeat).toBeUndefined();
    expect(root.getObjectByName('left-leg')!.position.y).toBeCloseTo(.30);
    expect(root.getObjectByName('left-knee')!.rotation.x).toBe(0);
    expect(Number(host.dataset.itemMeshes)).toBeGreaterThan(0);
    expect(JSON.stringify(g)).toBe(before); world.dispose();
  });

  it('puts ten mixed body types on ten distinct mattress volumes without rewriting the snapshot', () => {
    const g = snapshot(), kinds = ['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature'] as const;
    g.companions = Array.from({ length: 10 }, (_, index) => ({ ...g.companions[0], id: index + 4,
      activity: 'sleep', area: 'bedroom' as const, avatar3d: { ...g.companions[0].avatar3d!, kind: kinds[index % kinds.length] } }));
    const before = JSON.stringify(g), { host, labels } = layers(), world = createLivingWorld(host, labels, g, vi.fn());
    world.update(g, 4, 'bedroom'); world.setMotion(false);
    const scene = rendererState.instances[0].lastScene!, used = new Set<number>();
    expect(host.dataset.sleepingCharacters).toBe('10');
    for (const companion of g.companions) {
      const root = character(scene, companion.id), bed = root.userData.sleepingBed;
      expect(used.has(bed.id)).toBe(false); used.add(bed.id);
      const bounds = new Three.Box3().setFromObject(scene.getObjectByName(`room-bed-${bed.id}-mattress`)!);
      const bodyBounds = indexedVisibleBounds(root.getObjectByName('body')!);
      const pillows = bedPillows(scene, bed);
      expect(bodyBounds.min.y).toBeCloseTo(bounds.max.y, 5);
      expect(bodyBounds.min.x).toBeGreaterThanOrEqual(bounds.min.x);
      expect(bodyBounds.max.x).toBeLessThanOrEqual(bounds.max.x);
      expect(bodyBounds.min.z).toBeGreaterThanOrEqual(bounds.min.z);
      expect(bodyBounds.max.z).toBeLessThanOrEqual(bounds.max.z);
      expect(bodyBounds.min.z).toBeGreaterThanOrEqual(pillows.min.z);
      expect(bodyBounds.min.z).toBeLessThanOrEqual(pillows.max.z);
      expectActualSleepingContact(root, bounds.max.y);
    }
    expect(used.size).toBe(10); expect(JSON.stringify(g)).toBe(before); world.dispose();
  });
});

describe('simultaneous panorama actors and scene name selection', () => {
  it('keeps sleeping, resting and walking actors in the same world while only the focus camera changes', () => {
    const group = mixedSnapshot(), before = JSON.stringify(group), { host, labels } = layers();
    const world = createLivingWorld(host, labels, group, vi.fn()); world.setMotion(false);
    const renderer = rendererState.instances[0], scene = renderer.lastScene!, environment = scene.getObjectByName('home-world-environment')!;
    const actors = group.companions.map(c => character(scene, c.id));
    const poses = actors.map(root => ({ position: root.position.clone(), rotation: root.quaternion.clone(), scale: root.scale.clone() }));
    const resources = sceneResources(scene);
    const releases = [...resources.geometries, ...resources.materials].map(resource => vi.spyOn(resource, 'dispose'));
    const cameraPositions = new Set<string>();
    for (const view of ['overview', 'indoor', 'bedroom', 'outdoor'] as HomeWorldView[]) {
      world.update(group, view === 'bedroom' ? 5 : view === 'outdoor' ? 6 : 4, view);
      expect(host.dataset.presentation).toBe('home-world'); expect(host.dataset.focusView).toBe(view);
      expect(host.dataset.meshCharacters).toBe('3'); expect(host.dataset.seatedCharacters).toBe('1'); expect(host.dataset.sleepingCharacters).toBe('1');
      expect(Number(host.dataset.itemMeshes)).toBeGreaterThan(0);
      expect(scene.getObjectByName('home-world-environment')).toBe(environment);
      cameraPositions.add(renderer.lastCamera!.position.toArray().join(','));
      actors.forEach((root, index) => {
        expect(character(scene, group.companions[index].id)).toBe(root); expect(root.visible).toBe(true);
        expect(root.position.equals(poses[index].position)).toBe(true);
        expect(root.quaternion.equals(poses[index].rotation)).toBe(true); expect(root.scale.equals(poses[index].scale)).toBe(true);
        expect(root.userData.homeRegion).toBe(group.companions[index].area);
      });
      const couch = new Three.Box3().setFromObject(scene.getObjectByName('sofa-main-seat')!);
      const mattress = new Three.Box3().setFromObject(scene.getObjectByName('room-bed-0-mattress')!);
      expect(new Three.Box3().setFromObject(actors[0].getObjectByName('body')!).min.y).toBeCloseTo(couch.max.y, 5);
      expectActualSleepingContact(actors[1], mattress.max.y);
      for (const release of releases) expect(release).not.toHaveBeenCalled();
    }
    expect(cameraPositions.size).toBe(4); expect(labels.querySelectorAll('button.living3d-name')).toHaveLength(3);
    expect(JSON.stringify(group)).toBe(before); world.dispose(); world.dispose();
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce(); expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
  });

  it('uses name buttons only for selection, preserves friend action permissions and ignores detached stale buttons', () => {
    const group = mixedSnapshot(), before = JSON.stringify(group), select = vi.fn(), { host, labels } = layers();
    const world = createLivingWorld(host, labels, group, select); world.setMotion(false);
    const buttons = [...labels.querySelectorAll<HTMLButtonElement>('button.living3d-name')];
    expect(buttons).toHaveLength(3);
    buttons.forEach(button => { expect(button.type).toBe('button'); expect(button.getAttribute('aria-label')).toContain('选择画面中的'); });
    buttons[0].click(); expect(select).toHaveBeenLastCalledWith(4);
    buttons[2].click(); expect(select).toHaveBeenLastCalledWith(6);
    const menu = document.createElement('div'), activity = document.createElement('button'), performActivity = vi.fn();
    activity.disabled = true; activity.textContent = '只有主人可安排'; activity.addEventListener('click', performActivity); menu.append(activity); document.body.append(menu);
    world.setSelectionMenu(menu, 6); world.update(group, 6, 'outdoor'); world.rotate(.2); world.zoom(.95);
    expect(activity.disabled).toBe(true); activity.click(); expect(performActivity).not.toHaveBeenCalled();
    expect(JSON.stringify(group)).toBe(before);
    const afterLeave = { ...group, companions: group.companions.filter(c => c.id !== 6) };
    world.update(afterLeave, null, 'overview'); select.mockClear();
    buttons[2].click(); expect(select).not.toHaveBeenCalled();
    world.dispose(); select.mockClear();
    buttons[0].click(); buttons[1].click(); expect(select).not.toHaveBeenCalled();
  });
});

describe('complete-house exterior and reversible cutaway resources', () => {
  it('keeps the same real world and furniture, hides indoor overlays and prevents through-roof selection in exterior mode', () => {
    const group = mixedSnapshot();
    group.companions = group.companions.map(c => c.id === 4 || c.id === 5 ? { ...c, area: 'indoor' as const, activity: 'talk' } : c);
    group.events = [{ id: 'synthetic-room-dialogue', at: 1000, kind: 'dialogue', activity: null, origin: 'real_provider', area: 'indoor',
      characters: [4, 5], message: '合成共享台词', lines: [
        { character_id: 4, name: '客厅伙伴', text: '合成室内台词甲' },
        { character_id: 5, name: '卧室伙伴', text: '合成室内台词乙' },
      ] }];
    const before = JSON.stringify(group), select = vi.fn(), { host, labels } = layers();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_001_000);
    const world = createLivingWorld(host, labels, group, select), renderer = rendererState.instances[0], scene = renderer.lastScene!;
    try {
      world.setMotion(true);
      world.setBubbleReceipts(new Map([['synthetic-room-dialogue', 1000]]));
      const environment = scene.getObjectByName('home-world-environment')!, actors = group.companions.map(c => character(scene, c.id));
      const actorPositions = actors.map(root => root.position.clone()), resources = sceneResources(scene);
      const releases = [...resources.geometries, ...resources.materials].map(resource => vi.spyOn(resource, 'dispose'));
      const indoorNames = [4, 5].map(id => labels.querySelector<HTMLButtonElement>(`button[aria-label="选择画面中的${group.companions.find(c => c.id === id)!.name}"]`)!);
      const outdoorName = labels.querySelector<HTMLButtonElement>('button[aria-label="选择画面中的院子朋友"]')!;
      const markers = indoorNames.map(name => name.closest<HTMLElement>('.living3d-marker')!);
      const firstBubble = markers[0].querySelector<HTMLElement>('.living3d-bubble')!;
      expect(firstBubble.hidden).toBe(false); expect(markers[0].hidden).toBe(false);
      const canvas = renderer.domElement;
      canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn(); canvas.hasPointerCapture = vi.fn(() => false);
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, toJSON: () => ({}) });
      const menu = document.createElement('div'); document.body.append(menu); world.setSelectionMenu(menu, 4);
      for (let index = 0; index < 3; index++) {
        world.setHouseView('exterior');
        expect(host.dataset.houseView).toBe('exterior');
        expect(scene.getObjectByName('home-world-environment')).toBe(environment);
        for (const name of indoorNames) { expect(name.hidden).toBe(true); name.click(); }
        for (const marker of markers) expect(marker.hidden).toBe(true);
        expect(firstBubble.hidden).toBe(true); expect(menu.hidden).toBe(true);
        expect(outdoorName.hidden).toBe(false); expect(outdoorName.closest<HTMLElement>('.living3d-marker')!.hidden).toBe(false);
        const point = new Three.Box3().setFromObject(actors[0]).getCenter(new Three.Vector3()).project(renderer.lastCamera!);
        const coordinates = { bubbles: true, clientX: (point.x + 1) * 400, clientY: (1 - point.y) * 250 };
        canvas.dispatchEvent(new MouseEvent('pointerdown', coordinates)); canvas.dispatchEvent(new MouseEvent('pointerup', coordinates));
        expect(select).not.toHaveBeenCalled();
        outdoorName.click(); expect(select).toHaveBeenLastCalledWith(6); select.mockClear();
        actors.forEach((root, index) => { expect(character(scene, group.companions[index].id)).toBe(root); expect(root.visible).toBe(true); expect(root.position.equals(actorPositions[index])).toBe(true); });
        world.setHouseView('interior');
        expect(host.dataset.houseView).toBe('interior'); expect(menu.hidden).toBe(false);
        for (const name of indoorNames) expect(name.hidden).toBe(false);
        for (const marker of markers) expect(marker.hidden).toBe(false);
        expect(firstBubble.hidden).toBe(false);
      }
      expect(rendererState.instances).toHaveLength(1); expect(JSON.stringify(group)).toBe(before);
      const after = sceneResources(scene); expect(after.geometries).toEqual(resources.geometries); expect(after.materials).toEqual(resources.materials);
      for (const release of releases) expect(release).not.toHaveBeenCalled();
      world.dispose(); world.dispose();
      for (const release of releases) expect(release).toHaveBeenCalledOnce();
      expect(renderer.dispose).toHaveBeenCalledOnce(); expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    } finally { world.dispose(); clock.mockRestore(); }
  });
});
