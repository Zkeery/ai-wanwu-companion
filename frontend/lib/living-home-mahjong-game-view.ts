import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import type {HomeMahjongGameSnapshot} from './living-home-mahjong-game';
import type {PublicSharedMahjongSnapshot} from './shared-mahjong';

const NUMERALS=['一','二','三','四','五','六','七','八','九'];
const FACES=[...NUMERALS.flatMap(n=>[n+'万',n+'筒',n+'条']),'东风','南风','西风','北风','红中','发财','白板'];
const CELL=84,COLS=6,SIZE=CELL*COLS,FACE_INDEX=new Map(FACES.map((text,index)=>[text,index]));
type Tile={text:string|null;actorId:number;seatId:string;role:'hand'|'meld'|'discard';x:number;z:number;yaw:number;width:number;depth:number;height:number;standing:boolean;faceVisible:boolean;hidden:'hand'|'meld'|null};
type ViewInput={tiles:Tile[];wall:number;signature:string;logicalTiles:number;totalTiles:number;rules:'basic'|'sichuan';wonActorIds:number[];pendingDiscard:boolean;heldDraw:boolean;faceCount:number;hiddenHandCount:number;hiddenMeldCount:number;standingCount:number;faceDownHandCount:number};

function inputOf(snapshot:HomeMahjongGameSnapshot):ViewInput|null {
  if(!snapshot)return null;
  const rules=snapshot.rules??'basic',totalTiles=snapshot.totalTiles??(rules==='sichuan'?108:136);
  if(!['basic','sichuan'].includes(rules)||totalTiles!==(rules==='sichuan'?108:136)||!['playing','won','exhausted'].includes(snapshot.status)||snapshot.players.length!==4||!Number.isInteger(snapshot.wallRemaining)||snapshot.wallRemaining<0||snapshot.wallRemaining>totalTiles)return null;
  const validFace=(text:string)=>FACE_INDEX.has(text)&&(rules!=='sichuan'||text.length===2&&['万','筒','条'].includes(text.at(-1)??''));
  const event=snapshot.lastEvent,winner=rules==='basic'&&snapshot.status==='won'&&event?.kind==='win'?event.actorId:null,pending=snapshot.phase==='discard'&&snapshot.phaseProgress<.6&&event?.kind==='discard';
  const wonActorIds=snapshot.players.filter(player=>player.won===true||player.actorId===winner).map(player=>player.actorId);
  const sichuanEnded=rules==='sichuan'&&(snapshot.status==='won'||snapshot.status==='exhausted');
  const tiles:Tile[]=[],usedSeats=new Set<number>(),usedActors=new Set<number>();let discarded=0,logicalVisible=0,pendingDiscard=false,heldDraw=false;
  const pendingDiscards:{text:string;actorId:number;seatId:string}[]=[];
  for(const player of snapshot.players){
    const seat=Number(/(\d+)$/.exec(player.seatId)?.[1]);
    if(!Number.isInteger(seat)||seat<0||seat>3||usedSeats.has(seat)||!Number.isSafeInteger(player.actorId)||player.actorId<=0||usedActors.has(player.actorId)||player.hand.length>14)return null;
    usedSeats.add(seat);usedActors.add(player.actorId);
    const turn=-seat*Math.PI/2,c=Math.cos(turn),s=Math.sin(turn);
    function add(text:string,role:Tile['role'],x:number,z:number,width:number,depth:number,hidden:Tile['hidden']=null,standing=hidden==='hand'){if(!validFace(text))return false;tiles.push({text,actorId:player.actorId,seatId:player.seatId,role,x:x*c+z*s,z:-x*s+z*c,yaw:Math.PI+turn,width,depth:standing?.018:depth,height:standing?.064:.022,standing,faceVisible:hidden===null,hidden});return true;}
    const revealHand=rules==='sichuan'?sichuanEnded:wonActorIds.includes(player.actorId),standHand=!revealHand&&!(rules==='sichuan'&&player.won===true);
    const held=snapshot.phase==='hold'&&event?.kind==='draw'&&event.actorId===player.actorId?player.hand.lastIndexOf(event.tile??''):-1;
    for(let i=0;i<player.hand.length;i++){if(!validFace(player.hand[i]))return null;if(i===held){heldDraw=true;continue;}if(!add(player.hand[i],'hand',(i-(player.hand.length-1)/2)*.044,-.51,.041,.058,revealHand?null:'hand',standHand))return null;}
    const melds=player.melds.flatMap(meld=>meld.tiles);
    if(player.melds.length>4||player.melds.some(meld=>{
      if(rules==='sichuan'&&meld.kind==='chow')return true;
      if(!['chow','pung','kong'].includes(meld.kind)||meld.tiles.length!==(meld.kind==='kong'?4:3))return true;
      if(meld.kind!=='chow')return false;
      const suit=meld.tiles[0]?.at(-1),numbers=meld.tiles.map(text=>NUMERALS.indexOf(text[0])).sort((a,b)=>a-b);
      return !['万','筒','条'].includes(suit??'')||meld.tiles.some(text=>text.length!==2||text.at(-1)!==suit||!FACE_INDEX.has(text))||numbers[0]<0||numbers[1]!==numbers[0]+1||numbers[2]!==numbers[1]+1;
    }))return null;
    let meldIndex=0;for(const meld of player.melds)for(const text of meld.tiles){if(!add(text,'meld',(meldIndex-(melds.length-1)/2)*.036,-.39,.034,.05,meld.concealed===true&&!sichuanEnded?'meld':null))return null;meldIndex++;}
    logicalVisible+=player.hand.length+melds.length+player.discards.length;
    for(let i=0;i<player.discards.length;i++){const text=player.discards[i];if(!validFace(text))return null;if(pending&&event?.actorId===player.actorId&&i===player.discards.length-1&&event.tile===text){pendingDiscard=true;continue;}pendingDiscards.push({text,actorId:player.actorId,seatId:player.seatId});discarded++;}
  }
  const rows=Math.ceil(discarded/14);
  pendingDiscards.forEach((card,index)=>tiles.push({...card,role:'discard',x:((index%14)-6.5)*.036,z:(Math.floor(index/14)-(rows-1)/2)*.051,yaw:0,width:.033,depth:.046,height:.022,standing:false,faceVisible:true,hidden:null}));
  const logicalTiles=logicalVisible+snapshot.wallRemaining;
  if(logicalTiles>totalTiles)return null;
  return{tiles,wall:snapshot.wallRemaining,logicalTiles,totalTiles,rules,wonActorIds,pendingDiscard,heldDraw,faceCount:tiles.filter(tile=>tile.faceVisible).length,hiddenHandCount:tiles.filter(tile=>tile.hidden==='hand').length,hiddenMeldCount:tiles.filter(tile=>tile.hidden==='meld').length,standingCount:tiles.filter(tile=>tile.standing).length,faceDownHandCount:tiles.filter(tile=>tile.hidden==='hand'&&!tile.standing).length,signature:JSON.stringify([snapshot.revision,snapshot.status,rules,totalTiles,snapshot.wallRemaining,snapshot.players,pendingDiscard||heldDraw?event:null,snapshot.phase==='hold'&&heldDraw,winner])};
}

