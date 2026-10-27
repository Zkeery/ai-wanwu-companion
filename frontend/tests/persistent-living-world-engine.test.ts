import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import type { HomeLeisureActivity, HomeLeisureSeat } from '@/lib/living-home-leisure';
import type { LivingLeisureRequest } from '@/lib/living-persistent-world';
import { collectHomeNavigationObstacles, homeNavigationBounds } from '@/lib/living-home-navigation';
import { collectNaturalNavigationObstacles } from '@/lib/living-natural-navigation';
import { collectHomeJourneyObstacles } from '@/lib/living-home-journey-geometry';
import { createLivingNavigation, type NavPoint } from '@/lib/living-navigation';
import { createHomeJourneyController, type JourneyContext, type JourneyPose, type JourneyProposal } from '@/lib/living-home-journey';
import { createLivingPedestrianTraffic } from '@/lib/living-pedestrian-traffic';

const gpu = vi.hoisted(() => ({ instances: [] as Array<{ scene: THREE.Scene | null; camera:THREE.Camera|null; loop: ((time: number) => void) | null }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; camera:THREE.Camera|null=null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; this.camera=camera; });
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});

type Kind = 'home' | 'forest' | 'desert';
type Options = NonNullable<Parameters<typeof createLivingWorld>[5]>;
const OWN = 401, OTHER = 402;
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
let rejectedBodyBoxCandidates = 0;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0; rejectedBodyBoxCandidates = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  for (const name of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(name, vi.fn(() => { throw new Error('persistent world engine acceptance is isolated and free'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  if (rejectedBodyBoxCandidates) console.info('PERSISTENT_TRIANGLE_NARROWPHASE ' + JSON.stringify({ bodyBoxCandidatesWithoutActualMeshCrossing: rejectedBodyBoxCandidates }));
  worlds.splice(0).forEach(world => world.dispose());
  expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function snapshot(kind: Kind): Gathering {
  return parseGathering({ id: '6c3780c6-3571-4c2a-9cba-a6a8e47c7491', title: '真实存档契约的隔离验证', scene_type: kind, revision: 1, closed: false, is_manager: true, me: 'owner-a',
    members: [{ id: 'owner-a', name: '本人成员', manager: true }, { id: 'owner-b', name: '另一成员', manager: false }],
    companions: [OWN, OTHER].map((id, index) => ({ id, owner_id: index ? 'owner-b' : 'owner-a', name: '测试伙伴' + id, activity: 'observe', area: 'outdoor', x: .3 + index * .3, y: .76,
      avatar3d: { version: 1, kind: index ? 'plant' : 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: id, source: 'procedural_existing_features' } })),
    items: [{ id: 'existing-bench', kind: 'bench', x: kind === 'home' ? 0 : .76, y: kind === 'home' ? .44 : .7, flipped: true, mine: true, contributor_name: '本人成员', growth_status: null },
      { id: 'existing-tree', kind: 'tree', x: .1, y: .2, flipped: false, mine: true, contributor_name: '本人成员', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function setup(group = snapshot('home'), options: Options = {}) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const requested = vi.fn<(request: LivingLeisureRequest) => void>(), doorChanged = vi.fn();
  const world = createLivingWorld(host, labels, group, vi.fn(), doorChanged, {
    persistentWorld: true, realistic: true, localLeisurePreview: true, localRoomTransitions: true, localCompanionDoors: true,
    localReferenceVilla: true, localNaturalWorld: true, localNaturalLeisure: true, onLeisureRequest: requested, ...options,
  });
  worlds.push(world); const renderer = gpu.instances.at(-1)!;
  return { world, host, labels, group, requested, doorChanged, renderer, scene: renderer.scene! };
}
type Fixture = ReturnType<typeof setup>;
function actor(f: Fixture, id = OWN) { const root = f.scene.children.find(o => o.userData.characterId === id); expect(root, 'actual actor ' + id).toBeDefined(); return root!; }

it.each(['departure', 'new activity'] as const)('invalidates an actual local shared speech caption on %s', async reason => {
  const group = snapshot('home'); group.items = []; group.companions = group.companions.map(c => ({ ...c, activity: 'talk', area: 'outdoor' }));
  const synthesis = { getVoices: vi.fn(() => [{ name: '合成本地音色', lang: 'zh-CN', localService: true, default: true }]), speak: vi.fn(), cancel: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('speechSynthesis', synthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} voice = null; lang = ''; pitch = 1; rate = 1; volume = 1; onend = null; onerror = null; });
  const f = setup(group, { localQuietAudio: true }); f.world.setMotion(true);
  until(f, () => group.companions.every(c => actor(f, c.id).userData.socialGathering?.ready));
  expect(await f.world.setLifeAudio(true)).toBe(true);
  const event = { id: 'synthetic-audible-lifecycle', at: Date.now() / 1000, kind: 'dialogue', origin: 'real_provider', area: 'outdoor' as const, activity: null, characters: [OTHER, OWN], message: '合成共享结果', lines: [{ character_id: OTHER, name: '合成乙', text: '合成发言正在播放。' }, { character_id: OWN, name: '合成甲', text: '合成下一句。' }] };
  f.world.setBubbleReceipts(new Map([[event.id, event.at]]));
  apply(f, { ...group, revision: 2, events: [event] }); step(f);
  expect(f.host.dataset.lifeSpeechStatus).toBe('speaking'); const count = synthesis.speak.mock.calls.length;
  const next = { ...f.group, revision: 3 };
  if (reason === 'departure') next.companions = next.companions.filter(c => c.id !== OTHER);
  else next.events = [...next.events, { id: 'synthetic-changed-activity', at: Date.now() / 1000, kind: 'activity', activity: 'rest', origin: 'offline_rules', area: 'outdoor', characters: [OTHER], message: '合成切换活动' }];
  apply(f, next); step(f);
  expect(f.host.dataset.lifeSpeechStatus).toBe('ready'); expect(synthesis.speak).toHaveBeenCalledTimes(count);
  expect(synthesis.cancel).toHaveBeenCalled(); expect(f.requested).not.toHaveBeenCalled();
});

it.each(['home','forest','desert'] as const)('saved social partners walk together in %s, face each other and take turns without changing their records', kind => {
  const group = snapshot(kind); group.items = [];
  group.companions = group.companions.map(c => ({ ...c, activity: 'talk', area: 'outdoor' }));
  const original = JSON.stringify(group), f = setup(group); f.world.setMotion(true);
  let arrived = false;
  for (let frame = 0; frame < 1600; frame++) {
    const before = group.companions.map(c => actor(f, c.id).position.clone()); step(f);
    group.companions.forEach((c, index) => expect(actor(f, c.id).position.distanceTo(before[index])).toBeLessThan(.3));
    if (group.companions.every(c => actor(f, c.id).userData.socialGathering?.ready)) { arrived = true; break; }
  }
  expect(arrived, JSON.stringify({ data: f.host.dataset, actors: group.companions.map(c => ({ id: c.id, position: actor(f, c.id).position.toArray(), social: actor(f, c.id).userData.socialGathering, journey: actor(f, c.id).userData.homeJourney })) })).toBe(true);
  for (let i = 0; i < 40; i++) step(f);
  for (const c of group.companions) {
    const root = actor(f, c.id), center = root.userData.socialGathering.center;
    const expected = Math.atan2(center.x - root.position.x, center.z - root.position.z);
    expect(Math.abs(Math.atan2(Math.sin(root.rotation.y - expected), Math.cos(root.rotation.y - expected)))).toBeLessThan(.05);
  }
  const a = actor(f), b = actor(f, OTHER);
  expect(a.position.distanceTo(b.position)).toBeGreaterThan(a.userData.navigationClearance + b.userData.navigationClearance);
  const captions=()=>[...f.labels.querySelectorAll<HTMLElement>('[data-kind="preset"]')].filter(e=>!e.hidden);
  expect(captions()).toHaveLength(1);const firstCaption=captions()[0];
  for(let i=0;i<60;i++)step(f);expect(captions()).toHaveLength(1);expect(captions()[0]).not.toBe(firstCaption);
  f.world.setBubbleReceipts(new Map([['synthetic-real-response',Date.now()/1000]]));
  apply(f,{...group,revision:2,events:[{id:'synthetic-real-response',kind:'dialogue',activity:null,origin:'real_provider',area:'outdoor',at:Date.now()/1000,message:'synthetic response',characters:[OWN,OTHER],lines:[{character_id:OWN,name:'测试',text:'收到共享回复。'},{character_id:OTHER,name:'测试',text:'我们轮流说。'}]}]});step(f);expect(captions()).toHaveLength(0);expect([...f.labels.querySelectorAll<HTMLElement>('[data-kind="dialogue"]')].filter(e=>!e.hidden)).toHaveLength(1);
  f.world.setMotion(false);const frozen=group.companions.map(c=>actor(f,c.id).position.clone());vi.setSystemTime(Date.now()+2000);f.world.update(group,null);group.companions.forEach((c,i)=>expect(actor(f,c.id).position.distanceTo(frozen[i])).toBeLessThan(1e-8));
  expect(f.requested).not.toHaveBeenCalled(); expect(JSON.stringify(group)).toBe(original);
  f.world.setMotion(true);apply(f,{...group,revision:group.revision+1,companions:group.companions.filter(c=>c.id===OWN)});step(f);expect(f.host.dataset.socialParticipants).toBe('0');expect(captions()).toHaveLength(0);
}, 60_000);
function slots(f: Fixture, activity: HomeLeisureActivity) { return f.world.getLeisureSeats().filter(s => s.station === activity && s.available !== false); }
function slot(f: Fixture, activity: HomeLeisureActivity, index = 0): HomeLeisureSeat { const result = slots(f, activity)[index]; expect(result, f.group.scene_type + ' ' + activity + ' actual seat ' + index).toBeDefined(); return result!; }
function saved(group: Gathering, id: number, seat: HomeLeisureSeat | null): Gathering {
  return { ...group, revision: group.revision + 1, companions: group.companions.map(c => {
    if (c.id !== id) return c;
    const { leisure: _old, ...other } = c; void _old;
    return seat ? { ...other, leisure: { activity: seat.station, seat_id: seat.id, station_version: 1 as const } } : other;
  }) };
}
function trianglePenetration(surface: THREE.Object3D, volume: THREE.Box3) {
  const inner = volume.clone().expandByScalar(-.006); if (!new THREE.Box3().setFromObject(surface, true).intersectsBox(inner)) return false;
  const triangle = new THREE.Triangle(), vertex = new THREE.Vector3(); let hit = false;
  surface.traverse(object => {
    if (hit || !(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
      for (const [offset, point] of [[0, triangle.a], [1, triangle.b], [2, triangle.c]] as const) point.copy(vertex.fromBufferAttribute(positions, indices ? indices.getX(i + offset) : i + offset).applyMatrix4(object.matrixWorld));
      if (inner.intersectsTriangle(triangle)) { hit = true; return; }
    }
  }); return hit;
}
function exactTriangleCrossing(surface: THREE.Object3D, body: THREE.Object3D) {
  function triangles(root: THREE.Object3D) {
    const rows: Array<{ triangle: THREE.Triangle; box: THREE.Box3; mesh: string }> = [];
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (let p: THREE.Object3D | null = object; p; p = p.parent) if (!p.visible) return;
      const points = object.geometry.getAttribute('position'), indices = object.geometry.index;
      for (let i = 0; i < (indices?.count ?? points.count); i += 3) {
        const triangle = new THREE.Triangle();
        for (const [offset, point] of [[0, triangle.a], [1, triangle.b], [2, triangle.c]] as const) point.fromBufferAttribute(points, indices ? indices.getX(i + offset) : i + offset).applyMatrix4(object.matrixWorld);
        rows.push({ triangle, box: new THREE.Box3().setFromPoints([triangle.a, triangle.b, triangle.c]), mesh: object.name || object.geometry.type });
      }
    }); return rows;
  }
  const furniture = triangles(surface), avatar = triangles(body), ray = new THREE.Ray(), direction = new THREE.Vector3(), hit = new THREE.Vector3();
  const crosses = (edge: THREE.Triangle, face: THREE.Triangle) => {
    for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.c], [edge.c, edge.a]]) {
      const length = direction.subVectors(b, a).length(); if (length < .012) continue; ray.set(a, direction.multiplyScalar(1 / length));
      if (ray.intersectTriangle(face.a, face.b, face.c, false, hit)) { const distance = hit.distanceTo(a); if (distance > .006 && distance < length - .006) return true; }
    } return false;
  };
  for (const a of furniture) for (const b of avatar) if (a.box.intersectsBox(b.box) && (crosses(a.triangle, b.triangle) || crosses(b.triangle, a.triangle))) return { furnitureMesh: a.mesh, bodyMesh: b.mesh };
  return null;
}
function assertTeaFurnitureClear(f: Fixture) {
  const names = f.group.scene_type === 'home' ? ['home-farmhouse-tea-table-body', 'home-tea-stool'] : ['natural-' + f.group.scene_type + '-tea-table-body', 'natural-' + f.group.scene_type + '-tea-stool-0', 'natural-' + f.group.scene_type + '-tea-stool-1'];
  for (const companion of f.group.companions) {
    const body = actor(f, companion.id).getObjectByName('body'); expect(body).toBeDefined(); const volume = new THREE.Box3().setFromObject(body!, true);
    for (const name of names) {
      const surface = f.scene.getObjectByName(name); if (!surface || !trianglePenetration(surface, volume)) continue;
      const actualCrossing = exactTriangleCrossing(surface, body!);
      if (!actualCrossing) { rejectedBodyBoxCandidates++; continue; }
      throw new Error('PERSISTENT_TEA_FURNITURE_PENETRATION ' + JSON.stringify({ scene: f.group.scene_type, actor: companion.id, surface: name, exactTriangleCrossing: actualCrossing, position: actor(f, companion.id).position.toArray(), journey: actor(f, companion.id).userData.homeJourney }));
    }
  }

}
function assertMahjongFurnitureClear(f: Fixture) {
  if (f.group.scene_type !== 'home') return;
  const ids = new Set(f.world.getLocalLeisure().assignments.filter(value => value.activity === 'mahjong').map(value => value.actorId));
  if (!ids.size) return;
  const furniture = ['home-mahjong-table-body', ...[0, 1, 2, 3].map(index => 'home-mahjong-chair-' + index)].flatMap(name => {
    const root = f.scene.getObjectByName(name), result: THREE.Mesh[] = []; root?.traverse(mesh => { if (mesh instanceof THREE.Mesh) result.push(mesh); }); return result;
  });
  for (const id of ids) for (const name of ['body', 'left-arm', 'right-arm', 'left-leg', 'right-leg']) {
    const root = actor(f, id), part = root.getObjectByName(name)!, volume = new THREE.Box3().setFromObject(part, true);
    for (const surface of furniture) {
      const bounds = new THREE.Box3().setFromObject(surface, true);
      if (!volume.intersectsBox(bounds) || surface.name.endsWith('-seat') && volume.min.y >= bounds.max.y - .006) continue;
      const crossing = exactTriangleCrossing(surface, part); if (!crossing) continue;
      throw new Error('PERSISTENT_MAHJONG_FURNITURE_PENETRATION ' + JSON.stringify({ actor: id, part: name, surface: surface.name || surface.parent?.name, crossing,
        position: root.position.toArray(), journey: root.userData.homeJourney, contactCollision: root.userData.contactCollision }));
    }
  }
  const present = [...ids].map(id => ({ id, root: actor(f, id), parts: ['body', 'left-arm', 'right-arm', 'left-leg', 'right-leg'].map(name => {
    const part = actor(f, id).getObjectByName(name)!; return { part, bounds: new THREE.Box3().setFromObject(part, true) };
  }) }));
  for (let first = 0; first < present.length; first++) for (let second = first + 1; second < present.length; second++) {
    for (const a of present[first].parts) for (const b of present[second].parts) {
      if (!a.bounds.intersectsBox(b.bounds)) continue; const crossing = exactTriangleCrossing(a.part, b.part); if (!crossing) continue;
      throw new Error('PERSISTENT_MAHJONG_PEER_PENETRATION ' + JSON.stringify({ first: present[first].id, second: present[second].id,
        firstPart: a.part.name, secondPart: b.part.name, crossing, positions: [present[first].root.position.toArray(), present[second].root.position.toArray()] }));
    }
  }
}
function step(f: Fixture, delta = 100) { vi.setSystemTime(Date.now() + delta); expect(f.renderer.loop).toBeTypeOf('function'); f.renderer.loop!(Date.now()); assertTeaFurnitureClear(f); assertMahjongFurnitureClear(f); }
function until(f: Fixture, predicate: () => boolean, limit = 1300) {
  for (let i = 0; i < limit; i++) { step(f); if (predicate()) return; }
  const root = actor(f), bounds = new THREE.Box3().setFromObject(root, true), size = bounds.getSize(new THREE.Vector3());
  const nodes = ['home-main-entry-door', 'home-room-connection-door', 'home-courtyard-gate'].flatMap(id => {
    const door = f.scene.getObjectByName(id); return door ? [{ id, openness: door.userData.homeDoorOpenness, leafAngle: door.getObjectByName(id + '-leaf')?.rotation.y, position: door.getWorldPosition(new THREE.Vector3()).toArray() }] : [];
  });
  const navigation = f.group.scene_type === 'home' ? collectHomeNavigationObstacles(f.scene, null) : collectNaturalNavigationObstacles(f.scene, null);
  throw new Error('PERSISTENT_WORLD_STALL ' + JSON.stringify({ fixture: f.group, scene: f.group.scene_type, leisure: f.world.getLocalLeisure(), data: { ...f.host.dataset },
    actor: { position: root.position.toArray(), size: size.toArray(), min: bounds.min.toArray(), max: bounds.max.toArray(), clearance: root.userData.navigationClearance, portalClearance: root.userData.journeyPortalClearance, portal: root.userData.journeyPortal, journey: root.userData.homeJourney, navigation: root.userData.homeNavigation },
    actors: f.group.companions.map(c => ({ id: c.id, position: actor(f, c.id).position.toArray(), journey: actor(f, c.id).userData.homeJourney, navigation: actor(f, c.id).userData.homeJourneyNavigation, portal: actor(f, c.id).userData.journeyPortal, support: actor(f, c.id).userData.journeyCurrentSupport, clearance: actor(f, c.id).userData.navigationClearance, contactCollision: actor(f, c.id).userData.contactCollision })),
    seats: f.world.getLeisureSeats(),
    doors: nodes, navigationObstacles: navigation, journeyObstacles: collectHomeJourneyObstacles(f.scene, null) }));
}
function apply(f: Fixture, group: Gathering) { f.group = group; f.world.update(group, null); }
function assignment(f: Fixture, id = OWN) { return f.world.getLocalLeisure().assignments.find(a => a.actorId === id); }
function seated(f: Fixture, id = OWN) { return !!assignment(f, id) && actor(f, id).userData.roomRestSeat?.seatId === assignment(f, id)?.seatId && !actor(f, id).userData.homeJourney?.active; }
function cupContact(f: Fixture, cup: THREE.Object3D, phase: string) {
  const root = actor(f), arm = root.getObjectByName('right-arm')!, body = root.getObjectByName('body')!;
  const palm = new THREE.Vector3(.075, -.265, .045).applyMatrix4(arm.matrixWorld), handle = new THREE.Vector3(.075, .0415, -.035).applyMatrix4(cup.matrixWorld);
  const value = { scene: f.group.scene_type, phase, parent: cup.parent?.name, wasRightArm: cup.parent === arm, palm: palm.toArray(), handle: handle.toArray(), distance: palm.distanceTo(handle),
    gripError: cup.userData.gripError, rootMatrix: root.matrixWorld.toArray(), bodyMatrix: body.matrixWorld.toArray(), armMatrix: arm.matrixWorld.toArray(), cupMatrix: cup.matrixWorld.toArray() };
  console.info('PERSISTENT_CUP_CONTACT ' + JSON.stringify(value)); return value;
}
function existingItems(f: Fixture) {
  const result: Array<{ root: THREE.Object3D; matrix: number[]; rotation: number[] }> = [];
  f.scene.traverse(root => { if (root.userData.homeItemId) result.push({ root, matrix: root.matrixWorld.toArray(), rotation: root.rotation.toArray().slice(0, 3) as number[] }); });
  expect(result.map(x => x.root.userData.homeItemId).sort()).toEqual(['existing-bench', 'existing-tree']);
  expect(result.find(x => x.root.userData.homeItemId === 'existing-bench')!.root.rotation.y).toBeCloseTo(Math.PI);
  if (f.group.scene_type === 'home' && f.group.items.find(item => item.id === 'existing-bench')?.x === 0) {
    const bench = result.find(x => x.root.userData.homeItemId === 'existing-bench')!.root, box = new THREE.Box3().setFromObject(bench, true), bounds = homeNavigationBounds('outdoor');
    expect(box.min.x).toBeGreaterThan(bounds.minX); expect(box.max.x).toBeLessThan(bounds.maxX); expect(box.min.z).toBeGreaterThan(bounds.minZ); expect(box.max.z).toBeLessThan(bounds.maxZ);
    for (const obstacle of collectHomeNavigationObstacles(f.scene, null).filter(o => o.source !== 'home-realistic-item-bench')) {
      expect(box.min.x < obstacle.maxX && box.max.x > obstacle.minX && box.min.z < obstacle.maxZ && box.max.z > obstacle.minZ, 'clear fixture bench does not overlap ' + obstacle.source).toBe(false);
    }
  }
  return () => result.forEach(x => { expect(x.root.parent).not.toBeNull(); expect(x.root.matrixWorld.toArray()).toEqual(x.matrix); expect(x.root.rotation.toArray().slice(0, 3)).toEqual(x.rotation); });
}

function assertTelevisionFurnitureClear(f:Fixture,id:number) {
  const sofa=f.scene.getObjectByName('sofa-main');expect(sofa).toBeDefined();
  const furniture:THREE.Mesh[]=[];sofa!.traverse(object=>{if(object instanceof THREE.Mesh)furniture.push(object);});
  for(const name of ['body','left-arm','right-arm','left-leg','right-leg']){const part=actor(f,id).getObjectByName(name)!;const volume=new THREE.Box3().setFromObject(part,true);for(const surface of furniture){const bounds=new THREE.Box3().setFromObject(surface,true);if(!volume.intersectsBox(bounds)||surface.name==='sofa-main-seat'&&volume.min.y>=bounds.max.y-.006)continue;const hit=exactTriangleCrossing(surface,part);if(hit)throw new Error('TV_REAL_CONTACT_DIAG '+JSON.stringify({id,name,hit,p:actor(f,id).position.toArray(),journey:actor(f,id).userData.homeJourney,contact:actor(f,id).userData.contactCollision,partBounds:[volume.min.toArray(),volume.max.toArray()],surfaceBounds:[bounds.min.toArray(),bounds.max.toArray()],meshes:(()=>{const rows:Array<{name:string;type:string;min:number[];max:number[]}>=[];part.traverse(o=>{if(o instanceof THREE.Mesh){const b=new THREE.Box3().setFromObject(o,true);if(b.intersectsBox(bounds))rows.push({name:o.name,type:o.geometry.type,min:b.min.toArray(),max:b.max.toArray()});}});return rows;})()}));}}
}

function nineCompanionCrowd(): Gathering {
    const makeSpec=(kind:string,seed:number)=>({version:1,kind,body:['#f1eadb','#86b293','#b79ccd'][seed%3],accent:'#d9bf91',detail:'#4b4853',seed,source:'procedural_existing_features'});
    const group=parseGathering({id:'synthetic-unified',title:'免费立体生活场景验证',scene_type:'home',revision:1,closed:false,is_manager:true,me:'A',invitation:null,members:[{id:'A',name:'合成A',manager:true},{id:'B',name:'合成B',manager:false}],
      companions:Array.from({length:9},(_,i)=>({id:i+1,name:'合成伙伴'+(i+1),owner_id:'A',x:.15+(i%3)*.35,y:.15+Math.floor(i/3)*.35,activity:i===0?'sleep':i===8?'walk':'observe',area:i===0?'bedroom':'outdoor',avatar3d:makeSpec(['cup','plant','bouquet','fruit','garment','creature'][i%6],i)})),
      items:[{id:'saved-tree',kind:'tree',x:.15,y:.22,mine:true,contributor_name:'合成',growth_status:null},{id:'saved-bench',kind:'bench',x:.75,y:.65,mine:true,contributor_name:'合成',growth_status:null}],votes:[],stories:[],goal:null,story_enabled:false,season:{current_season:'summer'},events:[]})!;
    return group;
}

describe('actual persistent living world engine with service-authoritative leisure', () => {
  it('clears an obsolete pedestrian passing plan when a journey takes ownership without relaxing its swept body guard', () => {
    const traffic = createLivingPedestrianTraffic();
    const initial = traffic.step([
      { id: 1, region: 'home', position: { x: -.95, z: 0 }, desired: { x: 2, z: 0 }, radius: .9, walking: true, speed: 1, heading: { x: 1, z: 0 }, canTraverse: () => true },
      { id: 2, region: 'home', position: { x: .95, z: 0 }, desired: { x: -2, z: 0 }, radius: .9, walking: true, speed: 1, heading: { x: -1, z: 0 }, canTraverse: () => true },
    ], .1);
    expect(initial.get(2)!.yielded).toBe(true); expect(Math.abs(initial.get(2)!.position.z)).toBeGreaterThan(0);
    let positions = [initial.get(1)!.position, initial.get(2)!.position], forwardSteps = 0;
    for (let frame = 0; frame < 10; frame++) {
      const before = positions.map(point => ({ ...point }));
      const accepted = traffic.step(before.map((position, index) => ({ id: index + 1, region: 'home', position, desired: { x: position.x + .1, z: position.z },
        radius: .9, walking: true, speed: 1, managedRoute: true, heading: { x: 1, z: 0 },
        canTraverse: (from: NavPoint, to: NavPoint) => Math.abs(to.z - from.z) < 1e-8 && to.x >= from.x })), .1);
      positions = [accepted.get(1)!.position, accepted.get(2)!.position]; if (accepted.get(1)!.moving) forwardSteps++;
      for (let sample = 0; sample <= 20; sample++) {
        const t = sample / 20, points = positions.map((point, index) => ({ x: before[index].x + (point.x - before[index].x) * t, z: before[index].z + (point.z - before[index].z) * t }));
        expect(Math.hypot(points[0].x - points[1].x, points[0].z - points[1].z)).toBeGreaterThanOrEqual(1.835 - 1e-7);
      }
    }
    expect(forwardSteps).toBeGreaterThan(0); expect(positions[1].z).toBe(initial.get(2)!.position.z);
  });
  it('pure controller rejects a tempting bay on the other remaining route and clears a tight counterflow without changing either goal', () => {
    const graph = createLivingNavigation({ bounds: { minX: -6, maxX: 6, minZ: -2, maxZ: 5 }, blocked: [
      { minX: -6, maxX: 6, minZ: -2, maxZ: -1.05 }, { minX: -1, maxX: 6, minZ: 1.05, maxZ: 5 },
    ], clearance: .9, step: .16 });
    const controller = createHomeJourneyController(), traffic = createLivingPedestrianTraffic(), distance = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
    const pose = (x: number, z: number): JourneyPose => ({ x, z, y: 0, yaw: 0, tilt: 0, scale: 1, area: 'outdoor', contact: null });
    let corridorProtected = false, bayUsed = 0;
    const context: JourneyContext = { radius: .9, revision: 1, recoverYieldingRoute: true, coordinateContacts: true, doorOpen: () => true, portalClear: () => true,
      isClear: (from, to) => graph.isSegmentClear(from, to), plan: (from, to, _area, avoid) => graph.planTo({ from, to, id: 1, avoid }),
      yieldPlan: (from, _area, avoid, keepFree) => {
        const tempting = { x: from.x < 0 ? -2 : 2, z: 0 }, safeBay = { x: -4, z: 3 };
        if (keepFree.some(peer => distance(tempting, peer.position) < .9 + peer.radius + .035)) corridorProtected = true;
        for (const to of [tempting, safeBay]) {
          if ([...avoid, ...keepFree].some(peer => distance(to, peer.position) < .9 + peer.radius + .035)) continue;
          const route = graph.planTo({ from, to, id: 1, avoid }); if (route.blocked) continue; bayUsed++; return route;
        } return null;
      } };
    for (const [id, actual, goal] of [[4, pose(-1, 0), pose(4.5, 0)], [5, pose(1, 0), pose(-4.5, 0)]] as const) {
      controller.reconcile(id, { key: 'initial-' + id, pose: actual, approach: actual }, actual);
      controller.reconcile(id, { key: 'original-' + id, pose: goal, approach: goal }, actual);
    }
    for (let frame = 0; frame < 900 && (controller.get(4)!.active || controller.get(5)!.active); frame++) {
      const proposals = new Map<number, JourneyProposal>(), before = [controller.get(4)!.pose, controller.get(5)!.pose];
      for (const id of [4, 5]) { const proposal = controller.prepare(id, .1, { ...context, yaw: controller.get(id)!.pose.yaw }); if (proposal) proposals.set(id, proposal); }
      const accepted = traffic.step([4, 5].map(id => { const current = controller.get(id)!.pose, proposal = proposals.get(id); return { id, region: 'home', position: current,
        desired: proposal?.desired ?? current, radius: .9, walking: !!proposal && distance(proposal.position, proposal.desired) > 1e-7, speed: proposal?.speed ?? 0,
        heading: proposal ? { x: Math.sin(proposal.yaw), z: Math.cos(proposal.yaw) } : undefined, canTraverse: proposal?.canTraverse ?? (() => false) }; }), .1);
      for (const id of [4, 5]) if (proposals.has(id)) controller.commit(id, accepted.get(id)!.position, .1);
      for (let part = 0; part <= 20; part++) {
        const after = [controller.get(4)!.pose, controller.get(5)!.pose], a = { x: before[0].x + (after[0].x - before[0].x) * part / 20, z: before[0].z + (after[0].z - before[0].z) * part / 20 },
          b = { x: before[1].x + (after[1].x - before[1].x) * part / 20, z: before[1].z + (after[1].z - before[1].z) * part / 20 };
        expect(distance(a, b)).toBeGreaterThanOrEqual(1.8 - 1e-6);
      }
    }
    expect(corridorProtected).toBe(true); expect(bayUsed).toBeGreaterThan(0);
    expect(controller.get(4)).toMatchObject({ active: false, targetKey: 'original-4', pose: { x: 4.5, z: 0 } });
    expect(controller.get(5)).toMatchObject({ active: false, targetKey: 'original-5', pose: { x: -4.5, z: 0 } });
  });
  it('rejects the actual tea seat blocked by an existing flipped bench without sending intent or moving saved furniture', () => {
    const group = snapshot('home'); group.items = group.items.map(item => item.id === 'existing-bench' ? { ...item, x: .76, y: .7 } : item);
    const f = setup(group), original = existingItems(f), tea = f.world.getLeisureSeats().find(seat => seat.id === 'tea-1');
    expect(tea).toBeDefined(); expect(tea!.available).toBe(false);
    const bench = collectHomeNavigationObstacles(f.scene, null).find(o => o.source === 'home-realistic-item-bench'); expect(bench).toBeDefined();
    const gap = Math.hypot(Math.max(bench!.minX - tea!.x, 0, tea!.x - bench!.maxX), Math.max(bench!.minZ - tea!.z, 0, tea!.z - bench!.maxZ));
    expect(gap).toBeLessThan(actor(f).userData.navigationClearance);
    expect(f.world.startLocalLeisure('tea', OWN)).toBe(false); expect(f.requested).not.toHaveBeenCalled(); expect(f.world.getLocalLeisure().assignments).toEqual([]); original();
  });
  for (const kind of ['home', 'forest', 'desert'] as const) {
    it(kind + ' excludes stored furniture and its bench seat, then restores its original transform and flip when unstored', () => {
      const group = snapshot(kind); group.items = group.items.map(item => item.id === 'existing-bench' ? { ...item, stored: true } : item);
      const f = setup(group); let hiddenMesh = false; f.scene.traverse(root => { if (root.userData.homeItemId === 'existing-bench') hiddenMesh = true; });
      expect(hiddenMesh).toBe(false); expect(f.world.getLeisureSeats().filter(seat => seat.station === 'bench')).toEqual([]);
      apply(f, { ...group, revision: group.revision + 1, items: group.items.map(item => item.id === 'existing-bench' ? { ...item, stored: false } : item) });
      const restored: THREE.Object3D[] = []; f.scene.traverse(root => { if (root.userData.homeItemId === 'existing-bench') restored.push(root); });
      expect(restored).toHaveLength(1); const item = group.items.find(item => item.id === 'existing-bench')!;
      expect(restored[0].position.x).toBeCloseTo((item.x - .5) * 8, 8);
      expect(restored[0].position.z).toBeCloseTo((item.y - .5) * 5.2 + (kind === 'home' ? 4.1 : 0), 8);
      expect(restored[0].rotation.y).toBeCloseTo(Math.PI); expect(f.world.getLeisureSeats().some(seat => seat.station === 'bench')).toBe(true); expect(f.requested).not.toHaveBeenCalled();
    });
    it(kind + ' renders enhanced real-scope geometry and emits a single owned intent without beginning a local activity', () => {
      const f = setup(snapshot(kind)); expect(f.group.id.startsWith('synthetic-')).toBe(false);
      expect(f.world.getLocalLeisure().scope.persistent).toBe(true); expect(f.world.getLocalLeisure().permitted).toBe(true);
      expect(f.scene.getObjectByName('home-main-entry-door')).toBeDefined(); expect(f.scene.getObjectByName('home-room-connection-door')).toBeDefined();
      if (kind !== 'home') expect(f.host.dataset.naturalIndoor).toBe('true');
      const seat = slot(f, 'tea'), before = actor(f).position.toArray();
      expect(f.world.startLocalLeisure('tea', OWN)).toBe(true);
      expect(f.requested).toHaveBeenCalledExactlyOnceWith({ activity: 'tea', actorId: OWN, seatId: seat.id });
      expect(f.world.getLocalLeisure().assignments).toEqual([]); expect(actor(f).position.toArray()).toEqual(before);
      expect(f.group.companions[0].leisure).toBeUndefined();
    });
    it(kind + ' denies missing callbacks and writes to another owner without changing saved activity or assigning a seat', () => {
      const f = setup(snapshot(kind), { onLeisureRequest: undefined });
      expect(f.world.startLocalLeisure('tea', OWN)).toBe(false); expect(f.world.stopLocalLeisure(OWN)).toBe(false); expect(f.world.getLocalLeisure().assignments).toEqual([]);
      const callback = setup(snapshot(kind));
      expect(callback.world.startLocalLeisure('tea', OTHER)).toBe(false); expect(callback.world.stopLocalLeisure(OTHER)).toBe(false);
      expect(callback.world.startLocalLeisure('tea', 999)).toBe(false); expect(callback.requested).not.toHaveBeenCalled();
      expect(callback.world.getLocalLeisure().assignments).toEqual([]);
    });
    it(kind + ' restores both owners from server seats and does not replay them for identical polls or an unrelated revision', () => {
      const f = setup(snapshot(kind)), first = slot(f, 'tea'), second = slot(f, kind === 'home' ? 'mahjong' : 'tea', kind === 'home' ? 0 : 1);
      apply(f, saved(saved(f.group, OWN, first), OTHER, second)); f.world.setMotion(true);
      until(f, () => seated(f, OWN) && seated(f, OTHER)); step(f);
      const assignments = f.world.getLocalLeisure().assignments.map(a => ({ ...a })), roots = [actor(f), actor(f, OTHER)];
      const cup = f.scene.getObjectByName(first.cupId!); expect(cup).toBeDefined(); const parent = cup!.parent;
      expect(parent).toBe(actor(f).getObjectByName('right-arm'));
      const original = existingItems(f), group = structuredClone(f.group);
      for (let i = 0; i < 3; i++) { step(f, 300); apply(f, { ...structuredClone(group), revision: group.revision + i }); }
      expect(f.world.getLocalLeisure().assignments).toEqual(assignments);
      expect(cup!.parent).toBe(parent); roots.forEach(root => expect(root.userData.homeJourney?.active).not.toBe(true));
      expect(f.requested).not.toHaveBeenCalled(); original();
    }, 60_000);
    it(kind + ' restores an existing saved bench after engine recreation and preserves flipped furniture across updates', () => {
      const f = setup(snapshot(kind)), bench = slot(f, 'bench'); apply(f, saved(f.group, OWN, bench));
      expect(assignment(f)).toMatchObject({ actorId: OWN, seatId: bench.id, activity: 'bench' });
      const savedGroup = structuredClone(f.group), original = existingItems(f); apply(f, structuredClone(savedGroup)); original();
      f.world.dispose();
      const fresh = setup(savedGroup); expect(assignment(fresh)).toMatchObject({ actorId: OWN, seatId: bench.id, activity: 'bench' });
      expect(fresh.requested).not.toHaveBeenCalled(); existingItems(fresh)();
    });
    it(kind + ' retains a pending stop until the service clears it, then returns the cup and saved sleeping actor through real doors', () => {
      const group = snapshot(kind); group.companions = group.companions.filter(c => c.id === OWN).map(c => ({ ...c, activity: 'sleep', area: 'bedroom' }));
      // The separate blocked-egress case retains the saved tree. Here its removal gives an actually clear doorway.
      group.items = group.items.filter(item => item.id !== 'existing-tree');
      const f = setup(group), tea = slot(f, 'tea'); f.world.setMotion(true);
      const bench = f.scene.children.flatMap(root => root.children).find(root => root.userData.homeItemId === 'existing-bench')!;
      expect(bench).toBeDefined(); const benchMatrix = bench.matrixWorld.toArray();
      expect(actor(f).userData.sleepingBed).toBeDefined();
      apply(f, saved(f.group, OWN, tea)); until(f, () => seated(f));
      const cup = f.scene.getObjectByName(tea.cupId!); expect(cup).toBeDefined(); cupContact(f, cup!, 'seated-arrival'); step(f);
      const heldParent = cup!.parent;
      expect(heldParent).toBe(actor(f).getObjectByName('right-arm'));
      expect(cupContact(f, cup!, 'held-100ms').distance).toBeLessThan(1e-7); step(f, 1000); expect(cupContact(f, cup!, 'held-1100ms').distance).toBeLessThan(1e-7);
      expect(f.world.stopLocalLeisure(OWN)).toBe(true); expect(f.requested).toHaveBeenCalledExactlyOnceWith({ activity: null, actorId: OWN });
      expect(assignment(f)?.seatId).toBe(tea.id); expect(cup!.parent).toBe(heldParent);
      apply(f, saved(f.group, OWN, null));
      expect(assignment(f)).toBeUndefined();
      until(f, () => !!actor(f).userData.sleepingBed && !actor(f).userData.homeJourney?.active);
      expect(cup!.parent).not.toBe(heldParent); expect(cup!.parent).not.toBeNull(); expect(f.group.companions[0].activity).toBe('sleep');
      console.info('PERSISTENT_CUP_BINDING ' + JSON.stringify({ scene: kind, cup: cup!.name, heldParent: heldParent?.name, wasRightArm: heldParent === actor(f).getObjectByName('right-arm'), restoredParent: cup!.parent?.name, gripError: cup!.userData.gripError }));
      expect(f.doorChanged.mock.calls.some(call => call[0] === 'home-main-entry-door' && call[1] === true && call[2] === 'companion')).toBe(true);
      expect(f.doorChanged.mock.calls.some(call => call[0] === 'home-room-connection-door' && call[1] === true && call[2] === 'companion')).toBe(true);
      expect(bench.matrixWorld.toArray()).toEqual(benchMatrix); expect(bench.rotation.y).toBeCloseTo(Math.PI);
    }, 60_000);
  }

  for (const kind of ['home', 'forest'] as const) it(kind + ' retains its saved tree and either passes safely or waits at a genuinely blocked exit', () => {
    const group = snapshot(kind); group.companions = group.companions.filter(c => c.id === OWN).map(c => ({ ...c, activity: 'sleep', area: 'bedroom' }));
    const f = setup(group), tea = slot(f, 'tea'), original = existingItems(f); apply(f, saved(f.group, OWN, tea)); f.world.setMotion(true);
    if(kind==='home'){
      const treeSolids=collectHomeJourneyObstacles(f.scene,null).filter(o=>o.source.startsWith('home-item-tree')).map(o=>f.scene.getObjectByName(o.source)!).filter(Boolean);
      for(let i=0;i<1300;i++){step(f);for(const solid of treeSolids)for(const name of ['body','left-arm','right-arm','left-leg','right-leg']){const part=actor(f).getObjectByName(name)!;if(trianglePenetration(solid,new THREE.Box3().setFromObject(part,true)))expect(exactTriangleCrossing(solid,part),'tree mesh must remain solid').toBeFalsy();}if(actor(f).userData.roomRestSeat?.seatId===tea.id&&!actor(f).userData.homeJourney?.active)break;}
      expect(actor(f).userData.roomRestSeat?.seatId).toBe(tea.id);expect(actor(f).userData.homeJourney?.active??false).toBe(false);expect(f.requested).not.toHaveBeenCalled();original();return;
    }
    for (let i = 0; i < 1300; i++) step(f);
    expect(['blocked', 'wait-door']).toContain(actor(f).userData.homeJourney?.phase);
    expect(f.scene.getObjectByName('home-main-entry-door')!.userData.homeDoorOpenness).toBe(1);
    const obstacles = collectNaturalNavigationObstacles(f.scene, null), root = actor(f), p = root.position;
    const blocked = obstacles.filter(o => o.source.startsWith('home-item-tree')).map(o => ({ ...o, gap: Math.hypot(Math.max(o.minX - p.x, 0, p.x - o.maxX), Math.max(o.minZ - p.z, 0, p.z - o.maxZ)) })).sort((a, b) => a.gap - b.gap)[0];
    expect(blocked).toBeDefined(); expect(blocked.gap).toBeLessThan(root.userData.navigationClearance);
    const body = new THREE.Box3().setFromObject(root, true), treeSurface = f.scene.getObjectByName(blocked.source); expect(treeSurface).toBeDefined();
    expect(body.intersectsBox(new THREE.Box3().setFromObject(treeSurface!, true))).toBe(false);
    expect(assignment(f)?.seatId).toBe(tea.id); expect(f.requested).not.toHaveBeenCalled(); original();
  }, 60_000);

  it('defaults to only one owned Mahjong intent and never locally recruits the other owner or auto-starts four players', () => {
    const f = setup(snapshot('home')); expect(f.world.toggleLocalLeisure('mahjong')).toBe(true);
    expect(f.requested).toHaveBeenCalledTimes(1); expect(f.requested.mock.calls[0][0]).toMatchObject({ activity: 'mahjong', actorId: OWN });
    expect(f.world.getLocalLeisure().assignments).toEqual([]); expect(f.world.getLocalMahjong()?.status).not.toBe('playing');
  });
  it('home dynamically seats four real cup and plant bodies at all four Mahjong chairs when the physical approaches are clear', () => {
    const group = snapshot('home'); group.items = [];
    group.companions = [OWN, OTHER, 403, 404].map((id, index) => ({ ...structuredClone(group.companions[index % 2]), id, x: .2 + index * .2, y: .76 }));
    const f = setup(group), seats = slots(f, 'mahjong'); expect(seats, 'all four physical chairs require usable standing and real-rig contact approaches').toHaveLength(4);
    let next = group; group.companions.forEach((companion, index) => { next = saved(next, companion.id, seats[index]); }); apply(f, next); f.world.setMotion(true);
    const arrivals = new Map<number, number>(); let elapsedSteps = 0;
    until(f, () => { elapsedSteps++; group.companions.forEach(companion => { if (seated(f, companion.id) && !arrivals.has(companion.id)) arrivals.set(companion.id, elapsedSteps / 10); });
      if (elapsedSteps % 100 === 0) console.info('PERSISTENT_FOUR_PROGRESS ' + JSON.stringify({ seconds: elapsedSteps / 10, actors: group.companions.map(companion => {
        const root = actor(f, companion.id), navigation = root.userData.homeJourneyNavigation; return { id: companion.id, position: root.position.toArray(), phase: root.userData.homeJourney?.phase ?? 'seated', stage: navigation?.stage, goal: navigation?.stages?.[navigation.stage]?.goal, waited: navigation?.waited };
      }) })); return group.companions.every(companion => seated(f, companion.id)); });
    for (let frame = 0; frame < 30; frame++) step(f);
    expect(f.world.getLocalLeisure().assignments).toHaveLength(4); expect(f.requested).not.toHaveBeenCalled();
    expect(f.world.getLeisureSeats().filter(seat => seat.station === 'mahjong').map(seat => [seat.x, seat.z])).toEqual(seats.map(seat => [seat.x, seat.z]));
    console.info('PERSISTENT_FOUR_MAHJONG_ARRIVALS ' + JSON.stringify({ arrivals: [...arrivals], final: group.companions.map(companion => ({ id: companion.id, position: actor(f, companion.id).position.toArray() })) }));
    apply(f, saved(f.group, OWN, null)); let previous = actor(f).position.clone();
    until(f, () => { const current = actor(f).position.clone(); expect(current.distanceTo(previous), 'leaving a real chair remains continuous').toBeLessThan(.2); previous = current; return !actor(f).userData.homeJourney?.active && !actor(f).userData.roomRestSeat; });
    group.companions.filter(companion => companion.id !== OWN).forEach(companion => expect(seated(f, companion.id)).toBe(true)); expect(f.requested).not.toHaveBeenCalled();
  }, 60_000);
  it('accepts service-selected home television and Mahjong seats without generating local intent', () => {
    const f = setup(snapshot('home')), television = slot(f, 'television'), mahjong = slot(f, 'mahjong');
    apply(f, saved(saved(f.group, OWN, television), OTHER, mahjong));
    expect(f.world.getLocalLeisure().assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: OWN, activity: 'television', seatId: television.id }),
      expect.objectContaining({ actorId: OTHER, activity: 'mahjong', seatId: mahjong.id }),
    ])); expect(f.requested).not.toHaveBeenCalled();
  });
  it('clears held props and old assignments on owner, group and scene changes and requires a new owned intent', () => {
    const f = setup(snapshot('forest')), tea = slot(f, 'tea'); apply(f, saved(f.group, OWN, tea)); f.world.setMotion(true); until(f, () => seated(f)); step(f);
    const cup = f.scene.getObjectByName(tea.cupId!)!, parent = cup.parent;
    expect(parent).toBe(actor(f).getObjectByName('right-arm'));
    const ownerSwitch = { ...saved(f.group, OWN, null), me: 'owner-b' }; apply(f, ownerSwitch);
    expect(f.world.getLocalLeisure().assignments).toEqual([]); expect(cup.parent).not.toBe(parent);
    expect(f.world.startLocalLeisure('tea', OWN)).toBe(false); expect(f.world.startLocalLeisure('tea', OTHER)).toBe(true);
    expect(f.requested.mock.calls.at(-1)![0].actorId).toBe(OTHER);
    apply(f, { ...snapshot('forest'), id: '38e5b7cb-3d0a-4967-acb7-1ba9b41666f6' }); expect(f.world.getLocalLeisure().assignments).toEqual([]);
    apply(f, snapshot('desert')); expect(f.world.getLocalLeisure().assignments).toEqual([]);
    expect(f.scene.getObjectByName('natural-forest-teacup-0')).toBeUndefined(); expect(f.scene.getObjectByName('natural-desert-teacup-0')).toBeDefined();
  }, 60_000);
  it('keeps invalid member scopes and a closed service snapshot read-only with no local leisure fallback', () => {
    for (const change of [(g: Gathering) => ({ ...g, members: g.members.filter(m => m.id !== g.me) }), (g: Gathering) => ({ ...g, closed: true })]) {
      const f = setup(change(snapshot('forest'))); expect(f.world.startLocalLeisure('tea', OWN)).toBe(false); expect(f.requested).not.toHaveBeenCalled(); expect(f.world.getLocalLeisure().assignments).toEqual([]);
    }
  });
  it('never emits a persistent activity or stop intent after the actual world has been disposed', () => {
    const f = setup(snapshot('home')); f.world.dispose();
    expect(f.world.startLocalLeisure('tea', OWN)).toBe(false); expect(f.world.stopLocalLeisure(OWN)).toBe(false);
    expect(f.world.toggleLocalLeisure('mahjong')).toBe(false); expect(f.requested).not.toHaveBeenCalled(); expect(f.labels.children).toHaveLength(0);
  });
  it('keeps the original nine-companion crowd continuous: twenty seconds of walking then sixty seconds with a safe observer courtesy and a complete second television dock', () => {
    const group=nineCompanionCrowd();
    const unchanged=JSON.stringify(group),presence=vi.fn(),f=setup(group,{persistentWorld:false,onLeisureRequest:undefined,strictLeisureContacts:true,onJourneyChange:presence,
      initialLeisure:[{activity:'tea',actorIds:[2,3]},{activity:'television',actorIds:[4]},{activity:'mahjong',actorIds:[5,6,7,8]}]});
    const observers=[2,3,5,6,7,8],standing=new Map(observers.map(id=>[id,actor(f,id).position.clone()]));
    const firstTelevision=f.world.getLocalLeisure().assignments.find(a=>a.actorId===4)!;expect(firstTelevision.activity).toBe('television');
    const bounds=(id:number)=>{const result=new THREE.Box3(),root=actor(f,id);for(const name of ['body','left-arm','right-arm','left-leg','right-leg']){const part=root.getObjectByName(name);expect(part).toBeDefined();result.union(new THREE.Box3().setFromObject(part!,true));}return result;};
    const originalGeometry=collectHomeJourneyObstacles(f.scene,null),observerGraph=createLivingNavigation({bounds:homeNavigationBounds('outdoor'),blocked:originalGeometry,clearance:Number(actor(f,2).userData.navigationClearance),step:.08});
    let previousObserver=actor(f,2).position.clone(),previousPosition=actor(f,9).position.clone(),previousBoxes=new Map(group.companions.map(c=>[c.id,bounds(c.id)])),stillFrames=0;
    const trace:Array<{frame:number;x:number;z:number;moving:boolean;stride:number[]}>=[];f.world.setMotion(true);
    for(let frame=0;frame<=800;frame++){
      if(frame)step(f);
      if(frame===200){expect(f.world.startLocalLeisure('television',9)).toBe(true);const seats=f.world.getLocalLeisure().assignments.filter(a=>a.activity==='television');expect(seats.map(a=>a.actorId).sort((a,b)=>a-b)).toEqual([4,9]);expect(seats.find(a=>a.actorId===9)!.seatId).not.toBe(firstTelevision.seatId);}
      const root=actor(f,9),position=root.position.clone(),horizontal=Math.hypot(position.x-previousPosition.x,position.z-previousPosition.z);
      expect(position.distanceTo(previousPosition),'walker and requested journey never teleport').toBeLessThan(.2);previousPosition=position;
      const currentObserver=actor(f,2).position.clone();expect(currentObserver.distanceTo(previousObserver),'courtesy is continuous walking').toBeLessThan(.2);expect(observerGraph.isSegmentClear({x:previousObserver.x,z:previousObserver.z},{x:currentObserver.x,z:currentObserver.z}),'courtesy swept original body radius clears every real static obstacle').toBe(true);previousObserver=currentObserver;
      for(const id of observers.filter(id=>id!==2||frame<=200))expect(actor(f,id).position.distanceTo(standing.get(id)!),'opening a door must not respawn unrelated observers').toBeLessThan(1e-8);

      const currentBoxes=new Map(group.companions.map(c=>[c.id,bounds(c.id)]));
      for(const movingId of [2,9]){const moving=currentBoxes.get(movingId)!.clone().union(previousBoxes.get(movingId)!);for(const c of group.companions.filter(c=>c.id!==movingId))expect(moving.intersectsBox(currentBoxes.get(c.id)!.clone().union(previousBoxes.get(c.id)!)),'actual body and limb swept boxes remain separated: '+movingId+' vs '+c.id).toBe(false);}
      previousBoxes=currentBoxes;const moving=!!root.userData.homeNavigation?.moving,stride=['left-leg','right-leg'].map(name=>root.getObjectByName(name)!.rotation.x);
      stillFrames=horizontal<1e-7&&!moving?stillFrames+1:0;if(stillFrames>=20&&!root.userData.roomRestSeat){expect(Math.max(...stride.map(Math.abs)),'stopped bodies cannot keep stepping').toBeLessThan(1e-4);expect(Math.abs(position.y),'stopped bodies cannot keep walking bob').toBeLessThan(.001);}
      trace.push({frame,x:position.x,z:position.z,moving,stride});
      if(frame>200&&root.userData.homeRegion==='indoor')assertTelevisionFurnitureClear(f,9);
    }
    const reversals=(rows:typeof trace)=>rows.slice(2).filter((r,i)=>{const a=rows[i],b=rows[i+1],dx=r.x-b.x,dz=r.z-b.z,px=b.x-a.x,pz=b.z-a.z;return Math.hypot(dx,dz)>.005&&Math.hypot(px,pz)>.005&&dx*px+dz*pz<-.5*Math.hypot(dx,dz)*Math.hypot(px,pz);}).length;
    expect(reversals(trace.slice(0,200)),'ordinary walking must not shuttle over centimetres').toBe(0);expect(reversals(trace.slice(200)),'a requested television journey must not alternate tiny waiting bays').toBe(0);
    expect(trace.slice(650).every(row=>!row.moving),'the reached television seat stays settled').toBe(true);
    const last=actor(f,9);expect(seated(f,9),'the actual requested second seat completes its real dock').toBe(true);expect(last.userData.roomRestSeat.seatId).toBe('television-1');
    expect(actor(f,2).userData.homeIdleYield).toMatchObject({requester:0,requestKey:'completed',area:'outdoor'});expect(actor(f,2).position.distanceTo(standing.get(2)!)).toBeGreaterThan(.5);expect(actor(f,2).userData.homeJourney?.active).not.toBe(true);
    const held=actor(f,2).userData.homeIdleYield.target;expect(actor(f,2).position.x).toBeCloseTo(held.x,7);expect(actor(f,2).position.z).toBeCloseTo(held.z,7);
    expect(presence.mock.calls.at(-1)![0].actors.find((a:{id:number})=>a.id===9)).toMatchObject({phase:'idle',active:false,area:'indoor'});
    expect(f.world.getLocalLeisure().assignments.find(a=>a.actorId===4)).toEqual(firstTelevision);expect(JSON.stringify(group)).toBe(unchanged);expect(f.requested).not.toHaveBeenCalled();
  },60000);

  it('keeps the paid-free television request honestly blocked when a real saved tree fills the only safe side bay',()=>{
    const group=nineCompanionCrowd();group.items.push({id:'no-side-tree',kind:'tree',x:.69375,y:.02,mine:true,contributor_name:'合成',growth_status:null});
    const original=JSON.stringify(group),f=setup(group,{persistentWorld:false,onLeisureRequest:undefined,strictLeisureContacts:true,initialLeisure:[{activity:'television',actorIds:[4]}]});
    const observer=actor(f,2).position.clone();f.world.setMotion(true);expect(f.world.startLocalLeisure('television',9)).toBe(true);
    let last=actor(f,9).position.clone();for(let index=0;index<160;index++){step(f);const current=actor(f,9).position.clone();expect(current.distanceTo(last)).toBeLessThan(.2);last=current;}
    expect(actor(f,2).position.distanceTo(observer),'no nonexistent side bay can be assigned').toBeLessThan(1e-8);expect(actor(f,2).userData.homeIdleYield).toBeUndefined();
    expect(actor(f,9).userData.homeJourney).toMatchObject({active:true,phase:'blocked',waitingForClearance:true});expect(actor(f,9).userData.roomRestSeat).toBeUndefined();
    expect(actor(f,2).userData.homeIdleYieldAttempt?.route).toBeNull();expect(JSON.stringify(group)).toBe(original);expect(f.requested).not.toHaveBeenCalled();
  },30000);

  it('freezes an actual courtesy while paused or hidden and stops it at its real position when the requesting activity is cancelled',()=>{
    const group=nineCompanionCrowd(),original=JSON.stringify(group),f=setup(group,{persistentWorld:false,onLeisureRequest:undefined,strictLeisureContacts:true,initialLeisure:[{activity:'television',actorIds:[4]}]});
    const observed=actor(f,2).position.clone(),television4=f.world.getLocalLeisure().assignments.find(a=>a.actorId===4);f.world.setMotion(true);expect(f.world.startLocalLeisure('television',9)).toBe(true);
    until(f,()=>!!actor(f,2).userData.homeIdleYield&&actor(f,2).position.distanceTo(observed)>.2,100);
    f.world.setMotion(false);const positions=new Map(group.companions.map(c=>[c.id,actor(f,c.id).position.clone()]));vi.setSystemTime(Date.now()+5000);f.world.update(group,null);
    for(const id of [2,9])expect(actor(f,id).position.distanceTo(positions.get(id)!),'paused routes retain exact actual positions').toBeLessThan(1e-8);
    const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(true);f.world.setMotion(true);for(let i=0;i<10;i++)step(f);for(const id of [2,9])expect(actor(f,id).position.distanceTo(positions.get(id)!),'hidden routes retain exact actual positions').toBeLessThan(1e-8);hidden.mockReturnValue(false);
    const cancelled=actor(f,2).position.clone();expect(f.world.stopLocalLeisure(9)).toBe(true);for(let i=0;i<20;i++)step(f);
    expect(Math.hypot(actor(f,2).position.x-cancelled.x,actor(f,2).position.z-cancelled.z),'cancellation does not finish the old bay route or bounce home').toBeLessThan(1e-7);expect(Math.abs(actor(f,2).position.y),'a stopped step settles to the original floor').toBeLessThan(.001);expect(actor(f,2).userData.homeIdleYield).toMatchObject({requester:0,requestKey:'cancelled'});expect(f.world.getLocalLeisure().assignments.find(a=>a.actorId===4)).toEqual(television4);
    expect(JSON.stringify(group)).toBe(original);f.world.update({...group,id:'synthetic-next-owner',me:'B',scene_type:'forest'},null);for(const c of group.companions)expect(actor(f,c.id).userData.homeIdleYield,'a scope/owner/scene switch releases old courtesy state').toBeUndefined();expect(f.requested).not.toHaveBeenCalled();
  },30000);

  it('renews a cancelled courtesy twice from the actual standing point and releases its lease after the final television dock',()=>{
    const group=nineCompanionCrowd(),original=JSON.stringify(group),f=setup(group,{persistentWorld:false,onLeisureRequest:undefined,strictLeisureContacts:true,initialLeisure:[{activity:'television',actorIds:[4]}]});
    const television4=f.world.getLocalLeisure().assignments.find(a=>a.actorId===4),initial=actor(f,2).position.clone();
    const physicalBounds=(id:number)=>{const box=new THREE.Box3(),root=actor(f,id);for(const name of ['body','left-arm','right-arm','left-leg','right-leg'])box.union(new THREE.Box3().setFromObject(root.getObjectByName(name)!,true));return box;};
    const graph=createLivingNavigation({bounds:homeNavigationBounds('outdoor'),blocked:collectHomeJourneyObstacles(f.scene,null),clearance:Number(actor(f,2).userData.navigationClearance),step:.08});
    const advance=()=>{const before=new Map(group.companions.map(c=>[c.id,physicalBounds(c.id)])),positions=new Map([2,9].map(id=>[id,actor(f,id).position.clone()]));step(f);
      const after=new Map(group.companions.map(c=>[c.id,physicalBounds(c.id)]));
      for(const id of [2,9]){expect(actor(f,id).position.distanceTo(positions.get(id)!),'renewal never teleports').toBeLessThan(.2);for(const peer of group.companions.filter(c=>c.id!==id))expect(before.get(id)!.clone().union(after.get(id)!).intersectsBox(before.get(peer.id)!.clone().union(after.get(peer.id)!)),'renewal swept bodies stay separated: '+id+' / '+peer.id).toBe(false);}
      const from=positions.get(2)!,to=actor(f,2).position;expect(graph.isSegmentClear(from,to),'renewed observer route clears saved furniture').toBe(true);
      if(actor(f,9).userData.homeRegion==='indoor')assertTelevisionFurnitureClear(f,9);
    };
    const reach=(predicate:()=>boolean,limit:number)=>{for(let i=0;i<limit&&!predicate();i++)advance();expect(predicate(),'renewed physical journey reaches its required phase').toBe(true);};
    f.world.setMotion(true);
    for(let cycle=0;cycle<2;cycle++){
      const from=actor(f,2).position.clone();expect(f.world.startLocalLeisure('television',9)).toBe(true);
      reach(()=>actor(f,2).userData.homeIdleYield?.requester===9&&actor(f,2).position.distanceTo(from)>.12,160);
      const stopped=actor(f,2).position.clone();expect(f.world.stopLocalLeisure(9)).toBe(true);
      for(let i=0;i<20;i++)advance();
      expect(actor(f,2).userData.homeIdleYield).toMatchObject({requester:0,requestKey:'cancelled'});
      expect(Math.hypot(actor(f,2).position.x-stopped.x,actor(f,2).position.z-stopped.z)).toBeLessThan(1e-7);
      expect(actor(f,2).position.distanceTo(initial)).toBeGreaterThan(.1);
    }
    expect(f.world.startLocalLeisure('television',9)).toBe(true);
    reach(()=>seated(f,9),600);for(let i=0;i<30;i++)advance();
    expect(actor(f,2).userData.homeIdleYield).toMatchObject({requester:0,requestKey:'completed'});
    const parked=actor(f,2).position.clone();for(let i=0;i<100;i++)advance();
    expect(actor(f,2).position.distanceTo(parked),'completed request keeps the actual bay without repeated shuffling').toBeLessThan(1e-7);
    expect(f.world.getLocalLeisure().assignments.find(a=>a.actorId===4)).toEqual(television4);
    expect(JSON.stringify(group)).toBe(original);expect(f.requested).not.toHaveBeenCalled();
  },60000);


  for(const kind of ['forest','desert'] as const)it(kind+' clears an actual cabin entry with a continuous observer courtesy and preserves saved furniture',()=>{
    const group=snapshot(kind);group.items=group.items.map(i=>i.id==='existing-tree'?{...i,x:.95,y:.95}:i);group.companions=group.companions.map((c,i)=>({...c,x:i?0:.5}));
    const f=setup(group),original=JSON.stringify(group),itemsUnchanged=existingItems(f),initial=actor(f,OTHER).position.clone();
    const body=(id:number)=>{const box=new THREE.Box3();for(const name of ['body','left-arm','right-arm','left-leg','right-leg'])box.union(new THREE.Box3().setFromObject(actor(f,id).getObjectByName(name)!,true));return box;};
    const graph=createLivingNavigation({bounds:{minX:kind==='forest'?-7:-8,maxX:7,minZ:-5.8,maxZ:5.8},blocked:collectNaturalNavigationObstacles(f.scene,null),clearance:Number(actor(f,OTHER).userData.navigationClearance),step:.08});
    let positions=new Map(group.companions.map(c=>[c.id,actor(f,c.id).position.clone()])),boxes=new Map(group.companions.map(c=>[c.id,body(c.id)])),yielded=false;
    apply(f,{...f.group,revision:2,companions:f.group.companions.map(c=>c.id===OWN?{...c,activity:'rest',area:'indoor'}:c)});f.world.setMotion(true);
    for(let i=0;i<500;i++){
      step(f);const nextBoxes=new Map(group.companions.map(c=>[c.id,body(c.id)]));
      for(const id of [OWN,OTHER])expect(actor(f,id).position.distanceTo(positions.get(id)!),'natural courtesy has no position jumps').toBeLessThan(.2);
      expect(boxes.get(OWN)!.clone().union(nextBoxes.get(OWN)!).intersectsBox(boxes.get(OTHER)!.clone().union(nextBoxes.get(OTHER)!)),'actual body and limbs stay separated during entry').toBe(false);
      expect(graph.isSegmentClear(positions.get(OTHER)!,actor(f,OTHER).position),'observer respects original natural furniture geometry').toBe(true);
      yielded ||= !!actor(f,OTHER).userData.homeIdleYield;
      positions=new Map(group.companions.map(c=>[c.id,actor(f,c.id).position.clone()]));boxes=nextBoxes;
    }
    expect(yielded).toBe(true);expect(actor(f,OTHER).position.distanceTo(initial)).toBeGreaterThan(.5);
    expect(actor(f,OTHER).userData.homeIdleYield).toMatchObject({requester:0,requestKey:'completed',area:'outdoor'});
    expect(actor(f,OWN).userData.roomRestSeat).toBeDefined();expect(actor(f,OWN).userData.homeRegion).toBe('indoor');
    expect(f.doorChanged.mock.calls.some(call=>call[0]==='home-main-entry-door'&&call[1]===true&&call[2]==='companion')).toBe(true);
    const settled=actor(f,OTHER).position.clone(),facing=actor(f,OTHER).rotation.y;for(let i=0;i<80;i++){step(f);expect(actor(f,OTHER).position.distanceTo(settled)).toBeLessThan(1e-7);expect(Math.abs(actor(f,OTHER).rotation.y-facing),'idle facing never accumulates a spin').toBeLessThan(.13);}
    itemsUnchanged();expect(JSON.stringify(group)).toBe(original);expect(f.requested).not.toHaveBeenCalled();
  },60000);

  for(const kind of ['forest','desert'] as const)it(kind+' freezes and cancels an ongoing observer courtesy without resetting its floor position',()=>{
    const group=snapshot(kind);group.items=group.items.map(i=>i.id==='existing-tree'?{...i,x:.95,y:.95}:i);group.companions=group.companions.map((c,i)=>({...c,x:i?0:.5}));
    const f=setup(group),initial=actor(f,OTHER).position.clone(),original=JSON.stringify(group),unchanged=existingItems(f);
    const resting=()=>({...f.group,revision:f.group.revision+1,companions:f.group.companions.map(c=>c.id===OWN?{...c,activity:'rest' as const,area:'indoor' as const}:c)});
    apply(f,resting());f.world.setMotion(true);until(f,()=>!!actor(f,OTHER).userData.homeIdleYield&&actor(f,OTHER).position.distanceTo(initial)>.15,200);
    const paused=actor(f,OTHER).position.clone();f.world.setMotion(false);vi.setSystemTime(Date.now()+1000);f.world.update(f.group,null);expect(actor(f,OTHER).position.distanceTo(paused)).toBeLessThan(1e-8);
    const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(true);f.world.setMotion(true);vi.setSystemTime(Date.now()+1000);f.world.update(f.group,null);expect(actor(f,OTHER).position.distanceTo(paused)).toBeLessThan(1e-8);hidden.mockReturnValue(false);
    apply(f,{...f.group,revision:f.group.revision+1,companions:f.group.companions.map(c=>c.id===OWN?{...c,activity:'observe',area:'outdoor'}:c)});for(let i=0;i<20;i++)step(f);
    expect(actor(f,OTHER).userData.homeIdleYield).toMatchObject({requester:0,requestKey:'cancelled'});expect(Math.hypot(actor(f,OTHER).position.x-paused.x,actor(f,OTHER).position.z-paused.z)).toBeLessThan(1e-7);
    apply(f,resting());until(f,()=>!!actor(f,OWN).userData.roomRestSeat&&actor(f,OWN).userData.homeRegion==='indoor',600);for(let i=0;i<20;i++)step(f);
    expect(actor(f,OTHER).userData.homeIdleYield).toMatchObject({requester:0,requestKey:'completed'});unchanged();expect(JSON.stringify(group)).toBe(original);expect(f.requested).not.toHaveBeenCalled();
    apply(f,{...snapshot(kind==='forest'?'desert':'forest'),id:'new-scope-after-courtesy'});for(const c of f.group.companions)expect(actor(f,c.id).userData.homeIdleYield).toBeUndefined();
  },60000);

});


