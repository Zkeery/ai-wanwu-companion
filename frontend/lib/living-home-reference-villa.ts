import { buildVillaIndoorStair } from './living-villa-stair-mesh';
import { buildVillaUpperInterior } from './living-villa-upper-floor';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HomeMaterialLibrary, HomeMaterialRole } from './living-home-materials';

type Slab = [number, number, number, number, number, number];
const VARIANT = 'reference-white-courtyard-villa';

/** Visual-only, explicit local variant. Ground-floor coordinates and door leaves stay untouched. */
export function applyReferenceCourtyardVilla(world: THREE.Group): void {
  if (world.userData.referenceCourtyardVilla === VARIANT) return;
  const library = world.userData.homeMaterialLibrary as HomeMaterialLibrary | undefined;
  const owned = new Map<string, THREE.MeshStandardMaterial>();
  const templates = new Map<HomeMaterialRole, THREE.MeshStandardMaterial>();
  world.traverse(object => { if (object instanceof THREE.Mesh) for (const value of Array.isArray(object.material) ? object.material : [object.material]) if (value instanceof THREE.MeshStandardMaterial && value.userData.homeMaterialRole && !templates.has(value.userData.homeMaterialRole)) templates.set(value.userData.homeMaterialRole, value); });
  const archive = new THREE.Group(); archive.name = 'home-reference-villa-retained-materials'; archive.visible = false;
  world.add(archive); const retained = new Set<THREE.Material>();
  function retain(values:THREE.Material | THREE.Material[]) {
    for (const value of Array.isArray(values) ? values : [values]) if (!retained.has(value)) { retained.add(value); const holder = new THREE.Mesh(new THREE.BufferGeometry(), value); holder.name = 'home-reference-villa-original-material'; archive.add(holder); }
  }
  function replace(object: THREE.Mesh, value:THREE.Material) { retain(object.material); object.material=value; }

  function material(color: string, role: HomeMaterialRole = 'plaster', scope = 'shared') {
    const key = scope + ':' + role + ':' + color;
    const existing = owned.get(key); if (existing) return existing;
    // Scoped library materials keep independent tints and receive late texture updates.
    const source = templates.get(role) ?? library?.material(role, color, VARIANT + ':' + key);
    if (source && !templates.has(role)) { templates.set(role, source); retain(source); }
    const value = library?.material(role, color, VARIANT + ':' + key) ?? source?.clone() ?? new THREE.MeshStandardMaterial({ color, roughness: .86 });
    value.color.set(color);
    value.userData.homePreserveDiffuseTint = true;
    if (role === 'roof' || role === 'stone') { value.userData.homeDiffuseSuppressed = true; value.map = null; }
    if (role === 'plaster') { value.roughness=.96; value.metalness=0; value.bumpScale=.005; }
    if (role === 'roof') { value.roughness=.91; value.metalness=0; value.normalScale.set(.18,.18); }
    if (role === 'metal') { value.roughness=.58; value.metalness=.42; }
    if (role === 'glass') { value.roughness=.1; value.metalness=.08; }
    if (role === 'foliage') { value.roughness=.94; value.metalness=0; }
    value.userData = { ...value.userData, referenceVillaOwned: true, baseOpacity: value.opacity, baseTransparent: value.transparent, baseDepthWrite: value.depthWrite };
    owned.set(key, value); return value;
  }
  function mesh(parent: THREE.Object3D, name: string, geometry: THREE.BufferGeometry, color: string, role: HomeMaterialRole = 'plaster') {
    library?.uv(geometry, role);
    const value = new THREE.Mesh(geometry, material(color, role));
    value.name = name; value.castShadow = true; value.receiveShadow = true;
    value.userData.referenceVillaVisual = true; value.userData.baseCastShadow = true; parent.add(value); return value;
  }
  function slabs(parent: THREE.Object3D, name: string, pieces: Slab[], color: string, role: HomeMaterialRole = 'plaster') {
    const parts = pieces.map(([x,y,z,w,h,d]) => { const geometry = new THREE.BoxGeometry(w,h,d); geometry.translate(x,y,z); return geometry; });
    const geometry = mergeGeometries(parts, false); parts.forEach(value => value.dispose());
    if (!geometry) return;
    return mesh(parent, name, geometry, color, role);
  }
  // Keep original geometry, transforms, collision slabs and disposal ownership in the scene graph.
  world.getObjectByName('home-common-gabled-roof')?.traverse(object => {
    object.userData.referenceVillaSuperseded = true; object.visible = false;
  });
  world.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.referenceVillaSuperseded) return;
    const name = object.name;
    let wall: THREE.Object3D | null = object.parent;
    while (wall && wall.userData.architectureRole !== 'exterior-wall-upper') wall = wall.parent;
    const wallScope = wall?.uuid ?? 'shared';
    if (/^home-exterior-.*-(body|stone-realistic|stone-\d+)$/.test(name) || /^home-courtyard-.*-wall-body$/.test(name)) {
      replace(object, material('#e4e4dc', 'plaster', wallScope));
    } else if (/^home-exterior-.*-timber$/.test(name) || /^home-courtyard-.*-coping$/.test(name)) {
      replace(object, material('#4f5556', 'metal', wallScope));
    } else if (/^home-window-.*-glass$/.test(name)) {
      const warm = material('#a6b1ad', 'glass', wallScope); warm.emissive.set('#b5aa8c'); warm.emissiveIntensity=.025; warm.opacity=.24; warm.userData.baseOpacity=.24;
      replace(object, warm);
    } else if (/^home-window-.*-frame$/.test(name)) {
      replace(object, material('#534d43', 'wood', wallScope));
    } else if (/^home-window-.*-stone-reveal$/.test(name)) {
      replace(object, material('#e2dfd2', 'plaster', wallScope));
    } else if (/^home-window-.*-shutters$/.test(name)) {
      // The previous cottage shutters are retained for recovery, not layered over modern windows.
      object.userData.referenceVillaSuperseded = true; object.visible = false;
    }
  });
  const exterior = new THREE.Group(); exterior.name = 'home-reference-villa-upper-and-roof';
  exterior.userData.architectureManaged = true; exterior.userData.architectureRole = 'roof';
  exterior.userData.referenceVillaVisual = true; exterior.userData.homeUpperFloorAccessible = false;
  world.add(exterior);
  const upperBottom=3.38, upperFront=-1.45, upperBack=-8.3;
  slabs(exterior, 'home-reference-villa-upper-floor-slab', [[0,3.35,-4.225,17,.22,8.43]], '#e6e4d9');
  // The recessed upper floor leaves a usable-looking balcony, without inventing a second-floor route.
  slabs(exterior, 'home-reference-villa-upper-side-walls', [[-8.4,5.115,-4.875,.24,3.47,6.85],[8.4,5.115,-4.875,.24,3.47,6.85]], '#e4e4dc');
  function facade(name:string,z:number,centers:number[],front:boolean) {
    const pieces:Slab[]=[[0,upperBottom+.38,z,16.8,.76,.24],[0,6.53,z,16.8,.64,.24]];
    let start=-8.4;
    const width=2.7;
    for(const x of centers){ const left=x-width/2; if(left>start) pieces.push([(start+left)/2,5.155,z,left-start,2.55,.24]); start=x+width/2; }
    if(start<8.4)pieces.push([(start+8.4)/2,5.155,z,8.4-start,2.55,.24]);
    slabs(exterior,name+'-plaster',pieces,'#e4e4dc');
    for(let i=0;i<centers.length;i++) window(exterior,name+'-window-'+i,centers[i],5.155,z+(front ? .035 : -.035),2.7,2.55,front);
  }
  function window(parent:THREE.Object3D,name:string,x:number,y:number,z:number,w:number,h:number,front:boolean) {
    const frames:Slab[]=[];
    for(const sx of [-1,1])frames.push([x+sx*w/2,y,z,.065,h+.09,.13]);
    for(const sy of [-1,1])frames.push([x,y+sy*h/2,z,w+.1,.065,.13]);
    frames.push([x,y,z,.055,h,.11],[x,y-.34,z,w,.045,.1]);
    slabs(parent,name+'-black-frame',frames,'#534d43','wood');
    const glass=slabs(parent,name+'-warm-glass',[[x,y,z,w,h,.035]],'#a8b3af','glass');
    if(glass){retain(glass.material);const value=(glass.material as THREE.MeshStandardMaterial).clone();value.color.set('#a8b3af');value.emissive.set('#b5aa8c');value.emissiveIntensity=.035;value.opacity=.3;value.userData.baseOpacity=.3;glass.material=value;glass.castShadow=false;glass.userData.baseCastShadow=false;}
    const inset=front?-.1:.1;
    slabs(parent,name+'-interior-reveal',[[x,y-h/2-.035,z,w+.15,.12,.35]],'#d9d6c8');
    for(const side of [-1,1])slabs(parent,name+'-linen-'+side,[[x+side*(w/2-.2),y,z+inset,.3,h,.04]],'#d4c9b0','fabric');
  }
  facade('home-reference-villa-upper-front',upperFront,[-5.6,0,5.6],true);
  facade('home-reference-villa-upper-back',upperBack,[-5.6,0,5.6],false);
  // Black steel railings are thin and regularly spaced, rather than solid toy-like panels.
  const rails:Slab[]=[];
  rails.push([0,3.48,-.27,17.1,.18,2.5],[0,4.53,.89,17.1,.065,.065],[0,3.67,.89,17.1,.065,.065]);
  for(let x=-8.45;x<=8.45;x+=.39)rails.push([x,4.1,.89,.035,.89,.035]);
  for(const x of [-8.5,8.5]){rails.push([x,4.53,-.27,.065,.065,2.35],[x,3.67,-.27,.065,.065,2.35]);for(let z=-1.35;z<.9;z+=.36)rails.push([x,4.1,z,.035,.89,.035]);}
  slabs(exterior,'home-reference-villa-black-balcony-railings',rails,'#303839','metal');
  slabs(exterior,'home-reference-villa-balcony-white-edge',[[0,3.48,.94,17.2,.16,.17]],'#e8e6dd');
  slabs(exterior,'home-reference-villa-upper-cornice',[[0,6.88,-4.875,17.25,.19,7.22]],'#e4e3db');
  // A four-slope hip roof: all geometry is volumetric and freely viewable from the back.
  const minX=-8.85,maxX=8.85,minZ=-8.8,maxZ=-.85,eave=7.02,peak=9.02,half=(maxZ-minZ)/2,cz=(minZ+maxZ)/2;
  const ridgeLeft=minX+half,ridgeRight=maxX-half;
  const vertices=[minX,eave,minZ,maxX,eave,minZ,maxX,eave,maxZ,minX,eave,maxZ,ridgeLeft,peak,cz,ridgeRight,peak,cz];
  const geometry=new THREE.BufferGeometry(); geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
  geometry.setIndex([0,4,5,0,5,1,3,2,5,3,5,4,0,3,4,1,5,2]);geometry.computeVertexNormals();
  const roof=mesh(exterior,'home-reference-villa-blue-grey-hip-roof',geometry,'#536978','roof');
  roof.material.side=THREE.DoubleSide;roof.userData.roofForm='four-slope-hip';
  const slope=(peak-eave)/half;
  const tiles:THREE.Matrix4[]=[];const transform=new THREE.Object3D();
  for(let x=minX+.16;x<maxX;x+=.31)for(let z=minZ+.2;z<maxZ;z+=.39){
    const ds=[z-minZ,maxZ-z,x-minX,maxX-x], d=Math.min(...ds),face=ds.indexOf(d),y=eave+d*slope+.035;
    transform.position.set(x,y,z); transform.rotation.set(0,0,0);
    const direction=face===0?new THREE.Vector3(0,slope,1):face===1?new THREE.Vector3(0,-slope,1):face===2?new THREE.Vector3(1,slope,0):new THREE.Vector3(1,-slope,0);
    transform.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize());transform.updateMatrix();tiles.push(transform.matrix.clone());
  }
  const tileGeometry=new THREE.CylinderGeometry(.026,.035,.42,5,1,false);
  const tileMesh=new THREE.InstancedMesh(tileGeometry,material('#637b8d','roof'),tiles.length);tileMesh.name='home-reference-villa-individual-tile-ribs';
  tiles.forEach((matrix,index)=>tileMesh.setMatrixAt(index,matrix));tileMesh.instanceMatrix.needsUpdate=true;tileMesh.castShadow=true;tileMesh.receiveShadow=true;tileMesh.userData.referenceVillaVisual=true;exterior.add(tileMesh);
  slabs(exterior,'home-reference-villa-roof-ridge',[[0,peak+.055,cz,ridgeRight-ridgeLeft+.2,.13,.16]],'#4d6273','roof');
  slabs(exterior,'home-reference-villa-eave-fascia',[[0,eave-.055,minZ,17.8,.18,.15],[0,eave-.055,maxZ,17.8,.18,.15],[minX,eave-.055,cz,.15,.18,maxZ-minZ],[maxX,eave-.055,cz,.15,.18,maxZ-minZ]],'#444e54','metal');
  // Low one-storey wings cover the unchanged wider ground floor on both sides.
  for(const side of [-1,1]){
    const wing=new THREE.Group();wing.name='home-reference-villa-ground-wing-'+side;wing.userData.architectureManaged=true;wing.userData.architectureRole='roof';exterior.add(wing);wing.userData.referenceVillaVisual=true;
    const shape=new THREE.BufferGeometry();const a=side*8.5,b=side*11.7;
    shape.setAttribute('position',new THREE.Float32BufferAttribute([a,4.28,-8.6,a,4.28,.12,b,3.43,.12,b,3.43,-8.6],3));shape.setIndex([0,1,2,0,2,3]);shape.computeVertexNormals();
    const slopeRoof=mesh(wing,wing.name+'-slate',shape,'#596d7d','roof');slopeRoof.material.side=THREE.DoubleSide;
    const strips:Slab[]=[];for(let z=-8.5;z<.12;z+=.3)strips.push([(a+b)/2,3.86,z,3.38,.055,.035]);
    const ribs=slabs(wing,wing.name+'-tile-ribs',strips,'#6b8090','roof');if(ribs){ribs.geometry.translate(-(a+b)/2,-3.86,0);ribs.rotation.z=-side*Math.atan2(.85,3.2);ribs.position.set((a+b)/2,3.86,0);}
  }
  // The front gatehouse is strictly beyond the original courtyard walk boundary (z <= 7.88).
  // Its central corridor keeps the existing x=0 courtyard gate and approach unobstructed.
  const gatehouse=new THREE.Group();gatehouse.name='home-reference-villa-front-gatehouse';gatehouse.userData.referenceVillaVisual=true;world.add(gatehouse);
  const entryGap=1.4,frontZ=10.7,backZ=8.75;
  const buildings:Slab[]=[];
  for(const side of [-1,1]){
    const left=side<0?-5.75:entryGap,right=side<0?-entryGap:5.75,cx=(left+right)/2,w=right-left;
    const winWidth=1.85,winX=side*3.6,low=.825,high=2.475;
    buildings.push([cx,1.45,backZ,w,2.9,.18],[left+.09,1.45,(frontZ+backZ)/2,.18,2.9,frontZ-backZ],[right-.09,1.45,(frontZ+backZ)/2,.18,2.9,frontZ-backZ],
      [cx,low/2,frontZ,w,low,.18],[cx,(high+2.9)/2,frontZ,w,2.9-high,.18],
      [(left+winX-winWidth/2)/2,(low+high)/2,frontZ,winX-winWidth/2-left,high-low,.18],[(right+winX+winWidth/2)/2,(low+high)/2,frontZ,right-winX-winWidth/2,high-low,.18]);
  }
  // Real window openings and recessed utility interiors remain outside the playable courtyard.
  slabs(gatehouse,'home-reference-villa-gatehouse-side-wings',buildings,'#e9e8de');
  slabs(gatehouse,'home-reference-villa-gatehouse-dark-plinth',[[-3.575,.22,10.74,4.35,.44,.15],[3.575,.22,10.74,4.35,.44,.15]],'#656e70','stone');
  const gatehouseRoof=new THREE.Group();gatehouseRoof.name='home-reference-villa-gatehouse-flat-roof';gatehouseRoof.userData.referenceVillaVisual=true;gatehouse.add(gatehouseRoof);
  slabs(gatehouseRoof,'home-reference-villa-gatehouse-roof-slab',[[0,3.02,9.725,11.85,.22,2.2]],'#e8e9e6');
  slabs(gatehouseRoof,'home-reference-villa-gatehouse-dark-parapet',[[0,3.24,10.87,11.95,.28,.16],[0,3.24,8.57,11.95,.28,.16],[-5.9,3.24,9.725,.16,.28,2.3],[5.9,3.24,9.725,.16,.28,2.3]],'#4b565b','metal');
  for(const x of [-3.6,3.6])window(gatehouse,'home-reference-villa-gatehouse-window-'+x,x,1.65,frontZ+.025,1.85,1.65,true);
  slabs(gatehouse,'home-reference-villa-gatehouse-entrance-trim',[[-1.44,1.45,10.76,.2,2.9,.25],[1.44,1.45,10.76,.2,2.9,.25]],'#dedfd7');
  slabs(gatehouse,'home-reference-villa-gatehouse-light-sconces',[[-1.84,2.2,10.81,.07,.45,.09],[1.84,2.2,10.81,.07,.45,.09]],'#f4e5bc','glass');
  // Flower beds frame the outside of the saved courtyard, leaving the gate and outside path clear.
  const garden=new THREE.Group();garden.name='home-reference-villa-outside-flower-garden';garden.userData.referenceVillaVisual=true;garden.userData.homeBackdrop=true;world.add(garden);
  const ground=world.getObjectByName('home-realistic-grass-ground');if(ground instanceof THREE.Mesh)replace(ground,material('#8c967a','grass'));
  const beds:Slab[]=[];
  for(const side of [-1,1]){
    beds.push([side*6.7,-.24,4.6,1.25,.21,7.7],[side*13.2,-.24,-4.4,1.2,.21,9.1],[side*3.95,-.24,12.05,4.3,.21,1.45]);
  }
  slabs(garden,'home-reference-villa-raised-garden-soil',beds,'#4d4432','stone');
  const edging:Slab[]=[];for(const[x,y,z,w,h,d]of beds){edging.push([x,y+.04,z-d/2,w,.14,.07],[x,y+.04,z+d/2,w,.14,.07],[x-w/2,y+.04,z,.07,.14,d],[x+w/2,y+.04,z,.07,.14,d]);void h;}
  slabs(garden,'home-reference-villa-flower-bed-edging',edging,'#b6b8a4','stone');
  function instances(name:string,geometry:THREE.BufferGeometry,color:string,role:HomeMaterialRole,poses:{x:number;y:number;z:number;sx:number;sy:number;sz:number;rx?:number;ry?:number;rz?:number}[]) {
    const value=new THREE.InstancedMesh(geometry,material(color,role),poses.length);value.name=name;value.castShadow=true;value.receiveShadow=true;value.userData.referenceVillaVisual=true;value.userData.referenceVillaGarden=true;const transform=new THREE.Object3D();
    poses.forEach((pose,index)=>{transform.position.set(pose.x,pose.y,pose.z);transform.scale.set(pose.sx,pose.sy,pose.sz);transform.rotation.set(pose.rx??0,pose.ry??index*.73,pose.rz??0);transform.updateMatrix();value.setMatrixAt(index,transform.matrix);});if(role==='foliage'){const tint=new THREE.Color();for(let index=0;index<poses.length;index++){const shade=.84+noise(index*13+poses.length)*.22;tint.setRGB(shade,shade,shade);value.setColorAt(index,tint);}if(value.instanceColor)value.instanceColor.needsUpdate=true;}value.instanceMatrix.needsUpdate=true;garden.add(value);return value;
  }
  const noise=(seed:number)=>{const v=Math.sin(seed*12.9898+78.233)*43758.5453;return v-Math.floor(v);};
  type Pose={x:number;y:number;z:number;sx:number;sy:number;sz:number;rx?:number;ry?:number;rz?:number};const stems:Pose[]=[],leaves:Pose[]=[],flowers:Pose[][]=[[],[],[],[]],centers:Pose[]=[];
  for(let b=0;b<beds.length;b++){
    const[x,,z,w,,d]=beds[b],columns=Math.max(2,Math.floor(w/.24)),rows=Math.max(2,Math.floor(d/.24));
    for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
      const seed=b*10007+row*131+col*17,cellW=w/columns,cellD=d/rows;
      const px=x-w/2+(col+.5+(noise(seed)-.5)*.58)*cellW,pz=z-d/2+(row+.5+(noise(seed+7)-.5)*.58)*cellD,h=.17+noise(seed+19)*.43;
      const flowerScale=.045+noise(seed+31)*.045;
      if((row+col)%3===0)stems.push({x:px,y:-.12+h/2,z:pz,sx:.009,sy:h,sz:.009});
      for(let l=0;l<2;l++)leaves.push({x:px+(l?-.038:.038),y:-.12+h*(.28+l*.14),z:pz,sx:.075+noise(seed+l)*.045,sy:.025,sz:.035+noise(seed+l+4)*.025,rx:(noise(seed+l+9)-.5)*.5,ry:noise(seed+l+23)*Math.PI,rz:l?-.38:.38});
      centers.push({x:px,y:h-.1,z:pz,sx:.012,sy:.008,sz:.012});
      flowers[(Math.floor(row/7)+Math.floor(col/5)+b+(noise(seed+41)>.84?1:0))%4].push({x:px,y:h-.108,z:pz,sx:flowerScale,sy:.035,sz:flowerScale*(.8+noise(seed+17)*.3),rx:(noise(seed+51)-.5)*.4,ry:noise(seed+59)*Math.PI*2,rz:(noise(seed+61)-.5)*.35});
    }
  }
  instances('home-reference-villa-flower-stems',new THREE.CylinderGeometry(1,1,1,3),'#56624c','foliage',stems);
  const leafGeometry=new THREE.PlaneGeometry(2,2);leafGeometry.rotateX(-Math.PI/2);
  instances('home-reference-villa-flower-leaves',leafGeometry,'#616d50','foliage',leaves);
  const blossomPositions:number[]=[];
  for(let petal=0;petal<5;petal++){
    const a=petal*Math.PI*2/5,tip=[Math.cos(a),-.07,Math.sin(a)],left=[Math.cos(a-.56)*.57,.025,Math.sin(a-.56)*.57],right=[Math.cos(a+.56)*.57,.025,Math.sin(a+.56)*.57],cup=[Math.cos(a)*.49,.16,Math.sin(a)*.49];
    blossomPositions.push(0,0,0,...cup,...left,...left,...cup,...tip,...tip,...cup,...right,...right,...cup,0,0,0);
  }
  const blossomGeometry=new THREE.BufferGeometry();blossomGeometry.setAttribute('position',new THREE.Float32BufferAttribute(blossomPositions,3));blossomGeometry.computeVertexNormals();
  ['#b9969a','#dad8ca','#a19aaa','#c2b68f'].forEach((color,index)=>{const flower=instances('home-reference-villa-flower-petals-'+index,blossomGeometry.clone(),color,'foliage',flowers[index]);(flower.material as THREE.MeshStandardMaterial).side=THREE.DoubleSide;});blossomGeometry.dispose();
  instances('home-reference-villa-flower-centers',new THREE.SphereGeometry(1,4,2),'#9e9069','foliage',centers);
  const sprayPositions:number[]=[];
  for(let leaf=0;leaf<20;leaf++){
    const a=leaf*2.39996,r=.2+noise(leaf+113)*.65,cx=Math.cos(a)*r,cz=Math.sin(a)*r,cy=(noise(leaf+207)-.5)*1.15,len=.12+noise(leaf+103)*.12;
    const dx=Math.cos(a)*len,dz=Math.sin(a)*len,wx=-Math.sin(a)*len*.42,wz=Math.cos(a)*len*.42;
    sprayPositions.push(cx-dx,cy,cz-dz,cx+wx,cy+.04,cz+wz,cx+dx,cy+.015,cz+dz,cx-dx,cy,cz-dz,cx+dx,cy+.015,cz+dz,cx-wx,cy-.015,cz-wz);
  }
  const sprayGeometry=new THREE.BufferGeometry();sprayGeometry.setAttribute('position',new THREE.Float32BufferAttribute(sprayPositions,3));sprayGeometry.computeVertexNormals();
  const shrubs:Pose[]=[];for(const side of [-1,1])for(let i=0;i<9;i++)shrubs.push({x:side*7.08,y:.04,z:1.5+i*.82,sx:.38+(i%2)*.08,sy:.36,sz:.42});
  const shrubMesh=instances('home-reference-villa-outside-low-shrubs',sprayGeometry.clone(),'#56634a','foliage',shrubs);(shrubMesh.material as THREE.MeshStandardMaterial).side=THREE.DoubleSide;
  const trunks:Pose[]=[],crowns:Pose[]=[];
  for(const side of [-1,1])for(let t=0;t<3;t++){
    const tx=side*15.1,tz=-7.3+t*7.4;trunks.push({x:tx,y:1.15,z:tz,sx:.12,sy:3.1,sz:.12});
    for(let branch=0;branch<18;branch++){const a=branch*2.39996,r=.28+(branch%4)*.26;crowns.push({x:tx+Math.cos(a)*r,y:2.5+(branch%5)*.23,z:tz+Math.sin(a)*r,sx:.5+(branch%3)*.09,sy:.38+(branch%4)*.07,sz:.48});}
  }
  instances('home-reference-villa-outside-tree-trunks',new THREE.CylinderGeometry(.8,1,1,7),'#79634b','wood',trunks);
  const treeLeaves=instances('home-reference-villa-outside-tree-leaves',sprayGeometry,'#59694e','foliage',crowns);(treeLeaves.material as THREE.MeshStandardMaterial).side=THREE.DoubleSide;
  garden.traverse(object=>{object.userData.referenceVillaGarden=true;});
  garden.userData.garden={style:'natural-low-saturation-residential-beds',visibleSoil:true,plantJitter:true,flowerHeightRange:[.17,.60],flowerCount:centers.length,flowerColors:4,treeCount:trunks.length,shrubCount:shrubs.length,centralOutsidePathHalfWidth:1.4,originalSavedTreeAndBenchMoved:false};
  world.userData.referenceCourtyardVilla=VARIANT;
  world.userData.referenceVilla = { variant:VARIANT, accessibleFloors:[1], upperFloorVisualOnly:true, upperFloorCutaway:true, originalRoomAndFurnitureCoordinatesPreserved:true, residentialRealism:true, frontGatehouseBounds:{minX:-5.98,maxX:5.98,minZ:8.49,maxZ:10.95}, clearEntranceHalfWidth:entryGap, tileInstances:tiles.length };
  buildVillaUpperInterior(world);
  buildVillaIndoorStair(world);
  world.updateMatrixWorld(true);
}
