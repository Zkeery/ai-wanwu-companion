import * as THREE from 'three';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import current from './fixtures/id5-current-g59-20261025.json';
import type {LivingAvatarMesh} from '@/lib/living-meshes';
import {createLivingWorld} from '@/lib/living-world-engine';
import {parseGathering} from '@/lib/gatherings';

const gpu = vi.hoisted(() => ({instances: [] as Array<{scene: THREE.Scene | null; loop: ((time: number) => void) | null}>}));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = {enabled: false, type: 0}; outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => {scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene;});
    constructor() {gpu.instances.push(this);}
  }
  return {...actual, WebGLRenderer: OfflineRenderer};
});
const captured = vi.hoisted(() => ({avatars: [] as Array<LivingAvatarMesh & {baseScale: THREE.Vector3}>}));
vi.mock('@/lib/living-meshes', async original => {
  const actual = await original<typeof import('@/lib/living-meshes')>();
  return {...actual, buildAvatar: (...args: Parameters<typeof actual.buildAvatar>) => {
    const avatar = actual.buildAvatar(...args); captured.avatars.push({...avatar, baseScale: avatar.root.scale.clone()}); return avatar;
  }};
});
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  captured.avatars = []; gpu.instances = []; vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
  for (const key of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(key, vi.fn(() => {throw new Error('OFFLINE_ONLY');}));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose());
  expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** Independent measurement of rendered vertices, without collision/support helpers. */
function vertices(parts: readonly THREE.Object3D[]) {
  const result: THREE.Vector3[] = [];
  for (const part of parts) part.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) result.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld));
  });
  return result;
}

/** Closed-mesh parity plus real surface distance avoids treating rounded-box air corners as mattress. */
function physicalSolid(mesh: THREE.Mesh) {
  const positions = mesh.geometry.getAttribute('position'), indices = mesh.geometry.index, faces: THREE.Triangle[] = [];
  for (let index = 0; index < (indices?.count ?? positions.count); index += 3) {
    const points = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(index + offset) : index + offset).applyMatrix4(mesh.matrixWorld));
    faces.push(new THREE.Triangle(points[0], points[1], points[2]));
  }
  const bounds = new THREE.Box3().setFromObject(mesh, true).expandByScalar(-.006), ray = new THREE.Ray(), hit = new THREE.Vector3(), closest = new THREE.Vector3();
  const center = bounds.getCenter(new THREE.Vector3()), points = vertices([mesh]), unique = new Map<string, THREE.Plane>();
  for (const face of faces) {
    const plane = new THREE.Plane().setFromCoplanarPoints(face.a, face.b, face.c);
    if (plane.normal.lengthSq() < .5) continue;
    if (plane.distanceToPoint(center) > 0) plane.negate();
    const key = [...plane.normal.toArray(), plane.constant].map(value => value.toFixed(7)).join('/'); unique.set(key, plane);
  }
  const planes = [...unique.values()], convex = planes.length >= 4 && planes.every(plane => points.every(point => plane.distanceToPoint(point) <= 1e-6));
  const direction = new THREE.Vector3(1, .173205080756, .271828182845).normalize();
  return {bounds, planes, faces, convex, planeCount: planes.length, faceCount: faces.length, penetrates(point: THREE.Vector3) {
    if (!bounds.containsPoint(point)) return false;
    if (convex) return planes.every(plane => plane.distanceToPoint(point) < -.006);
    ray.set(point, direction); const crossings: number[] = []; let distance = Infinity;
    for (const face of faces) {
      distance = Math.min(distance, face.closestPointToPoint(point, closest).distanceTo(point));
      if (ray.intersectTriangle(face.a, face.b, face.c, false, hit)) {
        const value = hit.distanceTo(point); if (value > 1e-7 && !crossings.some(previous => Math.abs(previous - value) < 1e-7)) crossings.push(value);
      }
    }
    return crossings.length % 2 === 1 && distance > .006;
  }};
}

