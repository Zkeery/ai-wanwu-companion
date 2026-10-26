import * as THREE from 'three';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {buildHomeWorldEnvironment,applyHomeWorldArchitectureView} from '../lib/living-home-world-meshes';
import {applyVillaUpperView,stepVillaUpperDoor,setVillaUpperDoor,VILLA_UPPER_FLOOR_Y} from '../lib/living-villa-upper-floor';
import {collectHomeJourneyObstacles} from '../lib/living-home-journey-geometry';
import {disposeLivingObject} from '../lib/living-world-engine';
import {villaLifeFurniture} from '../lib/living-villa-life-plan';
let world:THREE.Group;
beforeEach(()=>{vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(()=>new THREE.Texture());vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No network');}));world=buildHomeWorldEnvironment('summer',{resting:2,sleeping:1},{realistic:true,referenceVilla:true});});
afterEach(()=>{disposeLivingObject(world);expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('shows separated upstairs rooms with a true doorway and supported furniture',()=>{
 const root=world.getObjectByName('home-villa-upper-interior')!;expect(root).toBeTruthy();expect(root.userData.walkingConnected).toBe(true);expect(root.userData.localVisitOnly).toBe(true);
 const floor=world.getObjectByName('villa-upper-wood-floor')!;const floorBox=new THREE.Box3().setFromObject(floor,true);expect(floorBox.min.y).toBeCloseTo(VILLA_UPPER_FLOOR_Y);
 const sofa=world.getObjectByName('villa-upper-sofa-sofa-main')!,bed=world.getObjectByName('villa-upper-bed-room-bed-0')!;
 for(const object of [sofa,bed]){const box=new THREE.Box3().setFromObject(object,true);expect(box.min.y).toBeCloseTo(floorBox.max.y);expect(box.max.y).toBeLessThan(6.7);}
 expect(new THREE.Box3().setFromObject(sofa,true).max.x).toBeLessThan(0);expect(new THREE.Box3().setFromObject(bed,true).min.x).toBeGreaterThan(0);
 const opening=new THREE.Box3(new THREE.Vector3(-.2,3.6,-3.85),new THREE.Vector3(.2,5.8,-1.7));
 for(const name of ['partition-back','partition-front','partition-lintel'])expect(new THREE.Box3().setFromObject(world.getObjectByName('villa-upper-'+name)!,true).intersectsBox(opening)).toBe(false);
});
it('changes upper cutaway only and restores original exterior materials and ground collisions',()=>{
 const collision=collectHomeJourneyObstacles(world,null),ground=world.getObjectByName('sofa-main')!,original=ground.matrixWorld.toArray();
 const roof=world.getObjectByName('home-reference-villa-blue-grey-hip-roof')!,shell=world.getObjectByName('home-reference-villa-upper-and-roof')!;
 const front=world.getObjectByName('home-reference-villa-upper-front-plaster') as THREE.Mesh;const material=front.material as THREE.Material;const opacity=material.opacity;
 applyHomeWorldArchitectureView(world,'interior',{x:11,y:13,z:12});applyVillaUpperView(world,true,{x:11,y:13,z:12},false);
 expect(shell.visible).toBe(true);expect(roof.visible).toBe(false);expect(material.opacity).toBeLessThan(opacity);expect(world.getObjectByName('home-villa-upper-interior')!.visible).toBe(true);
 expect(collectHomeJourneyObstacles(world,null)).toEqual(collision);expect(ground.matrixWorld.toArray()).toEqual(original);
 applyHomeWorldArchitectureView(world,'exterior',{x:11,y:13,z:12});applyVillaUpperView(world,false,{x:11,y:13,z:12},true);
 expect(roof.visible).toBe(true);expect(material.opacity).toBe(opacity);
 applyHomeWorldArchitectureView(world,'interior',{x:0,y:2,z:0});applyVillaUpperView(world,false,{x:0,y:2,z:0},false);expect(shell.visible).toBe(false);expect(world.getObjectByName('home-villa-upper-interior')!.visible).toBe(false);
});
it('rotates the upper bedroom door continuously and honors pause, hidden, reverse and invalid time',()=>{
 const door=world.getObjectByName('villa-upper-bedroom-door')!;setVillaUpperDoor(world,true);
 stepVillaUpperDoor(world,.1,true);const angle=door.rotation.y;expect(angle).toBeLessThan(0);expect(angle).toBeGreaterThan(-Math.PI*.48);
 stepVillaUpperDoor(world,10,false);stepVillaUpperDoor(world,NaN,true);expect(door.rotation.y).toBe(angle);
 for(let i=0;i<20;i++)stepVillaUpperDoor(world,.1,true);expect(door.rotation.y).toBeCloseTo(-Math.PI*.48);
 setVillaUpperDoor(world,false);for(let i=0;i<20;i++)stepVillaUpperDoor(world,.1,true);expect(door.rotation.y).toBeCloseTo(0);
});
it('supports sleeping feet above the raised quilt binding without using the distant headboard height',()=>{
 const furniture=villaLifeFurniture(world)!,bed=world.getObjectByName('villa-upper-bed-room-bed-0')!;
 const quilt=new THREE.Box3().setFromObject(world.getObjectByName('villa-upper-bed-room-bed-0-foot-quilt')!,true);
 const binding=bed.children.find(o=>{const b=new THREE.Box3().setFromObject(o,true);return b.max.y>quilt.max.y&&b.min.z>=quilt.min.z&&b.max.z<=quilt.max.z;})!;
 expect(binding).toBeDefined();const top=new THREE.Box3().setFromObject(binding,true).max.y;
 expect(furniture.bed.y+furniture.bed.footLift).toBeGreaterThan(top);
 expect(furniture.bed.y+furniture.bed.footLift-top).toBeLessThan(.01);
 binding.position.y+=.02;const raised=villaLifeFurniture(world)!;
 expect(raised.bed.footLift-furniture.bed.footLift).toBeCloseTo(.02);
});
