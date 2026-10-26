import * as THREE from 'three';
import {it,expect,vi,afterEach} from 'vitest';
import {buildHomeWorldEnvironment} from '../lib/living-home-world-meshes';
import {buildVillaIndoorStair} from '../lib/living-villa-stair-mesh';
import {collectHomeJourneyObstacles} from '../lib/living-home-journey-geometry';
import {disposeLivingObject} from '../lib/living-world-engine';
const worlds:THREE.Group[]=[];
afterEach(()=>{worlds.forEach(w=>disposeLivingObject(w));worlds.length=0;vi.restoreAllMocks();});
function build(sleeping=1){vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(()=>new THREE.Texture());const w=buildHomeWorldEnvironment('summer',{resting:2,sleeping},{realistic:true,referenceVilla:true});worlds.push(w);return w;}
it('creates supported treads and a real opening through both upstairs slabs',()=>{
 const w=build(),root=w.getObjectByName('villa-indoor-stair')!;expect(root).toBeTruthy();expect(root.userData.stairDimensions).toMatchObject({steps:20,width:2.24});
 const ray=new THREE.Raycaster(new THREE.Vector3(1.65,2,-5),new THREE.Vector3(0,1,0),0,3);
 for(const name of ['home-reference-villa-upper-floor-slab','villa-upper-wood-floor']){const floor=w.getObjectByName(name)!;expect(ray.intersectObject(floor,true)).toHaveLength(0);expect(new THREE.Raycaster(new THREE.Vector3(4,2,-5),new THREE.Vector3(0,1,0),0,3).intersectObject(floor,true).length).toBeGreaterThan(0);}
 for(let n=0;n<20;n++){const b=new THREE.Box3().setFromObject(w.getObjectByName('villa-stair-tread-'+n)!);expect(b.min.y).toBeCloseTo(0);expect(b.max.y).toBeCloseTo(3.496*(n+1)/20);}
 expect(collectHomeJourneyObstacles(w,null).some(o=>o.source.startsWith('villa-stair-tread-'))).toBe(true);
});
it('does not move original furniture, double-build the stair, or erase a crowded bedrooms beds',()=>{
 const w=build(),names=['sofa-main','room-bed-0','room-bedside-table-0'],before=names.map(n=>w.getObjectByName(n)!.matrixWorld.toArray());expect(buildVillaIndoorStair(w)).toBe(true);expect(names.map(n=>w.getObjectByName(n)!.matrixWorld.toArray())).toEqual(before);
 const crowded=build(10);expect(crowded.getObjectByName('villa-indoor-stair')).toBeUndefined();expect(crowded.userData.villaStairUnavailable).toBe('existing-bedroom-furniture');for(let n=0;n<10;n++)expect(crowded.getObjectByName('room-bed-'+n)).toBeTruthy();
});
