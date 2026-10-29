import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { sceneRoundedBox } from './living-scene-shapes';
import type { HomeMaterialRole } from './living-home-materials';

/** Exterior presentation only. The existing entrance, doors and interior coordinates are retained. */
export function buildSoftCottageExterior(world: THREE.Group): void {
  if(world.getObjectByName('home-soft-cottage'))return;
  const cottage=new THREE.Group();cottage.name='home-soft-cottage';cottage.userData.softCottageExterior=true;cottage.scale.x=.8;world.add(cottage);
  const materials=new Map<string,THREE.MeshStandardMaterial>();
  function material(role:HomeMaterialRole,color:string){const key=role+color;let value=materials.get(key);if(!value){value=new THREE.MeshStandardMaterial({color,roughness:.9});value.userData.homeMaterialRole=role;materials.set(key,value);}return value;}
  function add(name:string,shape:THREE.BufferGeometry,role:HomeMaterialRole,color:string,x=0,y=0,z=0){const mesh=new THREE.Mesh(shape,material(role,color));mesh.name='home-soft-cottage-'+name;mesh.position.set(x,y,z);mesh.userData.homeMaterialRole=role;mesh.castShadow=mesh.receiveShadow=true;cottage.add(mesh);return mesh;}
  // One broad, soft body. On entering, the shell gives way to the existing room cutaway.
  add('wall-body',new RoundedBoxGeometry(14.4,3.18,8.2,3,.48),'plaster','#f8e6c1',0,1.59,-4.225);
  add('foundation',sceneRoundedBox(14.65,.24,8.5,.1),'stone','#e6d2b1',0,-.1,-4.225);
  const profile=new THREE.Shape();
  profile.moveTo(-7.78,3.02);profile.quadraticCurveTo(-8.02,3.18,-7.64,3.45);
  profile.lineTo(-.65,5.45);profile.quadraticCurveTo(0,5.65,.65,5.45);
  profile.lineTo(7.64,3.45);profile.quadraticCurveTo(8.02,3.18,7.78,3.02);
  profile.lineTo(.5,5.11);profile.quadraticCurveTo(0,5.28,-.5,5.11);profile.closePath();
  const roof=new THREE.ExtrudeGeometry(profile,{depth:8.75,steps:1,curveSegments:10,bevelEnabled:true,bevelThickness:.15,bevelSize:.12,bevelSegments:2});roof.translate(0,0,-8.58);roof.computeVertexNormals();
  add('round-gabled-roof',roof,'roof','#7fb8a4');
  const gable=new THREE.Shape();gable.moveTo(-7.0,3.06);gable.lineTo(-.45,4.96);gable.quadraticCurveTo(0,5.13,.45,4.96);gable.lineTo(7,3.06);gable.closePath();
  const gableShape=new THREE.ExtrudeGeometry(gable,{depth:8.05,curveSegments:8,bevelEnabled:true,bevelThickness:.12,bevelSize:.12,bevelSegments:2});gableShape.translate(0,0,-8.24);
  add('rounded-gable-wall',gableShape,'plaster','#faeacd');
  function window(x:number,radius:number){
    const glass=new THREE.CylinderGeometry(radius,radius,.07,32);glass.rotateX(Math.PI/2);
    const pane=add('window-glass-'+x,glass,'glass','#b8ded7',x,1.87,-.05);pane.userData.softCottageGlass=true;pane.castShadow=false;
    const frame=new THREE.TorusGeometry(radius+.035,.09,8,32);add('window-round-frame-'+x,frame,'wood','#d0a06d',x,1.87,.015);
    add('window-cross-'+x,sceneRoundedBox(radius*1.8,.085,.16,.035),'wood','#d0a06d',x,1.87,.055);
    add('window-mullion-'+x,sceneRoundedBox(.085,radius*1.8,.16,.035),'wood','#d0a06d',x,1.87,.055);
    add('window-sill-'+x,sceneRoundedBox(radius*2.25,.16,.4,.07),'stone','#ead9b9',x,1.87-radius-.14,.07);
  }
  window(-5.3,.53);window(3.35,.73);
  add('chimney',sceneRoundedBox(.94,1.05,.94,.16),'plaster','#f2d8b0',4.5,4.55,-5.9);
  add('chimney-cap',sceneRoundedBox(1.18,.22,1.15,.1),'roof','#80b2a1',4.5,5.13,-5.9);
  add('door-step',sceneRoundedBox(2.25,.08,.65,.1),'stone','#e9d3ac',-2.4/.8,.01,.27);
  // Hide the villa's busy exterior and the spare ground-floor facades only in exterior mode.
  world.userData.softCottageHiddenNames=[
    'home-reference-villa-upper-and-roof','home-villa-upper-interior','villa-indoor-stair',
    'home-environment-indoor','home-environment-bedroom','home-continuous-veranda',
    'home-common-foundation','home-room-seam-foundation','home-interior-partition',
    ...world.children.flatMap(child=>child.name==='home-world-architecture'?child.children.filter(o=>o.name.startsWith('home-exterior-')).map(o=>o.name):[]),
  ];
  const door=world.getObjectByName('home-main-entry-door');
  door?.traverse(object=>{if(/hinges|panel-moulding|handle-brass/.test(object.name)){object.visible=false;object.userData.referenceVillaSuperseded=true;}});
  world.userData.softCottage=true;
}

/** Applied after the existing view controllers so the villa cannot reappear behind the cottage. */
export function applySoftCottageView(world:THREE.Object3D,exterior:boolean,upper=false):void {
  if(!world.userData.softCottage)return;
  const shell=world.getObjectByName('home-soft-cottage');if(shell)shell.visible=exterior&&!upper;
  for(const name of world.userData.softCottageHiddenNames as string[]){
    const object=world.getObjectByName(name);if(!object)continue;
    if(name==='home-reference-villa-upper-and-roof'||name==='home-villa-upper-interior')object.visible=upper;
    else if(exterior&&!upper)object.visible=false;
    else if(!object.userData.referenceVillaSuperseded)object.visible=!object.userData.homeWallGhost;
  }
  const stair=world.getObjectByName('villa-indoor-stair');
  for(const part of stair?.children??[]){
    if(part.name==='villa-stair-handrail-front'||part.name.startsWith('villa-stair-handrail-upper-')||part.name.startsWith('villa-stair-post-upper-'))part.visible=upper;
  }
}
