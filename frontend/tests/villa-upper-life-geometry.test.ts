import * as THREE from 'three';
import {it,vi,expect} from 'vitest';
import {buildHomeWorldEnvironment} from '../lib/living-home-world-meshes';
import {buildVillaLifePlan,villaLifeFurniture} from '../lib/living-villa-life-plan';
import {disposeLivingObject} from '../lib/living-world-engine';
it('routes full-size bodies from the real landing to three distinct upstairs destinations',()=>{
 vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(()=>new THREE.Texture());const world=buildHomeWorldEnvironment('summer',{resting:2,sleeping:1},{realistic:true,referenceVilla:true});
 try{const furniture=villaLifeFurniture(world)!;expect(furniture.bed.footLift).toBeGreaterThan(0);const ground=world.getObjectByName('room-bed-0')!.matrixWorld.toArray();
 for(const activity of ['observe','rest','sleep'] as const){const plan=buildVillaLifePlan(world,activity,.98,{x:furniture.bed.x,y:4.5,z:-4.5,yaw:0,tilt:0,scale:.9,blend:1});expect(plan,activity+' full footprint route').not.toBeNull();expect(plan!.points[0]).toMatchObject({x:4,y:3.496,z:-7.15});expect(plan!.points.every(p=>Object.values(p).every(Number.isFinite))).toBe(true);}
 expect(world.getObjectByName('room-bed-0')!.matrixWorld.toArray()).toEqual(ground);
 }finally{disposeLivingObject(world);vi.restoreAllMocks();}
});
