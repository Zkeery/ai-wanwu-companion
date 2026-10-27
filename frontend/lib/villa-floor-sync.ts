import {errorText, request} from './api';
import {object,array} from './contracts';
import {text,number,boolean} from './gatherings';
import type {VillaActivity,createVillaFloorLife} from './living-villa-floor-life';
export type FloorCheckpoint=ReturnType<ReturnType<typeof createVillaFloorLife>['export']>;
export type FloorCommand={seq:number;id:number;activity:VillaActivity|null};
export type FloorSnapshot={revision:number;seq:number;applied:number;commands:FloorCommand[];checkpoint:FloorCheckpoint;fingerprint:string;driver:boolean;lease_until:number;server_time:number};
export type FloorEngine={applyServerFloor:(s:FloorSnapshot,preserve?:boolean)=>boolean;setFloorDriver:(drive:boolean)=>void;exportServerFloor:()=>{checkpoint:FloorCheckpoint;applied:number};canRequestServerFloor:(id:number,activity:VillaActivity|null)=>boolean};
export function parseFloor(value:unknown):FloorSnapshot{
 const r=object(value),cp=object(r.checkpoint);if(cp.version!==1||!Array.isArray(cp.states)||cp.states.length>3)throw new Error('楼层存档格式不正确');
 const commands=array(r.commands,v=>{const c=object(v);if(c.activity!==null&&!['observe','rest','sleep'].includes(String(c.activity)))throw new Error('楼层活动格式不正确');return{seq:number(c.seq),id:number(c.id),activity:c.activity as VillaActivity|null};});
 return{revision:number(r.revision),seq:number(r.seq),applied:number(r.applied),commands,checkpoint:cp as FloorCheckpoint,fingerprint:text(r.fingerprint),driver:boolean(r.driver),lease_until:number(r.lease_until),server_time:number(r.server_time)};
}
export function floorApi(kind:'shared'|'private',id:string,viewer:string){
 const url='/living/floors/'+kind+'/'+encodeURIComponent(id);
 return{read:async(signal?:AbortSignal)=>parseFloor(await request(url+'?viewer='+encodeURIComponent(viewer),{signal})),
 write:async(snapshot:FloorSnapshot,body:Record<string,unknown>,signal?:AbortSignal)=>parseFloor(await request(url,{method:'POST',body:JSON.stringify({request_id:crypto.randomUUID(),expected_revision:snapshot.revision,...body}),signal}))};
}
const IDLE_FLOOR_READ_MS=15_000;
/** One in-flight transaction. Failed writes stop; reconcile is read-only until explicitly resumed. */
export function createFloorSync(engine:()=>FloorEngine|null,transport:ReturnType<typeof floorApi>,viewer:string,onStatus:(s:string)=>void,valid:()=>boolean){
 let snapshot:FloorSnapshot|null=null,locked=false,stopped=false,disposed=false,driving=false,ackStamp='',appliedRevision=-1,nextIdleReadAt=0;
 const abort=new AbortController(),pause=()=>{driving=false;engine()?.setFloorDriver(false);};
 const apply=(next:FloorSnapshot,preserve=false)=>{const world=engine();if(!world||!world.applyServerFloor(next,preserve))throw new Error('二楼路线与当前布置不一致，已停止并保留存档');snapshot=next;appliedRevision=next.revision;};
 const quiet=(world:FloorEngine)=>!!snapshot&&!stopped&&!driving&&snapshot.commands.length===0&&snapshot.checkpoint.active===null&&world.exportServerFloor().checkpoint.active===null;
 async function tick(moving:boolean,force=false){
  if(disposed||!valid()){pause();return;}if(locked)return;locked=true;
  try{
   if(!moving){pause();return;}
   const world=engine();if(!world)return;
   if(!force&&quiet(world)&&Date.now()<nextIdleReadAt)return;
   if(driving&&snapshot&&!stopped){
    pause();const current=world.exportServerFloor(),stamp=JSON.stringify(current);
    if(stamp!==ackStamp){const saved=await transport.write(snapshot,{action:'checkpoint',viewer,...current},abort.signal);if(disposed||!valid())return;snapshot=saved;ackStamp=stamp;appliedRevision=saved.revision;}
   }
   const latest=await transport.read(abort.signal);if(disposed||!valid())return;
   if(latest.revision!==appliedRevision||!snapshot)apply(latest);else snapshot=latest;
   if(stopped){pause();return;}
   const needed=latest.commands.length>0||latest.checkpoint.active!==null||world.exportServerFloor().checkpoint.active!==null;
   if(!needed){pause();nextIdleReadAt=Date.now()+IDLE_FLOOR_READ_MS;onStatus('二楼进度已保存，双方可查看');return;}
   nextIdleReadAt=0;
   if(!latest.driver){
    try{const claimed=await transport.write(latest,{action:'claim',viewer},abort.signal);if(disposed||!valid())return;apply(claimed);}
    catch(e){if((e as {status?:number}).status===409){pause();onStatus('正在同步另一页面的二楼进度');return;}throw e;}
   }
   driving=true;world.setFloorDriver(true);onStatus('二楼进度自动保存中');
  }catch(e){pause();stopped=true;onStatus(e instanceof Error?errorText(e):'二楼保存尚未确认，已暂停，请核对进度');}
  finally{locked=false;}
 }
 return{tick,pause,async command(id:number,activity:VillaActivity|null){
  if(locked||disposed||stopped||!valid())throw new Error('请先核对二楼进度');const world=engine();if(!world)throw new Error('二楼同步尚未就绪');locked=true;pause();let rejected=false;
  try{const latest=await transport.read(abort.signal);if(disposed||!valid())return;apply(latest);if(!world.canRequestServerFloor(id,activity)){rejected=true;throw new Error('该二楼位置已被使用，或伙伴尚未结束当前活动，请核对近况后选择其他活动');}const next=await transport.write(latest,{action:'command',actor_id:id,activity},abort.signal);if(disposed||!valid())return;apply(next);onStatus('安排已保存，等待通道');}
  catch(e){if(!rejected){stopped=true;onStatus('保存结果待核对，已停止自动写入');}throw e;}
  finally{locked=false;}
 },async reconcile(){if(locked||disposed||!valid())return;locked=true;pause();try{const next=await transport.read(abort.signal);if(disposed||!valid())return;apply(next);stopped=false;ackStamp=JSON.stringify({checkpoint:next.checkpoint,applied:next.applied});onStatus('已核对服务器进度');}catch(e){stopped=true;onStatus(e instanceof Error?errorText(e):'暂时无法核对');}finally{locked=false;}},dispose(){disposed=true;pause();abort.abort();}};
}
