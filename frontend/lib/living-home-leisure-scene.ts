import * as T from 'three';
import { applyHomeTeaGrip, recommendHomeTeaBodyLean, type HomeTeaAvatar } from './living-home-tea-grip';
import { sampleHomeLeisurePose } from './living-home-leisure-pose';
import { homeSofaSeats } from './living-home-layout';
import { homeWorldPoint } from './living-home-world';
import type { Gathering } from './gatherings';
import type { HomeLeisureSeat, HomeLeisureSnapshot } from './living-home-leisure';
import { collectHomeJourneyObstacles } from './living-home-journey-geometry';
import { homeNavigationBounds } from './living-home-navigation';
import { createLivingNavigation } from './living-navigation';

type RawSeat = {id?:string;x?:number;y?:number;z?:number;yaw?:number;source?:string;referenceSeatIndex?:number;supportName?:string};
export function collectHomeLeisureSeats(world:T.Object3D|null,items:T.Object3D|null,g:Gathering,snapshot?:HomeLeisureSnapshot,clearance=.9,contactClear?:(seat:HomeLeisureSeat,approach:{x:number;z:number})=>boolean,strictContact=false):HomeLeisureSeat[]{
  if(!world)return [];world.updateWorldMatrix(true,true);items?.updateWorldMatrix(true,true);
  const result:HomeLeisureSeat[]=[],benches:T.Object3D[]=[];
  items?.traverse(o=>{if(o.userData.homeRestKind==='bench')benches.push(o)});
  const active=new Set(snapshot?.assignments.map(a=>a.actorId)??[]);
  const sofa=homeSofaSeats(g).filter(s=>!active.has(s.characterId));
  const worldYaw=(o:T.Object3D,yaw=0)=>{const v=new T.Vector3(Math.sin(yaw),0,Math.cos(yaw)).transformDirection(o.matrixWorld);return Math.atan2(v.x,v.z)};
  world.traverse(o=>{
    const station=o.userData.homeLeisure;if(!['tea','television','mahjong'].includes(station)||!Array.isArray(o.userData.homeLeisureSeats))return;
    (o.userData.homeLeisureSeats as RawSeat[]).forEach((raw,index)=>{
      let parent=o,slot=raw,physicalId=station+'-'+index;
      if(raw.source==='saved-bench'){
        const table=o.getWorldPosition(new T.Vector3());
        const bench=benches.find(b=>{const p=b.getWorldPosition(new T.Vector3());const dir=table.clone().sub(p);const forward=new T.Vector3(0,0,1).transformDirection(b.matrixWorld);return dir.length()<=1.5&&forward.dot(dir.normalize())>.25;});
        const source=bench?.userData.homeRestSeats?.[raw.referenceSeatIndex??0] as RawSeat|undefined;if(!bench||!source)return;
        parent=bench;slot=source;physicalId='bench-'+bench.userData.homeItemId+'-'+(raw.referenceSeatIndex??0);
      }
      if(![slot.x,slot.y,slot.z,slot.yaw??0].every(Number.isFinite))return;
      const p=parent.localToWorld(new T.Vector3(slot.x,slot.y,slot.z));
      const reserved=station==='television'?sofa.find(s=>{const p0=homeWorldPoint('indoor',{x:s.x,y:s.y,z:s.z});return Math.hypot(p0.x-p.x,p0.z-p.z)<.05;}):undefined;
      const table=o.getWorldPosition(new T.Vector3()),away=new T.Vector3(p.x-table.x,0,p.z-table.z).normalize();
      // The built-in stool sits north of the table with a clear approach from its
      // east side. Saved benches keep their original position and orientation.
      const teaApproach=station==='tea'?(raw.supportName==='home-tea-stool'?{x:p.x+1.4,z:p.z}:{x:p.x+away.x*1.4,z:p.z+away.z*1.4}):undefined;
      const teaSupport=station==='tea'?(raw.supportName?[raw.supportName]:raw.source==='saved-bench'&&parent.name?[parent.name]:undefined):undefined;
      result.push({id:station+'-'+index,station,area:station==='television'?'indoor':'outdoor',x:p.x,y:p.y,z:p.z,yaw:station==='tea'?Math.atan2(table.x-p.x,table.z-p.z):worldYaw(parent,slot.yaw),physicalId,...(reserved?{reservedByActorId:reserved.characterId}:{}),...(station==='tea'?{cupId:'home-teacup-'+index,approach:teaApproach,...(teaSupport?{support:teaSupport}:{})}:station==='mahjong'?{support:['home-mahjong-chair-'+index]}:{})});
    });
  });
  for(const bench of benches)(bench.userData.homeRestSeats as RawSeat[]).forEach((raw,index)=>{const p=bench.localToWorld(new T.Vector3(raw.x,raw.y,raw.z));result.push({id:'bench-'+bench.userData.homeItemId+'-'+index,station:'bench',area:'outdoor',x:p.x,y:p.y,z:p.z,yaw:worldYaw(bench,raw.yaw),physicalId:'bench-'+bench.userData.homeItemId+'-'+index});});
  // Legacy collectors expose logical seats. New persistent and adopted physical worlds validate approaches.
  if(!strictContact)return result;
  const obstacles=collectHomeJourneyObstacles(world,items);
  // A stored layout may place a real tree or bench in the built-in tea approach.
  // Keep that layout; reject the station instead of saving an unreachable seat.
  return result.map(seat=>{
    if(seat.station==='mahjong'){
      const standing=createLivingNavigation({bounds:homeNavigationBounds('outdoor'),blocked:obstacles,clearance,step:.16});
      // Enter beside the chair, never through the tabletop or its solid back.
      // Existing trees/benches stay authoritative; an obstructed seat is unavailable.
      const forward={x:Math.sin(seat.yaw),z:Math.cos(seat.yaw)},side={x:forward.z,z:-forward.x};
      for(const distance of [1.2,1.4,1.65,1.9,2.2,2.4])for(const lateral of [1,-1])for(const retreat of [0,.25,.45,.8]){
        const approach={x:seat.x+side.x*distance*lateral-forward.x*retreat,z:seat.z+side.z*distance*lateral-forward.z*retreat};
        if(standing.isSegmentClear(approach,approach)&&(!contactClear||contactClear(seat,approach)))return{...seat,approach,available:true};
      }
      return{...seat,available:false};
    }
    if(seat.station!=='tea'||!seat.approach)return seat;
    const supports=seat.support??[],bounds=homeNavigationBounds('outdoor');
    const standing=createLivingNavigation({bounds,blocked:obstacles,clearance});
    const contact=createLivingNavigation({bounds,blocked:obstacles.filter(o=>!supports.some(p=>o.source===p||o.source.startsWith(p+':'))),clearance:clearance*.9});
    return {...seat,available:standing.isSegmentClear(seat.approach,seat.approach)&&contact.isSegmentClear(seat.approach,seat)};
  });
}

