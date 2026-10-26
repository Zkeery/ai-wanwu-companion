import React from 'react';
import * as THREE from 'three';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Gatherings from '@/components/gatherings';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import {setToken} from '@/lib/auth';
import raw from './fixtures/id5-current-g50-20261025.json';

const gpu=vi.hoisted(()=>({instances:[] as Array<{scene:THREE.Scene|null;loop:((time:number)=>void)|null;motion:boolean[]}>}));
const planning=vi.hoisted(()=>({calls:[] as Array<{participants:number;planned:number}>}));
vi.mock('@/lib/living-social-gathering',async original=>{const actual=await original<typeof import('@/lib/living-social-gathering')>();return{...actual,planSocialGathering:(...args:Parameters<typeof actual.planSocialGathering>)=>{const result=actual.planSocialGathering(...args);planning.calls.push({participants:args[0].length,planned:result.size});return result;}};});
vi.mock('three',async original=>{const actual=await original<typeof import('three')>();class OfflineRenderer{
 domElement=document.createElement('canvas');shadowMap={enabled:false,type:0};outputColorSpace='';toneMapping=0;toneMappingExposure=1;scene:THREE.Scene|null=null;loop:((time:number)=>void)|null=null;motion:boolean[]=[];
 setPixelRatio=vi.fn();setSize=vi.fn();setClearColor=vi.fn();dispose=vi.fn();forceContextLoss=vi.fn();setAnimationLoop=vi.fn((loop:((time:number)=>void)|null)=>{this.loop=loop;this.motion.push(!!loop);});
 render=vi.fn((scene:THREE.Scene,camera:THREE.Camera)=>{scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);this.scene=scene;});constructor(){gpu.instances.push(this);}}
 return {...actual,WebGLRenderer:OfflineRenderer};});
vi.mock('@/components/team-shared',()=>({useTeamSession:()=> 'offline-react-bubble-session'}));
vi.mock('@/components/gathering-dialogue',()=>({default:()=> <p>隔离预设相聚验证，不启用AI</p>}));
vi.mock('@/components/space-decorations',()=>({default:()=>null}));
vi.mock('@/components/private-image',()=>({default:()=>null}));
vi.mock('@/components/motion-player',()=>({default:()=>null}));
vi.mock('next/dynamic',()=>({default:()=>function ActualSharedWorld(props:React.ComponentProps<typeof SharedLivingWorld3D>){return <SharedLivingWorld3D {...props}/>;}}));

