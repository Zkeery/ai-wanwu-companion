import * as THREE from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';

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
  return{group,world,renderer,root,step,seat,unchanged,assign,cancel,seated,host,labels};
}

for(const origin of ['yard','television-immediate','saved'] as const)it('restores the two-person gathering and alternating captions after leaving the bench without refresh from '+origin,()=>{
  const f=fixture(origin);f.assign();
  for(let i=0;i<700&&!f.seated();i++)f.step();
  expect(f.seated()).toBe(true);f.cancel();f.world.setHouseView('exterior');
  const actors=()=>f.renderer.scene!.children.filter(a=>a.userData.characterId);
  const previous=new Map(actors().map(a=>[Number(a.userData.characterId),a.position.clone()]));
  let maxStep=0,minGap=Infinity,frames=0,ready=false;
  for(;frames<700;frames++){
    f.step();const all=actors(),partners=all.filter(a=>[2,5].includes(a.userData.characterId));
    for(const a of all){const id=Number(a.userData.characterId);maxStep=Math.max(maxStep,a.position.distanceTo(previous.get(id)!));previous.set(id,a.position.clone());}
    for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)if(all[i].userData.homeRegion==='outdoor'&&all[j].userData.homeRegion==='outdoor'){
      minGap=Math.min(minGap,Math.hypot(all[i].position.x-all[j].position.x,all[i].position.z-all[j].position.z)-Number(all[i].userData.navigationClearance)-Number(all[j].userData.navigationClearance));
    }
    ready=partners.length===2&&partners.every(a=>a.userData.socialGathering?.ready===true);
    if(ready)break;
  }
  expect(ready,JSON.stringify(actors().map(a=>({id:a.userData.characterId,journey:a.userData.homeJourneyNavigation,social:a.userData.socialGathering})))).toBe(true);
  expect(maxStep,'continuous arrival must not jump or rely on refresh').toBeLessThan(.17);
  expect(minGap,'keep original full navigation radii and peer clearance').toBeGreaterThanOrEqual(.035-1e-6);
  const speakers=new Set<number>(),visibleTurns:Array<{id:number;text:string}>=[];
  for(let i=0;i<140;i++){
    f.step();const speaking:number[]=[];
    for(const id of [2,5]){
      const marker=[...f.labels.querySelectorAll<HTMLElement>('.living3d-marker')].find(m=>m.querySelector('.living3d-name')?.textContent==='合成伙伴'+id)!;
      const bubble=marker.querySelector<HTMLElement>('.living3d-bubble')!;
      if(!marker.hidden&&!bubble.hidden&&bubble.dataset.kind==='preset'&&bubble.textContent){speakers.add(id);speaking.push(id);if(visibleTurns.at(-1)?.id!==id)visibleTurns.push({id,text:bubble.textContent});}
    }
    expect(speaking.length,'at most one partner speaks at a time').toBeLessThanOrEqual(1);
    for(const a of actors().filter(a=>[2,5].includes(a.userData.characterId)))expect(a.userData.socialGathering?.ready).toBe(true);
  }
  expect([...speakers].sort(),'both real visible preset bubbles must return').toEqual([2,5]);expect(visibleTurns.length).toBeGreaterThanOrEqual(2);
  f.unchanged();
  console.info('BENCH_SOCIAL_RESTORE '+JSON.stringify({origin,frames,ready,maxStep,minGap,visibleTurns,networkCalls:vi.mocked(fetch).mock.calls.length}));
},120000);
