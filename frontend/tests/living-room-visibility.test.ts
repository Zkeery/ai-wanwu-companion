import * as THREE from 'three';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {constrainRoomCamera,collectArchitectureOccluders,architectureOccludes} from '@/lib/living-room-visibility';
import {applyHomeWorldArchitectureView,buildHomeWorldEnvironment,setHomeWorldDoorOpenness} from '@/lib/living-home-world-meshes';
import {disposeLivingObject} from '@/lib/living-world-engine';
import {homeNavigationBounds} from '@/lib/living-home-navigation';
const roots:THREE.Group[]=[];
beforeEach(()=>vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(()=>new THREE.Texture()));
afterEach(()=>{roots.splice(0).forEach(disposeLivingObject);vi.restoreAllMocks();});
function world(){const root=buildHomeWorldEnvironment('summer',{resting:1,sleeping:1},{realistic:true,referenceVilla:true});roots.push(root);return root;}
function wallMaterials(root:THREE.Object3D){const values=new Set<THREE.Material>();root.traverse(o=>{if(o instanceof THREE.Mesh)for(const m of Array.isArray(o.material)?o.material:[o.material])values.add(m);});return [...values];}
describe('room camera and physical label visibility',()=>{
 it.each(['indoor','bedroom'] as const)('keeps a full orbit and maximum zoom inside the %s walls without altering room coordinates',area=>{
  const b=homeNavigationBounds(area),target=new THREE.Vector3((b.minX+b.maxX)/2,1.1,(b.minZ+b.maxZ)/2),original={...b};
  for(let i=0;i<360;i++){const p=target.clone().add(new THREE.Vector3(Math.cos(i)*40,Math.sin(i)*15,Math.sin(i)*40));constrainRoomCamera(p,target,b);expect(p.x).toBeGreaterThanOrEqual(b.minX+.2);expect(p.x).toBeLessThanOrEqual(b.maxX-.2);expect(p.z).toBeGreaterThanOrEqual(b.minZ+.2);expect(p.z).toBeLessThanOrEqual(b.maxZ-.2);expect(p.y).toBeGreaterThanOrEqual(.85);expect(p.y).toBeLessThanOrEqual(2.75);}
  expect(b).toEqual(original);expect(constrainRoomCamera(new THREE.Vector3(target.x,1.9,target.z),target,b)).toBe(false);
 });
 it('separates all exterior wall materials so four-direction cutaways cannot overwrite one another',()=>{
  const root=world(),walls:THREE.Object3D[]=[];root.traverse(o=>{if(o.userData.architectureRole==='exterior-wall-upper')walls.push(o);});expect(walls.length).toBeGreaterThanOrEqual(4);
  for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++)expect(wallMaterials(walls[i]).every(m=>!wallMaterials(walls[j]).includes(m))).toBe(true);
  for(const camera of [{x:20,y:2,z:20},{x:-20,y:2,z:20},{x:-20,y:2,z:-20},{x:20,y:2,z:-20}]){
   applyHomeWorldArchitectureView(root,'interior',camera);
   for(const wall of walls){const [nx,nz]=wall.userData.wallNormal,origin=wall.userData.wallOrigin,ghost=(camera.x-origin.x)*nx+(camera.z-origin.z)*nz>0;expect(wall.userData.homeWallGhost).toBe(ghost);for(const m of wallMaterials(wall))expect(m.opacity).toBeLessThanOrEqual(ghost?.4:1);if(ghost)expect(wallMaterials(wall).every(m=>m.transparent&&!m.depthWrite)).toBe(true);}
  }
  applyHomeWorldArchitectureView(root,'exterior',{x:20,y:2,z:20});for(const wall of walls)for(const m of wallMaterials(wall)){expect(m.opacity).toBe(m.userData.baseOpacity);expect(m.transparent).toBe(m.userData.baseTransparent);expect(m.depthWrite).toBe(m.userData.baseDepthWrite);}
 });
 it('blocks a name behind the real rear wall, but not through its intentional interior cutaway',()=>{
  const root=world(),camera=new THREE.Vector3(-9,1.2,-12),actor=new THREE.Vector3(-9,1.2,-4.5),walls=collectArchitectureOccluders(root);expect(walls.length).toBeGreaterThan(0);
  applyHomeWorldArchitectureView(root,'exterior',camera);expect(architectureOccludes(camera,actor,walls)).toBe(true);
  applyHomeWorldArchitectureView(root,'interior',camera);expect(architectureOccludes(camera,actor,walls)).toBe(false);
 });
 it('respects a real closed door and reveals the character when that door is open',()=>{
  const root=world(),camera=new THREE.Vector3(-2.4,1.2,1),actor=new THREE.Vector3(-2.4,1.2,-1),walls=collectArchitectureOccluders(root);applyHomeWorldArchitectureView(root,'interior',camera);
  setHomeWorldDoorOpenness(root,'home-main-entry-door',0);expect(architectureOccludes(camera,actor,walls)).toBe(true);
  setHomeWorldDoorOpenness(root,'home-main-entry-door',1);expect(architectureOccludes(camera,actor,walls)).toBe(false);
 });
 it('ignores glass, faded walls and invisible ancestors while preserving solid wall occlusion',()=>{
  const root=new THREE.Group(),group=new THREE.Group();roots.push(root);group.userData.architectureRole='interior-partition';root.add(group);const material=new THREE.MeshStandardMaterial(),wall=new THREE.Mesh(new THREE.BoxGeometry(4,3,.2),material);wall.position.y=1.5;group.add(wall);const walls=collectArchitectureOccluders(root),from=new THREE.Vector3(0,1,3),to=new THREE.Vector3(0,1,-3);
  expect(architectureOccludes(from,to,walls)).toBe(true);material.transparent=true;material.opacity=.24;expect(architectureOccludes(from,to,walls)).toBe(false);material.opacity=1;group.visible=false;expect(architectureOccludes(from,to,walls)).toBe(false);group.visible=true;expect(architectureOccludes(from,to,walls)).toBe(true);
 });
});
