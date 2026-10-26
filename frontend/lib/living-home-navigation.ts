import * as THREE from 'three';
import { HOME_WORLD_REGIONS } from './living-home-world';
import type { GatheringArea } from './gatherings';

export type HomeNavBounds = { minX: number; maxX: number; minZ: number; maxZ: number };
export type HomeNavigationObstacle = HomeNavBounds & { source: string };
const finiteBounds = (b: THREE.Box3) => !b.isEmpty() && [b.min.x,b.max.x,b.min.z,b.max.z,b.min.y,b.max.y].every(Number.isFinite);
/** Regions remain separate; a saved activity changes rooms, this visual walk never crosses a door. */
export function homeNavigationBounds(area: GatheringArea): HomeNavBounds {
  const c = HOME_WORLD_REGIONS[area].center;
  return { minX:c.x-5.3,maxX:c.x+5.3,minZ:c.z-3.78,maxZ:c.z+3.78 };
}
function architectureRole(object: THREE.Object3D): string | undefined {
  for(let p: THREE.Object3D|null=object;p;p=p.parent) if(typeof p.userData.architectureRole==='string') return p.userData.architectureRole;
}
/** Actual physical bounds, independent of cutaway visibility/transparent walls. */
export function collectHomeNavigationObstacles(environment: THREE.Object3D|null, items: THREE.Object3D|null, doorSweeps: readonly string[] = []): HomeNavigationObstacle[] {
  const result: HomeNavigationObstacle[]=[];
  const add=(object:THREE.Object3D, custom?:THREE.Box3)=>{
    const b=custom??new THREE.Box3().setFromObject(object,true);
    if(!finiteBounds(b)||b.max.y<.05||b.min.y>1.6)return;
    result.push({minX:b.min.x-.002,maxX:b.max.x+.002,minZ:b.min.z-.002,maxZ:b.max.z+.002,source:object.name||object.uuid});
  };
  for(const root of [environment,items]){
    if(!root)continue; root.updateWorldMatrix(true,true);
    const visit=(object:THREE.Object3D)=>{
      if(object.userData.homeNavObstacle===true){add(object);return;}
      const role=architectureRole(object);
      if(object instanceof THREE.Mesh && (role?.startsWith('exterior-wall')||role==='interior-partition'||role==='door'||role==='courtyard-wall'))add(object);
      for(const child of object.children)visit(child);
    }; visit(root);
  }
  for(const id of doorSweeps){
    const door=environment?.getObjectByName(id),leaf=door?.getObjectByName(id+'-leaf');if(!leaf)continue;
    const previous=leaf.rotation.y,box=new THREE.Box3();
    try{for(let i=0;i<=8;i++){leaf.rotation.y=-68*Math.PI/180*i/8;leaf.updateWorldMatrix(true,true);box.union(new THREE.Box3().setFromObject(leaf,true));}}
    finally{leaf.rotation.y=previous;leaf.updateWorldMatrix(true,true);}
    // The continuous swept arc lies inside the sampled hull plus this angular margin.
    box.expandByScalar(.12);add(leaf,box);
  }
  return result;
}
/** A rotation-safe disk covers the body, raised arms and the walking foot swing. */
export function homeAvatarNavigationClearance(root:THREE.Object3D):number {
  root.updateWorldMatrix(true,true);const b=new THREE.Box3().setFromObject(root,true),origin=root.getWorldPosition(new THREE.Vector3());
  if(!finiteBounds(b))return .9;
  const x=Math.max(Math.abs(b.min.x-origin.x),Math.abs(b.max.x-origin.x)),z=Math.max(Math.abs(b.min.z-origin.z),Math.abs(b.max.z-origin.z));
  return Math.max(.45,Math.hypot(x,z)+.22);
}