it('upper floor viewing preserves every saved actor and furniture and clears on scene change',()=>{
 const f=setup(),before=JSON.stringify(f.group);f.world.setHouseView('interior');f.world.update(f.group,null,'indoor');
 f.world.rotate(.22);f.world.zoom(.9);const cameraBefore=f.renderer.camera!.position.toArray();
 const actors=[OWN,OTHER].map(id=>({id,position:actor(f,id).position.toArray(),rotation:actor(f,id).rotation.toArray()}));const oldItems=existingItems(f);
 expect(f.world.setUpperFloorView(true)).toBe(true);expect(f.host.dataset.upperFloorView).toBe('true');
 expect(f.scene.getObjectByName('home-villa-upper-interior')!.visible).toBe(true);expect(f.scene.getObjectByName('home-reference-villa-blue-grey-hip-roof')!.visible).toBe(false);
 for(const old of actors){expect(actor(f,old.id).position.toArray()).toEqual(old.position);expect(actor(f,old.id).rotation.toArray()).toEqual(old.rotation);}
 expect(f.world.setUpperFloorView(false)).toBe(true);expect(f.host.dataset.upperFloorView).toBe('false');expect(f.scene.getObjectByName('home-villa-upper-interior')!.visible).toBe(false);expect(f.renderer.camera!.position.toArray()).toEqual(cameraBefore);
 oldItems();expect(JSON.stringify(f.group)).toBe(before);expect(f.requested).not.toHaveBeenCalled();
 f.world.setUpperFloorView(true);apply(f,{...snapshot('forest'),id:'new-upper-test-scope'});expect(f.host.dataset.upperFloorView).toBe('false');expect(f.world.setUpperFloorView(true)).toBe(false);
});
it('upper bedroom door animates on the real renderer clock and freezes with the scene',()=>{
 const f=setup();f.world.setUpperFloorView(true);const door=f.scene.getObjectByName('villa-upper-bedroom-door')!;expect(f.world.toggleUpperDoor()).toBe(true);
 f.world.setMotion(true);step(f);expect(door.rotation.y).toBeLessThan(0);const first=door.rotation.y;f.world.setMotion(false);vi.advanceTimersByTime(1000);f.world.update(f.group,null);expect(door.rotation.y).toBe(first);
 f.world.setMotion(true);for(let n=0;n<12;n++)step(f);expect(door.rotation.y).toBeCloseTo(-Math.PI*.48);f.world.toggleUpperDoor();for(let n=0;n<12;n++)step(f);expect(door.rotation.y).toBeCloseTo(0);expect(f.requested).not.toHaveBeenCalled();
});

