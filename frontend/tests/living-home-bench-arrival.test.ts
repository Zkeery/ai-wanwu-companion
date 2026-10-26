import * as THREE from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';
import { collectHomeJourneyObstacles } from '@/lib/living-home-journey-geometry';
import { createLivingNavigation } from '@/lib/living-navigation';
import { homeNavigationBounds } from '@/lib/living-home-navigation';

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
  "title": "无动作只读形态复现",
  "scene_type": "home",
  "revision": 77,
  "closed": false,
  "is_manager": true,
  "me": "fixture-owner-0",
  "members": [
    {
      "id": "fixture-owner-0",
      "name": "合成成员0",
      "manager": false
    },
    {
      "id": "fixture-owner-1",
      "name": "合成成员1",
      "manager": true
    }
  ],
  "companions": [
    {
      "id": 4,
      "owner_id": "fixture-owner-1",
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
      "owner_id": "fixture-owner-0",
      "name": "合成伙伴5",
      "activity": "talk",
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
        "activity": "bench",
        "seat_id": "bench-fixture-item-0-0",
        "station_version": 1
      }
    },
    {
      "id": 2,
      "owner_id": "fixture-owner-1",
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

type Origin='yard'|'television-immediate'|'television-exit'|'saved';
function fixture(origin:Origin,benchIndex=0){
  const group=parseGathering(savedShape);
  group.companions=group.companions.map(c=>c.id===5?{...c,leisure:{activity:'bench',seat_id:'bench-fixture-item-'+benchIndex+'-0',station_version:1}}:c);
  const saved=JSON.stringify(group);
  const initial={...group,companions:group.companions.map(c=>c.id===5?{...c,leisure:origin==='saved'?c.leisure:origin==='yard'?undefined:{activity:'television' as const,seat_id:'television-0',station_version:1 as const}}:c)};
  const host=document.createElement('div'),labels=document.createElement('div');Object.defineProperties(host,{clientWidth:{value:390},clientHeight:{value:500}});document.body.append(host,labels);
  const world=createLivingWorld(host,labels,initial,vi.fn(),vi.fn(),{persistentWorld:true,realistic:true,localLeisurePreview:true,localRoomTransitions:true,localCompanionDoors:true,localReferenceVilla:true,localNaturalWorld:true,localNaturalLeisure:true,onLeisureRequest:vi.fn()});worlds.push(world);world.setMotion(true);
  const renderer=gpu.instances.at(-1)!,root=()=>renderer.scene!.children.find(a=>a.userData.characterId===5)!;
  const step=()=>{vi.setSystemTime(Date.now()+100);renderer.loop!(Date.now());};for(let i=0;i<100;i++)step();
  if(origin.startsWith('television')){world.update({...initial,revision:group.revision+1,companions:initial.companions.map(c=>c.id===5?{...c,leisure:undefined}:c)},null);for(let i=0;i<(origin==='television-exit'?150:1);i++)step();}
  const seat=world.getLeisureSeats().find(s=>s.id===group.companions.find(c=>c.id===5)!.leisure!.seat_id)!;
  const furniture: Array<{object:THREE.Object3D;matrix:number[]}> = [];
  renderer.scene!.traverse(object=>{if(object.userData.homeItemId||object.name==='home-mahjong-table')furniture.push({object,matrix:object.matrixWorld.toArray()});});
  const unchanged=()=>{expect(JSON.stringify(group)).toBe(saved);for(const{object,matrix}of furniture)expect(object.matrixWorld.toArray()).toEqual(matrix);expect(root().userData.navigationClearance).toBe(.8);};
  const assign=()=>world.update({...group,revision:group.revision+2},null);
  const cancel=()=>world.update({...group,revision:group.revision+3,companions:group.companions.map(c=>c.id===5?{...c,leisure:undefined}:c)},null);
  const seated=()=>root().userData.roomRestSeat?.seatId===seat.id&&!root().userData.homeJourney?.active;
  return{group,world,renderer,root,step,seat,unchanged,assign,cancel,seated};
}

for(const origin of ['yard','television-immediate','television-exit'] as const)it('walks to and leaves the saved bench without refresh from '+origin,()=>{
  const f=fixture(origin);f.assign();let frames=0,maxStep=0,minGap=Infinity,contactFrames=0;let previous=f.root().position.clone();
  let contactGraph:ReturnType<typeof createLivingNavigation>|null=null;
  for(;frames<700&&!f.seated();frames++){
    f.step();const a=f.root(),journey=a.userData.homeJourney;
    maxStep=Math.max(maxStep,a.position.distanceTo(previous));
    if(journey?.phase==='dock'&&journey.targetKey.startsWith('seat/outdoor')){
      if(!contactGraph){const obstacles=collectHomeJourneyObstacles(f.renderer.scene!,null);contactGraph=createLivingNavigation({bounds:homeNavigationBounds('outdoor'),blocked:obstacles.filter(o=>!(o.source.includes('bench')&&f.seat.x>=o.minX&&f.seat.x<=o.maxX&&f.seat.z>=o.minZ&&f.seat.z<=o.maxZ)),clearance:.8*.9,step:.16});}
      expect(contactGraph.isSegmentClear(previous,a.position),'bench transfer must avoid the original chair/tree/other bench').toBe(true);contactFrames++;
    }
    if(journey?.pose.area==='outdoor')for(const peer of f.renderer.scene!.children.filter(p=>p.userData.characterId&&p!==a&&p.userData.homeRegion==='outdoor')){
      const radius=.8*(journey.phase==='dock'?.9:1),peerRadius=Number(peer.userData.navigationClearance)*(peer.userData.roomRestSeat?.9:1);
      minGap=Math.min(minGap,Math.hypot(a.position.x-peer.position.x,a.position.z-peer.position.z)-radius-peerRadius);
    }
    previous=a.position.clone();
  }
  expect(f.seated(),JSON.stringify(f.root().userData.homeJourneyNavigation)).toBe(true);expect(contactFrames).toBeGreaterThan(0);expect(maxStep).toBeLessThan(.17);expect(minGap).toBeGreaterThanOrEqual(.035-1e-6);
  const seated=f.root().position.clone();for(let i=0;i<100;i++){f.step();expect(f.root().position.distanceTo(seated)).toBeLessThan(1e-6);}f.unchanged();
  f.cancel();let left=false;previous=f.root().position.clone();for(let i=0;i<500;i++){f.step();maxStep=Math.max(maxStep,f.root().position.distanceTo(previous));previous=f.root().position.clone();if(!f.root().userData.roomRestSeat&&!f.root().userData.homeJourney?.active&&f.root().position.distanceTo(seated)>1){left=true;break;}}
  expect(left,'bench exit must finish without refresh').toBe(true);expect(maxStep).toBeLessThan(.17);f.unchanged();
  console.info('BENCH_ARRIVAL_METRICS '+JSON.stringify({origin,frames,maxStep,minGap,contactFrames,stableSeatedSeconds:10,left:true}));
},120000);

it('clears a manually opened door and requests safe closure before continuing to the bench',()=>{
  const f=fixture('television-immediate');f.world.setDoorOpen('home-main-entry-door',true);f.assign();let held=0,maxStep=0;let previous=f.root().position.clone();
  for(let i=0;i<700&&!f.seated();i++){
    f.step();maxStep=Math.max(maxStep,f.root().position.distanceTo(previous));previous=f.root().position.clone();
    if(f.root().userData.homeJourney?.targetKey.startsWith('bench-egress/')){held++;expect(f.root().userData.roomRestSeat).toBeUndefined();expect(Math.hypot(f.root().position.x-f.seat.x,f.root().position.z-f.seat.z)).toBeGreaterThan(2);}
  }
  expect(held).toBeGreaterThanOrEqual(8);expect(f.seated()).toBe(true);expect(maxStep).toBeLessThan(.17);f.unchanged();
},120000);

it('honours cancellation while clearing the doorway',()=>{
  const f=fixture('television-immediate');f.world.setDoorOpen('home-main-entry-door',true);f.assign();let clearing=false;
  for(let i=0;i<300;i++){f.step();if(f.root().userData.homeJourney?.targetKey.startsWith('bench-egress/')){clearing=true;break;}}
  expect(clearing).toBe(true);f.cancel();f.world.setDoorOpen('home-main-entry-door',false);
  for(let i=0;i<500;i++){f.step();expect(f.root().userData.roomRestSeat).toBeUndefined();expect(f.root().userData.homeJourney?.targetKey??'').not.toContain('bench-egress/');if(!f.root().userData.homeJourney?.active)break;}
  expect(f.root().userData.homeJourney?.active).not.toBe(true);f.unchanged();
},120000);

it('restores the saved bench on a fresh world and preserves the saved records',()=>{
  const f=fixture('saved');expect(f.seated()).toBe(true);f.unchanged();
  const before=f.root().position.clone();f.world.dispose();const fresh=fixture('saved');expect(fresh.seated()).toBe(true);expect(fresh.root().position.distanceTo(before)).toBeLessThan(1e-6);fresh.unchanged();
},120000);
