import * as THREE from 'three';

export type HomeTelevisionChannel=0|1|2;
export type HomeTelevisionProgramInput=Readonly<{channel:HomeTelevisionChannel;powered:boolean;elapsed:number}>;
export type HomeTelevisionProgramSnapshot=Readonly<{status:'idle'|'ready'|'unavailable'|'disposed';bound:boolean;channel:HomeTelevisionChannel|null;powered:boolean;frame:number|null;drawCount:number;textureCount:number;planeCount:number}>;
const WIDTH=408,HEIGHT=222,FPS=8,FRAMES=192;
const LABELS=['田园风景','趣味动画','乡村美食'] as const;
function oval(ctx:CanvasRenderingContext2D,x:number,y:number,rx:number,ry:number,color:string){ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.fill();}
function line(ctx:CanvasRenderingContext2D,points:readonly(readonly[number,number])[],color:string,width=2){ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();points.forEach(([x,y],i)=>{if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();}
function drawLandscape(ctx:CanvasRenderingContext2D,time:number){
  ctx.fillStyle='#b3c9cd';ctx.fillRect(0,0,WIDTH,HEIGHT);oval(ctx,332,39,17,17,'#ede0b6');
  for(let i=0;i<3;i++){const x=(time*7+i*148)%500-50;oval(ctx,x,39+i*11,30,8,'#dbe3db');oval(ctx,x+17,35+i*11,22,10,'#dbe3db');}
  ctx.fillStyle='#8b9f85';ctx.beginPath();ctx.moveTo(0,126);ctx.lineTo(74,67);ctx.lineTo(149,123);ctx.lineTo(229,74);ctx.lineTo(330,127);ctx.lineTo(408,93);ctx.lineTo(408,222);ctx.lineTo(0,222);ctx.closePath();ctx.fill();
  ctx.fillStyle='#748e69';ctx.fillRect(0,139,408,83);ctx.fillStyle='#b5b187';ctx.beginPath();ctx.moveTo(170,148);ctx.lineTo(190,148);ctx.lineTo(274,222);ctx.lineTo(124,222);ctx.closePath();ctx.fill();
  ctx.fillStyle='#ded8c2';ctx.fillRect(61,111,73,45);ctx.fillStyle='#686e69';ctx.beginPath();ctx.moveTo(51,112);ctx.lineTo(97,84);ctx.lineTo(145,112);ctx.closePath();ctx.fill();ctx.fillStyle='#796b56';ctx.fillRect(91,128,15,28);ctx.fillStyle='#b2cbd0';ctx.fillRect(69,123,15,14);ctx.fillRect(112,123,15,14);
  for(let i=0;i<16;i++){const x=17+i*26,y=170+(i%3)*13,sway=Math.sin(time*1.2+i)*3;line(ctx,[[x,y+17],[x+sway,y]],'#627c50');oval(ctx,x+sway,y,4,2,'#b8c37a');}
  for(let i=0;i<2;i++){const x=225+Math.sin(time*.32+i)*54,y=63+i*12;line(ctx,[[x-5,y],[x,y+Math.sin(time*4+i)*3],[x+5,y]],'#647a7d',1.5);}
}
function drawCartoon(ctx:CanvasRenderingContext2D,time:number){
  ctx.fillStyle='#d5d8c9';ctx.fillRect(0,0,WIDTH,HEIGHT);ctx.fillStyle='#b8c6a6';ctx.fillRect(0,162,WIDTH,60);
  for(let i=0;i<3;i++){const x=93+i*112,bounce=Math.max(0,Math.sin(time*2+i*1.2))*19,y=140-bounce,color=['#c7b17d','#91a895','#c2a99b'][i];
    oval(ctx,x,170,29,5,'#9dac92');line(ctx,[[x-8,y+15],[x-10,y+29]],'#66685b',5);line(ctx,[[x+9,y+15],[x+12,y+29]],'#66685b',5);oval(ctx,x,y,26,29,color);oval(ctx,x-9,y-7,3,4,'#48544f');oval(ctx,x+9,y-7,3,4,'#48544f');line(ctx,[[x-8,y+7],[x,y+12+Math.sin(time*3+i)*2],[x+8,y+7]],'#667469',2);
    const wave=Math.sin(time*3+i)*10;line(ctx,[[x-23,y],[x-38,y-12-wave]],'#6d786c',4);line(ctx,[[x+23,y],[x+36,y-12+wave]],'#6d786c',4);
  }
  const ballX=206+Math.sin(time*.9)*133,ballY=183-Math.abs(Math.sin(time*1.8))*48;oval(ctx,ballX,ballY,12,12,'#c99077');line(ctx,[[ballX-10,ballY],[ballX+10,ballY]],'#ead8bb',2);
}
function drawFood(ctx:CanvasRenderingContext2D,time:number){
  ctx.fillStyle='#d8cebb';ctx.fillRect(0,0,WIDTH,HEIGHT);ctx.fillStyle='#b8ab94';ctx.fillRect(0,145,WIDTH,77);ctx.fillStyle='#99957e';ctx.fillRect(0,150,WIDTH,5);
  ctx.fillStyle='#b4beb5';ctx.fillRect(33,37,74,67);line(ctx,[[70,37],[70,104]],'#8b938b',4);line(ctx,[[33,70],[107,70]],'#8b938b',4);
  oval(ctx,236,172,104,16,'#8e806e');oval(ctx,236,153,80,31,'#4d5550');oval(ctx,236,144,75,23,'#686957');
  for(let i=0;i<12;i++){const angle=i*2.4+Math.sin(time*1.3)*.08,x=235+Math.cos(angle)*(20+i*3),y=143+Math.sin(angle)*(7+i*.5);oval(ctx,x,y,7,4,i%3===0?'#c59f69':i%3===1?'#87965d':'#b5aa78');}
  const stir=Math.sin(time*1.5)*19;line(ctx,[[253+stir,137],[320,72]],'#8b6f4f',9);oval(ctx,253+stir,137,11,5,'#a58c64');
  for(let i=0;i<3;i++){const drift=Math.sin(time*1.5+i)*6,x=215+i*24;line(ctx,[[x,115],[x+drift,100],[x-drift*.5,85],[x+drift,68]],'#e7e2d4',3);}
  oval(ctx,76,175,33,13,'#e8dfcf');oval(ctx,76,169,31,9,'#b1b389');ctx.fillStyle='#8b826b';ctx.fillRect(116,162,45,4);
}
function draw(ctx:CanvasRenderingContext2D,channel:HomeTelevisionChannel,frame:number){
  const time=frame/FPS;ctx.save();try{if(channel===0)drawLandscape(ctx,time);else if(channel===1)drawCartoon(ctx,time);else drawFood(ctx,time);ctx.fillStyle='#f2efe4';ctx.fillRect(10,10,106,23);ctx.fillStyle='#48584d';ctx.font='14px "PingFang SC", "Microsoft YaHei", sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(LABELS[channel],17,22);}finally{ctx.restore();}
}

/** Owns only a local screen overlay. The supplied frozen clock never starts a timer or a request. */
export function createHomeTelevisionPrograms(){
  let disposed=false,status:HomeTelevisionProgramSnapshot['status']='idle',worldRef:THREE.Object3D|null=null,screenRef:THREE.Object3D|null=null,original:THREE.Object3D|null=null,originalVisible=true;
  let failedWorld:THREE.Object3D|null=null,failedScreen:THREE.Object3D|null=null;
  let plane:THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>|null=null,channel:HomeTelevisionChannel|null=null,powered=false,frame:number|null=null,drawCount=0;
  const canvases:HTMLCanvasElement[]=[],contexts:CanvasRenderingContext2D[]=[],textures:THREE.CanvasTexture[]=[],frames=[-1,-1,-1];
  function clear(){
    plane?.removeFromParent();plane?.geometry.dispose();plane?.material.dispose();for(const texture of textures)texture.dispose();for(const canvas of canvases){canvas.width=0;canvas.height=0;}
    if(original)original.visible=originalVisible;plane=null;worldRef=null;screenRef=null;original=null;failedWorld=null;failedScreen=null;canvases.length=contexts.length=textures.length=0;frames.fill(-1);channel=null;powered=false;frame=null;drawCount=0;status=disposed?'disposed':'idle';
  }
  function bind(world:THREE.Object3D,screen:THREE.Object3D){
    try{
      if(typeof document==='undefined')return false;
      for(let i=0;i<3;i++){const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;canvases.push(canvas);const context=canvas.getContext('2d');if(!context){clear();return false;}contexts.push(context);const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.userData.homeTelevisionChannel=i;textures.push(texture);}
      const material=new THREE.MeshBasicMaterial({map:textures[0],toneMapped:false,depthWrite:false,side:THREE.FrontSide});plane=new THREE.Mesh(new THREE.PlaneGeometry(2.04,1.11),material);plane.name='home-television-active-program';plane.position.z=-.025;plane.rotation.y=Math.PI;plane.userData.homeLocalTelevisionProgram=true;plane.renderOrder=1;screen.add(plane);
      original=screen.getObjectByName('home-television-program')??null;originalVisible=original?.visible??true;if(original)original.visible=false;worldRef=world;screenRef=screen;status='ready';return true;
    }catch{clear();return false;}
  }
  function fallback(world:THREE.Object3D,screen:THREE.Object3D,input:HomeTelevisionProgramInput){
    if(!original){original=screen.getObjectByName('home-television-program')??null;originalVisible=original?.visible??true;}
    failedWorld=world;failedScreen=screen;worldRef=world;screenRef=screen;channel=input.channel;powered=input.powered;frame=null;status='unavailable';
    if(original)original.visible=powered;
  }
  function update(world:THREE.Object3D|null,input:HomeTelevisionProgramInput){
    if(disposed)return;if(!world){clear();return;}if(!input||![0,1,2].includes(input.channel)||typeof input.powered!=='boolean'||!Number.isFinite(input.elapsed)||input.elapsed<0)return;
    const screen=world.getObjectByName('home-television-screen');if(!screen){clear();return;}if(world===failedWorld&&screen===failedScreen){fallback(world,screen,input);return;}if(world!==worldRef||screen!==screenRef)clear();if(!plane&&!bind(world,screen)){fallback(world,screen,input);return;}
    try{
      channel=input.channel;powered=input.powered;plane!.visible=powered;if(original)original.visible=false;plane!.userData.channel=channel;
      if(!powered)return;const nextFrame=Math.floor((input.elapsed%(FRAMES/FPS))*FPS);
      if(frames[channel]!==nextFrame){draw(contexts[channel],channel,nextFrame);textures[channel].needsUpdate=true;frames[channel]=nextFrame;drawCount++;}
      plane!.material.map=textures[channel];frame=nextFrame;plane!.userData.frame=frame;plane!.userData.program=LABELS[channel];
    }catch{clear();fallback(world,screen,input);}
  }
  function getSnapshot():HomeTelevisionProgramSnapshot{return Object.freeze({status,bound:!!plane&&!!screenRef,channel,powered,frame,drawCount,textureCount:textures.length,planeCount:plane?1:0});}
  return{update,reset(){if(!disposed)clear();},getSnapshot,dispose(){if(disposed)return;disposed=true;clear();}};
}