function assertStairSolidsClear(f:Fixture){
 const objects:THREE.Object3D[]=[];f.scene.traverse(o=>{if(o instanceof THREE.Mesh&&(/villa-stair-(handrail|post)|^home-reference-villa-upper-(side-walls|front-plaster|back-plaster|floor-slab)|^villa-upper-(wood-floor|partition|bed-|sofa-)/.test(o.name)))objects.push(o);});
 const bed=f.scene.getObjectByName('villa-upper-bed-room-bed-0');if(bed)objects.push(bed);
 for(const partName of ['body','left-arm','right-arm','left-leg','right-leg']){const part=actor(f).getObjectByName(partName)!;const box=new THREE.Box3().setFromObject(part,true);for(const solid of objects)if(trianglePenetration(solid,box))expect(exactTriangleCrossing(solid,part),'detail '+JSON.stringify(exactTriangleCrossing(solid,part))+' stairs '+partName+' crosses '+solid.name+' at '+actor(f).position.toArray()+' body '+JSON.stringify(box)+' solid '+JSON.stringify(new THREE.Box3().setFromObject(solid,true))).toBeFalsy();}
}
it('villa stair visit walks continuously to the upstairs hall and back without a paid request',()=>{
 const group=snapshot('home');group.id='synthetic-stair-visit';group.items=group.items.map(i=>i.id==='existing-tree'?{...i,x:.95,y:.95}:i);group.companions=group.companions.filter(c=>c.id===OWN);const original=JSON.stringify(group);
 const f=setup(group,{persistentWorld:false}),unchanged=existingItems(f);expect(f.world.requestFloorVisit(OWN,true),JSON.stringify({radius:actor(f).userData.navigationClearance,bounds:homeNavigationBounds('outdoor'),obstacles:collectHomeJourneyObstacles(f.scene,null).filter(o=>o.minX<4.5&&o.maxX>2.3&&o.minZ<8.0&&o.maxZ>5.9)})).toBe(true);f.world.setMotion(true);
 let old=actor(f).position.clone(),maxY=0;
 for(let n=0;n<1600&&f.world.getFloorVisit()?.phase!=='upper';n++){step(f);const a=actor(f);expect(a.position.distanceTo(old),'no floor teleport '+JSON.stringify(f.world.getFloorVisit())).toBeLessThan(.22);maxY=Math.max(maxY,a.position.y);if(f.world.getFloorVisit()?.phase!=='approach')assertStairSolidsClear(f);old=a.position.clone();}
 expect(f.world.getFloorVisit()?.phase,JSON.stringify({visit:f.world.getFloorVisit(),position:actor(f).position.toArray(),journey:actor(f).userData.homeJourney,clearance:actor(f).userData.navigationClearance,dataset:{...f.host.dataset},doors:f.doorChanged.mock.calls})).toBe('upper');expect(maxY).toBeGreaterThan(3.4);expect(actor(f).position.y).toBeCloseTo(3.496);expect(actor(f).userData.homeFloor).toBe(2);
 const held=actor(f).position.clone();f.world.setMotion(false);vi.advanceTimersByTime(5000);f.world.update(group,null);expect(actor(f).position.toArray()).toEqual(held.toArray());
 expect(f.world.requestFloorVisit(OWN,false)).toBe(true);f.world.setMotion(true);
 for(let n=0;n<1100&&f.world.getFloorVisit();n++){const before=actor(f).position.clone();step(f);expect(actor(f).position.distanceTo(before)).toBeLessThan(.22);}
 expect(f.world.getFloorVisit()).toBeNull();expect(actor(f).position.y).toBeCloseTo(0);unchanged();expect(JSON.stringify(group)).toBe(original);expect(f.requested).not.toHaveBeenCalled();
},90000);
it('villa stair visit rejects production and another owners actor',()=>{
 const persisted=setup();expect(persisted.world.requestFloorVisit(OWN,true)).toBe(false);
 const group=snapshot('home');group.id='synthetic-stair-owner';const local=setup(group,{persistentWorld:false});expect(local.world.requestFloorVisit(OTHER,true)).toBe(false);expect(local.world.getFloorVisit()).toBeNull();
});
it.each([11.11,16.67,20,40])('a garment companion gets out of the villa bed at a steady %s ms display frame',frame=>{
 const group=snapshot('home');group.items=[];group.companions=group.companions.filter(c=>c.id===OWN).map(c=>({...c,activity:'sleep',area:'bedroom',avatar3d:{...c.avatar3d!,kind:'garment',body:'#efa3b8',accent:'#e3c56a',detail:'#5b5964',seed:533402354}}));
 const f=setup(group,{strictLeisureContacts:true});f.world.setHouseView('exterior');f.world.setMotion(true);for(let n=0;n<1200;n++)step(f,frame);
 expect(actor(f).userData.sleepingBed).toBeDefined();f.world.update({...group,revision:2,companions:group.companions.map(c=>({...c,activity:'observe',area:'outdoor'}))},OWN);
 let up=false;for(let n=0;n<1200&&!up;n++){const before=actor(f).position.clone();step(f,frame);expect(actor(f).position.distanceTo(before)).toBeLessThan(.2);up=actor(f).userData.homeJourney?.phase==='walk';}
 expect(up,'getting up must not depend on the display refresh rate '+JSON.stringify({journey:actor(f).userData.homeJourney,collision:actor(f).userData.contactCollision})).toBe(true);expect(actor(f).userData.sleepingBed).toBeUndefined();
},60000);