/** A shared table receives counts and public faces only. Hidden cards do not
 * have a face value in this renderer, including after the round ends. */
function publicInputOf(snapshot:PublicSharedMahjongSnapshot,phaseProgress=1):ViewInput|null {
  const game=snapshot?.game;
  if(!game||'own_hands' in game||game.players.length!==4||game.rules_version!=='sichuan-blood-battle-v1')return null;
  const tiles:Tile[]=[],actors=new Set<number>(),seats=new Set<number>();let logical=game.wall_remaining,heldDraw=false,pendingDiscard=false;
  if(!Number.isInteger(logical)||logical<0||logical>108)return null;
  for(const player of game.players){
    const seat=Number(/^mahjong-([0-3])$/.exec(player.seat_id)?.[1]);
    if(!Number.isInteger(seat)||seats.has(seat)||!Number.isSafeInteger(player.character_id)||player.character_id<=0||actors.has(player.character_id)||!Number.isInteger(player.hand_count)||player.hand_count<0||player.hand_count>14)return null;
    seats.add(seat);actors.add(player.character_id);
    const turn=-seat*Math.PI/2,c=Math.cos(turn),s=Math.sin(turn);
    function add(text:string|null,role:Tile['role'],x:number,z:number,width:number,depth:number,hidden:Tile['hidden']){
      if(text!==null&&!/^[一二三四五六七八九][万筒条]$/.test(text))return false;
      tiles.push({text,actorId:player.character_id,seatId:player.seat_id,role,x:x*c+z*s,z:-x*s+z*c,yaw:Math.PI+turn,width,depth:hidden==='hand'?.018:depth,height:hidden==='hand'?.064:.022,standing:hidden==='hand',faceVisible:text!==null&&hidden===null,hidden});return true;
    }
    const held=game.phase==='hold'&&game.last_event?.kind==='draw'&&game.last_event.character_id===player.character_id&&player.hand_count>0;
    if(held)heldDraw=true;
    const handOnTable=player.hand_count-Number(held);
    for(let i=0;i<handOnTable;i++)add(null,'hand',(i-(handOnTable-1)/2)*.044,-.51,.041,.058,'hand');
    if(player.melds.length>4)return null;
    const meldCount=player.melds.reduce((sum,m)=>sum+m.tile_count,0);let at=0;
    for(const meld of player.melds){
      if(meld.tile_count!==(meld.kind==='kong'?4:3)||!['pung','kong'].includes(meld.kind)||meld.concealed&&meld.tiles.length!==0||!meld.concealed&&meld.tiles.length!==meld.tile_count)return null;
      for(let i=0;i<meld.tile_count;i++)if(!add(meld.concealed?null:meld.tiles[i].face,'meld',(at++-(meldCount-1)/2)*.036,-.39,.034,.05,meld.concealed?'meld':null))return null;
    }
    logical+=player.hand_count+meldCount+player.discards.length;
  }
  const discards=game.players.flatMap(p=>p.discards.filter(tile=>{
    const held=game.phase==='discard'&&phaseProgress<.6&&game.last_event?.kind==='discard'&&game.last_event.character_id===p.character_id&&game.last_event.tile?.id===tile.id;
    if(held)pendingDiscard=true;return !held;
  }).map(t=>({...t,actorId:p.character_id,seatId:p.seat_id}))).sort((a,b)=>a.id-b.id);
  const rows=Math.ceil(discards.length/14);
  for(let i=0;i<discards.length;i++){const d=discards[i];if(!/^[一二三四五六七八九][万筒条]$/.test(d.face))return null;tiles.push({text:d.face,actorId:d.actorId,seatId:d.seatId,role:'discard',x:((i%14)-6.5)*.036,z:(Math.floor(i/14)-(rows-1)/2)*.051,yaw:0,width:.033,depth:.046,height:.022,standing:false,faceVisible:true,hidden:null});}
  if(logical>108)return null;
  return{tiles,wall:game.wall_remaining,logicalTiles:logical,totalTiles:108,rules:'sichuan',wonActorIds:game.players.filter(p=>p.won).map(p=>p.character_id),pendingDiscard,heldDraw,faceCount:tiles.filter(t=>t.faceVisible).length,hiddenHandCount:tiles.filter(t=>t.hidden==='hand').length,hiddenMeldCount:tiles.filter(t=>t.hidden==='meld').length,standingCount:tiles.filter(t=>t.standing).length,faceDownHandCount:0,signature:JSON.stringify([game.game_id,game.revision,game.status,game.players,game.wall_remaining,pendingDiscard,heldDraw])};
}

