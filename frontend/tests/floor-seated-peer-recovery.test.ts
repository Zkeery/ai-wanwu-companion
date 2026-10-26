import * as THREE from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';
import { parseFloor } from '@/lib/villa-floor-sync';
import {collectHomeJourneyObstacles} from '@/lib/living-home-journey-geometry';
import {homeNavigationBounds} from '@/lib/living-home-navigation';
import {createLivingNavigation} from '@/lib/living-navigation';
import shape from './fixtures/floor-seated-peer-20261026.json';

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
function setup(ownerActor=4) {
  const group = parseGathering(structuredClone(shape.group)); group.me=group.companions.find(c=>c.id===ownerActor)!.owner_id;
  const floor = parseFloor(structuredClone(shape.floor));
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } });
  document.body.append(host, labels);
  const request = vi.fn();
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), {
    strictLeisureContacts:true, persistentWorld: true, realistic: true, localLeisurePreview: true, localRoomTransitions: true,
    localCompanionDoors: true, localReferenceVilla: true, localNaturalWorld: true,
    localNaturalLeisure: true, onLeisureRequest: request,
  });
  worlds.push(world);
  return { world, group, floor, host, request, renderer: gpu.renderers.at(-1)! };
}

it('reaches upstairs continuously with full body clearance while the peer stays seated', () => {
 const f=setup(),original=structuredClone(f.group);expect(f.world.applyServerFloor(f.floor)).toBe(true);f.world.setFloorDriver(true);f.world.setMotion(true);
 let previous:THREE.Vector3|undefined,seated:THREE.Vector3|undefined,minSeparation=Infinity,maxStep=0,walkSegments=0,elapsed=0;
 let graph:ReturnType<typeof createLivingNavigation>|undefined;
 for(let i=0;i<2400;i++){
  vi.advanceTimersByTime(32);f.renderer.loop?.(Date.now());elapsed++;
  const scene=f.renderer.scene!,a=scene.children.find(a=>a.userData.characterId===4)!,peer=scene.children.find(a=>a.userData.characterId===5)!;
  seated??=peer.position.clone();expect(peer.position.distanceTo(seated)).toBeLessThan(1e-8);
  expect(a.userData.navigationClearance).toBe(.9);expect(peer.userData.navigationClearance).toBe(.8);
  if(previous)maxStep=Math.max(maxStep,previous.distanceTo(a.position));
  if(a.userData.homeRegion==='outdoor'&&a.userData.homeJourneyNavigation?.stage===0){
   minSeparation=Math.min(minSeparation,Math.hypot(a.position.x-peer.position.x,a.position.z-peer.position.z));
   graph??=createLivingNavigation({bounds:{...homeNavigationBounds('outdoor'),minZ:scene.getObjectByName('home-courtyard-enclosure')!.userData.bounds.minZ},blocked:collectHomeJourneyObstacles(scene,null),clearance:.9,step:.16});
   if(previous){expect(graph.isSegmentClear(previous,a.position)).toBe(true);walkSegments++;}
  }
  previous=a.position.clone();if(f.world.getFloorVisit(4)?.phase==='upper')break;
 }
 expect(f.world.getFloorVisit(4)?.phase).toBe('upper');
 expect(f.world.getFloorVisit(4)?.pose.blend).toBeCloseTo(1,12);expect(f.world.getFloorVisit(4)?.activity).toBe('sleep');
 expect(walkSegments).toBeGreaterThan(30);expect(minSeparation).toBeGreaterThanOrEqual(.9+.8+.035-1e-5);expect(maxStep).toBeLessThan(.13);
 expect(f.request).not.toHaveBeenCalled();expect(f.group).toEqual(original);
 console.log('FLOOR_SEATED_PEER',JSON.stringify({elapsedSeconds:elapsed*.032,walkSegments,minSeparation,maxStep,upper:true,peerUnchanged:true,externalCalls:0}));
},120000);

it('continues another owner’s stair visit after a mid-stair checkpoint reload',()=>{
 const first=setup(5);expect(first.world.applyServerFloor(first.floor)).toBe(true);first.world.setFloorDriver(true);first.world.setMotion(true);
 for(let i=0;i<1400;i++){vi.advanceTimersByTime(32);first.renderer.loop?.(Date.now());const state=first.world.getFloorVisit(4);if(state?.phase==='walking'&&state.distance>4)break;}
 const before=first.world.getFloorVisit(4)!;expect(before.phase).toBe('walking');expect(before.distance).toBeGreaterThan(4);
 const saved=first.world.exportServerFloor();first.world.setMotion(false);first.world.dispose();worlds.splice(worlds.indexOf(first.world),1);
 const restored=setup(5);expect(restored.world.applyServerFloor({...restored.floor,...saved})).toBe(true);
 expect(restored.world.getFloorVisit(4)?.pose).toEqual(before.pose);expect(restored.world.getFloorVisit(4)?.distance).toBe(before.distance);
 restored.world.setFloorDriver(true);restored.world.setMotion(true);
 for(let i=0;i<1800;i++){vi.advanceTimersByTime(32);restored.renderer.loop?.(Date.now());if(restored.world.getFloorVisit(4)?.phase==='upper')break;}
 expect(restored.world.getFloorVisit(4)?.phase).toBe('upper');expect(restored.world.getFloorVisit(4)?.pose.blend).toBeCloseTo(1,12);
 expect(restored.request).not.toHaveBeenCalled();expect(first.request).not.toHaveBeenCalled();
 const peer=restored.renderer.scene!.children.find(a=>a.userData.characterId===5)!;expect(peer.position.x).toBe(1.92);expect(peer.position.z).toBe(2.8);
},120000);