it('villa stair visit undocks from the original bed before climbing',()=>{
 const group=snapshot('home');group.id='synthetic-stair-visit';group.items=group.items.map(i=>i.id==='existing-tree'?{...i,x:.95,y:.95}:i);group.companions=group.companions.filter(c=>c.id===OWN).map(c=>({...c,activity:'sleep',area:'bedroom'}));const original=JSON.stringify(group);
 const f=setup(group,{persistentWorld:false}),unchanged=existingItems(f);expect(f.world.requestFloorVisit(OWN,true),JSON.stringify({radius:actor(f).userData.navigationClearance,bounds:homeNavigationBounds('outdoor'),obstacles:collectHomeJourneyObstacles(f.scene,null).filter(o=>o.minX<4.5&&o.maxX>2.3&&o.minZ<8.0&&o.maxZ>5.9)})).toBe(true);f.world.setMotion(true);
 let old=actor(f).position.clone(),maxY=0;
 for(let n=0;n<1600&&f.world.getFloorVisit()?.phase!=='upper';n++){step(f);const a=actor(f);expect(a.position.distanceTo(old),'no floor teleport '+JSON.stringify(f.world.getFloorVisit())).toBeLessThan(.22);maxY=Math.max(maxY,a.position.y);if(f.world.getFloorVisit()?.phase!=='approach')assertStairSolidsClear(f);old=a.position.clone();}
 expect(f.world.getFloorVisit()?.phase,JSON.stringify({visit:f.world.getFloorVisit(),position:actor(f).position.toArray(),journey:actor(f).userData.homeJourney,clearance:actor(f).userData.navigationClearance,dataset:{...f.host.dataset},doors:f.doorChanged.mock.calls})).toBe('upper');expect(maxY).toBeGreaterThan(3.4);expect(actor(f).position.y).toBeCloseTo(3.496);expect(actor(f).userData.homeFloor).toBe(2);
 const held=actor(f).position.clone();f.world.setMotion(false);vi.advanceTimersByTime(5000);f.world.update(group,null);expect(actor(f).position.toArray()).toEqual(held.toArray());
 expect(f.world.requestFloorVisit(OWN,false)).toBe(true);f.world.setMotion(true);
 for(let n=0;n<1100&&f.world.getFloorVisit();n++){const before=actor(f).position.clone();step(f);expect(actor(f).position.distanceTo(before)).toBeLessThan(.22);}
 expect(f.world.getFloorVisit()).toBeNull();expect(actor(f).position.y).toBeCloseTo(0);unchanged();expect(JSON.stringify(group)).toBe(original);expect(f.requested).not.toHaveBeenCalled();
},90000);