function atlas():THREE.CanvasTexture|null {
  try{
    if(typeof document==='undefined')return null;const canvas=document.createElement('canvas');canvas.width=canvas.height=SIZE;const ctx=canvas.getContext('2d');if(!ctx)return null;
    ctx.fillStyle='#f0eee3';ctx.fillRect(0,0,SIZE,SIZE);ctx.textAlign='center';ctx.textBaseline='middle';
    FACES.forEach((text,index)=>{const x=(index%COLS)*CELL,y=Math.floor(index/COLS)*CELL;ctx.strokeStyle='#c8c4b7';ctx.lineWidth=2;ctx.strokeRect(x+2,y+2,CELL-4,CELL-4);const suit=text.at(-1);ctx.fillStyle=suit==='万'||text==='红中'?'#9a403b':suit==='条'||text==='发财'?'#426149':'#354c60';ctx.font='600 31px "PingFang SC", "Microsoft YaHei", sans-serif';
      if(text==='白板'){ctx.strokeStyle='#506986';ctx.lineWidth=3;ctx.strokeRect(x+19,y+12,46,60);}
      else if(text==='红中'||text==='发财'){ctx.font='600 47px "PingFang SC", "Microsoft YaHei", sans-serif';ctx.fillText(text==='红中'?'中':'發',x+42,y+44);}
      else{ctx.fillText(text[0],x+42,y+25);ctx.font='600 28px "PingFang SC", "Microsoft YaHei", sans-serif';ctx.fillText(suit==='万'?'萬':suit!,x+42,y+60);}
    });
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;texture.userData.mahjongGameAtlas=true;return texture;
  }catch{return null;}
}

