import * as THREE from 'three';
import type { HomeMaterialLibrary, HomeMaterialRole } from './living-home-materials';

export const VILLA_UPPER_FLOOR_Y = 3.46;
export const VILLA_UPPER_CAMERA = { target: [0, 4.15, -4.55] as const, position: [11, 13, 12] as const, minDistance: 5, maxDistance: 28 };
const ROOT='home-villa-upper-interior';
/** Upper rooms share physical furnishings with the local collision-checked floor-life controller. */
export function buildVillaUpperInterior(world: THREE.Group): void {
  if(world.getObjectByName(ROOT))return;
  const shell=world.getObjectByName('home-reference-villa-upper-and-roof');if(!shell)return;
  const root=new THREE.Group();root.name=ROOT;root.userData.upperFloorInterior=true;root.visible=false;world.add(root);
  const library=world.userData.homeMaterialLibrary as HomeMaterialLibrary|undefined;
  const materials=new Map<string,THREE.MeshStandardMaterial>();
  function surface(color:string,role:HomeMaterialRole){const key=role+color;let value=materials.get(key);if(!value){value=library?.material(role,color,ROOT+key)??new THREE.MeshStandardMaterial({color,roughness:.86});materials.set(key,value);}return value;}
  function box(name:string,x:number,y:number,z:number,w:number,h:number,d:number,color:string,role:HomeMaterialRole='wood'){
    const geo=new THREE.BoxGeometry(w,h,d);library?.uv(geo,role);const value=new THREE.Mesh(geo,surface(color,role));value.name='villa-upper-'+name;value.userData.homeNavObstacle=!/floor|rug|lintel|header/.test(name);value.position.set(x,y,z);value.castShadow=true;value.receiveShadow=true;root.add(value);return value;
  }
  // Upper furnishings reuse local assets; their own collision tags never enter the ground-floor map.
  function furnishing(sourceName:string,name:string,x:number,z:number){
    const source=world.getObjectByName(sourceName);if(!source)return;
    const copy=source.clone(true);copy.traverse(o=>{o.name='villa-upper-'+name+'-'+o.name;o.userData={upperFloorFurniture:true};o.visible=true;});
    copy.userData.homeNavObstacle=true;copy.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(copy,true),center=bounds.getCenter(new THREE.Vector3());
    copy.position.x+=x-center.x;copy.position.z+=z-center.z;copy.position.y+=VILLA_UPPER_FLOOR_Y+.036-bounds.min.y;root.add(copy);
  }
  box('wood-floor',0,VILLA_UPPER_FLOOR_Y+.018,-4.875,16.55,.036,6.6,'#a38b69','wood-floor');
  // Two separate rooms; the central doorway has physical jambs, lintel and a rotating leaf.
  const bottom=VILLA_UPPER_FLOOR_Y+.036,doorZ=-2.75,doorWidth=2.4,wallTop=6.72,doorTop=bottom+2.5;
  box('partition-back',0,(bottom+wallTop)/2,-6.055,.17,wallTop-bottom,4.21,'#dedbd0','plaster');
  box('partition-front',0,(bottom+wallTop)/2,-1.575,.17,wallTop-bottom,.05,'#dedbd0','plaster');
  box('partition-lintel',0,(doorTop+wallTop)/2,doorZ,.17,wallTop-doorTop,doorWidth,'#dedbd0','plaster');
  for(const z of [doorZ-doorWidth/2,doorZ+doorWidth/2])box('door-jamb-'+z,0,bottom+1.25,z,.27,2.5,.09,'#705c45');
  box('door-header',0,doorTop,doorZ,.27,.12,doorWidth+.12,'#705c45');
  const hinge=new THREE.Group();hinge.name='villa-upper-bedroom-door';hinge.position.set(0,bottom,doorZ-doorWidth/2);hinge.userData.upperFloorDoor=true;root.add(hinge);
  const leaf=new THREE.Mesh(new THREE.BoxGeometry(.075,2.4,doorWidth-.11),surface('#887257','wood'));leaf.position.set(0,1.2,(doorWidth-.11)/2+.045);leaf.castShadow=true;leaf.receiveShadow=true;hinge.add(leaf);
  const handle=new THREE.Mesh(new THREE.SphereGeometry(.065,8,6),surface('#565b56','metal'));handle.position.set(-.09,1.15,doorWidth-.25);hinge.add(handle);
  root.userData.door={requested:false,progress:0};
  furnishing('sofa-main','sofa',-4.2,-6.35);
  furnishing('room-bed-0','bed',4.6,-5.1);
  furnishing('room-bedside-table-0','bedside',7.7,-2.0);
  furnishing('room-side-table','side-table',-6.9,-6.0);
  furnishing('room-bookcase','bookcase',-7.35,-3.45);
  box('lounge-rug',-4.2,bottom+.055,-4.55,4.5,.035,2.25,'#bfc3ad','fabric');
  box('coffee-table',-6.7,bottom+.51,-2.4,1.8,.12,.85,'#8b7355');
  for(const x of [-7.42,-5.98])for(const z of [-2.7,-2.1])box('table-leg-'+x+'-'+z,x,bottom+.25,z,.08,.5,.08,'#67573f');
  box('bedroom-rug',4.6,bottom+.05,-4.1,3.5,.025,3.6,'#b8beb0','fabric');
  // Keep the circulation space clear; staircase and actor paths are connected by separate modules.
  root.userData.rooms={lounge:{minX:-8.2,maxX:-.1,minZ:-8.15,maxZ:-1.55},bedroom:{minX:.1,maxX:8.2,minZ:-8.15,maxZ:-1.55}};
  root.userData.walkingConnected=false;
  const retained=new Set<THREE.Material>(),archive=world.getObjectByName('home-reference-villa-retained-materials');
  shell.traverse(o=>{
    if(o instanceof THREE.Mesh&&/upper-(front|back|side-walls)/.test(o.name)){
      for(const material of Array.isArray(o.material)?o.material:[o.material])if(archive&&!retained.has(material)){retained.add(material);const holder=new THREE.Mesh(new THREE.BufferGeometry(),material);holder.name='villa-upper-retained-shell-material';archive.add(holder);}
      o.material=Array.isArray(o.material)?o.material.map(m=>m.clone()):o.material.clone();
      for(const m of Array.isArray(o.material)?o.material:[o.material]){m.userData={...m.userData,upperBaseOpacity:m.opacity,upperBaseTransparent:m.transparent,upperBaseDepthWrite:m.depthWrite};}
    }
  });
  world.userData.upperFloorView=false;world.updateMatrixWorld(true);
}
export function applyVillaUpperView(world:THREE.Object3D,enabled:boolean,camera:{x:number;y:number;z:number},exterior:boolean):void{
  const root=world.getObjectByName(ROOT),shell=world.getObjectByName('home-reference-villa-upper-and-roof');if(!root||!shell)return;
  root.visible=enabled||exterior;shell.visible=enabled||exterior;world.userData.upperFloorView=enabled;
  shell.traverse(o=>{
    if(o===shell)return;
    if(/hip-roof|individual-tile-ribs|roof-ridge|eave-fascia|upper-cornice/.test(o.name))o.visible=!enabled;
    if(!(o instanceof THREE.Mesh))return;
    const fade=enabled&&(/upper-front/.test(o.name)&&camera.z>-1.45||/upper-back/.test(o.name)&&camera.z<-8.3||/upper-side-walls/.test(o.name));
    const solidCutaway=!!world.userData.softCottage;
    for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.userData.upperBaseOpacity!==undefined){
      if(solidCutaway)o.visible=!fade;
      const translucent=fade&&!solidCutaway;
      m.opacity=translucent?.18:m.userData.upperBaseOpacity;m.transparent=translucent||m.userData.upperBaseTransparent;m.depthWrite=translucent?false:m.userData.upperBaseDepthWrite;
    }
    o.castShadow=fade?false:o.userData.baseCastShadow??true;o.userData.homeWallGhost=fade;
  });
}
export function setVillaUpperDoor(world:THREE.Object3D,open:boolean):boolean{const root=world.getObjectByName(ROOT);if(!root)return false;root.userData.door.requested=open;return true;}
export function stepVillaUpperDoor(world:THREE.Object3D,dt:number,moving:boolean):void{
  const root=world.getObjectByName(ROOT),door=root?.getObjectByName('villa-upper-bedroom-door');if(!root||!door||!moving||!Number.isFinite(dt)||dt<=0)return;
  const state=root.userData.door,target=state.requested?1:0;
  state.progress+=Math.sign(target-state.progress)*Math.min(Math.abs(target-state.progress),Math.min(.1,dt)*1.6);
  door.rotation.y=-state.progress*Math.PI*.48;
}
