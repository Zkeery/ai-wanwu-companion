import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';

type RendererBoundary = {
  scene: THREE.Scene | null; camera: THREE.Camera | null;
  loop: ((time: number) => void) | null; render: ReturnType<typeof vi.fn>;
};
const captured = vi.hoisted(() => ({ renderers: [] as RendererBoundary[], controls: [] as OrbitControls[] }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; camera: THREE.Camera | null = null;
    loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => {
      // Match WebGLRenderer's default matrix update boundary, including its
      // flags and non-forced call. All matrix math below is actual Three code.
      if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
      if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
      this.scene = scene; this.camera = camera;
    });
    constructor() { captured.renderers.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});
vi.mock('three/addons/controls/OrbitControls.js', async original => {
  const actual = await original<typeof import('three/addons/controls/OrbitControls.js')>();
  class CapturedOrbitControls extends actual.OrbitControls {
    constructor(object: THREE.Camera, element: HTMLElement | null = null) { super(object, element); captured.controls.push(this); }
  }
  return { ...actual, OrbitControls: CapturedOrbitControls };
});

const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); captured.renderers.length = 0; captured.controls.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  for (const name of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(name, vi.fn(() => { throw new Error('matrix regression must stay offline and free'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function setup(actor = false) {
  const group = parseGathering({ id: 'synthetic-matrix-regression', title: '免费矩阵边界验证', scene_type: 'home', revision: 1,
    closed: false, is_manager: true, me: 'synthetic-owner', members: [{ id: 'synthetic-owner', name: '合成成员', manager: true }],
    companions: actor ? [{ id: 701, owner_id: 'synthetic-owner', name: '合成伙伴', activity: 'observe', area: 'bedroom', x: .7, y: .6,
      avatar3d: { version: 1, kind: 'plant', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 701, source: 'procedural_existing_features' } }] : [],
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 390 }, clientHeight: { value: 450 } }); document.body.append(host, labels);
  const world = createLivingWorld(host, labels, group, vi.fn(), undefined, {
    realistic: true, localLeisurePreview: true, localRoomTransitions: true, localCompanionDoors: true, localReferenceVilla: true,
  });
  worlds.push(world); const renderer = captured.renderers.at(-1)!, controls = captured.controls.at(-1)!;
  return { host, group, world, renderer, controls, scene: renderer.scene!, camera: renderer.camera! };
}
type Fixture = ReturnType<typeof setup>;
function tick(fixture: Fixture, milliseconds = 100) {
  vi.setSystemTime(Date.now() + milliseconds); fixture.renderer.loop!(Date.now());
}
function expectCurrentWorldMatrix(object: THREE.Object3D) {
  const expected = object.parent ? new THREE.Matrix4().multiplyMatrices(object.parent.matrixWorld, object.matrix) : object.matrix;
  object.matrixWorld.elements.forEach((value, index) => expect(value).toBeCloseTo(expected.elements[index], 10));
}

describe('actual Three matrix/render boundary', () => {
  it.each(['rotate', 'zoom', 'reset', 'animation'] as const)('performs one scene matrix traversal per %s draw and publishes current child transforms', operation => {
    const f = setup(), parent = new THREE.Group(), child = new THREE.Mesh(new THREE.BoxGeometry(.1, .2, .3), new THREE.MeshStandardMaterial({ color: '#557744' }));
    parent.position.set(2, 3, 4); child.position.set(.5, .6, .7); parent.add(child); f.scene.add(parent);
    if (operation === 'animation') f.world.setMotion(true);
    const update = vi.spyOn(f.scene, 'updateMatrixWorld'); f.renderer.render.mockClear();
    parent.position.x += 1; parent.rotation.y = .37; child.position.z += .9;
    if (operation === 'rotate') f.world.rotate(.2);
    else if (operation === 'zoom') f.world.zoom(.9);
    else if (operation === 'reset') f.world.reset();
    else tick(f);
    expect(f.renderer.render).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]).toEqual([]);
    expectCurrentWorldMatrix(parent); expectCurrentWorldMatrix(child); expectCurrentWorldMatrix(f.camera);
    expect(child.matrixWorld.elements[12]).not.toBe(0);
  });

  it('restores the exact ground camera after viewing upstairs with one draw per switch', () => {
    const f = setup(); f.world.rotate(.17); f.world.zoom(.91);
    const before = f.camera.position.clone(), target = f.controls.target.clone(), fov = (f.camera as THREE.PerspectiveCamera).fov;
    const update = vi.spyOn(f.scene, 'updateMatrixWorld'); f.renderer.render.mockClear();
    expect(f.world.setUpperFloorView(true)).toBe(true);
    expect(f.renderer.render).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(1);
    expect(f.scene.getObjectByName('home-villa-upper-interior')?.visible).toBe(true);
    update.mockClear(); f.renderer.render.mockClear();
    expect(f.world.setUpperFloorView(false)).toBe(true);
    expect(f.renderer.render).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(1);
    expect(f.camera.position.distanceTo(before)).toBeLessThan(1e-10); expect(f.controls.target.distanceTo(target)).toBeLessThan(1e-10);
    expect((f.camera as THREE.PerspectiveCamera).fov).toBe(fov); expectCurrentWorldMatrix(f.camera);
  });

  it('keeps animated door matrices current and does not change the directional light', () => {
    const f = setup(), door = f.scene.getObjectByName('home-main-entry-door-leaf')!;
    expect(door).toBeDefined(); const light = f.scene.children.find(object => object instanceof THREE.DirectionalLight) as THREE.DirectionalLight;
    const lightState = [light.intensity, light.color.getHexString(), light.castShadow, light.shadow.mapSize.toArray()];
    f.world.setMotion(true); f.world.setDoorOpen('home-main-entry-door', true);
    for (let index = 0; index < 8; index++) { tick(f); expectCurrentWorldMatrix(door); }
    expect(Math.abs(door.rotation.y)).toBeGreaterThan(1);
    f.world.setDoorOpen('home-main-entry-door', false);
    for (let index = 0; index < 8; index++) { tick(f); expectCurrentWorldMatrix(door); }
    expect(door.rotation.y).toBeCloseTo(0, 8);
    expect([light.intensity, light.color.getHexString(), light.castShadow, light.shadow.mapSize.toArray()]).toEqual(lightState);
  });

  it('renders a rebuilt seasonal environment with current real mesh transforms', () => {
    const f = setup(), previous = f.scene.getObjectByName('home-world-environment')!;
    f.world.update({ ...f.group, revision: 2, season: 'autumn' }, null);
    const replacement = f.scene.getObjectByName('home-world-environment')!;
    expect(replacement).not.toBe(previous); expect(previous.parent).toBeNull(); expect(replacement.parent).toBe(f.scene);
    let checked = 0; replacement.traverse(object => { if (object instanceof THREE.Mesh) { expectCurrentWorldMatrix(object); checked++; } });
    expect(checked).toBeGreaterThan(50);
  });

  it('keeps the actual companion on a complete upstairs and downstairs route', () => {
    const f = setup(true), actor = f.scene.children.find(object => object.userData.characterId === 701)!;
    f.world.setMotion(true); expect(f.world.requestFloorVisit(701, true)).toBe(true);
    for (let frame = 0; frame < 2000 && f.world.getFloorVisit(701)?.phase !== 'upper'; frame++) { tick(f); expectCurrentWorldMatrix(actor); }
    expect(f.world.getFloorVisit(701)?.phase).toBe('upper'); expect(actor.position.y).toBeGreaterThan(3.4);
    expect(f.world.requestFloorVisit(701, false)).toBe(true);
    for (let frame = 0; frame < 2000 && f.world.getFloorVisit(701); frame++) { tick(f); expectCurrentWorldMatrix(actor); }
    expect(f.world.getFloorVisit(701)).toBeNull(); expect(actor.position.y).toBeLessThan(.5); expect(actor.parent).toBe(f.scene);
  }, 120_000);
});