function geometry(input:ViewInput){
  const bodies:THREE.BufferGeometry[]=[],faces:THREE.BufferGeometry[]=[];
  const colorize=(shape:THREE.BufferGeometry,color:string)=>{const value=new THREE.Color(color),values=new Float32Array(shape.getAttribute('position').count*3);for(let i=0;i<values.length;i+=3){values[i]=value.r;values[i+1]=value.g;values[i+2]=value.b;}shape.setAttribute('color',new THREE.BufferAttribute(values,3));};
  try{
    for(const tile of input.tiles){
      const body=new THREE.BoxGeometry(tile.width,tile.height,tile.depth);body.rotateY(tile.yaw);body.translate(tile.x,.804+tile.height/2,tile.z);colorize(body,tile.hidden?'#657e6d':'#e9e6d8');bodies.push(body);
      // Private cards have no textured face at all, even when the camera rotates behind them.
      if(!tile.faceVisible)continue;
      const face=new THREE.PlaneGeometry(tile.width*.94,tile.depth*.94);face.rotateX(-Math.PI/2);face.rotateY(tile.yaw);face.translate(tile.x,.804+tile.height+.0007,tile.z);
      const index=FACE_INDEX.get(tile.text!)!,u=(index%COLS)/COLS,v=Math.floor(index/COLS)/COLS,uv=face.getAttribute('uv'),margin=3/SIZE;
      for(let i=0;i<uv.count;i++)uv.setXY(i,u+margin+uv.getX(i)*(1/COLS-2*margin),1-v-1/COLS+margin+uv.getY(i)*(1/COLS-2*margin));faces.push(face);
    }
    if(input.wall){const wall=new THREE.BoxGeometry(.07+input.wall/input.totalTiles*.2,.032,.04);wall.translate(0,.82,.311);colorize(wall,'#6c806d');bodies.push(wall);}
    const empty=()=>new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([],3)).setAttribute('normal',new THREE.Float32BufferAttribute([],3)).setAttribute('uv',new THREE.Float32BufferAttribute([],2));
    return{body:bodies.length?mergeGeometries(bodies,false)??empty():empty(),face:faces.length?mergeGeometries(faces,false)??empty():empty()};
  }finally{bodies.forEach(value=>value.dispose());faces.forEach(value=>value.dispose());}
}