/** Exact vertical ray/triangle intersections indexed in XZ; independent of production support code. */
function supportingBedGap(bed: THREE.Object3D) {
  type Face = {a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; denominator: number};
  const cells = new Map<string, Face[]>(), size = .2;
  bed.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let index = 0; index < (indices?.count ?? positions.count); index += 3) {
      const [a, b, c] = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(index + offset) : index + offset).applyMatrix4(object.matrixWorld));
      const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(denominator) < 1e-12) continue;
      const face = {a, b, c, denominator};
      for (let x = Math.floor(Math.min(a.x, b.x, c.x) / size); x <= Math.floor(Math.max(a.x, b.x, c.x) / size); x++)
        for (let z = Math.floor(Math.min(a.z, b.z, c.z) / size); z <= Math.floor(Math.max(a.z, b.z, c.z) / size); z++) {
          const key = x + '/' + z, faces = cells.get(key) ?? []; faces.push(face); cells.set(key, faces);
        }
    }
  });
  return (point: THREE.Vector3) => {
    let gap = Infinity;
    for (const {a, b, c, denominator} of cells.get(Math.floor(point.x / size) + '/' + Math.floor(point.z / size)) ?? []) {
      const u = ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) / denominator;
      const v = ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) / denominator, w = 1 - u - v;
      if (u < -1e-8 || v < -1e-8 || w < -1e-8) continue;
      const distance = point.y - u * a.y - v * b.y - w * c.y;
      if (distance >= -.006) gap = Math.min(gap, Math.max(0, distance));
    }
    return gap;
  };
}


