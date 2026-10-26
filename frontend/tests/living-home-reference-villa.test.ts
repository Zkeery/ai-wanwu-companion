import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyReferenceCourtyardVilla } from '../lib/living-home-reference-villa';
import { buildHomeWorldEnvironment, applyHomeWorldArchitectureView } from '../lib/living-home-world-meshes';
import { collectHomeJourneyObstacles } from '../lib/living-home-journey-geometry';

const roots:THREE.Group[]=[];
beforeEach(()=>{vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(()=>new THREE.Texture<HTMLImageElement>());vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('reference villa must stay offline');}));});
afterEach(()=>{const geometry=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();for(const root of roots.splice(0))root.traverse(object=>{if(object instanceof THREE.Mesh){geometry.add(object.geometry);for(const value of Array.isArray(object.material)?object.material:[object.material])materials.add(value);}});geometry.forEach(value=>value.dispose());materials.forEach(value=>value.dispose());expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.restoreAllMocks();});
function environment(){const value=buildHomeWorldEnvironment('summer',{resting:2,sleeping:2},{realistic:true});roots.push(value);return value;}
function nodes(root:THREE.Group){const result:THREE.Object3D[]=[];root.traverse(o=>result.push(o));return result;}
function bounds(object:THREE.Object3D){object.updateWorldMatrix(true,true);return new THREE.Box3().setFromObject(object,true);}
function triangles(root:THREE.Object3D){let count=0,draws=0;root.traverse(object=>{if(object instanceof THREE.Mesh){count+=(object.geometry.index?.count??object.geometry.getAttribute('position')?.count??0)/3*(object instanceof THREE.InstancedMesh?object.count:1);draws++;}});return{count,draws};}

