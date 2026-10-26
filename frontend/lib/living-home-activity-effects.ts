import * as T from 'three';
import { sampleHomeAmbience } from './living-home-ambience';
import { createHomeTelevisionRemote } from './living-home-television-remote';
import type { HomeMahjongGameSnapshot } from './living-home-mahjong-game';
import type { HomeLeisureSeat,HomeLeisureSnapshot } from './living-home-leisure';
import type { HomeTeaAvatar } from './living-home-tea-grip';

type Rig=HomeTeaAvatar&{leftArm:T.Object3D};
type Borrowed={object:T.Object3D;parent:T.Object3D;position:T.Vector3;quaternion:T.Quaternion;scale:T.Vector3;matrix:T.Matrix4;auto:boolean};
/** Local props and steam use the renderer's frozen clock. No requests, timers or extra lights. */
export function createHomeActivityEffects(scene:T.Scene){
 const group=new T.Group();group.name='home-local-activity-effects';scene.add(group);
 const steam:T.Line[]=Array.from({length:3},(_,i)=>{const geometry=new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(new Float32Array(16*3),3));const material=new T.LineBasicMaterial({color:'#f7f5ee',transparent:true,opacity:.26,depthWrite:false});const line=new T.Line(geometry,material);line.name='home-tea-steam-'+i;line.frustumCulled=false;group.add(line);return line;});
 const mistGeometry=new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(new Float32Array(18*3),3)).setAttribute('aOpacity',new T.BufferAttribute(new Float32Array(18),1));
 const mistMaterial=new T.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{size:{value:.25}},vertexShader:'attribute float aOpacity;varying float vOpacity;uniform float size;void main(){vOpacity=aOpacity;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=size*300./max(.1,-p.z);}',fragmentShader:'varying float vOpacity;void main(){float d=length(gl_PointCoord-vec2(.5));float a=(1.-smoothstep(.12,.5,d))*vOpacity;gl_FragColor=vec4(.98,.97,.93,a);}'});
 const mist=new T.Points(mistGeometry,mistMaterial);mist.name='home-tea-steam-mist';mist.frustumCulled=false;group.add(mist);
 const steamCloudGeometry=new T.IcosahedronGeometry(1,1);const steamClouds=Array.from({length:3},(_,i)=>{const m=new T.Mesh(steamCloudGeometry,new T.MeshBasicMaterial({color:'#fffaf2',transparent:true,opacity:.18,depthWrite:false}));m.name='home-tea-steam-volume-'+i;m.frustumCulled=false;group.add(m);return m;});
 const televisionRemote=createHomeTelevisionRemote();
 const gameTileVisibility=new Map<T.Object3D,boolean>();
 function restoreGameTiles(){for(const [tile,visible]of gameTileVisibility)tile.visible=visible;gameTileVisibility.clear();}
 const borrowed=new Map<string,Borrowed>();let disposed=false;
 let steamAnchors=new WeakMap<T.Object3D,T.Object3D>();
 function steamAnchor(world:T.Object3D|null){
  if(!world)return;
  const cached=steamAnchors.get(world);
  if(cached?.userData.homeTeaSteamAnchor){for(let parent:T.Object3D|null=cached;parent;parent=parent.parent)if(parent===world)return cached;}
  steamAnchors.delete(world);
  let anchor:T.Object3D|undefined;world.traverse(object=>{if(object.userData.homeTeaSteamAnchor)anchor=object;});
  // Only retain a real descendant: missing/rebuilt props can appear on a later update.
  if(anchor)steamAnchors.set(world,anchor);
  return anchor;
 }
 function release(key:string){const b=borrowed.get(key);if(!b)return;b.parent.add(b.object);b.object.position.copy(b.position);b.object.quaternion.copy(b.quaternion);b.object.scale.copy(b.scale);b.object.matrix.copy(b.matrix);b.object.matrixAutoUpdate=b.auto;borrowed.delete(key);}
 function restore(){for(const key of [...borrowed.keys()])release(key);restoreGameTiles();televisionRemote.reset();steamAnchors=new WeakMap();group.visible=false;}
 function hold(key:string,object:T.Object3D|undefined,arm:T.Object3D){if(!object)return;let b=borrowed.get(key);if(b&&b.object!==object){release(key);b=undefined;}if(!b){if(!object.parent)return;borrowed.set(key,{object,parent:object.parent,position:object.position.clone(),quaternion:object.quaternion.clone(),scale:object.scale.clone(),matrix:object.matrix.clone(),auto:object.matrixAutoUpdate});}if(object.parent!==arm)arm.add(object);object.matrixAutoUpdate=true;object.position.set(.075,-.265,.095);object.rotation.set(.15,0,.12);const scale=arm.getWorldScale(new T.Vector3());object.scale.set(1/scale.x,1/scale.y,1/scale.z);}
 function update(world:T.Object3D|null,avatars:ReadonlyMap<number,Rig>,snapshot:HomeLeisureSnapshot,seats:readonly HomeLeisureSeat[],elapsed:number,mahjongGame?:HomeMahjongGameSnapshot){
  if(disposed)return;const active=new Set<string>(),teapot=steamAnchor(world);
  group.visible=!!teapot;
  if(teapot){const raw=teapot.userData.homeTeaSteamAnchor;const anchor=teapot.localToWorld(new T.Vector3(raw.x,raw.y,raw.z));group.position.copy(anchor);
   const mistPosition=mistGeometry.getAttribute('position') as T.BufferAttribute,mistOpacity=mistGeometry.getAttribute('aOpacity') as T.BufferAttribute;
   for(let i=0;i<18;i++){const p=(elapsed*.13+i/18)%1;mistPosition.setXYZ(i,Math.sin(p*7+i*.7)*.035+p*.035,.02+p*.6,Math.cos(p*6+i*.6)*.025);mistOpacity.setX(i,Math.min(1,p*10)*(1-p)*.35);}mistPosition.needsUpdate=mistOpacity.needsUpdate=true;
   steamClouds.forEach((cloud,i)=>{const p=(elapsed*.15+i/3)%1;cloud.position.set(Math.sin(p*5+i)*.035,.05+p*.52,Math.cos(p*6+i)*.025);cloud.scale.set(.035+p*.055,.06+p*.07,.03+p*.05);(cloud.material as T.MeshBasicMaterial).opacity=Math.sin(p*Math.PI)*.19;});
   steam.forEach((line,index)=>{const attr=line.geometry.getAttribute('position') as T.BufferAttribute;for(let j=0;j<16;j++){const phase=j/15,fade=Math.sin(Math.PI*phase);attr.setXYZ(j,Math.sin(phase*8-elapsed*.8+index)*.035*fade+index*.012,.02+phase*.55,Math.cos(phase*5-elapsed*.65+index)*.025*fade);}attr.needsUpdate=true;});
  }
  if(mahjongGame){for(let index=0;index<4;index++){const tile=borrowed.get('tile-'+index)?.object??world?.getObjectByName('home-mahjong-tile-'+index);if(tile){if(!gameTileVisibility.has(tile))gameTileVisibility.set(tile,tile.visible);tile.visible=false;}}}else restoreGameTiles();
  for(const assignment of snapshot.assignments){const rig=avatars.get(assignment.actorId),seat=seats.find(s=>s.id===assignment.seatId);if(!rig||!seat)continue;const sample=sampleHomeAmbience(assignment.activity,Math.max(0,elapsed-assignment.startedAtElapsed),assignment.actorId);
   if(assignment.activity==='mahjong'&&mahjongGame){
    const phase=mahjongGame.phase,progress=mahjongGame.phaseProgress,current=mahjongGame.turnActorId===assignment.actorId&&mahjongGame.status==='playing';
    const winner=mahjongGame.lastEvent?.kind==='win'&&mahjongGame.lastEvent.actorId===assignment.actorId&&(mahjongGame.status==='won'||phase==='win');
    const grip=current&&((phase==='hold'&&mahjongGame.lastEvent?.kind==='draw')||(phase==='discard'&&progress<.6));
    const smooth=(v:number)=>{const t=Math.max(0,Math.min(1,v));return t*t*(3-2*t);};
    const claiming=current&&mahjongGame.lastEvent?.actorId===assignment.actorId&&['chow','pung','kong'].includes(mahjongGame.lastEvent.kind),claimReach=claiming?Math.sin(Math.PI*progress)*.65:0;
    const reach=current?(phase==='draw'?smooth(progress):phase==='hold'?(mahjongGame.lastEvent?.kind==='draw'?1:claimReach):phase==='discard'?1-smooth((progress-.5)*2):0):0;
    const exchangeReach=phase==='exchange'?Math.sin(Math.PI*progress)*.55:0;
    rig.leftArm.rotation.set(winner?-1.15:-.42-claimReach*.55-exchangeReach,0,winner?.45:.18+claimReach*.18);rig.rightArm.rotation.set(winner?-1.15:-.42-Math.max(reach,claimReach)*.75-exchangeReach,0,winner?-.45:-.18-Math.max(reach,claimReach)*.29);
    const index=Number(assignment.seatId.split('-').at(-1)),key='tile-'+index,tile=borrowed.get(key)?.object??world?.getObjectByName('home-mahjong-tile-'+index);
    if(grip&&tile){active.add(key);tile.visible=true;hold(key,tile,rig.rightArm);}
   }else if(assignment.activity==='mahjong'){
    const reach=sample.mahjong.reach;rig.leftArm.rotation.x=-.42-(sample.mahjong.hand==='left'?reach*.75:0);rig.rightArm.rotation.x=-.42-(sample.mahjong.hand==='right'?reach*.75:0);
    const index=Number(assignment.seatId.split('-').at(-1)),key='tile-'+index;
    if(sample.mahjong.hold){active.add(key);hold(key,borrowed.get(key)?.object??world?.getObjectByName('home-mahjong-tile-'+index),sample.mahjong.hand==='left'?rig.leftArm:rig.rightArm);}
   }
   if(assignment.activity==='television'&&snapshot.television.powered){
    const index=Number(assignment.seatId.split('-').at(-1)),key='seed-'+index;
    if(sample.television.seedHandLift>.03){active.add(key);hold(key,borrowed.get(key)?.object??world?.getObjectByName('home-television-seed-'+index),rig.rightArm);}
    rig.rightArm.rotation.x=-.48-sample.television.seedHandLift*1.0;rig.rightArm.rotation.z=-.16-sample.television.seedHandLift*.7;
    rig.eyes.scale.y=1-sample.television.laugh*.35;rig.body.rotation.z+=sample.television.laugh*.022*Math.sin(elapsed*20);rig.body.position.y=.75+sample.television.laugh*.012*Math.sin(elapsed*15);
   }
  }
  televisionRemote.update(world,avatars,snapshot,seats,elapsed);
  for(const key of [...borrowed.keys()])if(!active.has(key))release(key);
 }
 function dispose(){if(disposed)return;disposed=true;restore();televisionRemote.dispose();group.removeFromParent();for(const line of steam){line.geometry.dispose();(line.material as T.Material).dispose();}mistGeometry.dispose();mistMaterial.dispose();steamCloudGeometry.dispose();steamClouds.forEach(c=>(c.material as T.Material).dispose());}
 return{update,restore,dispose,getTelevisionRemote:()=>televisionRemote.getSnapshot(),getBorrowed:()=>[...borrowed.keys()]};
}
