import {describe,expect,it,vi} from 'vitest';
import {createLivingNavigation} from '@/lib/living-navigation';
import {planSocialGathering,type SocialActor} from '@/lib/living-social-gathering';

// Narrow depth prevents a preferred circle; the two real standing pockets are
// separated by an actual projected obstacle. A clear eye line can allow the
// stationary conversation without allowing either body to walk through it.
const bounds={minX:-3,maxX:3,minZ:-.95,maxZ:.95};
const obstacle={minX:-.025,maxX:.025,minZ:-.8,maxZ:.8};
const graph=(_:unknown,clearance:number)=>createLivingNavigation({bounds,blocked:[obstacle],clearance,step:.08});
const actors=(distance:number):SocialActor[]=>[
 {id:2,area:'outdoor',radius:.85,from:{x:-distance/2,z:0}},
 {id:5,area:'outdoor',radius:.8,from:{x:distance/2,z:0}},
];
const plan=(distance:number,canSee:Parameters<typeof planSocialGathering>[4],occupied:Parameters<typeof planSocialGathering>[3]=()=>[])=>planSocialGathering(actors(distance),()=>bounds,graph,occupied,canSee);

describe('stationary social safety uses the original body radii',()=>{
 it('permits the g45 safe near-conversation gap without moving either body',()=>{
  const distance=1.8606468856192306,input=actors(distance),before=structuredClone(input),canSee=vi.fn(()=>true);
  const result=planSocialGathering(input,()=>bounds,graph,()=>[],canSee);
  expect(result.size).toBe(2);expect(canSee).toHaveBeenCalledOnce();
  for(const actor of input){expect(result.get(actor.id)?.position).toEqual(actor.from);expect(result.get(actor.id)?.stationary).toBe(true);expect(graph(null,actor.radius).isSegmentClear(actor.from!,actor.from!)).toBe(true);}
  expect(graph(null,.85).isSegmentClear(input[0].from!,input[1].from!),'body route remains obstructed').toBe(false);
  expect(distance-input[0].radius-input[1].radius).toBeGreaterThan(.04);expect(input).toEqual(before);
 });
 it('rejects a positive body gap smaller than the navigation margin',()=>{
  const input=actors(1.68),freeGraph=(_:unknown,clearance:number)=>createLivingNavigation({bounds,blocked:[],clearance,step:.08}),canSee=vi.fn(()=>true);
  for(const actor of input)expect(freeGraph(null,actor.radius).isSegmentClear(actor.from!,actor.from!)).toBe(true);
  expect(planSocialGathering(input,()=>bounds,freeGraph,()=>[],canSee).size).toBe(0);expect(canSee).not.toHaveBeenCalled();
 });
 it('rejects actual body overlap',()=>{
  const freeGraph=(_:unknown,clearance:number)=>createLivingNavigation({bounds,blocked:[],clearance,step:.08});
  expect(planSocialGathering(actors(1.64),()=>bounds,freeGraph,()=>[],()=>true).size).toBe(0);
 });
 it('rejects a high-wall or closed-door eye-line result even when both body pockets are safe',()=>{
  const canSee=vi.fn(()=>false);expect(plan(2,canSee).size).toBe(0);expect(canSee).toHaveBeenCalledOnce();
 });
 it('rejects a real third body occupying either unchanged standing pocket',()=>{
  const canSee=vi.fn(()=>true);expect(plan(2,canSee,()=>[{position:{x:-1,z:0},radius:.9}]).size).toBe(0);expect(canSee).not.toHaveBeenCalled();
 });
});
