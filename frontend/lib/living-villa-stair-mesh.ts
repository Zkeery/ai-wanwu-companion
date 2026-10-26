import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
const footprint=new THREE.Box3(new THREE.Vector3(.48,0,-7.15),new THREE.Vector3(2.82,3.496,-2.47));
/** Keep every existing ground furnishing. Crowded bedroom layouts retain their furniture and have no stair. */
export function buildVillaIndoorStair(world:THREE.Group):boolean{
 if(world.getObjectByName('villa-indoor-stair'))return true;
 world.updateMatrixWorld(true);let collision=false;
 world.traverse(o=>{if(o.userData.homeNavObstacle&&/^(room-bed-|room-bedside-table-)/.test(o.name)&&new THREE.Box3().setFromObject(o,true).intersectsBox(footprint))collision=true;});
 if(collision){world.userData.villaStairUnavailable='existing-bedroom-furniture';return false;}
 const root=new THREE.Group();root.name='villa-indoor-stair';root.userData.villaStair=true;world.add(root);
 const wood=new THREE.MeshStandardMaterial({color:'#978166',roughness:.82}),rail=new THREE.MeshStandardMaterial({color:'#454d4a',roughness:.55,metalness:.4});
 function box(name:string,x:number,y:number,z:number,w:number,h:number,d:number,material=wood){const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);mesh.name=name;mesh.userData.homeNavObstacle=true;mesh.position.set(x,y,z);mesh.castShadow=mesh.receiveShadow=true;root.add(mesh);return mesh;}
 const rise=3.496/20,tread=4.6/20;
 for(let n=0;n<20;n++)box('villa-stair-tread-'+n,1.65,rise*(n+1)/2,-2.5-tread*(n+.5),2.24,rise*(n+1),tread+.002);
 for(const x of [.5,2.8]){
  for(let n=0;n<=16;n+=2)box('villa-stair-post-'+x+'-'+n,x,3.496*n/20+.5,-2.5-4.6*n/20,.045,1,.045,rail);
  const bar=box('villa-stair-handrail-'+x,x,3.496*.4+1,-2.5-4.6*.4,.065,.065,Math.hypot(3.496,4.6)*.8,rail);bar.rotation.x=Math.atan2(3.496,4.6);
 }
 // The upper exit is to the right of the final tread. A real opening clears the actor's head through both slabs.
 for(const name of ['home-reference-villa-upper-floor-slab','villa-upper-wood-floor']){
  const mesh=world.getObjectByName(name);if(!(mesh instanceof THREE.Mesh))continue;
  mesh.updateWorldMatrix(true,false);const b=new THREE.Box3().setFromObject(mesh,true),y=(b.min.y+b.max.y)/2,h=b.max.y-b.min.y;
  const regions=[[b.min.x,.45,b.min.z,b.max.z],[2.85,b.max.x,b.min.z,b.max.z],[.45,2.85,b.min.z,-7.1],[.45,2.85,-3.8,b.max.z]];
  const parts=regions.filter(([x1,x2,z1,z2])=>x2>x1&&z2>z1).map(([x1,x2,z1,z2])=>new THREE.BoxGeometry(x2-x1,h,z2-z1).translate((x1+x2)/2,y,(z1+z2)/2).applyMatrix4(mesh.matrixWorld.clone().invert()));
  const geometry=mergeGeometries(parts,false);parts.forEach(p=>p.dispose());if(geometry){mesh.geometry.dispose();mesh.geometry=geometry;mesh.userData.stairOpening={minX:.45,maxX:2.85,minZ:-7.1,maxZ:-3.8};}
 }
 for(const x of [.4,2.9]){box('villa-stair-handrail-upper-'+x,x,4.536,-4.9,.065,.065,2.2,rail);for(const z of [-6,-4.9,-3.8])box('villa-stair-post-upper-'+x+'-'+z,x,4.016,z,.045,1.04,.045,rail);}
 box('villa-stair-handrail-front',1.65,4.536,-3.8,2.5,.065,.065,rail);
 const upper=world.getObjectByName('home-villa-upper-interior');if(upper){upper.userData.walkingConnected=true;upper.userData.localVisitOnly=true;}
 world.userData.referenceVilla.upperFloorVisualOnly=false;world.userData.referenceVilla.localVisitFloors=[1,2];world.userData.referenceVilla.upperFloorLocalVisitOnly=true;
 // These are new upper-storey furnishings, not saved ground-floor assets.
 const upperBed=world.getObjectByName('villa-upper-bed-room-bed-0');if(upperBed){upperBed.position.x+=1.6;upperBed.position.z+=.95;}
 root.userData.stairDimensions={width:2.24,rise,tread,steps:20};world.userData.villaStairAvailable=true;world.updateMatrixWorld(true);return true;
}

/** Lift each real shoe onto the next tread/landing, instead of driving it through a floor slab. */
export function supportVillaStairFeet(root:THREE.Object3D,legs:readonly THREE.Object3D[],knees:readonly THREE.Object3D[]){
 function support(x:number,z:number){
  if(x>=.53&&x<=2.77&&z>=-7.1&&z<=-2.5)return Math.min(20,Math.max(1,Math.ceil((-2.5-z)/4.6*20)))*3.496/20;
  if(x>=-8.2&&x<=8.2&&z>=-8.15&&z<=-1.55&&(x<=.45||x>=2.85||z<=-7.1||z>=-3.8))return 3.496;
  return 0;
 }
 root.updateWorldMatrix(true,true);
 for(let i=0;i<legs.length;i++){
  const foot=knees[i]?.children.at(-1);if(!foot)continue;const b=new THREE.Box3().setFromObject(foot,true);let y=0;
  // Use the footprint corners and centre; no reduced avatar radius or collider.
  for(const x of [b.min.x,(b.min.x+b.max.x)/2,b.max.x])for(const z of [b.min.z,(b.min.z+b.max.z)/2,b.max.z])y=Math.max(y,support(x,z));
  // Ground actors below the first floor cannot stand on the ceiling outside the stair opening.
  if(root.position.y<1&&y>root.position.y+.6)continue;
  const lift=Math.max(0,y+.004-b.min.y);legs[i].position.y+=lift/root.scale.y;legs[i].updateWorldMatrix(true,true);
 }
}
