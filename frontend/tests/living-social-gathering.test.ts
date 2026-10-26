import { describe, expect, it } from 'vitest';
import { createLivingNavigation } from '@/lib/living-navigation';
import { planSocialGathering, socialGroupReady, socialGatheringTurn } from '@/lib/living-social-gathering';
import { parseGathering } from '@/lib/gatherings';

const bounds = { minX: -5, maxX: 5, minZ: -4, maxZ: 4 };
const actors = [2, 1].map(id => ({ id, area: 'outdoor' as const, radius: .6 }));
const graph = (_: unknown, radius: number) => createLivingNavigation({ bounds, blocked: [], clearance: radius });
const plan = () => planSocialGathering(actors, () => bounds, graph, () => []);

describe('shared social gathering without network', () => {
  it('allocates separated facing positions deterministically without mutating saved inputs', () => {
    const before = JSON.stringify(actors), first = plan();
    expect([...first.keys()]).toEqual([1, 2]);
    expect([...planSocialGathering([...actors].reverse(), () => bounds, graph, () => [])]).toEqual([...first]);
    const [a, b] = [...first.values()];
    expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThan(1.2);
    for (const slot of first.values()) expect(Math.atan2(slot.center.x - slot.position.x, slot.center.z - slot.position.z)).toBe(slot.yaw);
    expect(JSON.stringify(actors)).toBe(before);
  });
  it('does not scatter a blocked group or invent company for a lone actor', () => {
    expect(planSocialGathering(actors.slice(0, 1), () => bounds, graph, () => []).size).toBe(0);
    const blocked = (_: unknown, clearance: number) => createLivingNavigation({ bounds, blocked: [bounds], clearance });
    expect(planSocialGathering(actors, () => bounds, blocked, () => []).size).toBe(0);
    expect(planSocialGathering([actors[0], { ...actors[1], area: 'indoor' }], () => bounds, graph, () => []).size).toBe(0);
  });
  it('waits for everyone, including moving, missing and upstairs participants', () => {
    const p = plan(), slot = p.get(1)!;
    const actual = (id: number) => ({ ...p.get(id)!.position, area: 'outdoor', moving: false, upstairs: false });
    expect(socialGroupReady(slot, p, actual)).toBe(true);
    for (const changed of [{ moving: true }, { upstairs: true }, { x: 50 }, { area: 'indoor' }])
      expect(socialGroupReady(slot, p, id => ({ ...actual(id), ...(id === 2 ? changed : {}) }))).toBe(false);
    expect(socialGroupReady(slot, p, id => id === 2 ? null : actual(id))).toBe(false);
  });
  it('shows one alternating preset speaker with the same shared clock on both clients', () => {
    const g = parseGathering({ id: 'social-offline', scene_type: 'home', title: 'isolated', revision: 1, closed: false, is_manager: true, story_enabled: false, stories: [], votes: [], goal: null, season: {}, me: 'synthetic', companions: [], members: [], items: [], events: [{ id: 'activity', kind: 'activity', activity: 'talk', area: 'outdoor', at: 100, characters: [1, 2], message: 'synthetic' }] });
    const p = plan(), a = socialGatheringTurn(g, p.get(1)!, 100)!, b = socialGatheringTurn(g, p.get(2)!, 106)!;
    expect(a.actorId).toBe(1); expect(b.actorId).toBe(2); expect(a.kind).toBe('preset');
    expect(socialGatheringTurn(structuredClone(g), p.get(2)!, 100)).toEqual(a);
    expect(socialGatheringTurn(g, p.get(1)!, 99)).toBeNull();
    expect(a.text).not.toContain('synthetic');
  });
});

describe('nearby meeting when furniture leaves no empty circle',()=>{
  const narrow={minX:-4,maxX:4,minZ:-1,maxZ:1};
  const input=[{id:2,area:'outdoor' as const,radius:.3,from:{x:-3,z:0}},{id:5,area:'outdoor' as const,radius:.3,from:{x:3,z:0}}];
  const narrowGraph=(_:unknown,radius:number)=>createLivingNavigation({bounds:narrow,blocked:[],clearance:radius,step:.16});
  it('keeps one partner still and proves a reachable separated meeting without changing saved origins',()=>{
    const before=JSON.stringify(input),seen:Array<[number,number]>=[];
    const result=planSocialGathering(input,()=>narrow,narrowGraph,()=>[],()=>true,(a,b)=>{seen.push([a.from!.x,b.from!.x]);return true;});
    expect(result.size).toBe(2);expect(seen.length).toBeGreaterThan(0);
    const moved=input.filter(a=>Math.hypot(result.get(a.id)!.position.x-a.from.x,result.get(a.id)!.position.z-a.from.z)>.01);
    expect(moved).toHaveLength(1);
    const moving=moved[0],fixed=input.find(a=>a.id!==moving.id)!;
    const route=narrowGraph(null,moving.radius).planTo({from:moving.from,to:result.get(moving.id)!.position,id:moving.id,avoid:[{position:fixed.from,radius:fixed.radius}]});
    expect(route.blocked).toBeNull();expect(route.points[0]).toEqual(moving.from);
    const a=result.get(2)!,b=result.get(5)!;expect(Math.hypot(a.position.x-b.position.x,a.position.z-b.position.z)).toBeGreaterThanOrEqual(.64);
    expect(a.sightRequired).toBe(true);expect(b.sightRequired).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('rejects a candidate with a blocked final eye line',()=>{
    expect(planSocialGathering(input,()=>narrow,narrowGraph,()=>[],()=>false,()=>false).size).toBe(0);
  });
  it('cannot pull a distant partner through a disconnected wall',()=>{
    const wall={minX:-.2,maxX:.2,minZ:-1,maxZ:1};
    const separated=(_:unknown,radius:number)=>createLivingNavigation({bounds:narrow,blocked:[wall],clearance:radius,step:.16});
    expect(planSocialGathering(input,()=>narrow,separated,()=>[],()=>true,()=>true).size).toBe(0);
  });
});