type Activity='observe'|'walk'|'talk';
let width:number,height:number,mobile:boolean,slowReads:boolean,groupReads:number,postCount:number,floorReads:number,wire:typeof raw.group;
let pendingPost:{resolve:(value:Response)=>void;value:typeof raw.group}|null;
const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
const flush=()=>act(async()=>{for(let i=0;i<20;i++)await Promise.resolve();});
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(1_000_000);gpu.instances=[];planning.calls=[];width=350;height=400;mobile=true;slowReads=false;groupReads=0;postCount=0;floorReads=0;pendingPost=null;wire={...structuredClone(raw.group),me:'fixture-owner-1'};
 history.replaceState(null,'','/gatherings?space='+wire.id);setToken('offline-react-bubble-session');
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');vi.spyOn(document,'hidden','get').mockReturnValue(false);
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement){return this.dataset.testid==='living3d-canvas'?width:0;});vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockImplementation(function(this:HTMLElement){return this.dataset.testid==='living3d-canvas'?height:0;});
 HTMLElement.prototype.scrollIntoView=vi.fn();vi.stubGlobal('matchMedia',vi.fn((query:string)=>({matches:!query.includes('prefers-reduced-motion')&&mobile,media:query,addEventListener:vi.fn(),removeEventListener:vi.fn(),addListener:vi.fn(),removeListener:vi.fn(),dispatchEvent:vi.fn()})));
 vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('offline timeout','TimeoutError')),ms);return controller.signal;});
 vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(()=>new THREE.Texture<HTMLImageElement>());vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);for(const key of ['Audio','AudioContext'])vi.stubGlobal(key,vi.fn(()=>{throw new Error('NO_PAID_OR_MEDIA_CALLS');}));
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input).replace(/^.*\/api\/v1/,''),plain=path.split('?')[0],method=init?.method??'GET';
  if(method==='GET'&&plain==='/gatherings')return response([]);if(method==='GET'&&plain==='/characters')return response([]);
  if(method==='GET'&&plain==='/gatherings/personal')return response({inventory:[],notifications:[],memories:[]});
  if(method==='GET'&&plain==='/gatherings/'+wire.id){groupReads++;if(slowReads&&groupReads>1)return new Promise<Response>((_resolve,reject)=>{const signal=init?.signal;const abort=()=>reject(signal?.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});return response(wire);}
  if(method==='GET'&&plain==='/living/floors/shared/'+wire.id){floorReads++;return response(raw.floor);}
  if(method==='POST'&&plain==='/gatherings/'+wire.id+'/commands'){
   const body=JSON.parse(String(init?.body));if(body.command.action!=='activity')throw new Error('UNEXPECTED_MUTATION');postCount++;
   wire={...wire,revision:wire.revision+1,companions:wire.companions.map(c=>body.command.character_ids.includes(c.id)?{...c,activity:body.command.activity,area:'outdoor',leisure:null}:c)};
   return new Promise<Response>(resolve=>{pendingPost={resolve,value:structuredClone(wire)};});
  }
  throw new Error('UNEXPECTED_ROUTE_NETWORK_BLOCKED');
 }));
});
afterEach(async()=>{cleanup();if(pendingPost)pendingPost.resolve(response(pendingPost.value));await flush();expect(Audio).not.toHaveBeenCalled();expect(AudioContext).not.toHaveBeenCalled();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});
const host=()=>screen.getByTestId('living3d-canvas');
async function step(frames:number){for(let i=0;i<frames;i++)await act(async()=>{await vi.advanceTimersByTimeAsync(100);gpu.instances.at(-1)?.loop?.(Date.now());});}
async function arrange(activity:Activity){
 const label={observe:'观察',walk:'散步',talk:'相聚'}[activity];fireEvent.click(screen.getByRole('button',{name:'安排'+label}));await flush();
 expect(pendingPost,'real POST is held so React renders busy').not.toBeNull();expect(gpu.instances.at(-1)!.loop,'saving pauses through the real React animate effect').toBeNull();
 await act(async()=>{await vi.advanceTimersByTimeAsync(200);pendingPost!.resolve(response(pendingPost!.value));pendingPost=null;});await flush();expect(gpu.instances.at(-1)!.loop,'receipt must resume through the actual effect').not.toBeNull();
}
it.each([{name:'phone with menu',mobile:true,slow:false},{name:'desktop with menu',mobile:false,slow:false},{name:'phone with stale polling and menu',mobile:true,slow:true}])('$name: real React busy, view, snapshot and floor replay preserve visible social bubbles',async scenario=>{
 mobile=scenario.mobile;width=mobile?350:800;height=mobile?400:500;render(<Gatherings/>);await flush();expect(gpu.instances).toHaveLength(1);expect(host()).toHaveAttribute('data-scene-revision','50');
 fireEvent.click(screen.getByRole('button',{name:'查看合成伙伴5的生活近况'}));await flush();expect(screen.getByRole('group',{name:'合成伙伴5的活动'})).toHaveAttribute('data-menu-placement',mobile?'panel':'anchor');
 await arrange('observe');await step(100);await arrange('walk');const walker=gpu.instances[0].scene!.children.find(o=>o.userData.characterId===5)!,walkStart=walker.position.clone();await step(100);const walkDistance=walker.position.distanceTo(walkStart);expect(walkDistance,'the previous no-refresh walking fix remains effective').toBeGreaterThan(1);slowReads=scenario.slow;
 const beforeReceipt=walker.position.clone();await arrange('talk');expect(walker.position.distanceTo(beforeReceipt),'the response must not snap to a new meeting').toBeLessThan(.001);const seen=new Set<string>();const snapshots:unknown[]=[];let settledPlanCalls:number|null=null;
 for(let i=0;i<200;i++){await step(1);for(const marker of [...document.querySelectorAll<HTMLElement>('.living3d-marker')]){const bubble=marker.querySelector<HTMLElement>('.living3d-bubble');if(bubble&&!bubble.hidden&&!marker.hidden)seen.add(marker.querySelector('button')!.textContent!);}if(i===100)settledPlanCalls=planning.calls.length;if([0,49,199].includes(i))snapshots.push({frame:i,scene:{...host().dataset},labels:[...document.querySelectorAll<HTMLElement>('.living3d-marker')].map(marker=>({name:marker.querySelector('button')!.textContent,hidden:marker.hidden,occluded:marker.dataset.occluded,bubbleHidden:marker.querySelector<HTMLElement>('.living3d-bubble')!.hidden}))});}
 console.info('REACT_MOBILE_BUBBLE_DIAGNOSTIC '+JSON.stringify({name:scenario.name,postCount,groupReads,floorReads,seen:[...seen],renderers:gpu.instances.length,motionChanges:gpu.instances[0].motion,menuStillOpen:!!screen.queryByRole('group',{name:'合成伙伴5的活动'}),walkDistance,planCalls:planning.calls,settledPlanCalls,snapshots}));
 expect(postCount).toBe(3);expect(gpu.instances).toHaveLength(1);expect(host()).toHaveAttribute('data-social-participants','2');expect([...seen].sort()).toEqual(['合成伙伴2','合成伙伴5']);expect(gpu.instances[0].loop).not.toBeNull();expect(planning.calls.length,'a settled empty plan is retried in bounded fashion').toBeLessThanOrEqual(5);expect(planning.calls.length,'successful meeting and same-revision polling must not cause repeated planning').toBe(settledPlanCalls);
},120000);
