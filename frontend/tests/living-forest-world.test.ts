import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildForestEnvironment, buildForestItem } from '../lib/living-forest-world';
import type { HomeMaterialLibrary } from '../lib/living-home-materials';
import { createLivingNavigation } from '../lib/living-navigation';
import { sceneKinds } from '../lib/living-ui';
const roots:THREE.Object3D[]=[],requested:string[]=[];
function keep<T extends THREE.Object3D>(value:T):T{roots.push(value);return value;}
function bounds(object:THREE.Object3D){object.updateWorldMatrix(true,true);return new THREE.Box3().setFromObject(object,true);}
function obstacles(root:THREE.Object3D){const result:{minX:number;maxX:number;minZ:number;maxZ:number;source:string}[]=[];root.updateMatrixWorld(true);const visit=(object:THREE.Object3D)=>{if(object.userData.naturalNavObstacle){const b=bounds(object);if(b.max.y>=.05&&b.min.y<=1.6)result.push({minX:b.min.x,maxX:b.max.x,minZ:b.min.z,maxZ:b.max.z,source:object.name});return;}object.children.forEach(visit);};visit(root);return result;}
beforeEach(()=>{requested.length=0;vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(url=>{requested.push(String(url));return new THREE.Texture();});});
afterEach(()=>{const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();for(const root of roots.splice(0))root.traverse(object=>{if(object instanceof THREE.Mesh){geometries.add(object.geometry);for(const material of Array.isArray(object.material)?object.material:[object.material]){materials.add(material);for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);}}});textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose());vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('metre-scale local forest camp',()=>{
  it('owns one lazy local PBR library using bundled wood, stone and woodland soil surfaces',()=>{
    const world=keep(buildForestEnvironment(null));const surfaces=world.userData.homeMaterialLibrary as HomeMaterialLibrary;expect(surfaces).toBeDefined();expect(world.userData.homeTextureStatus).toBe(surfaces.status);expect(world.userData.homeMaterialMode).toBe('pbr-local');expect(world.userData.naturalScene).toBe('forest');
    expect(requested).toHaveLength(9);expect(new Set(requested).size).toBe(9);for(const url of requested){expect(url).toMatch(new RegExp('/home-realistic/polyhaven/(wood_floor|grass_ground|old_stone_wall)/'));expect(url).not.toMatch(/^https?:/);}
    world.traverse(object=>{if(object instanceof THREE.Mesh){expect(object.material).toBeDefined();expect(object.castShadow||object.name.includes('ground')||object.name.includes('clearing')).toBe(true);}});
  });
  it('builds a closed real timber cabin with door, glazed framed window, solid roof planes and grounding foundation',()=>{
    const world=keep(buildForestEnvironment('summer')),cabin=world.getObjectByName('forest-timber-cabin')!;expect(cabin.position.toArray()).toEqual([-3.45,0,-6.15]);expect(cabin.userData.naturalNavObstacle).toBe(true);
    expect(cabin.getObjectByName('forest-cabin-door')).toBeInstanceOf(THREE.Mesh);expect(cabin.getObjectByName('forest-cabin-window-glass')).toBeInstanceOf(THREE.Mesh);
    for(const side of [-1,1])expect(cabin.getObjectByName('forest-cabin-roof-plane-'+side)).toBeInstanceOf(THREE.Mesh);
    expect(cabin.userData.naturalDoorDimensions).toEqual({width:1.05,height:2.08});const b=bounds(cabin);expect(b.min.y).toBeCloseTo(0);expect(b.max.y).toBeGreaterThan(3.8);expect(b.max.z).toBeLessThan(-3.8);
    const glass=cabin.getObjectByName('forest-cabin-window-glass') as THREE.Mesh<THREE.BoxGeometry,THREE.MeshStandardMaterial>;expect(glass.material.transparent).toBe(true);expect(glass.material.roughness).toBeLessThan(.2);
  });
  it('uses stitched sagging A-frame fabric, full groundsheet, rods and staked guy lines instead of a cone tent',()=>{
    const world=keep(buildForestEnvironment(null)),tent=world.getObjectByName('forest-canvas-tent')!;expect(tent.position.toArray()).toEqual([3.6,0,-5.9]);expect(tent.userData.naturalNavObstacle).toBe(true);
    expect(tent.getObjectByName('forest-canvas-tent-groundsheet')).toBeInstanceOf(THREE.Mesh);const counts={panels:0,ropes:0,cones:0};tent.traverse(object=>{if(object.name.includes('-fabric-panel-')){counts.panels++;const mesh=object as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;expect(mesh.geometry.getAttribute('position').count).toBe(99);expect(mesh.material.side).toBe(THREE.DoubleSide);}if(object.name.includes('-guyline-'))counts.ropes++;if(object instanceof THREE.Mesh&&object.geometry.type==='ConeGeometry')counts.cones++;});expect(counts).toEqual({panels:2,ropes:4,cones:0});expect(bounds(tent).min.y).toBeCloseTo(0);expect(bounds(tent).max.z).toBeLessThan(-4.3);
  });
  it('keeps ground traversable and buildings, actual trunks and stones physically registered without a giant canopy obstacle',()=>{
    const world=keep(buildForestEnvironment('spring'));const found=obstacles(world);expect(found.some(o=>o.source==='forest-timber-cabin')).toBe(true);expect(found.some(o=>o.source==='forest-canvas-tent')).toBe(true);expect(found.filter(o=>o.source.startsWith('forest-edge-tree-')&&o.source.endsWith('-trunk'))).toHaveLength(9);expect(found.filter(o=>o.source.startsWith('forest-distant-tree-')&&o.source.endsWith('-trunk'))).toHaveLength(12);expect(found.some(o=>/crown|ground|clearing/.test(o.source))).toBe(false);
    const nav=createLivingNavigation({bounds:world.userData.naturalNavigationBounds,blocked:found,clearance:1});const route=nav.planTo({from:{x:-4,z:2.5},to:{x:4,z:2.5},id:'forest-clear-walk'});expect(route.blocked).toBeNull();expect(route.safeAnchor).toEqual({x:-4,z:2.5});expect(nav.isSegmentClear({x:-4,z:2.5},{x:4,z:2.5})).toBe(true);for(const x of [-4,4])for(const z of [-2.8,2.8])expect(nav.isSegmentClear({x,z},{x,z})).toBe(true);
    expect(nav.isSegmentClear({x:-3.45,z:-3},{x:-3.45,z:-6})).toBe(false);
  });
  it('models seasonal leaves and an explicit winter snow layer without claiming a texture tint changes loaded grass',()=>{
    const summer=keep(buildForestEnvironment('summer')),autumn=keep(buildForestEnvironment('autumn')),winter=keep(buildForestEnvironment('winter'));
    expect(autumn.userData.naturalLitterLeafCount).toBeGreaterThan(summer.userData.naturalLitterLeafCount);expect(winter.getObjectByName('forest-season-snow-0')).toBeInstanceOf(THREE.Mesh);expect(summer.getObjectByName('forest-season-snow-0')).toBeUndefined();
    const crown=summer.getObjectByName('forest-edge-tree-0-crown')!;expect(crown.userData.localMotion).toBe('leaf');expect(crown.userData.naturalNavObstacle).toBeUndefined();let curved=0;crown.traverse(object=>{if(object instanceof THREE.Mesh){curved++;expect(object.geometry.type).toBe('BufferGeometry');expect(object.geometry.getAttribute('position').count).toBeGreaterThan(100);}});expect(curved).toBe(2);
  });
  it.each(sceneKinds.forest)('preserves every existing forest saved kind %s as visible volume rooted at the original local origin',kind=>{
    const world=keep(buildForestEnvironment(null)),surfaces=world.userData.homeMaterialLibrary as HomeMaterialLibrary,item=keep(buildForestItem(kind,'autumn',surfaces));expect(item.position.toArray()).toEqual([0,0,0]);let meshes=0;item.traverse(object=>{if(object instanceof THREE.Mesh)meshes++;});expect(meshes).toBeGreaterThan(0);expect(bounds(item).isEmpty()).toBe(false);expect(item.userData.homeMaterialOwnerId).toBe(surfaces.ownerId);
    if(kind==='tree'){expect(item.getObjectByName('home-item-tree-trunk')?.userData.naturalNavObstacle).toBe(true);expect(item.getObjectByName('home-item-tree-low-crown')?.userData.naturalNavObstacle).toBeUndefined();}
    if(kind==='cushion'){const b=bounds(item);expect(b.min.y).toBeCloseTo(0,3);expect(b.max.y).toBeCloseTo(.2,3);}
  });
  it.each(['bench','shade','tent','rock','pond','campfire','flower','mushroom','fireflies'])('keeps legacy decoration %s visible without changing its caller-owned position',kind=>{
    const world=keep(buildForestEnvironment(null)),item=keep(buildForestItem(kind,null,world.userData.homeMaterialLibrary));item.position.set(-1.2,0,2.6);item.updateMatrixWorld(true);expect(bounds(item).isEmpty()).toBe(false);expect(item.position.toArray()).toEqual([-1.2,0,2.6]);
    if(kind==='pond')expect(obstacles(item).some(b=>b.source==='forest-saved-pond-bank')).toBe(true);
  });
  it('has finite mesh bounds and metre-scaled UVs while making no wall-clock, fetch or timer request',()=>{
    const fetch=vi.spyOn(globalThis,'fetch'),timer=vi.spyOn(globalThis,'setTimeout'),date=vi.spyOn(Date,'now');
    try{const world=keep(buildForestEnvironment('autumn'));world.traverse(object=>{if(object instanceof THREE.Mesh){const b=bounds(object);expect([b.min.x,b.min.y,b.min.z,b.max.x,b.max.y,b.max.z].every(Number.isFinite)).toBe(true);expect(object.geometry.getAttribute('uv')).toBeDefined();}});expect(fetch).not.toHaveBeenCalled();expect(timer).not.toHaveBeenCalled();expect(date).not.toHaveBeenCalled();}
    finally{fetch.mockRestore();timer.mockRestore();date.mockRestore();}
  });

  it('uses irregular footpaths with two owned granular soil maps and grass clumps rather than an untextured grey disc',()=>{
    const world=keep(buildForestEnvironment('summer')),floor=world.getObjectByName('forest-trodden-clearing') as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;
    expect(floor.userData.naturalFloorDetail).toBe('irregular-granular-clearing-and-branching-footpaths');expect(floor.material.map).toBeInstanceOf(THREE.DataTexture);expect(floor.material.bumpMap).toBeInstanceOf(THREE.DataTexture);expect(floor.material.map).not.toBe(floor.material.bumpMap);expect(floor.material.roughness).toBeGreaterThan(.95);
    const pixels=(floor.material.map!.image as {data:Uint8Array}).data;const values=new Set<number>();for(let i=0;i<pixels.length;i+=4)values.add(pixels[i]);expect(values.size).toBeGreaterThan(40);expect(bounds(floor).max.z).toBeGreaterThan(7);expect(world.getObjectByName('forest-verge-grass')!.children).toHaveLength(2);expect(obstacles(world).some(o=>o.source===floor.name)).toBe(false);
  });
  it('joins dense small leaves to an actual merged branch skeleton and keeps the glass opening clear of opaque front boards',()=>{
    const world=keep(buildForestEnvironment('summer')),tree=world.getObjectByName('forest-edge-tree-0')!;expect(tree.userData.naturalLeafCount).toBe(580);expect(world.userData.naturalUnderstoryCount).toBe(6);expect(obstacles(world).filter(o=>o.source.startsWith('forest-understory-'))).toHaveLength(6);const supports=tree.getObjectByName('forest-edge-tree-0-branched-crown-support') as THREE.Mesh;expect(supports.geometry.getAttribute('position').count).toBeGreaterThan(500);expect(supports.userData.naturalNavObstacle).toBeUndefined();
    const cabin=world.getObjectByName('forest-timber-cabin')!,opaque:THREE.Object3D[]=[];cabin.traverse(object=>{if(object instanceof THREE.Mesh&&/^forest-cabin-front-/.test(object.name))opaque.push(object);});const ray=new THREE.Raycaster(new THREE.Vector3(-4.55,1.75,-3.9),new THREE.Vector3(0,0,-1));expect(ray.intersectObjects(opaque,false)).toHaveLength(0);expect(cabin.getObjectByName('forest-cabin-door-plank-seam-0')).toBeInstanceOf(THREE.Mesh);expect(cabin.getObjectByName('forest-cabin-door-hinge-0.61')).toBeInstanceOf(THREE.Mesh);
  });

  it('extends one visible continuous ground to64metres with a real layered distant forest instead of a circular floating island',()=>{
    const world=keep(buildForestEnvironment('summer')),legacy=world.getObjectByName('forest-ground')!,ground=world.getObjectByName('forest-ground-continuation')!;
    expect(legacy.visible).toBe(false);expect(ground.visible).toBe(true);expect(ground.userData.naturalContinuousGround).toBe(true);expect(world.userData.naturalGroundExtent).toBe(64);const b=bounds(ground);expect(b.min.x).toBeCloseTo(-32);expect(b.max.x).toBeCloseTo(32);expect(b.min.z).toBeCloseTo(-32);expect(b.max.z).toBeCloseTo(32);expect(Math.abs(b.min.y)).toBeLessThan(.00001);expect(Math.abs(b.max.y)).toBeLessThan(.00001);
    expect(world.userData.naturalDistantTreeCount).toBe(12);const far=world.children.filter(child=>child.userData.naturalDistantContext);expect(far).toHaveLength(12);expect(far.every(tree=>tree.position.z<=-11)).toBe(true);expect(new Set(far.map(tree=>tree.scale.y)).size).toBe(4);expect(obstacles(world).some(o=>/forest-ground/.test(o.source))).toBe(false);
    const sourceTrees=world.children.filter(child=>child.name.startsWith('forest-edge-tree-'));expect(sourceTrees).toHaveLength(9);expect(world.getObjectByName('forest-timber-cabin')!.position.toArray()).toEqual([-3.45,0,-6.15]);
  });
  it('supports deterministic no-DOM construction without texture requests or a false success status',()=>{
    vi.stubGlobal('document',undefined);const world=keep(buildForestEnvironment('winter'));expect(requested).toEqual([]);expect(world.userData.homeTextureStatus).toEqual({pending:0,loaded:0,failed:0,unavailable:9});expect(world.getObjectByName('forest-timber-cabin')).toBeDefined();
  });
});
