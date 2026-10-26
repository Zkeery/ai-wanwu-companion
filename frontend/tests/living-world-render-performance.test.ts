import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';

type RendererBoundary = {
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  loop: ((time: number) => void) | null;
  render: ReturnType<typeof vi.fn>;
  setPixelRatio: ReturnType<typeof vi.fn>;
  outputColorSpace: string;
  toneMapping: number;
  toneMappingExposure: number;
};
const captured = vi.hoisted(() => ({ renderers: [] as RendererBoundary[], controls: [] as OrbitControls[] }));

// Retain real scene graphs, materials, geometry and OrbitControls. Only the GPU
// boundary is replaced; counts below do not measure GPU or real phone FPS.
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; camera: THREE.Camera | null = null;
    loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn();
    dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => {
      scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
      this.scene = scene; this.camera = camera;
    });
    constructor() { captured.renderers.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});
vi.mock('three/addons/controls/OrbitControls.js', async original => {
  const actual = await original<typeof import('three/addons/controls/OrbitControls.js')>();
  class CapturedOrbitControls extends actual.OrbitControls {
    constructor(object: THREE.Camera, element: HTMLElement | null = null) {
      super(object, element); captured.controls.push(this);
    }
  }
  return { ...actual, OrbitControls: CapturedOrbitControls };
});

const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
let media: MediaQueryList;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  captured.renderers.length = 0; captured.controls.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  media = Object.assign(new EventTarget(), { matches: false, media: '', onchange: null }) as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('devicePixelRatio', 3);
  for (const name of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(name, vi.fn(() => { throw new Error('render regression must remain offline and free'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose());
  expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function snapshot(kind = 'forest') {
  return parseGathering({ id: 'b0fe809c-7c46-4e1b-9690-b91f43134c66', title: '免费绘制调度验证', scene_type: kind, revision: 1,
    closed: false, is_manager: true, me: 'synthetic-owner', members: [{ id: 'synthetic-owner', name: '合成成员', manager: true }],
    companions: [], items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function setup(kind = 'forest', realistic = false) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 390 }, clientHeight: { value: 450 } }); document.body.append(host, labels);
  const group = snapshot(kind), world = createLivingWorld(host, labels, group, vi.fn(), undefined, { realistic }); worlds.push(world);
  const renderer = captured.renderers.at(-1)!, controls = captured.controls.at(-1)!;
  return { host, group, world, renderer, controls, scene: renderer.scene! };
}

describe('actual Three world rendering scheduling', () => {
  it.each(['rotate', 'zoom', 'reset'] as const)('renders exactly once for a paused %s operation', operation => {
    const { world, renderer } = setup(); world.setMotion(false); renderer.render.mockClear();
    if (operation === 'rotate') world.rotate(.3);
    else if (operation === 'zoom') world.zoom(.9);
    else world.reset();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('coalesces real OrbitControls changes into the next animation callback while moving', () => {
    const { world, renderer, controls } = setup(); world.setMotion(true); renderer.render.mockClear();
    const before = controls.object.position.clone();
    controls.object.position.x += 1; controls.update();
    controls.object.position.x += .5; controls.update();
    expect(controls.object.position.distanceTo(before)).toBeGreaterThan(.1);
    expect(renderer.render).not.toHaveBeenCalled();
    renderer.loop!(0); expect(renderer.render).toHaveBeenCalledTimes(1);
    renderer.loop!(1); expect(renderer.render).toHaveBeenCalledTimes(1);
    renderer.loop!(1000 / 30); expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('keeps OrbitControls changes immediately visible while paused', () => {
    const { world, renderer, controls } = setup(); world.setMotion(false); renderer.render.mockClear();
    controls.object.position.x += 1; controls.update();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it.each([60, 90, 120])('draws about 300 scheduled frames for ten seconds of %i Hz RAF input', refreshRate => {
    const { world, renderer } = setup(); world.setMotion(true); renderer.render.mockClear();
    for (let frame = 0; frame <= refreshRate * 10; frame++) {
      const timestamp = Math.round(frame * 1000 / refreshRate * 1000) / 1000;
      vi.setSystemTime(1_000_000 + timestamp); renderer.loop!(timestamp);
    }
    expect(renderer.render.mock.calls.length).toBeGreaterThanOrEqual(300);
    expect(renderer.render.mock.calls.length).toBeLessThanOrEqual(301);
    expect(renderer.scene).toBeDefined();
  });

  it('changes only pixel density on mobile media changes, keeping colors and actual geometry', () => {
    const { scene, renderer, host } = setup('home', true);
    const currentMeshes = () => { const result: THREE.Mesh[] = []; scene.traverse(object => { if (object instanceof THREE.Mesh) result.push(object); }); return result; };
    const meshes = currentMeshes();
    const geometries = meshes.map(mesh => mesh.geometry);
    const materialState = () => meshes.map(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => ({
      uuid: material.uuid, color: 'color' in material ? (material.color as THREE.Color).getHexString() : null,
      transparent: material.transparent, opacity: material.opacity,
    })));
    const colors = materialState(), renderStyle = [renderer.outputColorSpace, renderer.toneMapping, renderer.toneMappingExposure];
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    Object.defineProperty(media, 'matches', { configurable: true, value: true }); media.dispatchEvent(new Event('change'));
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.25);
    expect(host.dataset.touchMode).toBe('scroll-and-two-finger-view');
    expect([renderer.outputColorSpace, renderer.toneMapping, renderer.toneMappingExposure]).toEqual(renderStyle);
    expect(currentMeshes().map(mesh => mesh.uuid)).toEqual(meshes.map(mesh => mesh.uuid));
    expect(materialState()).toEqual(colors); expect(currentMeshes().map(mesh => mesh.geometry)).toEqual(geometries);
    Object.defineProperty(media, 'matches', { configurable: true, value: false }); media.dispatchEvent(new Event('change'));
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(host.dataset.touchMode).toBe('drag-view'); expect(materialState()).toEqual(colors);
  });

  it('rebinds cached moving leaves after a seasonal environment rebuild', () => {
    const { scene, group, world, renderer } = setup('home', true);
    const leaves = () => { const nodes: THREE.Object3D[] = []; scene.traverse(object => { if (object.userData.localMotion === 'leaf') nodes.push(object); }); return nodes; };
    const original = leaves(); expect(original.length).toBeGreaterThan(0);
    world.setMotion(true); vi.setSystemTime(1_000_100); renderer.loop!(100);
    world.update({ ...group, revision: 2, season: 'autumn' }, null);
    const removedAngles = original.map(object => object.rotation.z), replacement = leaves();
    expect(replacement.length).toBeGreaterThan(0); expect(replacement.some(object => original.includes(object))).toBe(false);
    const before = replacement.map(object => object.rotation.z);
    vi.setSystemTime(1_000_300); renderer.loop!(300);
    expect(replacement.some((object, index) => Math.abs(object.rotation.z - before[index]) > 1e-8)).toBe(true);
    expect(original.map(object => object.rotation.z)).toEqual(removedAngles);
  });
});