it.each(['rest','sleep'] as const)('upper floor %s reaches actual furniture and returns',activity=>{
 const group=snapshot('home');group.id='synthetic-upper-life-'+activity;group.items=group.items.map(i=>i.id==='existing-tree'?{...i,x:.95,y:.95}:i);group.companions=group.companions.filter(c=>c.id===OWN);
 const f=setup(group,{persistentWorld:false});expect(f.world.requestFloorActivity(OWN,activity)).toBe(true);f.world.setMotion(true);
 for(let i=0;i<2500&&f.world.getFloorVisit()?.phase!=='upper';i++){step(f);assertStairSolidsClear(f);}
 expect(f.world.getFloorVisit()?.phase,JSON.stringify({state:f.world.getFloorVisit(),blocked:f.host.dataset.upperContactBlocked})).toBe('upper');expect(actor(f).position.y).toBeGreaterThan(3.4);
 f.world.setUpperFloorView(true);expect(f.world.setUpperDoorOpen(false)).toBe(true);for(let i=0;i<30;i++)step(f);expect(f.world.requestFloorVisit(OWN,false)).toBe(true);for(let i=0;i<2500&&f.world.getFloorVisit();i++){step(f);assertStairSolidsClear(f);}expect(f.world.getFloorVisit(),f.host.dataset.upperContactBlocked).toBeNull();
},60_000);

