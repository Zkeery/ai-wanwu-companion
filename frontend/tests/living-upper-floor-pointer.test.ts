import * as THREE from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';

const gpu = vi.hoisted(() => ({ renderers: [] as Array<{ domElement: HTMLCanvasElement; scene: THREE.Scene; camera: THREE.Camera }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class Renderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    scene!: THREE.Scene; camera!: THREE.Camera;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn(); setAnimationLoop = vi.fn();
    render(scene: THREE.Scene, camera: THREE.Camera) { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; this.camera = camera; }
    constructor() { gpu.renderers.push(this); }
  }
  return { ...actual, WebGLRenderer: Renderer };
});
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network is forbidden'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => { worlds.splice(0).forEach(w => w.dispose()); expect(fetch).not.toHaveBeenCalled(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const group = parseGathering({ id: 'upper-pointer-isolated', title: '合成二楼点击', scene_type: 'home', revision: 1, me: 'owner-a', closed: false, is_manager: true,
    members: [{ id: 'owner-a', name: '甲', manager: true }, { id: 'owner-b', name: '乙', manager: false }],
    companions: [1, 2].map(id => ({ id, name: '合成伙伴' + id, owner_id: id === 1 ? 'owner-a' : 'owner-b', activity: 'observe', area: 'outdoor', x: .3, y: .7,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: id, source: 'procedural_existing_features' } })),
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
  const host = document.createElement('div'), labels = document.createElement('div'); document.body.append(host, labels);
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } });
  const selected = vi.fn(), world = createLivingWorld(host, labels, group, selected, vi.fn(), { realistic: true, persistentWorld: true, localLeisurePreview: true, localReferenceVilla: true, localRoomTransitions: true }); worlds.push(world);
  expect(world.setUpperFloorView(true)).toBe(true);
  const renderer = gpu.renderers.at(-1)!;
  renderer.domElement.setPointerCapture = vi.fn(); renderer.domElement.releasePointerCapture = vi.fn(); renderer.domElement.hasPointerCapture = vi.fn(() => false);
  vi.spyOn(renderer.domElement, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, toJSON: () => ({}) });
  const actors = [1, 2].map(id => renderer.scene.children.find(o => o.userData.characterId === id)!);
  // Isolate hit testing at the renderer boundary; staircase simulation has its own suite.
  actors.forEach((a, i) => { a.position.set(-4 - i * 2, 3.5, -2.3); a.userData.homeFloor = i === 0 ? 2 : 1; });
  renderer.scene.updateMatrixWorld(true);
  return { world, group, renderer, actors, selected };
}
function aim(f: ReturnType<typeof setup>, object: THREE.Object3D) {
  const center = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  f.renderer.camera.position.copy(center).add(new THREE.Vector3(0, 2, 3)); f.renderer.camera.lookAt(center); f.renderer.camera.updateMatrixWorld(true);
  return center.project(f.renderer.camera);
}
function point(f: ReturnType<typeof setup>, p: THREE.Vector3, type: string, dx = 0) {
  f.renderer.domElement.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: (p.x + 1) * 400 + dx, clientY: (1 - p.y) * 250 }));
}
it('selects the visible upstairs body with a physical click and keeps the saved gathering unchanged', () => {
  const f = setup(), before = JSON.stringify(f.group), p = aim(f, f.actors[0]);
  point(f, p, 'pointerdown'); point(f, p, 'pointerup');
  expect(f.selected).toHaveBeenCalledExactlyOnceWith(1); expect(JSON.stringify(f.group)).toBe(before);
});
it('does not select a downstairs, hidden or dragged body while viewing upstairs', () => {
  const f = setup(), other = aim(f, f.actors[1]); point(f, other, 'pointerdown'); point(f, other, 'pointerup');
  const own = aim(f, f.actors[0]); f.actors[0].visible = false; point(f, own, 'pointerdown'); point(f, own, 'pointerup'); f.actors[0].visible = true;
  point(f, own, 'pointerdown'); point(f, own, 'pointerup', 20); point(f, own, 'pointerdown'); point(f, own, 'pointercancel'); point(f, own, 'pointerup');
  expect(f.selected).not.toHaveBeenCalled();
});
it('allows selecting another upstairs companion for inspection without granting command rights', () => {
  const f = setup(); f.actors[1].userData.homeFloor = 2; const p = aim(f, f.actors[1]); point(f, p, 'pointerdown'); point(f, p, 'pointerup');
  expect(f.selected).toHaveBeenCalledExactlyOnceWith(2); expect(f.world.canRequestServerFloor(2, 'rest')).toBe(false);
});
it('keeps physical upstairs door clicks working without selecting a companion', () => {
  const f = setup(), door = f.renderer.scene.getObjectByName('villa-upper-bedroom-door')!, leaf = door.children.find(o => o instanceof THREE.Mesh)!;
  const center = new THREE.Box3().setFromObject(leaf).getCenter(new THREE.Vector3());
  f.renderer.camera.position.copy(center).add(new THREE.Vector3(-2, 0, 0)); f.renderer.camera.lookAt(center); f.renderer.camera.updateMatrixWorld(true);
  const p = center.project(f.renderer.camera); point(f, p, 'pointerdown'); point(f, p, 'pointerup');
  expect(f.renderer.scene.getObjectByName('home-villa-upper-interior')!.userData.door.requested).toBe(true); expect(f.selected).not.toHaveBeenCalled();
});
