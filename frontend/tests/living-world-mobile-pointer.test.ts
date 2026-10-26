import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';

const gpu = vi.hoisted(() => ({ instances: [] as Array<{ domElement: HTMLCanvasElement; scene: THREE.Scene; camera: THREE.Camera; outputColorSpace: string; toneMapping: number; toneMappingExposure: number }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class Renderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    scene!: THREE.Scene; camera!: THREE.Camera; outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 0;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn(); setAnimationLoop = vi.fn();
    render(scene: THREE.Scene, camera: THREE.Camera) { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; this.camera = camera; }
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: Renderer };
});
let world: ReturnType<typeof createLivingWorld> | null;
const capturedControls: OrbitControls[] = [];
const media = { matches: true, listeners: new Set<() => void>(), addEventListener: vi.fn((_e: string, fn: () => void) => media.listeners.add(fn)), removeEventListener: vi.fn((_e: string, fn: () => void) => media.listeners.delete(fn)) };
beforeEach(() => {
  media.matches = true; media.listeners.clear(); world = null; capturedControls.length = 0;
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const connect = OrbitControls.prototype.connect;
  vi.spyOn(OrbitControls.prototype, 'connect').mockImplementation(function (this: OrbitControls, element: HTMLElement | SVGElement) { capturedControls.push(this); connect.call(this, element); });
});
afterEach(() => { world?.dispose(); expect(fetch).not.toHaveBeenCalled(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(width = 390, height = 360) {
  const group = parseGathering({ id: 'synthetic-mobile', title: '免费手机触控', scene_type: 'home', revision: 1, me: 'a', closed: false, is_manager: true,
    members: [{ id: 'a', name: '甲', manager: true }], companions: [{ id: 1, name: '合成伙伴', owner_id: 'a', activity: 'observe', area: 'outdoor', x: .3, y: .6,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 1, source: 'procedural_existing_features' } }],
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
  const host = document.createElement('div'), labels = document.createElement('div'); document.body.append(host, labels);
  host.style.touchAction = 'manipulation'; Object.defineProperties(host, { clientWidth: { get: () => width }, clientHeight: { get: () => height } });
  const selected = vi.fn(); world = createLivingWorld(host, labels, group, selected, undefined, { realistic: true });
  const renderer = gpu.instances.at(-1)!;
  renderer.domElement.setPointerCapture = vi.fn(); renderer.domElement.releasePointerCapture = vi.fn(); renderer.domElement.hasPointerCapture = vi.fn(() => false);
  vi.spyOn(renderer.domElement, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 390, bottom: 360, width: 390, height: 360, toJSON: () => ({}) });
  return { host, selected, group, renderer, resize(w: number, h: number) { width = w; height = h; world!.update(group, null); } };
}
it('lets one finger scroll while two fingers control the scene, and cleans up on dispose', () => {
  const f = setup(), controls = capturedControls.at(-1)!; expect(f.host.style.touchAction).toBe('pan-y'); expect(controls.touches.ONE).toBeNull(); expect(controls.touches.TWO).toBe(THREE.TOUCH.DOLLY_ROTATE);
  const color = [f.renderer.outputColorSpace, f.renderer.toneMapping, f.renderer.toneMappingExposure];
  media.matches = false; media.listeners.forEach(fn => fn());
  expect(f.host.style.touchAction).toBe('none'); expect(controls.touches.ONE).toBe(THREE.TOUCH.ROTATE);
  expect([f.renderer.outputColorSpace, f.renderer.toneMapping, f.renderer.toneMappingExposure]).toEqual(color);
  world!.dispose(); world = null; expect(f.host.style.touchAction).toBe('manipulation'); expect(media.listeners.size).toBe(0);
});
it('keeps a mobile action panel readable after its companion moves out of the camera', () => {
  setup(); const menu = document.createElement('div'); document.body.append(menu);
  menu.style.left = '200px'; menu.style.top = '100px'; menu.hidden = true;
  world!.setSelectionMenu(menu, 1, 'panel'); world!.rotate(2); world!.zoom(1.15);
  expect(menu.hidden).toBe(false); expect(menu.style.left).toBe(''); expect(menu.style.top).toBe('');
  world!.setSelectionMenu(menu, null); expect(menu.style.left).toBe('50%');
});
it('does not fade the house into the fog just to fit a narrow screen', () => {
  const f = setup(1120, 560);
  const fogAmount = () => {
    const fog = f.renderer.scene.fog as THREE.Fog;
    const depth = new THREE.Vector3(0, 1, 0).sub(f.renderer.camera.position).dot(f.renderer.camera.getWorldDirection(new THREE.Vector3()));
    return THREE.MathUtils.smoothstep(depth, fog.near, fog.far);
  };
  const desktop = fogAmount(), color = [f.renderer.outputColorSpace, f.renderer.toneMapping, f.renderer.toneMappingExposure];
  f.resize(320, 400);
  expect(fogAmount()).toBeLessThanOrEqual(desktop + .01);
  expect([f.renderer.outputColorSpace, f.renderer.toneMapping, f.renderer.toneMappingExposure]).toEqual(color);
});
it('uses actual raycasting for a tap but never selects after pinch, cancellation, or returning drag', () => {
  const f = setup(), actor = f.renderer.scene.children.find(o => o.userData.characterId === 1)!;
  const center = new THREE.Box3().setFromObject(actor).getCenter(new THREE.Vector3());
  f.renderer.camera.position.copy(center).add(new THREE.Vector3(0, 2, 3)); f.renderer.camera.lookAt(center); f.renderer.camera.updateMatrixWorld(true);
  const p = center.project(f.renderer.camera), x = (p.x + 1) * 195, y = (1 - p.y) * 180;
  const point = (type: string, id: number, dx = 0) => { const e = new MouseEvent(type, { bubbles: true, clientX: x + dx, clientY: y }); Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: 'touch' } }); f.renderer.domElement.dispatchEvent(e); };
  point('pointerdown', 1); point('pointerdown', 2); point('pointerup', 2); point('pointerup', 1);
  point('pointerdown', 3); point('pointermove', 3, 20); point('pointermove', 3); point('pointerup', 3);
  point('pointerdown', 4); point('pointercancel', 4); point('pointerup', 4);
  expect(f.selected).not.toHaveBeenCalled();
  point('pointerdown', 5); point('pointerup', 5); expect(f.selected).toHaveBeenCalledExactlyOnceWith(1);
});