/** Reuse the actual table cup. Restore before replacing a world or disposing an avatar. */
export function createHomeTeaCupBinding(){
  const held=new Map<number,{cup:T.Object3D;parent:T.Object3D;position:T.Vector3;quaternion:T.Quaternion;scale:T.Vector3;matrix:T.Matrix4;matrixAutoUpdate:boolean}>();
  function release(id:number){const v=held.get(id);if(!v)return;v.parent.add(v.cup);v.cup.position.copy(v.position);v.cup.quaternion.copy(v.quaternion);v.cup.scale.copy(v.scale);v.cup.matrix.copy(v.matrix);v.cup.matrixAutoUpdate=v.matrixAutoUpdate;held.delete(id);}
  function restore(){for(const id of [...held.keys()])release(id);}
  function sync(world:T.Object3D|null,assignments:readonly {actorId:number;activity:string;seatId:string}[],seats:readonly HomeLeisureSeat[],avatars:ReadonlyMap<number,{root:T.Object3D;rightArm:T.Object3D}>){
    const tea=new Map(assignments.filter(a=>a.activity==='tea').map(a=>[a.actorId,a]));
    for(const id of held.keys())if(!tea.has(id)||!avatars.has(id))release(id);
    for(const [id,a]of tea){if(held.has(id))continue;const seat=seats.find(s=>s.id===a.seatId),avatar=avatars.get(id),cup=seat?.cupId?world?.getObjectByName(seat.cupId):null;
      if(!cup?.parent||!avatar)continue;
      held.set(id,{cup,parent:cup.parent,position:cup.position.clone(),quaternion:cup.quaternion.clone(),scale:cup.scale.clone(),matrix:cup.matrix.clone(),matrixAutoUpdate:cup.matrixAutoUpdate});
      // Hand is .32 below the shoulder in the existing avatar rig. Hold by the side of the cup.
      avatar.rightArm.add(cup);cup.position.set(-.045,-.31,.05);cup.quaternion.identity();cup.scale.setScalar(1/Math.max(.01,avatar.root.scale.x));
    }
  }
  function orient(avatars:ReadonlyMap<number,HomeTeaAvatar>,assignments:readonly {actorId:number;startedAtElapsed:number}[],elapsed:number){for(const [id,{cup}]of held){const avatar=avatars.get(id),assignment=assignments.find(a=>a.actorId===id);if(!avatar||!assignment)continue;const pose=sampleHomeLeisurePose('tea',Math.max(0,elapsed-assignment.startedAtElapsed),id),lean=recommendHomeTeaBodyLean(avatar,pose.cupLift);avatar.body.rotation.x+=lean.bodyLeanX;const grip=applyHomeTeaGrip(avatar,pose.cupLift);if(grip.valid){cup.matrixAutoUpdate=false;cup.matrix.copy(grip.cupLocalMatrix);cup.matrixWorldNeedsUpdate=true;cup.userData.gripError=grip.error;}}}
  return{sync,release,restore,orient,getHeld:()=>[...held.keys()]};
}
