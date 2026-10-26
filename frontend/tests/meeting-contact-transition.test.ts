import * as THREE from 'three';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createLivingWorld} from '@/lib/living-world-engine';
import {parseGathering} from '@/lib/gatherings';
import raw from './fixtures/motion-blocked-current-20261025.json';

const gpu=vi.hoisted(()=>({instances:[] as Array<{scene:THREE.Scene|null;loop:((time:number)=>void)|null}>}));
const calls=vi.hoisted(()=>({poses:[] as Array<ReadonlyArray<{id:number;from?:{x:number;z:number}}>>}));
vi.mock('@/lib/living-social-gathering',async original=>{const actual=await original<typeof import('@/lib/living-social-gathering')>();return{...actual,planSocialGathering:(...args:Parameters<typeof actual.planSocialGathering>)=>{calls.poses.push(structuredClone(args[0]));return actual.planSocialGathering(...args);}}});
vi.mock('three',async original=>{const actual=await original<typeof import('three')>();class OfflineRenderer{
 domElement=document.createElement('canvas');shadowMap={enabled:false,type:0};outputColorSpace='';toneMapping=0;toneMappingExposure=1;scene:THREE.Scene|null=null;loop:((time:number)=>void)|null=null;
 setPixelRatio=vi.fn();setSize=vi.fn();setClearColor=vi.fn();dispose=vi.fn();forceContextLoss=vi.fn();setAnimationLoop=vi.fn((loop:((time:number)=>void)|null)=>{this.loop=loop;});
 render=vi.fn((scene:THREE.Scene,camera:THREE.Camera)=>{scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);this.scene=scene;});constructor(){gpu.instances.push(this);}}
 return {...actual,WebGLRenderer:OfflineRenderer};});
const worlds:Array<ReturnType<typeof createLivingWorld>>=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1_000_000);gpu.instances=[];calls.poses=[];vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});for(const key of ['fetch','Audio','AudioContext'])vi.stubGlobal(key,vi.fn(()=>{throw new Error('OFFLINE_ONLY');}));vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(()=>new THREE.Texture<HTMLImageElement>());vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);});
afterEach(()=>{worlds.splice(0).forEach(w=>w.dispose());expect(fetch).not.toHaveBeenCalled();expect(Audio).not.toHaveBeenCalled();expect(AudioContext).not.toHaveBeenCalled();document.body.replaceChildren();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

// This pre-existing multi-contact fixture cannot finish every physical undock in
// either the original or current engine. It tests the safety gate only; a pass
// must not be reported as proof that the underlying undock limitation is fixed.
it.each([{contact:'rest',area:'indoor'},{contact:'sleep',area:'bedroom'}] as const)('$contact contact is never used as a safe conversation origin before physical undock',({contact,area})=>{
 const companions=raw.group.companions.filter(c=>[2,5].includes(c.id)).map(c=>({...c,activity:contact,area,leisure:null}));
 const initial=parseGathering({...raw.group,companions}),host=document.createElement('div'),labels=document.createElement('div');Object.defineProperties(host,{clientWidth:{value:800},clientHeight:{value:500}});document.body.append(host,labels);
 const world=createLivingWorld(host,labels,initial,vi.fn(),vi.fn(),{persistentWorld:true,realistic:true,localLeisurePreview:true,localRoomTransitions:true,localCompanionDoors:true,localReferenceVilla:true,localQuietAudio:true});worlds.push(world);world.setMotion(true);const renderer=gpu.instances.at(-1)!,scene=renderer.scene!,actor=(id:number)=>scene.children.find(o=>o.userData.characterId===id)!;
 for(let i=0;i<100;i++){vi.setSystemTime(Date.now()+100);renderer.loop!(Date.now());}
 expect([2,5].every(id=>!!actor(id).userData[contact==='rest'?'roomRestSeat':'sleepingBed']),'precondition: both physically in contact').toBe(true);
 const docked=new Map([2,5].map(id=>[id,actor(id).position.clone()]));
 const next=parseGathering({...raw.group,revision:raw.group.revision+1,companions:companions.map(c=>({...c,activity:'talk',leisure:null})),events:[]});world.update(next,null);
 let readyAt:number|null=null,maxJump=0;
 for(let i=0;i<1800;i++){const previous=new Map([2,5].map(id=>[id,actor(id).position.clone()]));vi.setSystemTime(Date.now()+100);renderer.loop!(Date.now());for(const id of [2,5])maxJump=Math.max(maxJump,actor(id).position.distanceTo(previous.get(id)!));const contactBlocked=[2,5].some(id=>{const journey=actor(id).userData.homeJourney;return journey?.active&&(journey.contactBlend>0||!!journey.pose?.contact);});if(contactBlocked){expect([2,5].some(id=>actor(id).userData.socialGathering?.ready),'no pretend conversation while peer is still in physical contact').toBe(false);expect(calls.poses.some(actors=>actors.length===2),'do not permanently plan from an unsafe contact origin').toBe(false);}if([2,5].every(id=>actor(id).userData.socialGathering?.ready)){readyAt=i;break;}}
 console.info('MEETING_CONTACT_METRICS '+JSON.stringify({contact,area,readyAt,maxJump,planCalls:calls.poses.length,from:calls.poses,actors:[2,5].map(id=>({id,position:actor(id).position.toArray(),docked:docked.get(id)!.toArray(),journey:actor(id).userData.homeJourney,social:actor(id).userData.socialGathering}))}));
 expect(maxJump,'continuous contact exit').toBeLessThan(.3);expect(calls.poses.length,'bounded stable replanning').toBeLessThanOrEqual(3);
},120_000);
