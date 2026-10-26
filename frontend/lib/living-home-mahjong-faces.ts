import * as THREE from 'three';

const NUMERALS=['一','二','三','四','五','六','七','八','九'];
const FACES=new Set([...NUMERALS.flatMap(n=>[n+'万',n+'筒',n+'条']),'东风','南风','西风','北风','红中','发财','白板']);
const NAME='home-mahjong-face-overlay';
const FONT='"PingFang SC", "Microsoft YaHei", sans-serif';

function localTileBounds(tile:THREE.Object3D):THREE.Box3 {
  const bounds=new THREE.Box3();
  function visit(object:THREE.Object3D,matrix:THREE.Matrix4){
    if(object.userData.mahjongFaceOverlay)return;
    if(object instanceof THREE.Mesh){const position=object.geometry.getAttribute('position');if(position)bounds.union(new THREE.Box3().setFromBufferAttribute(position).applyMatrix4(matrix));}
    for(const child of object.children){const local=child.matrixAutoUpdate?new THREE.Matrix4().compose(child.position,child.quaternion,child.scale):child.matrix.clone();visit(child,new THREE.Matrix4().multiplyMatrices(matrix,local));}
  }
  visit(tile,new THREE.Matrix4());return bounds;
}

function drawFace(ctx:CanvasRenderingContext2D,text:string){
  const w=256,h=384;
  ctx.fillStyle='#f3f0e5';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#c6c2b4';ctx.lineWidth=5;ctx.strokeRect(5,5,w-10,h-10);
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='600 120px '+FONT;
  const number=NUMERALS.indexOf(text[0])+1;
  const layouts:Record<number,[number,number][]>= {
    1:[[.5,.5]],2:[[.5,.26],[.5,.74]],3:[[.24,.24],[.5,.5],[.76,.76]],
    4:[[.24,.24],[.76,.24],[.24,.76],[.76,.76]],5:[[.24,.22],[.76,.22],[.5,.5],[.24,.78],[.76,.78]],
    6:[[.26,.22],[.74,.22],[.26,.5],[.74,.5],[.26,.78],[.74,.78]],
    7:[[.24,.19],[.5,.31],[.76,.43],[.26,.64],[.74,.64],[.26,.86],[.74,.86]],
    8:[[.26,.16],[.74,.16],[.26,.39],[.74,.39],[.26,.62],[.74,.62],[.26,.85],[.74,.85]],
    9:[[.2,.2],[.5,.2],[.8,.2],[.2,.5],[.5,.5],[.8,.5],[.2,.8],[.5,.8],[.8,.8]],
  };
  function circle(x:number,y:number,r:number,color:string){ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
  if(text.endsWith('万')){ctx.fillStyle='#293a3d';ctx.font='600 118px '+FONT;ctx.fillText(text[0],128,116);ctx.fillStyle='#9c3635';ctx.font='600 138px '+FONT;ctx.fillText('萬',128,265);}
  else if(text.endsWith('筒')){
    for(const [index,[px,py]]of layouts[number].entries()){const x=32+px*192,y=42+py*294,r=number===1?63:number===2?37:number<6?26:20;const color=['#315b63','#904744','#3e6853'][index%3];circle(x,y,r,color);circle(x,y,r*.6,'#f3f0e5');circle(x,y,r*.23,color);}
  }else if(text.endsWith('条')){
    for(const [px,py]of layouts[number]){const x=32+px*192,y=42+py*294,sz=number===1?1.6:number<4?1.1:.8;ctx.fillStyle='#3d6751';ctx.fillRect(x-9*sz,y-27*sz,18*sz,54*sz);ctx.fillStyle='#b0bd97';for(const dy of [-15,7])ctx.fillRect(x-10*sz,y+dy*sz,20*sz,4*sz);ctx.fillStyle='#3d6751';for(const side of [-1,1]){ctx.beginPath();ctx.moveTo(x,y-10*sz);ctx.lineTo(x+side*28*sz,y-22*sz);ctx.lineTo(x+side*13*sz,y+2*sz);ctx.closePath();ctx.fill();}}
  }else if(text==='白板'){ctx.strokeStyle='#516b85';ctx.lineWidth=11;ctx.strokeRect(54,70,148,244);ctx.lineWidth=3;ctx.strokeRect(65,82,126,220);}
  else{ctx.fillStyle=text==='红中'?'#a03a37':text==='发财'?'#3d6b4e':'#334e60';ctx.font='600 150px '+FONT;ctx.fillText(text==='红中'?'中':text==='发财'?'發':text.endsWith('风')?text[0]:text,128,193);}
}

function disposeOverlay(overlay:THREE.Mesh){
  overlay.removeFromParent();overlay.geometry.dispose();
  for(const material of Array.isArray(overlay.material)?overlay.material:[overlay.material]){const map=(material as THREE.MeshStandardMaterial).map;if(map?.userData.mahjongFaceOwned)map.dispose();material.dispose();}
}

/** Original tile stays intact; this owned local face follows the tile when lifted by an arm. */
export function applyHomeMahjongFace(tile:THREE.Object3D,text:string):boolean{
  if(!FACES.has(text))return false;
  const previous=tile.children.find(child=>child instanceof THREE.Mesh&&child.name===NAME&&child.userData.mahjongFaceOverlay) as THREE.Mesh|undefined;
  if(previous?.userData.mahjongFace===text&&tile.userData.mahjongFace===text)return true;
  const bounds=localTileBounds(tile),size=bounds.getSize(new THREE.Vector3());
  if(bounds.isEmpty()||![...bounds.min.toArray(),...bounds.max.toArray()].every(Number.isFinite)||size.x<=0||size.z<=0)return false;
  let canvas:HTMLCanvasElement,context:CanvasRenderingContext2D|null;
  try{if(typeof document==='undefined')return false;canvas=document.createElement('canvas');canvas.width=256;canvas.height=384;context=canvas.getContext('2d');if(!context)return false;drawFace(context,text);}catch{return false;}
  let texture:THREE.CanvasTexture|undefined,geometry:THREE.PlaneGeometry|undefined,material:THREE.MeshStandardMaterial|undefined;
  try{
    texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;texture.userData.mahjongFaceOwned=true;
    geometry=new THREE.PlaneGeometry(size.x*.9,size.z*.9);geometry.rotateX(-Math.PI/2);
    material=new THREE.MeshStandardMaterial({map:texture,color:'#ffffff',roughness:.84,metalness:0,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    const overlay=new THREE.Mesh(geometry,material);overlay.name=NAME;overlay.position.set((bounds.min.x+bounds.max.x)/2,bounds.max.y+.0006,(bounds.min.z+bounds.max.z)/2);overlay.receiveShadow=true;overlay.castShadow=false;overlay.userData.mahjongFaceOverlay=true;overlay.userData.mahjongFace=text;overlay.visible=tile.userData.mahjongFaceExposed!==false;
    tile.add(overlay);tile.userData.mahjongFace=text;if(previous)disposeOverlay(previous);return true;
  }catch{texture?.dispose();geometry?.dispose();material?.dispose();return false;}
}

/** Concealed proxy keeps its original green back; the private face is not rendered. */
export function setHomeMahjongFaceExposed(tile:THREE.Object3D,exposed:boolean):void{
  tile.userData.mahjongFaceExposed=exposed;
  for(const child of tile.children)if(child.name===NAME&&child.userData.mahjongFaceOverlay)child.visible=exposed;
}
