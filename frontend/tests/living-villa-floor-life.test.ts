import {it,expect} from 'vitest';import {createVillaFloorLife,type VillaActivity,type VillaLifePlan} from '../lib/living-villa-floor-life';import {VILLA_STAIR_BOTTOM,VILLA_STAIR_ROUTE} from '../lib/living-villa-stair-visit';
const plan=(activity:VillaActivity):VillaLifePlan=>({activity,points:[{...VILLA_STAIR_ROUTE.at(-1)!,yaw:0,tilt:0,scale:1,blend:0},{x:activity==='sleep'?7:activity==='rest'?-4:6,y:3.496,z:-5,yaw:0,tilt:0,scale:1,blend:0}],support:[]});
function run(c:ReturnType<typeof createVillaFloorLife>,until:()=>boolean,limit=5000){for(let i=0;i<limit&&!until();i++){const s=c.snapshot();if(s?.phase==='approach')c.board(s.id,VILLA_STAIR_BOTTOM,Math.PI);c.step(.1,true,()=>true);}expect(until()).toBe(true);}
it('queues three different destinations and refuses duplicate furniture occupation',()=>{const c=createVillaFloorLife();expect(c.request(1,.9,plan('sleep'))).toBe(true);expect(c.request(2,.9,plan('rest'))).toBe(true);expect(c.request(3,.9,plan('observe'))).toBe(true);expect(c.request(4,.9,plan('sleep'))).toBe(false);expect(c.snapshot(2)?.phase).toBe('queued');run(c,()=>c.snapshots().every(s=>s.phase==='upper'));expect(c.snapshots()).toHaveLength(3);for(const id of [2,1,3])expect(c.request(id,.9,null)).toBe(true);run(c,()=>c.snapshots().every(s=>s.phase==='returned'));expect(c.releaseReturned()).not.toBeNull();});
it('pause, obstruction, cancellation and reversing keep the real position',()=>{const c=createVillaFloorLife();c.request(1,.9,plan('rest'));c.request(2,.9,plan('sleep'));c.request(2,.9,null);expect(c.snapshot(2)).toBeNull();c.board(1,VILLA_STAIR_BOTTOM,Math.PI);for(let i=0;i<90;i++)c.step(.1,true,()=>true);const p=c.snapshot()!.pose;c.step(1000,false,()=>true);c.step(.1,true,()=>false);expect(c.snapshot()!.pose).toEqual(p);c.request(1,.9,null);run(c,()=>c.snapshot()?.phase==='returned');expect(c.snapshot()!.pose.y).toBe(0);});
it('restores an exact moving checkpoint and rejects corrupt, foreign or overlapping records atomically',()=>{const c=createVillaFloorLife();c.request(1,.9,plan('rest'));c.request(2,.9,plan('sleep'));c.board(1,VILLA_STAIR_BOTTOM,Math.PI);for(let i=0;i<100;i++)c.step(.1,true,()=>true);const raw=JSON.parse(JSON.stringify(c.export())),d=createVillaFloorLife(),resolver=(id:number,a:VillaActivity)=>id<=2?{radius:.9,plan:plan(a)}:null;expect(d.restore(raw,resolver)).toBe(true);expect(d.snapshots()).toEqual(c.snapshots());for(let i=0;i<10;i++){c.step(.1,true,()=>true);d.step(.1,true,()=>true);}expect(d.snapshots()).toEqual(c.snapshots());const bad=JSON.parse(JSON.stringify(raw));bad.states[0].pose.x+=2;const before=d.export();expect(d.restore(bad,resolver)).toBe(false);expect(d.export()).toEqual(before);expect(d.restore(raw,()=>null)).toBe(false);});
it('changes upstairs activities then returns using the complete original staircase',()=>{const c=createVillaFloorLife();c.request(1,.9,plan('observe'));run(c,()=>c.snapshot()?.phase==='upper');const before=c.snapshot()!.pose;c.request(1,.9,plan('sleep'));expect(c.snapshot()!.pose).toEqual(before);run(c,()=>c.snapshot()?.phase==='upper');expect(c.snapshot()?.activity).toBe('sleep');c.request(1,.9,null);run(c,()=>c.snapshot()?.phase==='returned');expect(c.snapshot()!.pose.y).toBe(0);});

it('restores a partially changed activity and preserves the full staircase afterward',()=>{const c=createVillaFloorLife();c.request(1,.9,plan('observe'));run(c,()=>c.snapshot()?.phase==='upper');c.request(1,.9,plan('rest'));for(let i=0;i<50;i++)c.step(.1,true,()=>true);const d=createVillaFloorLife();expect(d.restore(JSON.parse(JSON.stringify(c.export())),(id,a)=>({radius:.9,plan:plan(a)}))).toBe(true);run(d,()=>d.snapshot()?.phase==='upper');d.request(1,.9,null);run(d,()=>d.snapshot()?.phase==='returned');expect(d.snapshot()?.pose.y).toBe(0);});

