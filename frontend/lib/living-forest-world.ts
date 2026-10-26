import * as THREE from 'three';
import { buildNaturalHouse } from './living-natural-house';
import { buildNaturalLeisureScene } from './living-natural-leisure-scene';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createHomeMaterials, type HomeMaterialLibrary, type HomeMaterialRole } from './living-home-materials';
import { buildRealisticHomeItem, homeLeafCluster, homeSeatCushionGeometry, type HomeLeaf } from './living-home-realistic-details';

type Builder = ReturnType<typeof builder>;
const V = (x:number,y:number,z:number)=>new THREE.Vector3(x,y,z);
function builder(surfaces:HomeMaterialLibrary){
  function mesh(parent:THREE.Object3D,name:string,shape:THREE.BufferGeometry,role:HomeMaterialRole,color:string,x=0,y=0,z=0,obstacle=false){
    surfaces.uv(shape,role);const value=new THREE.Mesh(shape,surfaces.material(role,color,'forest-'+role));value.name=name;value.position.set(x,y,z);value.castShadow=value.receiveShadow=true;value.userData.homeMaterialOwnerId=surfaces.ownerId;value.userData.homeMaterialRole=role;if(obstacle)value.userData.naturalNavObstacle=true;parent.add(value);return value;
  }
  const box=(p:THREE.Object3D,n:string,r:HomeMaterialRole,c:string,x:number,y:number,z:number,w:number,h:number,d:number,o=false)=>mesh(p,n,new THREE.BoxGeometry(w,h,d),r,c,x,y,z,o);
  function rod(parent:THREE.Object3D,name:string,a:THREE.Vector3,b:THREE.Vector3,radius:number,role:HomeMaterialRole='wood',obstacle=false){const direction=b.clone().sub(a);const value=mesh(parent,name,new THREE.CylinderGeometry(radius*.86,radius,direction.length(),8),role,role==='wood'?'#77644c':'#77786e',0,0,0,obstacle);value.position.copy(a).add(b).multiplyScalar(.5);value.quaternion.setFromUnitVectors(V(0,1,0),direction.normalize());return value;}
  return{mesh,box,rod};
}
function cabin(parent:THREE.Object3D,b:Builder){
  const root=new THREE.Group();root.name='forest-timber-cabin';root.position.set(-3.45,0,-6.15);root.userData.naturalNavObstacle=true;root.userData.naturalStructure='closed-timber-cabin';parent.add(root);
  const width=4.45,depth=3.4,height=2.55,front=depth/2;
  b.box(root,'forest-cabin-stone-plinth','stone','#817e6c',0,.11,0,width+.16,.22,depth+.16);
  b.box(root,'forest-cabin-floor','wood-floor','#84725b',0,.235,0,width,.065,depth);
  b.box(root,'forest-cabin-back','wood','#826c51',0,height/2+.25,-front,width,height,.13);
  for(const side of [-1,1])b.box(root,'forest-cabin-side-'+side,'wood','#826c51',side*width/2,height/2+.25,0,.13,height,depth);
  // Visible joinery and a real, closed door; entering this cabin is outside this preview scope.
  const doorX=.4,doorWidth=1.05,doorHeight=2.08;
  const windowLeft=-1.70,windowRight=-.80,windowBottom=1.09,windowTop=2.03;
  b.box(root,'forest-cabin-front-left-outer','wood','#826c51',(-width/2+windowLeft)/2,height/2+.25,front,windowLeft+width/2,height,.13);
  b.box(root,'forest-cabin-front-left-inner','wood','#826c51',(windowRight+doorX-doorWidth/2)/2,height/2+.25,front,doorX-doorWidth/2-windowRight,height,.13);
  b.box(root,'forest-cabin-front-window-base','wood','#826c51',-1.25,(.25+windowBottom)/2,front,.90,windowBottom-.25,.13);
  b.box(root,'forest-cabin-front-window-head','wood','#826c51',-1.25,(height+.25+windowTop)/2,front,.90,height+.25-windowTop,.13);
  b.box(root,'forest-cabin-front-right','wood','#826c51',(width/2+doorX+doorWidth/2)/2,height/2+.25,front,width/2-doorX-doorWidth/2,height,.13);
  b.box(root,'forest-cabin-front-lintel','wood','#826c51',doorX,doorHeight+(height-doorHeight)/2+.25,front,doorWidth,height-doorHeight,.13);
  b.box(root,'forest-cabin-door','wood','#68553f',doorX,.25+doorHeight/2,front+.025,doorWidth-.06,doorHeight-.035,.08);
  for(const side of [-1,1])b.box(root,'forest-cabin-door-jamb-'+side,'wood','#66543d',doorX+side*(doorWidth/2+.025),1.29,front+.095,.095,2.18,.1);
  b.box(root,'forest-cabin-door-head','wood','#66543d',doorX,2.36,front+.095,1.24,.1,.1);
  const handle=b.mesh(root,'forest-cabin-door-handle',new THREE.SphereGeometry(.036,10,8),'metal','#777268',doorX+.35,1.26,front+.09);handle.scale.set(1,1,.55);
  b.box(root,'forest-cabin-entry-step','stone','#817c69',doorX,.055,front+.24,1.38,.11,.48);
  const window=new THREE.Group();window.name='forest-cabin-front-window';window.position.set(-1.25,1.56,front+.087);root.add(window);
  b.box(window,'forest-cabin-window-glass','glass','#b8c8c4',0,0,0,.77,.78,.026);
  for(const x of [-.435,0,.435])b.box(window,'forest-cabin-window-upright-'+x,'wood','#5f543f',x,0,.023,x===0?.035:.085,.94,.075);
  for(const y of [-.44,0,.44])b.box(window,'forest-cabin-window-crossbar-'+y,'wood','#5f543f',0,y,.025,.96,y===0?.032:.085,.08);
  b.box(window,'forest-cabin-window-sill','wood','#5f543f',0,-.51,.08,1.08,.09,.24);
  for(const side of [-1,1])b.box(window,'forest-cabin-window-reveal-'+side,'wood','#665944',side*.40,0,-.055,.07,.82,.18);
  for(const y of [-.40,.40])b.box(window,'forest-cabin-window-reveal-horizontal-'+y,'wood','#665944',0,y,-.055,.82,.06,.18);
  for(let i=0;i<7;i++)b.box(root,'forest-cabin-door-plank-seam-'+i,'wood','#5c4b39',doorX-.4+i*.133,1.29,front+.069,.008,2.02,.008);
  for(const y of [.61,1.94])b.box(root,'forest-cabin-door-hinge-'+y,'metal','#5c5b50',doorX-doorWidth/2+.06,y,front+.078,.07,.12,.018);
  b.box(root,'forest-cabin-handle-backplate','metal','#69695e',doorX+.35,1.26,front+.075,.075,.16,.012);
  for(let i=0;i<11;i++){const y=.34+i*.225;const lowWindow=y>windowBottom-.02&&y<windowTop+.02;const spans=lowWindow?[[-width/2,windowLeft],[windowRight,doorX-doorWidth/2]]:[[-width/2,doorX-doorWidth/2]];for(const [index,[left,right]]of spans.entries())b.box(root,'forest-cabin-front-lap-left-'+i+'-'+index,'wood','#716148',(left+right)/2,y,front+.079,right-left,.022,.023);if(y<doorHeight+.25)b.box(root,'forest-cabin-front-lap-right-'+i,'wood','#716148',(width/2+doorX+doorWidth/2)/2,y,front+.079,width/2-doorX-doorWidth/2,.022,.023);else b.box(root,'forest-cabin-front-upper-lap-'+i,'wood','#716148',0,y,front+.079,width,.022,.023);}
  // Horizontal timber laps and exposed corner posts provide scale without image billboards.
  for(let i=0;i<11;i++){const y=.34+i*.225;b.box(root,'forest-cabin-rear-lap-'+i,'wood','#726148',0,y,-front-.075,width+.04,.023,.025);for(const side of [-1,1])b.box(root,'forest-cabin-side-lap-'+side+'-'+i,'wood','#726148',side*(width/2+.075),y,0,.025,.023,depth);}
  for(const x of [-width/2,width/2])for(const z of [-front,front])b.box(root,'forest-cabin-corner-'+x+'-'+z,'wood','#66523c',x,1.52,z,.16,2.65,.16);
  const roofRise=1.08,half=width/2+.3,slope=Math.hypot(half,roofRise),angle=Math.atan2(roofRise,half);
  for(const side of [-1,1]){const panel=b.box(root,'forest-cabin-roof-plane-'+side,'wood','#60503d',side*half/2,2.72+roofRise/2,0,slope,.14,depth+.65);panel.rotation.z=-side*angle;
    for(let i=0;i<9;i++){const t=(i+.5)/9;const batten=b.box(root,'forest-cabin-roof-batten-'+side+'-'+i,'wood','#635440',side*half*t,2.81+roofRise*(1-t),0,.045,.04,depth+.67);batten.rotation.z=-side*angle;}}
  for(const z of [-front-.025,front+.025]){const gable=new THREE.Shape();gable.moveTo(-width/2,0);gable.lineTo(width/2,0);gable.lineTo(0,roofRise);gable.closePath();b.mesh(root,'forest-cabin-timber-gable-'+z,new THREE.ExtrudeGeometry(gable,{depth:.075,bevelEnabled:false}),'wood','#7d6b51',0,2.68,z);}
  b.box(root,'forest-cabin-ridge-cap','metal','#615d53',0,3.86,0,.1,.06,depth+.78);
  root.userData.naturalDoorDimensions={width:doorWidth,height:doorHeight};return root;
}
function tent(parent:THREE.Object3D,b:Builder,name='forest-canvas-tent'){
  const root=new THREE.Group();root.name=name;root.userData.naturalNavObstacle=true;root.userData.naturalStructure='a-frame-canvas-tent';parent.add(root);
  const half=1.32,height=1.85,depth=2.7;
  b.box(root,name+'-groundsheet','fabric','#898575',0,.025,0,half*2,.05,depth);
  for(const side of [-1,1]){const positions:number[]=[],indices:number[]=[];for(let row=0;row<=8;row++)for(let column=0;column<=10;column++){const t=row/8,z=(column/10-.5)*depth;positions.push(side*half*t,.075+(1-t)*height-Math.sin(Math.PI*t)*.042+Math.sin(column*2.3)*Math.sin(t*Math.PI)*.009,z);}
    for(let row=0;row<8;row++)for(let column=0;column<10;column++){const a=row*11+column;indices.push(a,a+1,a+11,a+1,a+12,a+11);}const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();const panel=b.mesh(root,name+'-fabric-panel-'+side,geometry,'fabric','#b8ae96');panel.material.side=THREE.DoubleSide;
    for(const z of [-depth/2,depth/2]){b.rod(root,name+'-guyline-'+side+'-'+z,V(side*half*.9,.28,z*.8),V(side*1.72,.025,z*1.13),.008,'fabric');b.rod(root,name+'-peg-'+side+'-'+z,V(side*1.72,0,z*1.13),V(side*1.72,.075,z*1.13),.016,'metal');}}
  for(const z of [-depth/2,depth/2]){b.rod(root,name+'-post-'+z,V(0,.045,z),V(0,1.96,z),.025,'metal');for(const side of [-1,1]){const shape=new THREE.BufferGeometry();shape.setAttribute('position',new THREE.Float32BufferAttribute([side*half,.075,z,0,1.925,z,side*.31,.075,z],3));shape.computeVertexNormals();const curtain=b.mesh(root,name+'-entrance-flap-'+side+'-'+z,shape,'fabric','#a99e86');curtain.material.side=THREE.DoubleSide;}}
  b.rod(root,name+'-ridge',V(0,1.93,-depth/2-.05),V(0,1.93,depth/2+.05),.022,'metal');return root;
}
function forestTree(parent:THREE.Object3D,b:Builder,surfaces:HomeMaterialLibrary,season:string|null,index:number,x:number,z:number,distant=false){
  const root=new THREE.Group();root.name=(distant?'forest-distant-tree-':'forest-edge-tree-')+index;root.position.set(x,0,z);parent.add(root);b.rod(root,root.name+'-trunk',V(0,0,0),V(.09,3.2,0),.16,'wood',true);
  const branches:THREE.BufferGeometry[]=[],leaves:HomeLeaf[]=[];
  function branch(a:THREE.Vector3,c:THREE.Vector3,radius:number){const direction=c.clone().sub(a),geometry=new THREE.CylinderGeometry(radius*.5,radius,direction.length(),7);geometry.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(.5),new THREE.Quaternion().setFromUnitVectors(V(0,1,0),direction.normalize()),V(1,1,1)));branches.push(geometry);}
  const colors=season==='autumn'?['#8a7448','#a18a51']:season==='winter'?['#68776a','#7d8a76']:['#526c48','#74845a'];
  for(let limb=0;limb<12;limb++){
    const angle=limb*2.399+index*.51,reach=.82+(limb%3)*.19,end=V(Math.sin(angle)*reach,2.95+(limb%4)*.25,Math.cos(angle)*reach*.86),base=V(.06,2.02+(limb%4)*.19,0);branch(base,end,.055);
    const leafCount=season==='winter'?distant?4:7:distant?18:40;
    for(let twig=0;twig<3;twig++){const a=end.clone().lerp(base,.22+twig*.13),c=end.clone().add(V(Math.sin(angle+twig*2.1)*.36,.13+twig*.12,Math.cos(angle+twig*2.1)*.32));branch(a,c,.014);}
    for(let i=0;i<leafCount;i++){const turn=i*2.399+angle,radius=.13+(i%5)*.085;leaves.push({x:end.x+Math.sin(turn)*radius,y:end.y+Math.sin(i*.83)*.27+(i%3)*.11,z:end.z+Math.cos(turn)*radius*.8,length:.26+(i%4)*.045,width:.10+(i%3)*.025,rx:1.0+Math.cos(turn)*.4,ry:turn,rz:Math.sin(turn)*.52});}
  }
  for(let i=0;i<(season==='winter'?distant?8:16:distant?48:100);i++){const angle=i*2.399,radius=.13+(i%5)*.105;leaves.push({x:Math.sin(angle)*radius,y:3.82+(i%6)*.11,z:Math.cos(angle)*radius*.85,length:.27+(i%3)*.05,width:.11+(i%2)*.035,rx:.9+Math.cos(angle)*.3,ry:angle,rz:Math.sin(angle)*.55});}
  branch(V(.07,2.8,0),V(.03,4.25,0),.065);const wood=mergeGeometries(branches,false);branches.forEach(geometry=>geometry.dispose());if(wood)b.mesh(root,root.name+'-branched-crown-support',wood,'wood','#716048');
  const crown=homeLeafCluster(root,root.name+'-crown',leaves,colors,surfaces);crown.userData.localMotion='leaf';root.userData.naturalLeafCount=leaves.length;return root;
}
function forestSoilMaterial(ownerId:string){
  const size=128,pixels=new Uint8Array(size*size*4),bumps=new Uint8Array(size*size*4);
  const hash=(x:number,y:number)=>{let value=Math.imul(x+17,374761393)^Math.imul(y+41,668265263);value=Math.imul(value^(value>>>13),1274126177);return(value^(value>>>16))>>>0;};
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const random=hash(x,y),fine=(random%29)-14,patch=(hash(Math.floor(x/9),Math.floor(y/9))%17)-8,grain=random%37===0?15:random%41===0?-17:0,at=(y*size+x)*4;pixels[at]=112+fine+patch+grain;pixels[at+1]=99+fine+patch+grain;pixels[at+2]=76+fine+patch+grain;pixels[at+3]=255;const height=110+(random%69);bumps[at]=bumps[at+1]=bumps[at+2]=height;bumps[at+3]=255;}
  const map=new THREE.DataTexture(pixels,size,size,THREE.RGBAFormat),bump=new THREE.DataTexture(bumps,size,size,THREE.RGBAFormat);map.colorSpace=THREE.SRGBColorSpace;bump.colorSpace=THREE.NoColorSpace;
  for(const texture of [map,bump]){texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.needsUpdate=true;texture.userData.homeProceduralSurface='forest-soil';}
  const material=new THREE.MeshStandardMaterial({map,bumpMap:bump,bumpScale:.018,roughness:.98,color:'#ffffff'});material.userData.homeMaterialOwnerId=ownerId;material.userData.homeMaterialRole='forest-soil';return material;
}
function forestFloor(parent:THREE.Object3D,surfaces:HomeMaterialLibrary,season:string|null){
  const material=forestSoilMaterial(surfaces.ownerId),parts:THREE.BufferGeometry[]=[];
  const shape=new THREE.Shape();
  for(let i=0;i<46;i++){const angle=i*Math.PI*2/46,radius=1+Math.sin(i*1.7)*.09+Math.cos(i*2.3)*.045,x=Math.cos(angle)*3.65*radius,z=.6+Math.sin(angle)*2.55*radius;if(i)shape.lineTo(x,-z);else shape.moveTo(x,-z);}shape.closePath();const clearing=new THREE.ShapeGeometry(shape);clearing.rotateX(-Math.PI/2);clearing.translate(0,.003,0);surfaces.uv(clearing,'plaster');parts.push(clearing);
  const routes=[[[0,7.6],[-.35,4.8],[-.65,2.9],[-.25,.8]],[[0,.8],[-1,-.9],[-2.7,-2.9],[-3,-3.95]],[[.6,.7],[1.6,-1],[2.7,-2.8],[3.5,-4.2]]];
  for(const route of routes){const curve=new THREE.CatmullRomCurve3(route.map(([x,z])=>V(x,.004,z))),positions:number[]=[],indices:number[]=[];for(let i=0;i<=34;i++){const t=i/34,point=curve.getPoint(t),direction=curve.getTangent(t),width=.42+Math.sin(i*.7)*.045;for(const side of [-1,1])positions.push(point.x+direction.z*width*side,point.y,point.z-direction.x*width*side);if(i<34){const a=i*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}}const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();surfaces.uv(geometry,'plaster');parts.push(geometry);}
  const geometry=mergeGeometries(parts,false);parts.forEach(value=>value.dispose());if(geometry){const floor=new THREE.Mesh(geometry,material);floor.name='forest-trodden-clearing';floor.receiveShadow=true;floor.userData.homeMaterialOwnerId=surfaces.ownerId;floor.userData.homeMaterialRole='forest-soil';floor.userData.naturalFloorDetail='irregular-granular-clearing-and-branching-footpaths';parent.add(floor);}else{material.map?.dispose();material.bumpMap?.dispose();material.dispose();}
  const grass:HomeLeaf[]=[];for(let patch=0;patch<16;patch++){const angle=patch*2.399,center=V(Math.sin(angle)*(4.2+(patch%3)*.3),0,Math.cos(angle)*3.8+.5);for(let i=0;i<28;i++){const a=i*2.399,radius=(i%5)*.09,length=.10+(i%4)*.025;grass.push({x:center.x+Math.sin(a)*radius,y:length/2+.003,z:center.z+Math.cos(a)*radius,length,width:.014+(i%3)*.004,rx:.15,ry:a,rz:Math.sin(a)*.28});}}
  homeLeafCluster(parent,'forest-verge-grass',grass,season==='autumn'?['#77784f','#8b8357']:season==='winter'?['#7b8373','#929582']:['#65764b','#7c8758'],surfaces);
}
/** Existing saved coordinates are deliberately left to the caller. */
export function buildForestItem(kind:string,season:string|null,surfaces:HomeMaterialLibrary):THREE.Group{
  const b=builder(surfaces);if(kind==='tree'||kind==='bench'||kind==='shade'){const value=buildRealisticHomeItem(kind,season,surfaces);value.name='forest-saved-item-'+kind;
    value.traverse(object=>{delete object.userData.homeNavObstacle;if(kind==='tree'){if(object.name==='home-item-tree-trunk'||object.name.startsWith('home-item-tree-branch-'))object.userData.naturalNavObstacle=true;else if(object.userData.homeDetail==='layered-foliage')object.userData.localMotion='leaf';}});
    if(kind==='bench')value.userData.naturalNavObstacle=true;if(kind==='shade')for(const name of ['home-item-shade-pole','home-item-shade-canopy']){const part=value.getObjectByName(name);if(part)part.userData.naturalNavObstacle=true;}return value;}
  const root=new THREE.Group();root.name='forest-saved-item-'+kind;root.userData.homeMaterialOwnerId=surfaces.ownerId;
  if(kind==='cushion'){const value=b.mesh(root,'forest-saved-cushion',homeSeatCushionGeometry(.9,.2,.72),'fabric','#a4927d',0,.10,0,true);value.userData.naturalSoftProp=true;}
  else if(kind==='tent'){tent(root,b);}
  else if(kind==='rock'){const value=b.mesh(root,'forest-saved-rock',new THREE.IcosahedronGeometry(.45,1),'stone','#827f70',0,.23,0,true);value.scale.set(1,.64,.83);}
  else if(kind==='pond'){const edge=b.mesh(root,'forest-saved-pond-bank',new THREE.CylinderGeometry(.85,.92,.08,32),'stone','#858475',0,.025,0,true);edge.scale.z=.66;const water=b.mesh(root,'forest-saved-pond-water',new THREE.CircleGeometry(.76,40),'glass','#789c9c',0,.071,0);water.rotation.x=-Math.PI/2;water.scale.y=.66;water.material.color.set('#7f9b99');water.material.opacity=.83;water.material.roughness=.16;}
  else if(kind==='campfire'){for(let i=0;i<3;i++){const angle=i*Math.PI/3;b.rod(root,'forest-fire-log-'+i,V(-Math.cos(angle)*.4,.07,-Math.sin(angle)*.4),V(Math.cos(angle)*.4,.07,Math.sin(angle)*.4),.07,'wood',true);}for(let i=0;i<7;i++){const angle=i*Math.PI*2/7;const stone=b.mesh(root,'forest-fire-stone-'+i,new THREE.IcosahedronGeometry(.13,1),'stone','#77766a',Math.sin(angle)*.42,.09,Math.cos(angle)*.42,true);stone.scale.y=.7;}const flame=b.mesh(root,'forest-fire-flame',new THREE.SphereGeometry(.16,10,8),'foliage','#d6ab72',0,.27,0);flame.scale.set(.7,1.7,.7);flame.material.emissive.set('#b47d40');flame.material.emissiveIntensity=.28;flame.userData.localMotion='fire';}
  else if(kind==='flower'||kind==='mushroom'){for(let i=0;i<5;i++){const angle=i*2.399,x=Math.sin(angle)*.22,z=Math.cos(angle)*.2;if(kind==='mushroom'){b.rod(root,'forest-mushroom-stem-'+i,V(x,0,z),V(x,.23,z),.025,'plaster');const cap=b.mesh(root,'forest-mushroom-cap-'+i,new THREE.SphereGeometry(.10,12,8),'fabric','#a38a73',x,.25,z);cap.scale.y=.45;}else{b.rod(root,'forest-flower-stem-'+i,V(x,0,z),V(x,.34,z),.009,'foliage');const flower=b.mesh(root,'forest-flower-head-'+i,new THREE.SphereGeometry(.045,10,8),'foliage','#bda69e',x,.35,z);flower.scale.y=.35;}}root.userData.naturalNavObstacle=true;}
  else if(kind==='fireflies'){for(let i=0;i<6;i++){const fly=b.mesh(root,'forest-firefly-'+i,new THREE.SphereGeometry(.018,6,5),'foliage','#c5bf88',Math.sin(i*2.3)*.32,.32+(i%3)*.13,Math.cos(i*2.3)*.3);fly.userData.localMotion='leaf';}}
  else root.userData.naturalUnsupportedKind=kind;
  root.updateMatrixWorld(true);return root;
}
/** A metre-scale woodland clearing, using already bundled same-origin surfaces only. */
export function buildForestEnvironment(season:string|null,options:{onTextureLoaded?:()=>void;indoor?:boolean;leisure?:boolean}={}):THREE.Group{
  const root=new THREE.Group();root.name='natural-forest-world';const surfaces=createHomeMaterials(options),b=builder(surfaces);root.userData.homeMaterialLibrary=surfaces;root.userData.homeMaterialOwnerId=surfaces.ownerId;root.userData.homeTextureStatus=surfaces.status;root.userData.homeMaterialMode='pbr-local';root.userData.naturalScene='forest';root.userData.naturalNavigationBounds={minX:-5.35,maxX:5.35,minZ:-3.9,maxZ:4.6};
  const ground=b.mesh(root,'forest-ground',new THREE.CylinderGeometry(10.2,10.3,.16,80),'grass','#6f765c',0,-.08,0);ground.castShadow=false;ground.visible=false;ground.userData.naturalLegacyBase=true;
  const extent=new THREE.PlaneGeometry(64,64);extent.rotateX(-Math.PI/2);const continuous=b.mesh(root,'forest-ground-continuation',extent,'grass','#6f765c');continuous.castShadow=false;continuous.userData.naturalContinuousGround=true;root.userData.naturalGroundExtent=64;
  forestFloor(root,surfaces,season);
  if(options.indoor){root.add(buildNaturalHouse('forest',surfaces));root.userData.naturalHouse=true;}else cabin(root,b);const canvas=tent(root,b);canvas.position.set(3.6,0,-5.9);
  const locations=[[-7,-4.8],[-7.8,-.8],[-7.1,4.5],[-3.7,7.3],[1,8],[6.7,5.2],[7.7,.8],[7.1,-4.8],[0,-8.4]];
  locations.forEach(([x,z],i)=>forestTree(root,b,surfaces,season,i,options.indoor&&i===0?-7.5:options.indoor&&i===8?.8:x,z));
  if(options.indoor)root.userData.naturalIndoorContextTreeOffsets=[{index:0,fromX:-7,toX:-7.5},{index:8,fromX:0,toX:.8}];
  // Context trees remain beyond the navigation envelope, not a wall of flat billboards.
  const distantSpots=[[-13,-11],[-9,-12],[-1.5,-12.5],[5,-11.5],[9,-12.8],[13,-11.6],[-16,-18],[-10,-19],[-4,-18],[2,-20],[8,-18],[15,-19]];
  distantSpots.forEach(([x,z],index)=>{const tree=forestTree(root,b,surfaces,season,index,x,z,true);tree.scale.set(.92+(index%3)*.12,1.2+(index%4)*.1,.94+(index%3)*.13);tree.userData.naturalDistantContext=true;});root.userData.naturalDistantTreeCount=distantSpots.length;
  const shrubSpots=[[-6.4,-1.8],[-6.2,3.6],[6.3,-1.5],[6.5,3.5],[-2.6,5.7],[3,6.1]];
  shrubSpots.forEach(([x,z],index)=>{const shrub=new THREE.Group();shrub.name='forest-understory-'+index;shrub.position.set(options.indoor&&index===0?-8:x,0,options.indoor&&index===0?-2:z);if(options.indoor&&index===0)shrub.userData.naturalIndoorLandingRelocation={from:{x,z},to:{x:-8,z:-2}};shrub.userData.naturalNavObstacle=true;root.add(shrub);const leaves:HomeLeaf[]=[];for(let twig=0;twig<5;twig++){const angle=twig*2.399;b.rod(shrub,shrub.name+'-twig-'+twig,V(0,0,0),V(Math.sin(angle)*.3,.43+(twig%3)*.12,Math.cos(angle)*.26),.012);}for(let i=0;i<(season==='winter'?24:100);i++){const angle=i*2.399,radius=.12+(i%5)*.065;leaves.push({x:Math.sin(angle)*radius,y:.28+(i%6)*.09,z:Math.cos(angle)*radius*.86,length:.22+(i%3)*.035,width:.08+(i%2)*.025,rx:.8,ry:angle,rz:Math.sin(angle)*.4});}homeLeafCluster(shrub,shrub.name+'-foliage',leaves,season==='autumn'?['#827145','#948053']:['#596f49','#75835a'],surfaces);});root.userData.naturalUnderstoryCount=shrubSpots.length;
  const litter:HomeLeaf[]=[],leafCount=season==='autumn'?96:season==='winter'?16:42;
  for(let i=0;i<leafCount;i++){const angle=i*2.399,rad=4.7+(i%7)*.32;const x=Math.sin(angle)*rad,z=Math.cos(angle)*rad*.81;litter.push({x,y:.015+(i%3)*.002,z,length:.09+(i%4)*.018,width:.04+(i%2)*.014,rx:Math.PI/2,ry:angle,rz:.06*Math.sin(i)});}
  homeLeafCluster(root,'forest-ground-litter',litter,season==='autumn'?['#9a744d','#b0915e']:['#71694e','#8c7954'],surfaces);root.userData.naturalLitterLeafCount=leafCount;
  for(let i=0;i<14;i++){const angle=i*2.399,rad=6.0+(i%3)*.45;const x=Math.sin(angle)*rad,z=Math.cos(angle)*rad*.78;if((z < -3&&Math.abs(x)<5.8)||(Math.abs(x)<5.35&&z>-4&&z<4.05))continue;const atX=options.indoor&&i===7?-7.6:x,atZ=options.indoor&&i===7?-2.5:z;const stone=b.mesh(root,'forest-edge-stone-'+i,new THREE.IcosahedronGeometry(.22+(i%3)*.065,1),'stone','#858373',atX,.08,atZ,true);stone.scale.set(1,.6,.8);if(options.indoor&&i===7)stone.userData.naturalIndoorLandingRelocation={from:{x,z},to:{x:atX,z:atZ}};}
  if(season==='winter'){for(let i=0;i<8;i++){const angle=i*2.399,patch=b.mesh(root,'forest-season-snow-'+i,new THREE.CircleGeometry(1.1+(i%3)*.35,24),'plaster','#d9dbd4',Math.sin(angle)*7.1,.012,Math.cos(angle)*6.4);patch.rotation.x=-Math.PI/2;patch.scale.y=.65;patch.castShadow=false;}}
  if(options.indoor&&options.leisure)root.add(buildNaturalLeisureScene('forest',surfaces));
  root.updateMatrixWorld(true);return root;
}