function triangleInsideConvex(face: THREE.Triangle, solid: ReturnType<typeof physicalSolid>) {
 if(!solid.bounds.intersectsTriangle(face)) return false;
 if(!solid.convex){
  const points=[face.a,face.b,face.c,face.getMidpoint(new THREE.Vector3())];
  for(const [a,b] of [[face.a,face.b],[face.b,face.c],[face.c,face.a]]){const n=Math.ceil(a.distanceTo(b)/.006);for(let i=1;i<n;i++)points.push(a.clone().lerp(b,i/n));}
  if(points.some(p=>solid.penetrates(p)))return true;
  // Include intersections through face interiors, not merely rendered vertices.
  // Each segment/triangle intersection is exact; only penetration deeper than
  // the explicit 6mm surface tolerance is a failure.
  const crossings:THREE.Vector3[]=[],ray=new THREE.Ray(),direction=new THREE.Vector3(),hit=new THREE.Vector3();
  for(const boundary of solid.faces){
   if(!new THREE.Box3().setFromPoints([boundary.a,boundary.b,boundary.c]).intersectsTriangle(face))continue;
   for(const [edges,surface] of [[[[face.a,face.b],[face.b,face.c],[face.c,face.a]],boundary],[[[boundary.a,boundary.b],[boundary.b,boundary.c],[boundary.c,boundary.a]],face]] as const){
    for(const [a,b]of edges){const length=direction.subVectors(b,a).length();if(length<1e-10)continue;ray.set(a,direction.multiplyScalar(1/length));if(ray.intersectTriangle(surface.a,surface.b,surface.c,false,hit)&&hit.distanceTo(a)<=length+1e-9)crossings.push(hit.clone());}
   }
  }
  for(let i=0;i<crossings.length;i++)for(let j=i+1;j<crossings.length;j++){
   const length=crossings[i].distanceTo(crossings[j]);if(length<=.012)continue;
   for(let distance=.006;distance<length;distance+=.006)if(solid.penetrates(crossings[i].clone().lerp(crossings[j],distance/length)))return true;
  }
  return false;
 }
 let polygon=[face.a.clone(),face.b.clone(),face.c.clone()];
 for(const plane of solid.planes){const next:THREE.Vector3[]=[];for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length],da=plane.distanceToPoint(a)+.006,db=plane.distanceToPoint(b)+.006;if(da<-1e-8)next.push(a);if((da<0)!==(db<0))next.push(a.clone().lerp(b,da/(da-db)));}polygon=next;if(!polygon.length)return false;}
 return polygon.length>0;
}
function renderedFaces(parts:readonly THREE.Object3D[]){const result:THREE.Triangle[]=[];for(const part of parts)part.traverse(o=>{if(!(o instanceof THREE.Mesh))return;const p=o.geometry.getAttribute('position'),idx=o.geometry.index;for(let i=0;i<(idx?.count??p.count);i+=3){const v=[0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(p,idx?idx.getX(i+j):i+j).applyMatrix4(o.matrixWorld));result.push(new THREE.Triangle(v[0],v[1],v[2]));}});return result;}
it.each([100,1000/60])('actual id5 enters from bed side, sits on edge, then lies with complete 6mm solid safety at %s ms', frameMs=>{
 const source={...structuredClone(current.group),me:'fixture-owner-1',companions:current.group.companions.map(c=>c.id===5?{...c,activity:'observe',area:'outdoor',x:.65,y:.55,leisure:null}:c)};
 const initial=parseGathering(source),items=JSON.stringify(initial.items),host=document.createElement('div'),labels=document.createElement('div');Object.defineProperties(host,{clientWidth:{value:390},clientHeight:{value:845}});document.body.append(host,labels);
 const requested=vi.fn(),world=createLivingWorld(host,labels,initial,vi.fn(),vi.fn(),{persistentWorld:true,realistic:true,localLeisurePreview:true,localRoomTransitions:true,localCompanionDoors:true,localReferenceVilla:true,localNaturalWorld:true,localNaturalLeisure:true,localQuietAudio:true,onLeisureRequest:requested});worlds.push(world);world.setHouseView('interior');world.update(initial,5,'bedroom');world.setMotion(true);
 const renderer=gpu.instances.at(-1)!,scene=renderer.scene!,avatar=captured.avatars.find(a=>a.root.userData.characterId===5)!,actor=avatar.root;let now=Date.now();const step=()=>{now+=frameMs;vi.setSystemTime(Math.round(now));renderer.loop!(Date.now());};for(let i=0;i<10;i++)step();
 scene.updateMatrixWorld(true);const bed=scene.getObjectByName('room-bed-0')!,mattress=bed.getObjectByName('room-bed-0-mattress')!;const bedBounds=new THREE.Box3().setFromObject(mattress,true),bedCenter=bedBounds.getCenter(new THREE.Vector3());
 const solids:Array<{name:string;solid:ReturnType<typeof physicalSolid>}>=[];bed.traverse(o=>{if(o instanceof THREE.Mesh)solids.push({name:o.name||'unnamed-bed-part-'+solids.length,solid:physicalSolid(o)});});expect(solids.length).toBeGreaterThan(3);
 const mattressSolid=physicalSolid(mattress as THREE.Mesh);expect(mattressSolid.penetrates(bedCenter)).toBe(true);const tolerance=bedCenter.clone();tolerance.y=bedBounds.max.y-.003;expect(mattressSolid.penetrates(tolerance)).toBe(false);
 const parts=[avatar.body,avatar.leftArm,avatar.rightArm,avatar.leftLeg,avatar.rightLeg];
 const staticSnapshot=()=>JSON.stringify(solids.map(({name},i)=>[name,(()=>{const meshes:THREE.Mesh[]=[];bed.traverse(o=>{if(o instanceof THREE.Mesh)meshes.push(o);});return meshes[i].matrixWorld.elements;})()]));const beforeStatic=staticSnapshot();
 const bedGap=supportingBedGap(bed),bearing:THREE.Object3D[]=[];avatar.body.traverse(o=>{if(o.userData.sleepBodySupport)bearing.push(o);});let sideEdgeSeatedAt:number|null=null,minimumSeatSupportGap=Infinity;
 let previous=vertices(parts),previousPosition=actor.position.clone(),firstCollision:unknown=null,firstDock:unknown=null,sawSeated=false,sawLying=false,lyingBeforeSeated=false,settled:number|null=null,maxJump=0,minScale=Infinity,maxScale=0;const samples:unknown[]=[];
 const sleep=parseGathering({...source,revision:source.revision+1,companions:source.companions.map(c=>c.id===5?{...c,activity:'sleep',area:'bedroom',x:.35,y:.65}:c),events:[]}),copy=JSON.stringify(sleep);world.update(sleep,5,'bedroom');
 for(let frame=0;frame<Math.ceil(120_000/frameMs);frame++){
  step();scene.updateMatrixWorld(true);const actual=vertices(parts),journey=actor.userData.homeJourney,scale=actor.scale.x/avatar.baseScale.x;maxJump=Math.max(maxJump,actor.position.distanceTo(previousPosition));minScale=Math.min(minScale,scale);maxScale=Math.max(maxScale,scale);
  if(journey?.phase==='dock'){
   firstDock??={frame,root:actor.position.toArray(),pose:journey.pose,bed:bedBounds,side:actor.position.x<bedBounds.min.x-.02||actor.position.x>bedBounds.max.x+.02,withinLength:actor.position.z>bedBounds.min.z+.1&&actor.position.z<bedBounds.max.z-.1};
   if((journey.pose.bedSeat??0)>.85&&Math.abs(actor.rotation.x)<.25){
    sawSeated=true;const edgeDistance=Math.min(Math.abs(actor.position.x-bedBounds.min.x),Math.abs(actor.position.x-bedBounds.max.x));
    if(edgeDistance<.6){let gap=Infinity;for(const point of vertices(bearing))gap=Math.min(gap,bedGap(point));minimumSeatSupportGap=Math.min(minimumSeatSupportGap,gap);if(gap<.03)sideEdgeSeatedAt??=frame;}
   }
   if(Math.abs(actor.rotation.x)>.8){sawLying=true;if(!sawSeated)lyingBeforeSeated=true;}
  }
  const totalBounds=new THREE.Box3().setFromPoints(actual),near=solids.filter(s=>s.solid.bounds.intersectsBox(totalBounds));
  if(firstCollision===null&&near.length){
   const faces=renderedFaces(parts);
   outer:for(const row of near){for(let i=0;i<faces.length;i++)if(triangleInsideConvex(faces[i],row.solid)){firstCollision={frame,method:'actual_rendered_triangle_into_6mm_solid',solid:row.name,triangle:i,phase:journey?.phase,pose:journey?.pose,root:actor.position.toArray()};break outer;}}
  }
  if(firstCollision===null){const direction=new THREE.Vector3(),ray=new THREE.Ray(),hit=new THREE.Vector3();outer:for(let i=0;i<actual.length;i++){const segmentBounds=new THREE.Box3().setFromPoints([previous[i],actual[i]]);for(const row of solids){if(!row.solid.bounds.intersectsBox(segmentBounds))continue;const len=direction.subVectors(actual[i],previous[i]).length();if(len<1e-8)continue;ray.set(previous[i],direction.multiplyScalar(1/len));if(!ray.intersectBox(row.solid.bounds,hit)||hit.distanceTo(previous[i])>len)continue;const start=hit.distanceTo(previous[i]);for(let d=start;d<=len;d+=.003){const point=previous[i].clone().addScaledVector(direction,d);if(row.solid.penetrates(point)){firstCollision={frame,method:'actual_render_vertex_sweep_into_6mm_solid',solid:row.name,vertex:i,point:point.toArray(),phase:journey?.phase,pose:journey?.pose,root:actor.position.toArray()};break outer;}}}}}
  samples.push({frame,root:actor.position.toArray(),rotation:actor.rotation.toArray(),phase:journey?.phase,contactBlend:journey?.contactBlend,pose:journey?.pose,nav:actor.userData.homeNavigation,collision:actor.userData.contactCollision,sleeping:!!actor.userData.sleepingBed});previous=actual;previousPosition=actor.position.clone();if(actor.userData.sleepingBed){settled??=frame;if(frame>=settled+10)break;}
 }
 const metrics={scope:'independent warm actual g59 phone ordinary downstairs side entry only',frameMs,firstDock,sawSeated,sideEdgeSeatedAt,minimumSeatSupportGap,sawLying,lyingBeforeSeated,firstCollision,settled,maxJump,minScale,maxScale,solids:solids.map(r=>({name:r.name,convex:r.solid.convex,faces:r.solid.faceCount,planes:r.solid.planeCount})),itemsPreserved:JSON.stringify(sleep.items)===items,staticPreserved:staticSnapshot()===beforeStatic,rendererCount:gpu.instances.length,samples};
 const dir=process.env.BED_ENTRY_METRICS_DIR;if(dir){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'entry-frame-'+frameMs+'.json'),JSON.stringify(metrics,null,2)+'\n');}console.info('SIDE_ENTRY_INDEPENDENT_SUMMARY '+JSON.stringify({...metrics,samples:undefined}));
 expect(firstDock,'actual warm journey enters docking').not.toBeNull();expect((firstDock as {side:boolean}|null)?.side,'entry begins alongside mattress rather than bed foot').toBe(true);expect((firstDock as {withinLength:boolean}|null)?.withinLength,'side approach lies within bed length').toBe(true);expect(sawSeated,'sit on bed edge visibly before lie').toBe(true);expect(sideEdgeSeatedAt,'seated torso reaches actual mattress support at long edge before reclining').not.toBeNull();expect(sawLying).toBe(true);expect(lyingBeforeSeated).toBe(false);expect(firstCollision,'all bed meshes and swept actual body triangles stay out of solid interior beyond 6mm').toBeNull();expect(settled).not.toBeNull();expect(maxJump).toBeLessThan(.3);expect(minScale).toBeGreaterThanOrEqual(.9-1e-6);expect(maxScale).toBeLessThanOrEqual(1+1e-6);expect(metrics.itemsPreserved).toBe(true);expect(metrics.staticPreserved).toBe(true);expect(JSON.stringify(sleep)).toBe(copy);expect(requested).not.toHaveBeenCalled();expect(gpu.instances).toHaveLength(1);
},180_000);