it.each(['approach','walking','waiting'] as const)('removes an active %s actor and advances only the next queued actor',phase=>{
 const c=createVillaFloorLife();c.request(1,.9,plan('rest'));c.request(2,.9,plan('sleep'));c.request(3,.9,plan('observe'));
 if(phase!=='approach'){c.board(1,VILLA_STAIR_BOTTOM,Math.PI);c.step(.1,true,()=>phase!=='waiting');}
 expect(c.snapshot(1)?.phase).toBe(phase);
 const second=c.snapshot(2)!,third=c.snapshot(3)!;
 expect(c.remove(1)).toBe(true);expect(c.snapshot(1)).toBeNull();expect(c.export().active).toBe(2);
 expect(c.snapshot(2)).toEqual({...second,phase:'approach'});expect(c.snapshot(3)).toEqual(third);
 expect(c.board(1,VILLA_STAIR_BOTTOM,Math.PI)).toBe(false);
 run(c,()=>c.snapshots().every(s=>s.phase==='upper'));expect(c.snapshots().map(s=>s.id)).toEqual([2,3]);
});

it('removes a queued actor without interrupting the active journey or another reservation',()=>{
 const c=createVillaFloorLife();c.request(1,.9,plan('rest'));c.request(2,.9,plan('sleep'));c.request(3,.9,plan('observe'));
 c.board(1,VILLA_STAIR_BOTTOM,Math.PI);for(let i=0;i<90;i++)c.step(.1,true,()=>true);
 const active=c.snapshot(1),queued=c.snapshot(3);
 expect(c.remove(2)).toBe(true);expect(c.snapshot(2)).toBeNull();expect(c.export().active).toBe(1);
 expect(c.snapshot(1)).toEqual(active);expect(c.snapshot(3)).toEqual(queued);
 expect(c.request(4,.9,plan('sleep'))).toBe(true);expect(c.snapshot(4)?.phase).toBe('queued');
 run(c,()=>c.snapshots().every(s=>s.phase==='upper'));expect(c.snapshots().map(s=>s.id)).toEqual([1,3,4]);
});

it('removes an upstairs actor while preserving a peer on the stairs and a queued peer',()=>{
 const c=createVillaFloorLife();c.request(1,.9,plan('rest'));c.request(2,.9,plan('sleep'));c.request(3,.9,plan('observe'));
 run(c,()=>c.snapshot(1)?.phase==='upper');c.board(2,VILLA_STAIR_BOTTOM,Math.PI);for(let i=0;i<30;i++)c.step(.1,true,()=>true);
 const active=c.snapshot(2),queued=c.snapshot(3);
 expect(c.remove(1)).toBe(true);expect(c.snapshot(1)).toBeNull();expect(c.export().active).toBe(2);
 expect(c.snapshot(2)).toEqual(active);expect(c.snapshot(3)).toEqual(queued);
 run(c,()=>c.snapshots().every(s=>s.phase==='upper'));
});

it('advances a queued return from its actual upstairs pose when the active return leaves',()=>{
 const c=createVillaFloorLife();c.request(1,.9,plan('rest'));c.request(2,.9,plan('sleep'));
 run(c,()=>c.snapshots().every(s=>s.phase==='upper'));c.request(1,.9,null);c.request(2,.9,null);
 const second=c.snapshot(2)!;expect(second.phase).toBe('queued');expect(second.direction).toBe('down');expect(second.distance).toBeGreaterThan(0);
 expect(c.remove(1)).toBe(true);expect(c.export().active).toBe(2);expect(c.snapshot(2)).toEqual({...second,phase:'walking'});
 run(c,()=>c.snapshot(2)?.phase==='returned');expect(c.snapshot(2)?.pose.y).toBe(0);
});

it('allows a removed actor to rejoin from a fresh plan and makes repeated removal harmless',()=>{
 const c=createVillaFloorLife();c.request(1,.9,plan('sleep'));run(c,()=>c.snapshot(1)?.phase==='upper');
 expect(c.remove(1)).toBe(true);expect(c.export()).toEqual({version:1,active:null,states:[]});
 for(const id of [1,99,0,-1,NaN])expect(c.remove(id)).toBe(false);
 expect(c.export()).toEqual({version:1,active:null,states:[]});
 const fresh=createVillaFloorLife();fresh.request(1,.9,plan('rest'));
 expect(c.request(1,.9,plan('rest'))).toBe(true);expect(c.export()).toEqual(fresh.export());
 run(c,()=>c.snapshot(1)?.phase==='upper');expect(c.snapshot(1)?.activity).toBe('rest');
});