it('three upstairs activities queue physically and survive an exact local reload without changing saved layout',()=>{
 localStorage.clear();const group=snapshot('home');group.id='synthetic-upper-life-reload';group.items=group.items.map(i=>i.id==='existing-tree'?{...i,x:.95,y:.95}:i);group.companions=[0,1,2].map((n)=>({...group.companions[0],id:OWN+n,name:'测试'+n,x:.25+n*.24,y:.76,avatar3d:{...group.companions[0].avatar3d!,kind:'cup' as const}}));const original=JSON.stringify(group);
 const f=setup(group,{persistentWorld:false,localFloorStorage:true});for(const [i,activity] of (['sleep','rest','observe'] as const).entries())expect(f.world.requestFloorActivity(OWN+i,activity)).toBe(true);f.world.setMotion(true);
 for(let i=0;i<2200&&!f.world.getFloorLives().every(s=>s.phase==='upper');i++){step(f);const upper=f.world.getFloorLives().filter(s=>s.pose.y>3.4);for(let a=0;a<upper.length;a++)for(let b=a+1;b<upper.length;b++)expect(Math.hypot(upper[a].pose.x-upper[b].pose.x,upper[a].pose.z-upper[b].pose.z)).toBeGreaterThan(upper[a].radius+upper[b].radius);}
 expect(f.world.getFloorLives().map(s=>[s.activity,s.phase]),JSON.stringify({blocked:f.host.dataset.upperContactBlocked,actors:group.companions.map(c=>({id:c.id,pos:actor(f,c.id).position.toArray(),journey:actor(f,c.id).userData.homeJourney,nav:actor(f,c.id).userData.homeNavigation,yield:actor(f,c.id).userData.homeIdleYield}))})).toEqual([['sleep','upper'],['rest','upper'],['observe','upper']]);for(let i=0;i<6;i++)step(f);const before=f.world.getFloorLives().map(s=>({id:s.id,pose:s.pose}));f.world.dispose();const fresh=setup(group,{persistentWorld:false,localFloorStorage:true});expect(fresh.host.dataset.upperRestore).toBe('restored');expect(fresh.world.getFloorLives().map(s=>({id:s.id,pose:s.pose}))).toEqual(before);expect(JSON.stringify(group)).toBe(original);localStorage.clear();
},120_000);


it('server floor checkpoint restores both owners and only a leased driver advances',()=>{
 const group=snapshot('home');group.items=group.items.map(i=>i.id==='existing-tree'?{...i,x:.95,y:.95}:i);
 const leader=setup(group),follower=setup({...group,me:'owner-b'});
 const initial={revision:1,seq:2,applied:0,commands:[{seq:1,id:OWN,activity:'sleep' as const},{seq:2,id:OTHER,activity:'rest' as const}],checkpoint:{version:1 as const,active:null,states:[]},fingerprint:'synthetic-floor',driver:true,lease_until:1006,server_time:1000};
 expect(leader.world.applyServerFloor(initial)).toBe(true);expect(follower.world.applyServerFloor({...initial,driver:false})).toBe(true);expect(follower.world.canRequestServerFloor(OWN,'observe')).toBe(false);
 leader.world.setMotion(true);follower.world.setMotion(true);leader.world.setFloorDriver(true);
 const frozen=follower.world.exportServerFloor();for(let i=0;i<20;i++)step(follower);expect(follower.world.exportServerFloor()).toEqual(frozen);
 for(let i=0;i<2200&&!leader.world.getFloorLives().every(s=>s.phase==='upper');i++){
  const before=group.companions.map(c=>actor(leader,c.id).position.clone());step(leader);
  group.companions.forEach((c,n)=>expect(actor(leader,c.id).position.distanceTo(before[n])).toBeLessThan(.22));
  if(i===200){const moving={...initial,applied:2,commands:[],checkpoint:leader.world.exportServerFloor().checkpoint};expect(follower.world.applyServerFloor({...moving,driver:false})).toBe(true);expect(follower.world.exportServerFloor()).toEqual(leader.world.exportServerFloor());}
 }
 expect(leader.world.getFloorLives().map(s=>s.phase)).toEqual(['upper','upper']);
 expect(leader.host.dataset.upperContactBlocked).toBeUndefined();
 const saved={...initial,revision:2,applied:2,commands:[],checkpoint:leader.world.exportServerFloor().checkpoint};
 expect(follower.world.applyServerFloor({...saved,driver:false})).toBe(true);expect(follower.world.exportServerFloor()).toEqual(leader.world.exportServerFloor());
 const sorted=(v:unknown):unknown=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted((v as Record<string,unknown>)[k])])):v;
 const rebuilt=setup({...group,me:'owner-b'});expect(rebuilt.world.applyServerFloor(JSON.parse(JSON.stringify(sorted(saved))))).toBe(true);expect(rebuilt.world.exportServerFloor()).toEqual(leader.world.exportServerFloor());

 const tampered=structuredClone(saved);tampered.checkpoint.states[0].pose.y+=1;expect(rebuilt.world.applyServerFloor(tampered)).toBe(false);expect(rebuilt.world.exportServerFloor()).toEqual(leader.world.exportServerFloor());
},60_000);


