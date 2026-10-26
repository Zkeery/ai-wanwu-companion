/** Local, explicit floor visits. The ground navigator must deliver the real actor to the boarding point. */
export type VillaStairPoint={x:number;y:number;z:number};
export const VILLA_STAIR_BOTTOM={x:1.65,y:0,z:-1.42};
export const VILLA_STAIR_ROUTE:readonly VillaStairPoint[]=[VILLA_STAIR_BOTTOM,{x:1.65,y:0,z:-2.5},{x:1.65,y:3.496,z:-7.1},{x:1.65,y:3.496,z:-7.15},{x:4.0,y:3.496,z:-7.15}];
export const VILLA_STAIR_MAX_RADIUS=.98;
const lengths=VILLA_STAIR_ROUTE.slice(1).map((p,i)=>Math.hypot(p.x-VILLA_STAIR_ROUTE[i].x,p.y-VILLA_STAIR_ROUTE[i].y,p.z-VILLA_STAIR_ROUTE[i].z));
const total=lengths.reduce((a,b)=>a+b,0);
function sample(distance:number):VillaStairPoint{if(distance<=1e-7)return{...VILLA_STAIR_BOTTOM};if(distance>=total-1e-7)return{...VILLA_STAIR_ROUTE.at(-1)!};let left=distance;for(let i=0;i<lengths.length;i++){if(left<=lengths[i]||i===lengths.length-1){const t=Math.max(0,Math.min(1,left/lengths[i])),a=VILLA_STAIR_ROUTE[i],b=VILLA_STAIR_ROUTE[i+1];return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t};}left-=lengths[i];}return{...VILLA_STAIR_BOTTOM};}
export function createVillaStairVisit(){
 let state:null|{id:number;radius:number;distance:number;destination:'upper'|'ground';phase:'approach'|'walking'|'waiting'|'upper'|'returned';pose:VillaStairPoint;yaw:number}=null;
 return{
  request(id:number,radius:number,up:boolean):boolean{
   if(!Number.isFinite(id)||!Number.isFinite(radius)||radius<=0||radius>VILLA_STAIR_MAX_RADIUS)return false;
   if(state&&state.id!==id)return false;
   if(!state){if(!up)return false;state={id,radius,distance:0,destination:'upper',phase:'approach',pose:{...VILLA_STAIR_BOTTOM},yaw:Math.PI};return true;}
   if(state.phase==='approach'&&!up){state=null;return true;}
   state.destination=up?'upper':'ground';if(state.phase==='upper'||state.phase==='returned')state.phase='walking';return true;
  },
  board(id:number,actual:VillaStairPoint,yaw:number):boolean{
   if(!state||state.id!==id||state.phase!=='approach'||!Number.isFinite(yaw)||![actual.x,actual.y,actual.z].every(Number.isFinite)||Math.hypot(actual.x-VILLA_STAIR_BOTTOM.x,actual.y,actual.z-VILLA_STAIR_BOTTOM.z)>.04)return false;
   state.pose={...actual};state.yaw=yaw;state.phase='walking';return true;
  },
  step(dt:number,moving:boolean,clear:(id:number,from:VillaStairPoint,to:VillaStairPoint,radius:number)=>boolean){
   if(!state||state.phase==='approach'||!moving||!Number.isFinite(dt)||dt<=0)return;
   const delta=Math.min(.1,dt),end=state.destination==='upper'?total:0;
   if(Math.abs(state.distance-end)<1e-7){state.phase=end?'upper':'returned';return;}
   const direction=Math.sign(end-state.distance),next=Math.max(0,Math.min(total,state.distance+direction*delta*.85)),p=sample(next);
   if(!clear(state.id,state.pose,p,state.radius)){state.phase='waiting';return;}
   const dx=p.x-state.pose.x,dz=p.z-state.pose.z,target=Math.atan2(dx,dz),angle=Math.atan2(Math.sin(target-state.yaw),Math.cos(target-state.yaw));
   // Turn before walking around a landing; never snap a body through the railing.
   state.yaw+=Math.sign(angle)*Math.min(Math.abs(angle),delta*2.4);
   if(Math.abs(angle)>.24){state.phase='walking';return;}
   state.distance=next;state.pose=p;state.phase=Math.abs(next-end)<1e-7?(end?'upper':'returned'):'walking';
  },
  snapshot(){return state?{...state,pose:{...state.pose}}:null;},
  releaseReturned(){if(state?.phase==='returned'){const id=state.id;state=null;return id;}return null;},
  reset(){state=null;},
 };
}