/** Local presentation of a supplied real rules snapshot. It never invents a tile or changes game state. */
export function createHomeMahjongGameView(scene:THREE.Scene){
  let disposed=false,worldRef:THREE.Object3D|null=null,tableRef:THREE.Object3D|null=null,group:THREE.Group|null=null,texture:THREE.CanvasTexture|null=null,body:THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>|null=null,face:THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>|null=null,signature='';
  const legacy:{object:THREE.Object3D;visible:boolean}[]=[];
  function reset(){
    group?.removeFromParent();body?.geometry.dispose();face?.geometry.dispose();body?.material.dispose();face?.material.dispose();texture?.dispose();
    for(const old of legacy)old.object.visible=old.visible;legacy.length=0;group=null;body=null;face=null;texture=null;worldRef=null;tableRef=null;signature='';
  }
  function render(world:THREE.Object3D|null,input:ViewInput|null,snapshot:Pick<HomeMahjongGameSnapshot,'phase'|'phaseProgress'|'turnActorId'|'revision'> & {status:string}){
    if(disposed)return;const table=world?.getObjectByName('home-mahjong-table');if(!world||!input||!table){reset();return;}
    if(world!==worldRef||table!==tableRef)reset();
    if(!texture){texture=atlas();if(!texture)return;}
    if(signature===input.signature&&group){group.userData.snapshot.phase=snapshot.phase;group.userData.snapshot.phaseProgress=snapshot.phaseProgress;group.userData.snapshot.turnActorId=snapshot.turnActorId;return;}
    let shapes:ReturnType<typeof geometry>;try{shapes=geometry(input);}catch{return;}
    if(!group){
      group=new THREE.Group();group.name='home-mahjong-game-view';group.userData.mahjongGameView=true;group.userData.ownerSceneId=scene.uuid;
      const bodyMaterial=new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.85,metalness:0,vertexColors:true}),faceMaterial=new THREE.MeshStandardMaterial({map:texture,color:'#ffffff',roughness:.86,metalness:0});
      body=new THREE.Mesh(shapes.body,bodyMaterial);body.name='home-mahjong-game-tile-bodies';face=new THREE.Mesh(shapes.face,faceMaterial);face.name='home-mahjong-game-tile-faces';body.receiveShadow=face.receiveShadow=true;body.castShadow=true;group.add(body,face);table.add(group);worldRef=world;tableRef=table;
      for(const name of ['home-mahjong-legacy-tiles','home-mahjong-legacy-backs']){const object=table.getObjectByName(name);if(object){legacy.push({object,visible:object.visible});object.visible=false;}}
    }else{body!.geometry.dispose();face!.geometry.dispose();body!.geometry=shapes.body;face!.geometry=shapes.face;}
    signature=input.signature;group.userData.snapshot={revision:snapshot.revision,status:snapshot.status,rules:input.rules,totalTiles:input.totalTiles,wonActorIds:[...input.wonActorIds],turnActorId:snapshot.turnActorId,phase:snapshot.phase,phaseProgress:snapshot.phaseProgress,wallRemaining:input.wall,logicalTileCount:input.logicalTiles,renderedTileCount:input.tiles.length,faceCount:input.faceCount,hiddenHandCount:input.hiddenHandCount,hiddenMeldCount:input.hiddenMeldCount,standingCount:input.standingCount,faceDownHandCount:input.faceDownHandCount,pendingDiscard:input.pendingDiscard,heldDraw:input.heldDraw,proxyExcludedCount:Number(input.pendingDiscard)+Number(input.heldDraw),tiles:input.tiles.map(({text,...tile})=>({...tile,text:tile.faceVisible?text:null}))};
  }
  function update(world:THREE.Object3D|null,snapshot:HomeMahjongGameSnapshot){render(world,world?inputOf(snapshot):null,snapshot);}
  function updatePublic(world:THREE.Object3D|null,snapshot:PublicSharedMahjongSnapshot|null,progress=1){const game=snapshot?.game;if(!game){reset();return;}const phaseProgress=Math.max(0,Math.min(1,Number.isFinite(progress)?progress:1));render(world,publicInputOf(snapshot!,phaseProgress),{revision:game.revision,status:game.status,phase:game.phase,phaseProgress,turnActorId:game.turn_character_id});}
  return{update,updatePublic,reset,dispose(){if(disposed)return;reset();disposed=true;}};
}
