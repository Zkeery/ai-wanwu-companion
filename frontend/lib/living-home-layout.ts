import { gatheringCompanionArea, type Gathering } from './gatherings';
export type HomeBedSlot = { id: number; x: number; z: number; y: number; width: number; length: number };
/** Slots are physical furniture coordinates in the same world as the avatars. */
export function homeBedSlots(count: number): HomeBedSlot[] {
  const n=Math.min(10,Math.max(1,Math.floor(Number.isFinite(count)?count:1)));
  const columns=n<=1?1:n<=4?2:n<=6?3:5;
  const rows=Math.ceil(n/columns), xs=columns===1?[0]:columns===2?[-2.4,2.4]:columns===3?[-3.6,0,3.6]:[-4,-2,0,2,4];
  return Array.from({length:n},(_,id)=>({id,x:xs[id%columns],z:rows===1?-.7:Math.floor(id/columns)===0?-1.75:1.75,y:.66,width:columns===5?1.45:columns===3?1.8:2.15,length:rows===1?3.25:2.65}));
}
export function homeSleepingBeds(g: Gathering) {
  if(g.scene_type!=='home')return [];
  const companions=g.companions.filter(c=>c.activity==='sleep'&&gatheringCompanionArea(g,c)==='bedroom').sort((a,b)=>a.id-b.id);
  const slots=homeBedSlots(companions.length);
  return companions.map((c,i)=>({...slots[i],characterId:c.id}));
}
export function homeSofaSeats(g: Gathering) {
  if(g.scene_type!=='home')return [];
  return g.companions.filter(c=>c.activity==='rest'&&gatheringCompanionArea(g,c)==='indoor').sort((a,b)=>a.id-b.id).slice(0,10).map((c,i)=>({characterId:c.id,index:i,x:i<3?[0,-1.35,1.35][i]:[-4.2,-2.8,-1.4,0,1.4,2.8,4.2][i-3],y:.72,z:i<3?-1.45:1.75}));
}
