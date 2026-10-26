import * as THREE from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';
import { parseFloor } from '@/lib/villa-floor-sync';
import shape from './fixtures/floor-live-restore-shape-20261025.json';

const gpu = vi.hoisted(() => ({ renderers: [] as Array<{ scene: THREE.Scene | null; loop: ((time: number) => void) | null }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; loop: ((time: number) => void) | null = null;
    constructor() { gpu.renderers.push(this); }
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; });
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});

const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.renderers = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  for (const name of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(name, vi.fn(() => { throw new Error('NO_EXTERNAL_TRANSPORT'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose());
  expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function setup() {
  const group = parseGathering(structuredClone(shape.group));
  const floor = parseFloor(structuredClone(shape.floor));
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } });
  document.body.append(host, labels);
  const request = vi.fn();
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), {
    persistentWorld: true, realistic: true, localLeisurePreview: true, localRoomTransitions: true,
    localCompanionDoors: true, localReferenceVilla: true, localNaturalWorld: true,
    localNaturalLeisure: true, onLeisureRequest: request,
  });
  worlds.push(world);
  return { world, group, floor, host, request, renderer: gpu.renderers.at(-1)! };
}

it('applies the current empty server checkpoint despite overlapping saved downstairs anchors and television', () => {
  const f = setup(), original = JSON.stringify(f.group);
  expect(f.floor.seq).toBe(4); expect(f.floor.applied).toBe(4);
  expect(f.floor.checkpoint).toEqual({ version: 1, active: null, states: [] });
  expect(f.world.applyServerFloor(f.floor)).toBe(true);
  expect(f.world.getFloorLives()).toEqual([]);
  expect(f.world.exportServerFloor()).toEqual({ checkpoint: { version: 1, active: null, states: [] }, applied: 4 });
  expect(f.request).not.toHaveBeenCalled(); expect(JSON.stringify(f.group)).toBe(original);
});

it('reapplies the same current empty checkpoint after downstairs animation without changing saved activity or issuing a command', () => {
  const f = setup(), original = JSON.stringify(f.group);
  f.world.setMotion(true);
  for (let i = 0; i < 60; i++) { vi.advanceTimersByTime(32); f.renderer.loop?.(Date.now()); }
  f.world.setMotion(false);
  expect(f.world.applyServerFloor(f.floor)).toBe(true);
  expect(f.world.applyServerFloor(f.floor, true)).toBe(true);
  expect(f.world.getFloorLives()).toEqual([]);
  expect(f.request).not.toHaveBeenCalled(); expect(JSON.stringify(f.group)).toBe(original);
});
