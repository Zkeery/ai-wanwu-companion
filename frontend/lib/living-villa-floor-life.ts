import {VILLA_STAIR_ROUTE,VILLA_STAIR_MAX_RADIUS} from './living-villa-stair-visit';
export type VillaActivity='observe'|'rest'|'sleep';
export type VillaLifePose={x:number;y:number;z:number;yaw:number;tilt:number;scale:number;blend:number};
export type VillaLifePlan={activity:VillaActivity;points:VillaLifePose[];support:string[]};
export type VillaLifeState={id:number;radius:number;activity:VillaActivity;fromActivity:VillaActivity|null;direction:'up'|'down'|'change';phase:'queued'|'approach'|'walking'|'waiting'|'upper'|'returned';distance:number;pose:VillaLifePose;points:VillaLifePose[];support:string[];homePlan:VillaLifePlan};
const finite=Number.isFinite,activities=['observe','rest','sleep'];
// JSON object key order is not part of a checkpoint's meaning (server encoders may sort it).
function structural(value:unknown):string{if(Array.isArray(value))return '['+value.map(structural).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+structural(v)).join(',')+'}';return JSON.stringify(value);}
const point=(p:{x:number;y:number;z:number}):VillaLifePose=>({...p,yaw:Math.PI,tilt:0,scale:1,blend:0});
const metric=(a:VillaLifePose,b:VillaLifePose)=>Math.max(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),Math.abs(a.tilt-b.tilt)*.8,Math.abs(a.blend-b.blend)*.8);
const extent=(points:VillaLifePose[])=>points.slice(1).reduce((n,p,i)=>n+metric(points[i],p),0);
function sample(points:VillaLifePose[],distance:number):VillaLifePose{let left=distance;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],length=metric(a,b);if(left<=length||i===points.length-1){const t=length?Math.min(1,Math.max(0,left/length)):1;return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t,yaw:a.yaw+(b.yaw-a.yaw)*t,tilt:a.tilt+(b.tilt-a.tilt)*t,scale:a.scale+(b.scale-a.scale)*t,blend:a.blend+(b.blend-a.blend)*t};}left-=length;}return{...points.at(-1)!};}
const copy=(s:VillaLifeState):VillaLifeState=>({...s,pose:{...s.pose},points:s.points.map(p=>({...p})),support:[...s.support],homePlan:{...s.homePlan,points:s.homePlan.points.map(p=>({...p})),support:[...s.homePlan.support]}});
export function createVillaFloorLife(){
 const states=new Map<number,VillaLifeState>();let active:number|null=null;
 const promote=()=>{if(active!==null)return;const next=[...states.values()].find(s=>s.phase==='queued');if(next){active=next.id;next.phase=next.direction==='up'&&next.distance===0?'approach':'walking';}};
 function request(id:number,radius:number,plan:VillaLifePlan|null):boolean{
  if(!Number.isSafeInteger(id)||id<=0||!finite(radius)||radius<=0||radius>VILLA_STAIR_MAX_RADIUS)return false;
  const old=states.get(id);if(!plan){if(!old)return false;if(old.phase==='queued'&&old.direction==='up'||old.phase==='approach'){states.delete(id);if(active===id)active=null;promote();return true;}if(old.direction==='down')return true;if(old.direction==='change')return false;old.direction='down';if(active!==id)old.phase='queued';promote();return true;}
  if(!activities.includes(plan.activity)||!plan.points.length||plan.points.some(p=>Object.values(p).some(v=>!finite(v)))||[...states.values()].some(s=>s.id!==id&&s.activity===plan.activity&&s.phase!=='returned'))return false;
  if(old){if(old.activity===plan.activity&&old.direction!=='down')return true;if(old.phase!=='upper')return false;const upper=old.homePlan.points.map(p=>({...p})).reverse();old.fromActivity=old.activity;old.activity=plan.activity;old.points=[...upper,...plan.points.slice(1)];old.support=[...new Set([...old.support,...plan.support])];old.homePlan=plan;old.direction='change';old.distance=0;old.phase='queued';promote();return true;}
  const points=[...VILLA_STAIR_ROUTE.map(point),...plan.points.slice(1)];states.set(id,{id,radius,activity:plan.activity,fromActivity:null,direction:'up',phase:'queued',distance:0,pose:{...points[0]},points,support:[...plan.support],homePlan:plan});promote();return true;
 }
 return{
  request,
  /** A departed actor releases only its own visit and reservation. */
  remove(id:number){if(!states.delete(id))return false;if(active===id)active=null;promote();return true;},
  board(id:number,actual:{x:number;y:number;z:number},yaw:number){const s=states.get(id),p=VILLA_STAIR_ROUTE[0];if(active!==id||s?.phase!=='approach'||!finite(yaw)||![actual.x,actual.y,actual.z].every(finite)||Math.hypot(actual.x-p.x,actual.y-p.y,actual.z-p.z)>.04)return false;s.pose={...point(actual),yaw};s.phase='walking';return true;},
  step(dt:number,moving:boolean,clear:(state:VillaLifeState,from:VillaLifePose,to:VillaLifePose)=>boolean){if(!moving||!finite(dt)||dt<=0)return;promote();const s=active===null?null:states.get(active);if(!s||s.phase==='approach')return;const delta=Math.min(.1,dt),end=s.direction==='down'?0:extent(s.points),sign=Math.sign(end-s.distance);if(!sign){s.phase=s.direction==='down'?'returned':'upper';active=null;promote();return;}
   const distance=Math.max(0,Math.min(extent(s.points),s.distance+sign*delta*.72)),p=sample(s.points,distance),dx=p.x-s.pose.x,dz=p.z-s.pose.z;let yaw=s.pose.yaw;
   if(p.blend===0&&s.pose.blend===0&&Math.hypot(dx,dz)>1e-6){const target=Math.atan2(dx,dz),angle=Math.atan2(Math.sin(target-yaw),Math.cos(target-yaw));yaw+=Math.sign(angle)*Math.min(Math.abs(angle),delta*2.4);if(Math.abs(angle)>.24){const turned={...s.pose,yaw};if(clear(copy(s),s.pose,turned))s.pose=turned;else s.phase='waiting';return;}}
   else {const angle=Math.atan2(Math.sin(p.yaw-yaw),Math.cos(p.yaw-yaw));yaw+=Math.sign(angle)*Math.min(Math.abs(angle),delta*2.4);}
   p.yaw=yaw;if(!clear(copy(s),s.pose,p)){s.phase='waiting';return;}s.distance=distance;s.pose=p;s.phase=Math.abs(distance-end)<1e-7?(s.direction==='down'?'returned':'upper'):'walking';if(s.phase==='upper'||s.phase==='returned'){if(s.phase==='upper'&&s.direction==='change'){s.points=[...VILLA_STAIR_ROUTE.map(point),...s.homePlan.points.slice(1)];s.distance=extent(s.points);s.direction='up';s.fromActivity=null;s.support=[...s.homePlan.support];}active=null;promote();}
  },
  snapshot(id?:number){const s=id!==undefined?states.get(id):active!==null?states.get(active):states.values().next().value;return s?copy(s):null;},
  snapshots(){return[...states.values()].map(copy);},
  releaseReturned(){const s=[...states.values()].find(s=>s.phase==='returned');if(!s)return null;states.delete(s.id);return s.id;},
  reset(){states.clear();active=null;},
  export(){return{version:1 as const,active,states:[...states.values()].map(copy)};},
  restore(raw:unknown,plans:(id:number,activity:VillaActivity)=>{radius:number;plan:VillaLifePlan}|null):boolean{
   if(!raw||typeof raw!=='object')return false;const v=raw as ReturnType<typeof this.export>;if(v.version!==1||!Array.isArray(v.states)||v.states.length>3)return false;const checked=new Map<number,VillaLifeState>(),slots=new Set<string>();let running=0;
   for(const s of v.states){if(!s||!Number.isSafeInteger(s.id)||checked.has(s.id)||!activities.includes(s.activity)||slots.has(s.activity)||!['up','down','change'].includes(s.direction)||!['queued','approach','walking','waiting','upper'].includes(s.phase)||!finite(s.distance)||s.distance<0)return false;const actual=plans(s.id,s.activity);if(!actual||actual.radius!==s.radius||structural(actual.plan)!==structural(s.homePlan))return false;let expected=[...VILLA_STAIR_ROUTE.map(point),...actual.plan.points.slice(1)],support=actual.plan.support;
    if(s.direction==='change'){if(!s.fromActivity||!activities.includes(s.fromActivity))return false;const from=plans(s.id,s.fromActivity);if(!from)return false;expected=[...from.plan.points].reverse().concat(actual.plan.points.slice(1));support=[...new Set([...from.plan.support,...support])];}
    if(structural(expected)!==structural(s.points)||JSON.stringify(support)!==JSON.stringify(s.support)||s.distance>extent(expected)+1e-6||!s.pose||[s.pose.x,s.pose.y,s.pose.z,s.pose.yaw,s.pose.tilt,s.pose.scale,s.pose.blend].some(x=>typeof x!=='number'||!finite(x))||Math.abs(s.pose.yaw)>Math.PI*20)return false;
    const p=sample(expected,s.distance);if(Math.hypot(p.x-s.pose.x,p.y-s.pose.y,p.z-s.pose.z)>1e-6||Math.abs(p.tilt-s.pose.tilt)>1e-6||Math.abs(p.scale-s.pose.scale)>1e-6||Math.abs(p.blend-s.pose.blend)>1e-6)return false;
    if(s.phase==='upper'&&Math.abs(s.distance-extent(expected))>1e-6||s.phase==='approach'&&(s.distance!==0||s.direction!=='up'))return false;if(['approach','walking','waiting'].includes(s.phase)){running++;if(s.id!==v.active)return false;}checked.set(s.id,copy(s));slots.add(s.activity);
   }
   if(running>1||(v.active!==null&&!checked.has(v.active))||(running===0&&v.active!==null))return false;states.clear();checked.forEach((s,id)=>states.set(id,s));active=v.active;promote();return true;
  },
 };
}
