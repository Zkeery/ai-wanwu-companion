import * as THREE from 'three';
import {createLivingNavigation,type NavBounds} from './living-navigation';
import {VILLA_STAIR_ROUTE} from './living-villa-stair-visit';
import type {VillaActivity,VillaLifePlan,VillaLifePose} from './living-villa-floor-life';
export const VILLA_LIFE_FLOOR=3.496;
export function villaLifeFurniture(world:THREE.Object3D){
 world.updateWorldMatrix(true,true);const bed=world.getObjectByName('villa-upper-bed-room-bed-0-mattress'),seat=world.getObjectByName('villa-upper-sofa-sofa-main-seat');if(!bed||!seat)return null;
 const b=new THREE.Box3().setFromObject(bed,true),s=new THREE.Box3().setFromObject(seat,true),quilt=new THREE.Box3().setFromObject(world.getObjectByName('villa-upper-bed-room-bed-0-foot-quilt')??bed,true);
 let footSurface=quilt.max.y;
 // The quilt's raised binding is a separate mesh. Include all actual bed
 // surfaces over its footprint so the legs also clear that physical edge.
 world.getObjectByName('villa-upper-bed-room-bed-0')?.traverse(object=>{
  if(!(object instanceof THREE.Mesh))return;const bounds=new THREE.Box3().setFromObject(object,true);
  if(bounds.max.x>=quilt.min.x&&bounds.min.x<=quilt.max.x&&bounds.max.z>=quilt.min.z&&bounds.min.z<=quilt.max.z)footSurface=Math.max(footSurface,bounds.max.y);
 });
 return{bed:{x:(b.min.x+b.max.x)/2,y:b.max.y,z:(b.min.z+b.max.z)/2,length:b.max.z-b.min.z,footLift:Math.max(0,footSurface-b.max.y)+.008,support:'villa-upper-bed-room-bed-0'},seat:{x:(s.min.x+s.max.x)/2,y:s.max.y,z:(s.min.z+s.max.z)/2+.5,support:'villa-upper-sofa-sofa-main'}};
}
export function villaLifeObstacles(world:THREE.Object3D):Array<NavBounds&{name:string}>{
 world.updateWorldMatrix(true,true);const out:Array<NavBounds&{name:string}>=[];const add=(o:THREE.Object3D)=>{const b=new THREE.Box3().setFromObject(o,true);out.push({name:o.name,minX:b.min.x,maxX:b.max.x,minZ:b.min.z,maxZ:b.max.z});};
 for(const name of ['villa-upper-bed-room-bed-0','villa-upper-sofa-sofa-main','villa-upper-bedside-room-bedside-table-0','villa-upper-side-table-room-side-table','villa-upper-bookcase-room-bookcase','villa-upper-coffee-table','villa-upper-partition-back','villa-upper-partition-front']){const o=world.getObjectByName(name);if(o)add(o);}
 out.push({name:'stair-opening-and-guard',minX:.3675,maxX:2.9325,minZ:-7.1,maxZ:-3.7675});
 // Open door leaf remains a real obstacle; the actor waits for its hinge before crossing.
 out.push({name:'upper-open-door',minX:-2.4,maxX:.04,minZ:-4.04,maxZ:-3.7});return out;
}
export function buildVillaLifePlan(world:THREE.Object3D,activity:VillaActivity,radius:number,target:VillaLifePose):VillaLifePlan|null{
 const furniture=villaLifeFurniture(world);if(!furniture)return null;const approach=activity==='sleep'?{x:3.97,z:furniture.bed.z}:activity==='rest'?{x:furniture.seat.x,z:furniture.seat.z+1.65}:{x:6.95,z:-7.15};
 const graph=createLivingNavigation({bounds:{minX:-8.16,maxX:8.16,minZ:-8.15,maxZ:-1.55},blocked:villaLifeObstacles(world),clearance:radius,step:.16}),start=VILLA_STAIR_ROUTE.at(-1)!;
 const path=graph.planTo({from:start,to:approach,id:activity});if(path.blocked||!path.points.length||Math.hypot(path.points[0].x-start.x,path.points[0].z-start.z)>.001||Math.hypot(path.points.at(-1)!.x-approach.x,path.points.at(-1)!.z-approach.z)>.001)return null;
 const points:VillaLifePose[]=path.points.map(p=>({...p,y:VILLA_LIFE_FLOOR,yaw:0,tilt:0,scale:1,blend:0}));
 if(activity!=='observe'){const from=points.at(-1)!;for(let i=1;i<=30;i++){const t=i/30;points.push({x:from.x+(target.x-from.x)*t,y:from.y+(target.y-from.y)*t+Math.sin(Math.PI*t)*.35,z:from.z+(target.z-from.z)*t,yaw:target.yaw,tilt:target.tilt*t,scale:1+(target.scale-1)*t,blend:t});}}
 return{activity,points,support:activity==='sleep'?[furniture.bed.support]:activity==='rest'?[furniture.seat.support]:[]};
}