it.each(['observe','rest','sleep'] as const)('server floor preflight accepts the unchanged browser fixture for %s',async activity=>{
 const raw=(await import('./fixtures/villa-floor-browser.json')).default,group=parseGathering(raw),f=setup(group);
 const own=group.companions.find(c=>c.owner_id===group.me)!,root=actor(f,own.id),radius=Number(root.userData.navigationClearance),bottom={x:1.65,z:-1.42};
 const obstacles=collectHomeJourneyObstacles(f.scene,null),graph=createLivingNavigation({bounds:homeNavigationBounds('bedroom'),blocked:obstacles,clearance:radius,step:.08});
 expect(f.world.canRequestServerFloor(own.id,activity),JSON.stringify({id:own.id,radius,bounds:homeNavigationBounds('bedroom'),landingClear:graph.isSegmentClear(bottom,bottom),nearby:obstacles.filter(o=>o.minX-radius<bottom.x&&o.maxX+radius>bottom.x&&o.minZ-radius<bottom.z&&o.maxZ+radius>bottom.z)})).toBe(true);
 expect(f.world.canRequestServerFloor(own.id,null)).toBe(false);
 expect(f.world.canRequestServerFloor(group.companions.find(c=>c.owner_id!==group.me)!.id,activity)).toBe(false);
});

it('server floor preflight preserves a peers occupied upstairs bed while allowing another owner activity',async()=>{
 const raw=(await import('./fixtures/villa-floor-browser.json')).default,group=parseGathering(raw);
 const [cup,plant,bouquet]=group.companions;
 group.companions=[{...cup,id:4,activity:'sleep',area:'bedroom',x:.35,y:.65},{...bouquet,id:5,activity:'talk',area:'outdoor',x:.65,y:.55},{...plant,id:2,activity:'talk',area:'outdoor',x:.65,y:.55}];
 const before=JSON.stringify(group),f=setup(group),items:Array<{root:THREE.Object3D;matrix:number[]}>=[];
 f.scene.traverse(root=>{if(root.userData.homeItemId)items.push({root,matrix:root.matrixWorld.toArray()});});
 expect(items.map(item=>item.root.userData.homeItemId).sort()).toEqual(group.items.map(item=>item.id).sort());
 const unchanged=()=>items.forEach(item=>expect(item.root.matrixWorld.toArray()).toEqual(item.matrix));
 const initial={revision:1,seq:1,applied:0,commands:[{seq:1,id:5,activity:'sleep' as const}],checkpoint:{version:1 as const,active:null,states:[]},fingerprint:'three-person-occupied-bedroom',driver:true,lease_until:1006,server_time:1000};
 expect(f.world.applyServerFloor(initial)).toBe(true);f.world.setMotion(true);f.world.setFloorDriver(true);
 for(let frame=0;frame<3500&&f.world.getFloorVisit(5)?.phase!=='upper';frame++)step(f);
 expect(f.world.getFloorVisit(5)?.phase,JSON.stringify({floor:f.world.getFloorVisit(5),blocked:f.host.dataset.upperContactBlocked})).toBe('upper');
 const savedFloor=f.world.exportServerFloor();
 for(const id of [4,2]){
  expect(f.world.canRequestServerFloor(id,'observe')).toBe(true);expect(f.world.canRequestServerFloor(id,'rest')).toBe(true);
  expect(f.world.canRequestServerFloor(id,'sleep')).toBe(false);expect(f.world.canRequestServerFloor(id,null)).toBe(false);
 }
 for(const activity of ['observe','rest','sleep',null] as const)expect(f.world.canRequestServerFloor(5,activity)).toBe(false);
 expect(f.world.exportServerFloor()).toEqual(savedFloor);expect(JSON.stringify(group)).toBe(before);unchanged();expect(f.requested).not.toHaveBeenCalled();
 f.world.setMotion(false);const upstairsPosition=actor(f,5).position.clone();
 for(const activity of ['walk','rest'] as const){
  const next={...group,revision:group.revision+1,companions:group.companions.map(c=>c.id===4?{...c,activity,area:activity==='rest'?'indoor' as const:'outdoor' as const}:c)};
  apply(f,next);expect(f.world.exportServerFloor()).toEqual(savedFloor);
  expect(f.world.applyServerFloor({...initial,revision:3,applied:1,commands:[],checkpoint:savedFloor.checkpoint,fingerprint:'updated-ground-only',driver:false})).toBe(true);
  expect(f.world.exportServerFloor()).toEqual(savedFloor);expect(actor(f,5).position.toArray()).toEqual(upstairsPosition.toArray());unchanged();
 }
 const television=slot(f,'television');apply(f,saved(f.group,4,television));
 expect(f.world.applyServerFloor({...initial,revision:4,applied:1,commands:[],checkpoint:savedFloor.checkpoint,fingerprint:'updated-ground-leisure-only',driver:false})).toBe(true);
 f.world.setMotion(true);for(let frame=0;frame<1300&&!seated(f,4);frame++)step(f);
 expect(seated(f,4),JSON.stringify({assignment:assignment(f,4),journey:actor(f,4).userData.homeJourney})).toBe(true);
 expect(f.world.exportServerFloor()).toEqual(savedFloor);expect(actor(f,5).position.toArray()).toEqual(upstairsPosition.toArray());unchanged();
 const peer=setup({...group,me:bouquet.owner_id});expect(peer.world.applyServerFloor({...initial,revision:2,applied:1,commands:[],checkpoint:savedFloor.checkpoint,driver:false})).toBe(true);
 expect(peer.world.canRequestServerFloor(5,null)).toBe(true);expect(peer.world.canRequestServerFloor(5,'sleep')).toBe(true);
 expect(peer.world.canRequestServerFloor(4,'rest')).toBe(false);
},60_000);

it('server upstairs route works with the unchanged browser fixture',async()=>{
 const raw=(await import('./fixtures/villa-floor-browser.json')).default,group=parseGathering(raw),f=setup(group);
 const initial={revision:1,seq:2,applied:0,commands:[{seq:1,id:2,activity:'sleep' as const},{seq:2,id:4,activity:'rest' as const}],checkpoint:{version:1 as const,active:null,states:[]},fingerprint:'browser-fixture',driver:true,lease_until:1006,server_time:1000};
 expect(f.world.applyServerFloor(initial)).toBe(true);f.world.setMotion(true);f.world.setFloorDriver(true);
 for(let i=0;i<3500&&!f.world.getFloorLives().every(s=>s.phase==='upper');i++)step(f);
 expect(f.world.getFloorLives().map(s=>s.phase),JSON.stringify({phase:f.world.getFloorVisit()?.phase,blocked:f.host.dataset.upperContactBlocked,actors:group.companions.map(c=>({id:c.id,pos:actor(f,c.id).position.toArray(),journey:actor(f,c.id).userData.homeJourney,nav:actor(f,c.id).userData.homeNavigation,yield:actor(f,c.id).userData.homeIdleYield}))})).toEqual(['upper','upper']);
},60_000);


it.each([true,false])('isolates upstairs ownership from other downstairs leisure in persistent=%s',persistent=>{
 const group=snapshot('home');group.id='synthetic-floor-concurrent-leisure';group.items=[];group.companions.push({...group.companions[0],id:403,name:'测试一楼伙伴',x:.7,y:.7});const original=JSON.stringify(group);
 const f=setup(group,{persistentWorld:persistent});
 if(persistent)expect(f.world.applyServerFloor({revision:1,seq:1,applied:0,commands:[{seq:1,id:OWN,activity:'observe'}],checkpoint:{version:1,active:null,states:[]},fingerprint:'synthetic-concurrent',driver:false,lease_until:1006,server_time:1000})).toBe(true);
 else expect(f.world.requestFloorActivity(OWN,'observe')).toBe(true);
 const before=f.world.getFloorLives();expect(f.world.getFloorVisit(OWN)?.id).toBe(OWN);expect(f.world.getFloorVisit(403)).toBeNull();
 expect(f.world.startLocalLeisure('tea',403)).toBe(true);if(persistent)expect(f.requested).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({activity:'tea',actorId:403}));else expect(f.world.getLocalLeisure().assignments.some(a=>a.actorId===403&&a.activity==='tea')).toBe(true);
 expect(f.world.startLocalLeisure('tea',OWN)).toBe(false);expect(f.world.startLocalLeisure('tea',OTHER)).toBe(false);expect(f.world.getFloorLives()).toEqual(before);expect(JSON.stringify(group)).toBe(original);
});

it.each([true,false])('default leisure skips an upstairs companion in persistent=%s',persistent=>{
 const group=snapshot('home');group.id='synthetic-default-floor-leisure';group.items=[];group.companions.push({...group.companions[0],id:403,name:'一楼默认候选',x:.7,y:.7});const f=setup(group,{persistentWorld:persistent});
 if(persistent)expect(f.world.applyServerFloor({revision:1,seq:1,applied:0,commands:[{seq:1,id:OWN,activity:'observe'}],checkpoint:{version:1,active:null,states:[]},fingerprint:'synthetic-default',driver:false,lease_until:1006,server_time:1000})).toBe(true);else expect(f.world.requestFloorActivity(OWN,'observe')).toBe(true);
 expect(f.world.startLocalLeisure('tea')).toBe(true);if(persistent)expect(f.requested).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({actorId:403}));else{expect(f.world.getLocalLeisure().assignments.some(a=>a.actorId===403)).toBe(true);expect(f.world.getLocalLeisure().assignments.some(a=>a.actorId===OWN)).toBe(false);}
});

