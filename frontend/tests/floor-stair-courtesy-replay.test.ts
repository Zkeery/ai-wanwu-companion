import * as THREE from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';
import { parseFloor } from '@/lib/villa-floor-sync';
import shape from './fixtures/floor-no-motion-shape-20261026.json';

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

it('coordinates the stair request while the bench owner keeps the leisure assignment', () => {
  const group = parseGathering(structuredClone(shape.group)); group.me = group.companions.find(c => c.id === 4)!.owner_id;
  const floor = parseFloor(structuredClone(shape.floor));
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), {
    strictLeisureContacts: true, persistentWorld: true, realistic: true, localLeisurePreview: true, localRoomTransitions: true,
    localCompanionDoors: true, localReferenceVilla: true, localNaturalWorld: true, localNaturalLeisure: true,
  }); worlds.push(world);
  expect(world.applyServerFloor(floor)).toBe(true); world.setFloorDriver(true); world.setMotion(true);
  const renderer = gpu.renderers.at(-1)!;
  for (let i = 0; i < 3600; i++) { vi.advanceTimersByTime(32); renderer.loop?.(Date.now()); if (world.getFloorVisit(4)?.phase === 'upper') break; }
  expect(world.getFloorVisit(4)?.phase).toBe('upper');
  for (let i = 0; i < 1600; i++) { vi.advanceTimersByTime(32); renderer.loop?.(Date.now()); }
  const benchOwner = renderer.scene!.children.find(actor => actor.userData.characterId === 5)!;
  expect(benchOwner.userData.roomRestSeat?.seatId).toBe('bench-fixture-item-2-0');
  expect(group.companions.find(c => c.id === 5)!.leisure?.activity).toBe('bench');
}, 120000);