describe('explicit reference white courtyard villa visual variant',()=>{
  it('keeps every original transform, room, furniture, door ID and collision slab unchanged',()=>{
    const world=environment(),original=nodes(world).map(object=>({object,position:object.position.toArray(),quaternion:object.quaternion.toArray(),scale:object.scale.toArray(),slabs:JSON.stringify(object.userData.homeJourneySlabs),opening:JSON.stringify(object.userData.opening)}));
    const before=collectHomeJourneyObstacles(world,null);applyReferenceCourtyardVilla(world);
    for(const old of original){expect(old.object.position.toArray()).toEqual(old.position);expect(old.object.quaternion.toArray()).toEqual(old.quaternion);expect(old.object.scale.toArray()).toEqual(old.scale);expect(JSON.stringify(old.object.userData.homeJourneySlabs)).toBe(old.slabs);expect(JSON.stringify(old.object.userData.opening)).toBe(old.opening);}
    expect(collectHomeJourneyObstacles(world,null)).toEqual(before);
    for(const id of ['home-main-entry-door','home-room-connection-door','home-courtyard-gate'])expect(world.getObjectByName(id+'-leaf')).toBe(original.find(x=>x.object.name===id+'-leaf')?.object);
  });
  it('has a solid four-slope blue-grey roof, recessed upper floor and black balcony railing',()=>{
    const world=environment();applyReferenceCourtyardVilla(world);
    const roof=world.getObjectByName('home-reference-villa-blue-grey-hip-roof') as THREE.Mesh;
    expect(roof.userData.roofForm).toBe('four-slope-hip');expect((roof.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('536978');
    expect(bounds(roof).min.y).toBeCloseTo(7.02);expect(bounds(roof).max.y).toBeCloseTo(9.02);
    expect(world.getObjectByName('home-reference-villa-black-balcony-railings')).toBeTruthy();
    const glass=world.getObjectByName('home-reference-villa-upper-front-window-0-warm-glass') as THREE.Mesh;
    expect((glass.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(.035);
    expect(world.userData.referenceVilla.upperFloorVisualOnly).toBe(true);expect(world.userData.referenceVilla.accessibleFloors).toEqual([1]);
  });
  it('keeps every new low solid outside the original courtyard walking bounds',()=>{
    const world=environment(),old=new Set(nodes(world));applyReferenceCourtyardVilla(world);
    for(const object of nodes(world)){if(old.has(object)||!(object instanceof THREE.Mesh)||!object.geometry.getAttribute('position')||object.userData.referenceVillaGarden)continue;const box=bounds(object);if(box.min.y<=1.6&&box.max.y>=.05)expect(box.min.z,object.name).toBeGreaterThan(8.3);}
  });
  it('leaves a real open gatehouse corridor aligned with the original courtyard gate',()=>{
    const world=environment();applyReferenceCourtyardVilla(world);const gatehouse=world.getObjectByName('home-reference-villa-front-gatehouse')!;
    for(const x of [-1.2,0,1.2])for(const y of [.6,1.5,2.4]){const ray=new THREE.Raycaster(new THREE.Vector3(x,y,8.3),new THREE.Vector3(0,0,1),0,3);expect(ray.intersectObject(gatehouse,true),x+':'+y).toHaveLength(0);}
  });
  it('uses cutaway upper architecture without removing or orphaning the previous roof resources',()=>{
    const world=environment(),old=world.getObjectByName('home-common-gabled-roof')!;applyReferenceCourtyardVilla(world);
    expect(old.parent).not.toBeNull();expect(old.userData.referenceVillaSuperseded).toBe(true);expect(old.visible).toBe(false);
    const upper=world.getObjectByName('home-reference-villa-upper-and-roof')!;
    expect(upper.userData.architectureManaged).toBe(true);expect(upper.userData.architectureRole).toBe('roof');
    applyHomeWorldArchitectureView(world,'interior',{x:15,y:10,z:20});expect(upper.visible).toBe(false);
    applyHomeWorldArchitectureView(world,'exterior',{x:15,y:10,z:20});expect(upper.visible).toBe(true);
  });
  it('does not mutate pre-existing shared materials and retains displaced materials for disposal',()=>{
    const world=environment();const oldMaterial=(world.getObjectByName('home-exterior-front-low-wall-body') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const before={color:oldMaterial.color.getHexString(),map:oldMaterial.map,roughness:oldMaterial.roughness};applyReferenceCourtyardVilla(world);
    expect(oldMaterial.color.getHexString()).toBe(before.color);expect(oldMaterial.map).toBe(before.map);expect(oldMaterial.roughness).toBe(before.roughness);
    const archive=world.getObjectByName('home-reference-villa-retained-materials')!;expect(archive.visible).toBe(false);
    expect(archive.children.some(child=>child instanceof THREE.Mesh&&child.material===oldMaterial)).toBe(true);
    const material=(world.getObjectByName('home-exterior-front-low-wall-body') as THREE.Mesh).material as THREE.MeshStandardMaterial;expect(material).not.toBe(oldMaterial);expect(material.color.getHexString()).toBe('e4e4dc');
  });
  it('is idempotent, keeps the no-flag default cottage unchanged and adds no texture requests',()=>{
    const world=environment(),classic=environment();const calls=vi.mocked(THREE.TextureLoader.prototype.load).mock.calls.length;
    applyReferenceCourtyardVilla(world);const count=nodes(world).length;applyReferenceCourtyardVilla(world);expect(nodes(world).length).toBe(count);
    expect(classic.getObjectByName('home-reference-villa-upper-and-roof')).toBeUndefined();expect(classic.getObjectByName('home-common-gabled-roof')!.userData.referenceVillaSuperseded).toBeUndefined();
    expect(vi.mocked(THREE.TextureLoader.prototype.load).mock.calls.length).toBe(calls);
  });
  it('places the entire flower garden outside all three existing walk regions and the central approach',()=>{
    const world=environment();applyReferenceCourtyardVilla(world);const garden=world.getObjectByName('home-reference-villa-outside-flower-garden')!;
    const walking=[{minX:-10.95,maxX:-.35,minZ:-7.98,maxZ:-.42},{minX:.35,maxX:10.95,minZ:-7.98,maxZ:-.42},{minX:-5.3,maxX:5.3,minZ:.32,maxZ:7.88},{minX:-1.4,maxX:1.4,minZ:8.22,maxZ:14}];
    garden.traverse(object=>{if(!(object instanceof THREE.Mesh))return;const geometry=object.geometry;if(object instanceof THREE.InstancedMesh){for(let i=0;i<object.count;i++){const transform=new THREE.Matrix4();object.getMatrixAt(i,transform);geometry.computeBoundingBox();const box=geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(object.matrixWorld,transform));for(const r of walking)expect(box.max.x<=r.minX||box.min.x>=r.maxX||box.max.z<=r.minZ||box.min.z>=r.maxZ,object.name+':'+i).toBe(true);}}else{geometry.computeBoundingBox();const position=geometry.getAttribute('position');for(let i=0;i<position.count;i++){const point=new THREE.Vector3().fromBufferAttribute(position,i).applyMatrix4(object.matrixWorld);for(const r of walking)expect(point.x<=r.minX||point.x>=r.maxX||point.z<=r.minZ||point.z>=r.maxZ,object.name).toBe(true);}}});
    expect(garden.userData.garden.flowerCount).toBeGreaterThan(800);expect(garden.userData.garden.flowerColors).toBe(4);expect(garden.userData.garden.treeCount).toBe(6);
  });
  it('uses daylight glass, muted flower shades and many natural plant heights instead of a flat flower carpet',()=>{
    const world=environment();applyReferenceCourtyardVilla(world);const glass=(world.getObjectByName('home-reference-villa-upper-front-window-0-warm-glass') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(glass.opacity).toBeLessThanOrEqual(.3);expect(glass.emissiveIntensity).toBeLessThanOrEqual(.035);expect(world.getObjectByName('home-reference-villa-continuous-leafy-bed-cover')).toBeUndefined();
    const heights=new Set<number>();let flowers=0;
    for(let color=0;color<4;color++){
      const mesh=world.getObjectByName('home-reference-villa-flower-petals-'+color) as THREE.InstancedMesh;const hsl={h:0,s:0,l:0};(mesh.material as THREE.MeshStandardMaterial).color.getHSL(hsl,THREE.SRGBColorSpace);expect(hsl.s).toBeLessThan(.31);
      for(let i=0;i<mesh.count;i++){const matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);heights.add(Math.round(matrix.elements[13]*10000));flowers++;}
    }
    expect(flowers).toBeGreaterThan(800);expect(heights.size).toBeGreaterThan(100);
    const garden=world.getObjectByName('home-reference-villa-outside-flower-garden')!;expect(garden.userData.garden.visibleSoil).toBe(true);expect(garden.userData.garden.flowerHeightRange).toEqual([.17,.60]);
    const leaves=world.getObjectByName('home-reference-villa-outside-tree-leaves') as THREE.InstancedMesh;expect(leaves.geometry.getAttribute('position').count/3).toBeLessThan(80);
  });
  it('caps visual detail with instanced tile ribs and bounded mesh and triangle counts',()=>{
    const world=environment();applyReferenceCourtyardVilla(world);const variant=new THREE.Group();for(const name of ['home-reference-villa-upper-and-roof','home-reference-villa-front-gatehouse','home-reference-villa-outside-flower-garden'])variant.add(world.getObjectByName(name)!.clone());
    const budget=triangles(variant);expect(budget.draws).toBeLessThanOrEqual(110);expect(budget.count).toBeLessThanOrEqual(70000);
    const tile=world.getObjectByName('home-reference-villa-individual-tile-ribs') as THREE.InstancedMesh;expect(tile).toBeInstanceOf(THREE.InstancedMesh);expect(tile.count).toBeGreaterThan(1000);expect(tile.count).toBeLessThan(1800);
  });
});