describe('social facing continuity regression', () => {
  const ids = [2, 5] as const;
  const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  function socialSnapshot(single = false, sharedAnchor = false) {
    const group = snapshot('home'); group.items = [];
    group.companions = group.companions.slice(0, single ? 1 : 2).map((c, index) => ({
      ...c, id: ids[index], name: '合成转向伙伴' + ids[index], activity: 'talk', area: 'outdoor',
      owner_id: index ? 'owner-b' : 'owner-a', x: sharedAnchor ? .65 : index ? .1 : .5, y: sharedAnchor ? .55 : index ? .12 : .76,
      avatar3d: { ...c.avatar3d!, kind: index ? 'bouquet' as const : 'plant' as const, seed: ids[index] },
    }));
    if (sharedAnchor && !single) group.companions.push({ ...snapshot('home').companions[0], id: 4, name: '合成卧室伙伴4', activity: 'sleep', area: 'bedroom', x: .35, y: .65,
      avatar3d: { ...group.companions[0].avatar3d!, kind: 'cup', seed: 4 } });
    return group;
  }
  type FacingMetric = { id: number; previousYaw: number; previousPosition: THREE.Vector3; maxStep: number; totalTurn: number;
    reversals: number; lastSign: number; waitingFrames: number; waitingTurn: number; waitingMaxError: number; settledTurn: number; settledMaxStep: number };
  function metrics(f: Fixture): FacingMetric[] {
    return f.group.companions.filter(c => c.activity === 'talk').map(c => ({ id: c.id, previousYaw: actor(f, c.id).rotation.y, previousPosition: actor(f, c.id).position.clone(),
      maxStep: 0, totalTurn: 0, reversals: 0, lastSign: 0, waitingFrames: 0, waitingTurn: 0, waitingMaxError: 0, settledTurn: 0, settledMaxStep: 0 }));
  }
  function record(f: Fixture, rows: FacingMetric[], settled = false) {
    for (const row of rows) {
      const root = actor(f, row.id), change = angleDelta(root.rotation.y, row.previousYaw), magnitude = Math.abs(change);
      row.maxStep = Math.max(row.maxStep, magnitude); row.totalTurn += magnitude;
      if (magnitude > .01) { const sign = Math.sign(change); if (row.lastSign && sign !== row.lastSign) row.reversals++; row.lastSign = sign; }
      const social = root.userData.socialGathering, journey = root.userData.homeJourney;
      const waiting = social && !social.ready && !journey?.active && Math.hypot(root.position.x - social.target.x, root.position.z - social.target.z) < .24;
      if (waiting) {
        row.waitingFrames++; row.waitingTurn += magnitude;
        if (row.waitingFrames >= 15) row.waitingMaxError = Math.max(row.waitingMaxError, Math.abs(angleDelta(root.rotation.y, Math.atan2(social.center.x - root.position.x, social.center.z - root.position.z))));
      }
      if (settled) { row.settledTurn += magnitude; row.settledMaxStep = Math.max(row.settledMaxStep, magnitude); }
      row.previousYaw = root.rotation.y; row.previousPosition.copy(root.position);
    }
  }
  function summary(rows: FacingMetric[]) { return rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'previousPosition' && key !== 'previousYaw'))); }

  it.each(['shared saved anchor', 'staggered arrival'] as const)('keeps plant 2 and bouquet 5 continuous through %s and 90 seconds across polls', scenario => {
    const group = socialSnapshot(false, scenario === 'shared saved anchor'), original = JSON.stringify(group), f = setup(group), rows = metrics(f);
    const waitingTrace: Array<{ frame: number; id: number; yaw: number; ready: boolean; phase: string; position: number[] }> = [];
    f.world.setMotion(true); record(f, rows);
    let arrived = false;
    for (let frame = 0; frame < 1600; frame++) {
      step(f); record(f, rows);
      for (const id of ids) {
        const root = actor(f, id), social = root.userData.socialGathering;
        if (social && !social.ready && !root.userData.homeJourney?.active && (frame % 5 === 0 || waitingTrace.length < 4))
          waitingTrace.push({ frame, id, yaw: root.rotation.y, ready: social.ready, phase: root.userData.homeJourney?.phase ?? 'idle', position: root.position.toArray() });
      }
      if (ids.every(id => actor(f, id).userData.socialGathering?.ready)) { arrived = true; break; }
    }
    // Allow the one final bounded turn to complete before measuring an idle hold.
    for (let frame = 0; frame < 20; frame++) { step(f); record(f, rows); }
    for (let frame = 0; frame < 900; frame++) {
      if (frame % 50 === 0) { apply(f, structuredClone(f.group)); record(f, rows, true); }
      if (frame === 450) { apply(f, { ...structuredClone(f.group), revision: f.group.revision + 1 }); record(f, rows, true); }
      step(f); record(f, rows, true);
    }
    console.info('SOCIAL_TURN_CONTINUITY ' + JSON.stringify({ scenario, arrived, metrics: summary(rows), waitingTrace, final: ids.map(id => ({ id, yaw: actor(f, id).rotation.y, social: actor(f, id).userData.socialGathering, journey: actor(f, id).userData.homeJourney })) }));
    expect(arrived, 'both actual bodies must reach the social slots').toBe(true);
    if (scenario === 'staggered arrival') expect(rows.some(row => row.waitingFrames >= 15), 'one actual actor must wait at least 1.5 seconds for the other').toBe(true);
    for (const row of rows) {
      expect(row.maxStep, 'continuous yaw, actor ' + row.id).toBeLessThanOrEqual(.360001);
      expect(row.waitingMaxError, 'waiting actor faces the actual social center, actor ' + row.id).toBeLessThan(.05);
      expect(row.settledMaxStep, 'same/unrelated revision cannot restart facing, actor ' + row.id).toBeLessThan(1e-7);
      expect(row.settledTurn, '90 second idle hold cannot accumulate rotation, actor ' + row.id).toBeLessThan(1e-6);
    }
    expect(JSON.stringify(group)).toBe(original); expect(f.requested).not.toHaveBeenCalled();
  }, 60_000);

  it('keeps a lone saved talk actor quiet instead of rocking its whole body periodically', () => {
    const group = socialSnapshot(true), original = JSON.stringify(group), f = setup(group), root = actor(f, 2), body = root.getObjectByName('body')!;
    expect(body).toBeDefined(); f.world.setMotion(true);
    const yaws: number[] = [], leans: number[] = [];
    for (let frame = 0; frame < 300; frame++) { step(f); yaws.push(root.rotation.y); leans.push(body.rotation.z); }
    const yawSpan = Math.max(...yaws) - Math.min(...yaws), leanSpan = Math.max(...leans) - Math.min(...leans);
    console.info('SOCIAL_TURN_LONE ' + JSON.stringify({ yawSpan, leanSpan, participants: f.host.dataset.socialParticipants }));
    expect(f.host.dataset.socialParticipants).toBe('0'); expect(yawSpan).toBeLessThan(1e-7); expect(leanSpan).toBeLessThan(.001);
    expect(JSON.stringify(group)).toBe(original); expect(f.requested).not.toHaveBeenCalled();
  });
});

describe('social lifecycle regression', () => {
  const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  function socialSnapshot() {
    const group = snapshot('home');
    group.items = group.items.map(item => item.id === 'existing-tree' ? { ...item, x: .95, y: .95 } : item);
    group.companions = group.companions.map((companion, index) => ({ ...companion, activity: 'talk', area: 'outdoor', x: index ? .1 : .5, y: index ? .12 : .76 }));
    return group;
  }
  function poses(f: Fixture) {
    return new Map(f.group.companions.map(companion => {
      const root = actor(f, companion.id);
      return [companion.id, { position: root.position.clone(), yaw: root.rotation.y }] as const;
    }));
  }
  function unchangedPoses(f: Fixture, previous: ReturnType<typeof poses>, reason: string) {
    for (const [id, pose] of previous) {
      expect(actor(f, id).position.toArray(), reason + ' position ' + id).toEqual(pose.position.toArray());
      expect(actor(f, id).rotation.y, reason + ' yaw ' + id).toBe(pose.yaw);
    }
  }
  function visiblePresets(f: Fixture) {
    return [...f.labels.querySelectorAll<HTMLElement>('[data-kind="preset"]')].filter(label => !label.hidden);
  }
  function startMoving(f: Fixture) {
    f.world.setMotion(true);
    const initial = poses(f);
    until(f, () => f.group.companions.some(companion => actor(f, companion.id).position.distanceTo(initial.get(companion.id)!.position) > .05)
      && !f.group.companions.every(companion => actor(f, companion.id).userData.socialGathering?.ready), 100);
    expect(f.group.companions.some(companion => actor(f, companion.id).userData.homeJourney?.active), 'pause starts during a real journey').toBe(true);
  }
  function resumeFrames(f: Fixture, count: number, phase: string) {
    let previous = poses(f), maxTurn = 0, maxDistance = 0, moved = 0;
    for (let frame = 0; frame < count; frame++) {
      step(f);
      for (const [id, pose] of previous) {
        const root = actor(f, id), turn = Math.abs(angleDelta(root.rotation.y, pose.yaw)), distance = root.position.distanceTo(pose.position);
        maxTurn = Math.max(maxTurn, turn); maxDistance = Math.max(maxDistance, distance); moved += distance;
        expect(turn, phase + ' bounded turn, frame ' + frame + ', actor ' + id).toBeLessThanOrEqual(.360001);
        expect(distance, phase + ' no teleport/catch-up, frame ' + frame + ', actor ' + id).toBeLessThan(.3);
      }
      expect(visiblePresets(f).length, phase + ' has at most one current line').toBeLessThanOrEqual(1);
      previous = poses(f);
    }
    return { maxTurn, maxDistance, moved };
  }

  it('freezes moving social bodies for a one-hour pause and resumes without catching up', () => {
    const group = socialSnapshot(), original = JSON.stringify(group), f = setup(group), unchangedItems = existingItems(f);
    startMoving(f);
    const moving = poses(f), staleLoop = f.renderer.loop!;
    f.world.setMotion(false); unchangedPoses(f, moving, 'pause transition');
    const frozen = poses(f);
    vi.setSystemTime(Date.now() + 3_600_000); staleLoop(Date.now());
    apply(f, { ...structuredClone(group), revision: group.revision + 1 });
    unchangedPoses(f, frozen, 'one hour paused with a fresh poll'); expect(visiblePresets(f)).toHaveLength(0);
    f.world.setMotion(true); unchangedPoses(f, frozen, 'resume transition');
    const resumed = resumeFrames(f, 60, 'pause resume');
    console.info('SOCIAL_LIFECYCLE_PAUSE ' + JSON.stringify(resumed));
    expect(resumed.moved, 'resumed route must actually continue').toBeGreaterThan(.05);
    unchangedItems(); expect(JSON.stringify(group)).toBe(original); expect(f.group.items).toEqual(group.items); expect(f.requested).not.toHaveBeenCalled();
  }, 60_000);

  it('freezes moving social bodies while the document is hidden for one hour and resumes continuously', () => {
    const group = socialSnapshot(), original = JSON.stringify(group), f = setup(group), unchangedItems = existingItems(f);
    startMoving(f);
    const moving = poses(f), hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange')); unchangedPoses(f, moving, 'hide transition');
    step(f, 3_600_000); apply(f, { ...structuredClone(group), revision: group.revision + 1 });
    unchangedPoses(f, moving, 'one hour hidden with a fresh poll'); expect(visiblePresets(f)).toHaveLength(0);
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
    unchangedPoses(f, moving, 'visible transition');
    const resumed = resumeFrames(f, 60, 'hidden resume');
    console.info('SOCIAL_LIFECYCLE_HIDDEN ' + JSON.stringify(resumed));
    expect(resumed.moved, 'visible route must actually continue').toBeGreaterThan(.05);
    unchangedItems(); expect(JSON.stringify(group)).toBe(original); expect(f.group.items).toEqual(group.items); expect(f.requested).not.toHaveBeenCalled();
  }, 60_000);

  it('stops group chat when one arrived partner leaves and gathers the same ID again without jumps', () => {
    const group = socialSnapshot(), original = JSON.stringify(group), f = setup(group), unchangedItems = existingItems(f);
    f.world.setMotion(true); until(f, () => group.companions.every(companion => actor(f, companion.id).userData.socialGathering?.ready), 1600);
    resumeFrames(f, 20, 'initial settle'); expect(visiblePresets(f)).toHaveLength(1);
    const departing = actor(f, OTHER), survivor = new Map([...poses(f)].filter(([id]) => id === OWN));
    apply(f, { ...structuredClone(group), revision: group.revision + 1, companions: structuredClone(group.companions.filter(companion => companion.id === OWN)) });
    unchangedPoses(f, survivor, 'partner departure'); expect(departing.parent).toBeNull();
    expect(f.scene.children.some(root => root.userData.characterId === OTHER)).toBe(false);
    expect(f.host.dataset.socialParticipants).toBe('0'); expect(visiblePresets(f)).toHaveLength(0);
    // Losing the group can send the survivor back to its unchanged saved anchor.
    // Measure its quiet hold only after that real return route has completed.
    let returned = false;
    for (let frame = 0; frame < 1600; frame++) {
      resumeFrames(f, 1, 'single partner return');
      expect(actor(f).userData.socialGathering).toBeNull(); expect(visiblePresets(f)).toHaveLength(0);
      if (!actor(f).userData.homeJourney?.active) { returned = true; break; }
    }
    expect(returned, 'single partner completes its unchanged saved-anchor return').toBe(true);
    resumeFrames(f, 20, 'single partner settle');
    const body = actor(f).getObjectByName('body')!, yaws: number[] = [], leans: number[] = [];
    for (let frame = 0; frame < 120; frame++) {
      step(f); yaws.push(actor(f).rotation.y); leans.push(body.rotation.z);
      expect(actor(f).userData.socialGathering).toBeNull(); expect(visiblePresets(f)).toHaveLength(0);
    }
    expect(Math.max(...yaws) - Math.min(...yaws), 'remaining partner stays quietly oriented').toBeLessThan(1e-7);
    expect(Math.max(...leans) - Math.min(...leans), 'remaining partner has no pretend conversation gesture').toBeLessThan(.001);
    const beforeRejoin = poses(f);
    apply(f, { ...structuredClone(group), revision: group.revision + 2 });
    unchangedPoses(f, beforeRejoin, 'same ID rejoin'); expect(actor(f, OTHER)).not.toBe(departing);
    let arrived = false, maxTurn = 0, maxDistance = 0, moved = 0;
    for (let frame = 0; frame < 1600; frame++) {
      const metric = resumeFrames(f, 1, 'same ID rejoin');
      maxTurn = Math.max(maxTurn, metric.maxTurn); maxDistance = Math.max(maxDistance, metric.maxDistance); moved += metric.moved;
      if (group.companions.every(companion => actor(f, companion.id).userData.socialGathering?.ready)) { arrived = true; break; }
      expect(visiblePresets(f), 'unassembled partners cannot pretend to chat').toHaveLength(0);
    }
    console.info('SOCIAL_LIFECYCLE_REJOIN ' + JSON.stringify({ arrived, maxTurn, maxDistance, moved }));
    expect(arrived, 'both actual bodies must assemble again').toBe(true); expect(moved).toBeGreaterThan(.05);
    resumeFrames(f, 20, 'rejoined settle'); expect(visiblePresets(f)).toHaveLength(1);
    unchangedItems(); expect(JSON.stringify(group)).toBe(original); expect(f.group.items).toEqual(group.items); expect(f.group.companions).toEqual(group.companions); expect(f.requested).not.toHaveBeenCalled();
  }, 60_000);

  it('removes an upstairs departure from floor state before the same ID returns to social life', () => {
    const group = socialSnapshot(); group.id = 'synthetic-social-lifecycle-upper';
    const original = JSON.stringify(group), f = setup(group, { persistentWorld: false }), unchangedItems = existingItems(f);
    expect(f.world.requestFloorActivity(OWN, 'observe')).toBe(true); f.world.setMotion(true);
    until(f, () => f.world.getFloorVisit(OWN)?.phase === 'upper', 2500);
    expect(actor(f).position.y).toBeGreaterThan(3.4); expect(actor(f).userData.homeFloor).toBe(2);
    const departed = actor(f);
    apply(f, { ...structuredClone(group), revision: group.revision + 1, companions: structuredClone(group.companions.filter(companion => companion.id !== OWN)) });
    expect(departed.parent).toBeNull(); expect(f.world.getFloorVisit(OWN)).toBeNull(); expect(f.world.getFloorLives().some(visit => visit.id === OWN)).toBe(false);
    const survivor = poses(f); apply(f, { ...structuredClone(group), revision: group.revision + 2 });
    unchangedPoses(f, survivor, 'upstairs same ID rejoin'); expect(actor(f)).not.toBe(departed);
    expect(f.world.getFloorVisit(OWN)).toBeNull(); expect(f.world.getFloorLives().some(visit => visit.id === OWN)).toBe(false);
    expect(actor(f).position.y).toBeLessThan(.1); expect(actor(f).userData.homeFloor).not.toBe(2);
    const resumed = resumeFrames(f, 40, 'upstairs departure rejoin');
    console.info('SOCIAL_LIFECYCLE_UPPER_REJOIN ' + JSON.stringify({ ...resumed, floor: f.world.getFloorLives() }));
    unchangedItems(); expect(JSON.stringify(group)).toBe(original); expect(f.group.items).toEqual(group.items); expect(f.requested).not.toHaveBeenCalled();
  }, 90_000);
});
