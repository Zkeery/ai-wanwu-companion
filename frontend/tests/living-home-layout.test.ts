import { describe,expect,it } from 'vitest';
import type { Gathering } from '@/lib/gatherings';
import {homeBedSlots,homeSleepingBeds,homeSofaSeats}from '@/lib/living-home-layout';
const g=(n:number,activity='sleep',area='bedroom')=>({scene_type:'home',companions:Array.from({length:n},(_,i)=>({id:i+1,activity,area,x:.1,y:.8})),events:[]}as unknown as Gathering);
describe('physical home furniture layout',()=>{
 it.each([0,1,2,4,6,10])('allocates %i sleepers to stable, separate beds while retaining saved positions',n=>{const s=g(n),before=JSON.stringify(s),beds=homeSleepingBeds(s);expect(beds).toHaveLength(n);expect(homeSleepingBeds({...s,companions:[...s.companions].reverse()})).toEqual(beds);for(const a of beds)for(const b of beds)if(a!==b)expect(Math.abs(a.x-b.x)>=Math.min(a.width,b.width)||Math.abs(a.z-b.z)>=Math.min(a.length,b.length)).toBe(true);expect(JSON.stringify(s)).toBe(before);expect(homeBedSlots(n).length).toBe(Math.max(1,n));});
 it('does not make ordinary resting partners lie down or seat sleepers on the sofa',()=>{expect(homeSleepingBeds(g(2,'rest','indoor'))).toEqual([]);expect(homeSofaSeats(g(2))).toEqual([]);expect(homeSleepingBeds({...g(2),scene_type:'forest'})).toEqual([]);expect(homeSofaSeats(g(10,'rest','indoor'))).toHaveLength(10);});
});
