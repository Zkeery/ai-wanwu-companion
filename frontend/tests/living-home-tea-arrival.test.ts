import * as THREE from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';
import { collectHomeJourneyObstacles } from '@/lib/living-home-journey-geometry';
import { homeNavigationBounds } from '@/lib/living-home-navigation';
import { createLivingNavigation } from '@/lib/living-navigation';

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
  for (const name of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(name, vi.fn(() => { throw new Error('tea regression is isolated and free'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose());
  expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const savedShape = {
  "id": "600b7ac0-2164-482d-99e6-f52ba3a7f9a0",
  "title": "合成茶座导航回归",
  "scene_type": "home",
  "revision": 69,
  "closed": false,
  "is_manager": true,
  "me": "fixture-owner-0",
  "members": [
    {
      "id": "fixture-owner-0",
      "name": "合成成员0",
      "manager": true
    },
    {
      "id": "fixture-owner-1",
      "name": "合成成员1",
      "manager": false
    }
  ],
  "companions": [
    {
      "id": 4,
      "owner_id": "fixture-owner-0",
      "name": "合成伙伴4",
      "activity": "walk",
      "area": "outdoor",
      "x": 0.65,
      "y": 0.55,
      "avatar3d": {
        "version": 1,
        "kind": "garment",
        "body": "#eee9df",
        "accent": "#a7bec9",
        "detail": "#5b5964",
        "seed": 2536437237,
        "source": "procedural_existing_features"
      },
      "leisure": null
    },
    {
      "id": 5,
      "owner_id": "fixture-owner-1",
      "name": "合成伙伴5",
      "activity": "observe",
      "area": "outdoor",
      "x": 0.65,
      "y": 0.55,
      "avatar3d": {
        "version": 1,
        "kind": "bouquet",
        "body": "#b69acf",
        "accent": "#efa3b8",
        "detail": "#65516f",
        "seed": 2414310844,
        "source": "procedural_existing_features"
      },
      "leisure": {
        "activity": "tea",
        "seat_id": "tea-1",
        "station_version": 1
      }
    },
    {
      "id": 2,
      "owner_id": "fixture-owner-0",
      "name": "合成伙伴2",
      "activity": "talk",
      "area": "outdoor",
      "x": 0.65,
      "y": 0.55,
      "avatar3d": {
        "version": 1,
        "kind": "plant",
        "body": "#6ca572",
        "accent": "#a88668",
        "detail": "#426c4c",
        "seed": 2787687353,
        "source": "procedural_existing_features"
      },
      "leisure": null
    }
  ],
  "items": [
    {
      "id": "fixture-item-0",
      "kind": "bench",
      "x": 0.2,
      "y": 0.25,
      "flipped": false,
      "mine": true,
      "contributor_name": "合成贡献者",
      "stored": false,
      "stage": null,
      "care_remaining_seconds": null,
      "growth_status": null
    },
    {
      "id": "fixture-item-1",
      "kind": "tree",
      "x": 0.38,
      "y": 0.25,
      "flipped": false,
      "mine": true,
      "contributor_name": "合成贡献者",
      "stored": false,
      "stage": "planted",
      "care_remaining_seconds": 0,
      "growth_status": "needs_care"
    },
    {
      "id": "fixture-item-2",
      "kind": "bench",
      "x": 0.56,
      "y": 0.25,
      "flipped": false,
      "mine": true,
      "contributor_name": "合成贡献者",
      "stored": false,
      "stage": null,
      "care_remaining_seconds": null,
      "growth_status": null
    }
  ],
  "votes": [],
  "events": [],
  "stories": [],
  "goal": null,
  "story_enabled": false,
  "dialogue_enabled": false,
  "mahjong_available": false,
  "season": {
    "current_season": null
  }
};
it('reaches the saved tea chair from the yard without spinning indefinitely', () => {
  const group = parseGathering(savedShape);
  const initial = { ...group, companions: group.companions.map(c => c.id === 5 ? { ...c, leisure: undefined } : c) };
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 390 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const world = createLivingWorld(host, labels, initial, vi.fn(), vi.fn(), {
    persistentWorld: true, realistic: true, localLeisurePreview: true, localRoomTransitions: true,
    localCompanionDoors: true, localReferenceVilla: true, localNaturalWorld: true, localNaturalLeisure: true, onLeisureRequest: vi.fn(),
  });
  worlds.push(world); world.setMotion(true);
  const renderer = gpu.instances.at(-1)!;
  const step = () => { vi.setSystemTime(Date.now() + 100); renderer.loop!(Date.now()); };
  const root = () => renderer.scene!.children.find(o => o.userData.characterId === 5)!;
  for (let n = 0; n < 100; n++) step();
  const saved = JSON.stringify(group), roots = renderer.scene!.children.filter(o => o.userData.characterId);
  const previous = new Map(roots.map(a => [a.userData.characterId as number, a.position.clone()]));
  const radii = new Map(roots.map(a => [a.userData.characterId as number, Number(a.userData.navigationClearance)]));
  const graphs = new Map(roots.map(a => [a.userData.characterId as number, createLivingNavigation({ bounds: homeNavigationBounds('outdoor'), blocked: collectHomeJourneyObstacles(renderer.scene!, null), clearance: Number(a.userData.navigationClearance), step: .15 })]));
  const furniture: Array<{ object: THREE.Object3D; matrix: number[] }> = [];
  renderer.scene!.traverse(o => { if (o.userData.homeItemId || ['home-farmhouse-tea-table', 'home-tea-stool', 'home-mahjong-table', 'room-bed-0-mattress'].includes(o.name)) furniture.push({ object: o, matrix: o.matrixWorld.toArray() }); });
  world.update(group, null);
  const trace: unknown[] = []; let arrived = false;
  for (let n = 0; n < 700; n++) {
    step(); const a = root();
    if(n===120){
      const frozen=roots.map(body=>body.position.toArray()),work=JSON.stringify(root().userData.homePairedCourtesyWork);
      world.setMotion(false);vi.setSystemTime(Date.now()+10000);world.update(group,null);
      expect(roots.map(body=>body.position.toArray())).toEqual(frozen);expect(JSON.stringify(root().userData.homePairedCourtesyWork)).toBe(work);
      world.setMotion(true);
      const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(true);
      for(let i=0;i<10;i++)step();
      expect(roots.map(body=>body.position.toArray())).toEqual(frozen);expect(JSON.stringify(root().userData.homePairedCourtesyWork)).toBe(work);
      hidden.mockRestore();
    }
    if(n%50===0)world.update({...group,revision:group.revision+n},null);
    for (const body of roots) {
      const id = Number(body.userData.characterId), from = previous.get(id)!;
      expect(body.position.distanceTo(from), 'continuous physical motion for ' + id).toBeLessThan(.2);
      expect(body.userData.navigationClearance).toBe(radii.get(id));
      if (id !== 5 || !['dock', 'idle'].includes(body.userData.homeJourney?.phase)) expect(graphs.get(id)!.isSegmentClear(from, body.position), 'full-radius walking avoids original furniture for ' + id).toBe(true);
      previous.set(id, body.position.clone());
    }
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
      const left = roots[i], right = roots[j];
      expect(Math.hypot(left.position.x - right.position.x, left.position.z - right.position.z), 'partners retain physical clearance').toBeGreaterThanOrEqual(radii.get(Number(left.userData.characterId))! + radii.get(Number(right.userData.characterId))! - .001);
    }
    if (n % 50 === 0) trace.push({ n, position: a.position.toArray(), yaw: a.rotation.y, journey: a.userData.homeJourney, nav: a.userData.homeJourneyNavigation });
    if (a.userData.roomRestSeat?.seatId === 'tea-1' && !a.userData.homeJourney?.active) { arrived = true; break; }
  }
  expect(arrived,JSON.stringify(trace.slice(-2))).toBe(true);
  const seatedPosition = root().position.clone(), cup = renderer.scene!.getObjectByName('home-teacup-1')!;
  const steam = renderer.scene!.getObjectByName('home-tea-steam-0') as THREE.Line;
  expect(cup).toBeDefined(); expect(steam).toBeDefined();
  const steamBefore = Array.from(steam.geometry.getAttribute('position').array);
  for (let n = 0; n < 130; n++) {
    step(); expect(root().position.distanceTo(seatedPosition)).toBeLessThan(1e-6);
    const arm = root().getObjectByName('right-arm')!; expect(cup.parent).toBe(arm);
    const palm = new THREE.Vector3(.075, -.265, .045).applyMatrix4(arm.matrixWorld), handle = new THREE.Vector3(.075, .0415, -.035).applyMatrix4(cup.matrixWorld);
    expect(palm.distanceTo(handle)).toBeLessThan(1e-6);
  }
  expect(Array.from(steam.geometry.getAttribute('position').array)).not.toEqual(steamBefore);
  expect(steam.parent?.visible).toBe(true);
  expect(JSON.stringify(group)).toBe(saved);
  for (const { object, matrix } of furniture) expect(object.matrixWorld.toArray()).toEqual(matrix);
  expect(roots.find(a => a.userData.characterId === 4)!.userData.homeIdleYield).toBeUndefined();
  console.info('TEA_COMPLETE_METRICS ' + JSON.stringify({ work: root().userData.homePairedCourtesyWork, arrived, stableCupSeconds: 13, savedRecordsUnchanged: true, furnitureUnchanged: true }));
}, 120000);
