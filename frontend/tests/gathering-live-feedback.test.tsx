import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Gatherings from '@/components/gatherings';
import type {Gathering} from '@/lib/gatherings';
import {setToken} from '@/lib/auth';

type Activity='rest'|'sleep'|'walk'|'observe'|'talk';
const surface=vi.hoisted(()=>({session:'feedback-session-a',activity:undefined as undefined|((id:number,activity:Activity)=>Promise<void>|void)}));
vi.mock('@/components/team-shared',()=>({useTeamSession:()=>surface.session}));
vi.mock('@/components/gathering-dialogue',()=>({default:()=> <p>离线交流占位，未启用AI</p>}));
vi.mock('@/components/space-decorations',()=>({default:()=>null}));
// Keep actual GatheringWorld, which derives animate from suspended. Replace only
// the dynamic GPU surface; the real page, sync hook, HTTP client and parsers run.
vi.mock('next/dynamic',()=>({default:()=>function OfflineCanvas({gathering,onActivity,animate,busy}:{gathering:Gathering;onActivity?:typeof surface.activity;animate:boolean;busy:boolean}){
 surface.activity=onActivity;return <div data-testid="live-surface" data-space={gathering.id} data-revision={gathering.revision} data-animate={String(animate)} data-busy={String(busy)}><span data-testid="saved-activity">{gathering.companions[0]?.activity}</span></div>;
}}));

type Deferred={promise:Promise<Response>;resolve:(value:Response)=>void};
const deferreds:Deferred[]=[];
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(done=>{resolve=done;});const value={promise,resolve};deferreds.push(value);return value;}
function response(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});}
const personal=(kind='tree')=>({inventory:[{id:'synthetic-'+kind,kind}],notifications:[],memories:[]});
function group(id='space-a'){
 return{id,title:id==='space-a'?'合成住处甲':'合成住处乙',scene_type:'home',revision:4,closed:false,is_manager:true,me:surface.session==='feedback-session-a'?'owner-a':'owner-b',invitation:null,
 members:[{id:'owner-a',name:'甲',manager:true},{id:'owner-b',name:'乙',manager:false}],companions:[{id:1,name:'合成小叶',owner_id:'owner-a',activity:'observe',area:'outdoor',x:.3,y:.5}],items:[],votes:[],events:[],stories:[],goal:null,story_enabled:false,dialogue_enabled:false,season:{current_season:null}};
}
let saved:Record<string,ReturnType<typeof group>>,personalQueue:Array<Promise<Response>>,defaultInventory:string,slowSync:boolean,spaceReads:number,posts:number;
const flush=()=>act(async()=>{for(let i=0;i<20;i++)await Promise.resolve();});
const tick=(ms:number)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
const canvas=()=>screen.getByTestId('live-surface');
async function mount(){const view=render(<Gatherings/>);await flush();expect(canvas()).toHaveAttribute('data-revision','4');return view;}
async function arrange(activity:Activity){act(()=>{void Promise.resolve(surface.activity?.(1,activity)).catch(()=>{});});await flush();}
function inventoryTab(){fireEvent.click(screen.getByRole('tab',{name:'布置与照料'}));}
beforeEach(()=>{
 vi.useFakeTimers();surface.session='feedback-session-a';surface.activity=undefined;saved={'space-a':group(),'space-b':group('space-b')};personalQueue=[];defaultInventory='tree';slowSync=false;spaceReads=0;posts=0;deferreds.length=0;
 history.replaceState(null,'','/gatherings?space=space-a');setToken(surface.session);
 vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');vi.spyOn(document,'hidden','get').mockReturnValue(false);
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,media:'',addEventListener:vi.fn(),removeEventListener:vi.fn(),addListener:vi.fn(),removeListener:vi.fn(),dispatchEvent:vi.fn()})));
 vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('synthetic timeout','TimeoutError')),ms);return controller.signal;});
 for(const key of ['Audio','AudioContext'])vi.stubGlobal(key,vi.fn(()=>{throw new Error('NO_MEDIA_OR_MODEL_ALLOWED');}));
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input).replace(/^.*\/api\/v1/,''),method=init?.method??'GET';
  if(method==='GET'&&path==='/gatherings')return response(Object.values(saved).map(g=>({id:g.id,title:g.title,scene_type:g.scene_type,member_count:2})));
  if(method==='GET'&&path==='/characters')return response([{id:3,name:'合成闲置伙伴',persona:'',opening_line:'',image_path:null,status:'ready',created_at:''}]);
  if(method==='GET'&&path==='/gatherings/personal')return personalQueue.shift()??response(personal(defaultInventory));
  const read=path.match(/^\/gatherings\/(space-[ab])$/);
  if(method==='GET'&&read){spaceReads++;if(slowSync&&spaceReads>1)return new Promise<Response>((_resolve,reject)=>{const signal=init?.signal;const abort=()=>reject(signal?.reason??new Error('aborted'));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});return response(saved[read[1]]);}
  const command=path.match(/^\/gatherings\/(space-[ab])\/commands$/);
  if(method==='POST'&&command){const body=JSON.parse(String(init?.body));if(body.command.action!=='activity')throw new Error('UNEXPECTED_MUTATION');posts++;const current=saved[command[1]];saved[command[1]]={...current,revision:current.revision+1,companions:current.companions.map(c=>body.command.character_ids.includes(c.id)?{...c,activity:body.command.activity}:c)};return response(saved[command[1]]);}
  throw new Error('UNEXPECTED_ROUTE_NETWORK_BLOCKED');
 }));
});
afterEach(async()=>{cleanup();for(const value of deferreds)value.resolve(response(personal('shade')));await flush();expect(Audio).not.toHaveBeenCalled();expect(AudioContext).not.toHaveBeenCalled();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});

describe('saved activities update live without a hard refresh',()=>{
 it('unlocks the author and resumes the new activity after POST200 while personal inventory is still pending',async()=>{
  await mount();const oldInventory=deferred();personalQueue.push(oldInventory.promise);await arrange('walk');
  expect(posts).toBe(1);expect(canvas()).toHaveAttribute('data-revision','5');expect(screen.getByTestId('saved-activity')).toHaveTextContent('walk');
  expect(canvas(),'a committed activity must not wait for unrelated inventory').toHaveAttribute('data-busy','false');expect(canvas()).toHaveAttribute('data-animate','true');
 });
 it('keeps already-saved animation running after a transient sync read timeout',async()=>{
  await mount();expect(canvas()).toHaveAttribute('data-animate','true');slowSync=true;await tick(15000);await tick(3000);
  expect(screen.getByText(/暂时连不上，显示的是上次读取的近况/)).toBeVisible();expect(canvas()).toHaveAttribute('data-revision','4');
  expect(canvas(),'stale transport does not invalidate the last safe saved world').toHaveAttribute('data-animate','true');
 });
 it('immediately shows and animates a successful POST after a prior sync timeout without reloading',async()=>{
  await mount();slowSync=true;await tick(15000);await tick(3000);await arrange('walk');
  expect(posts).toBe(1);expect(canvas()).toHaveAttribute('data-revision','5');expect(screen.getByTestId('saved-activity')).toHaveTextContent('walk');expect(canvas()).toHaveAttribute('data-busy','false');expect(canvas()).toHaveAttribute('data-animate','true');
 });
 it('does not let an older initial personal request overwrite a newer command inventory result',async()=>{
  const initialInventory=deferred();personalQueue.push(initialInventory.promise);await mount();defaultInventory='bench';await arrange('walk');inventoryTab();
  expect(screen.getByRole('button',{name:'放回长椅'})).toBeVisible();initialInventory.resolve(response(personal('shade')));await flush();
  expect(screen.getByRole('button',{name:'放回长椅'})).toBeVisible();expect(screen.queryByRole('button',{name:'放回遮阳棚'})).toBeNull();
  // A personal-result guard must not discard the independent ready-character
  // catalog result that arrived with that older initial request.
  expect(screen.getByText('带 合成闲置伙伴 来')).toBeInTheDocument();
 });
 it('ignores a pending old-space personal response after entering another space with fresh inventory',async()=>{
  await mount();const oldInventory=deferred();personalQueue.push(oldInventory.promise);await arrange('walk');
  expect(screen.getByRole('button',{name:'← 所有共同住处'})).toBeEnabled();defaultInventory='bench';fireEvent.click(screen.getByRole('button',{name:'← 所有共同住处'}));await flush();
  fireEvent.click(screen.getByRole('button',{name:/合成住处乙/}));await flush();expect(canvas()).toHaveAttribute('data-space','space-b');inventoryTab();expect(screen.getByRole('button',{name:'放回长椅'})).toBeVisible();
  oldInventory.resolve(response(personal('shade')));await flush();expect(screen.getByRole('button',{name:'放回长椅'})).toBeVisible();expect(screen.queryByRole('button',{name:'放回遮阳棚'})).toBeNull();
 });
 it('ignores a pending old-account personal response after an account switch',async()=>{
  const view=await mount(),oldInventory=deferred();personalQueue.push(oldInventory.promise);await arrange('walk');
  defaultInventory='bench';surface.session='feedback-session-b';setToken(surface.session);history.replaceState(null,'','/gatherings?space=space-b');view.rerender(<Gatherings/>);await flush();inventoryTab();expect(screen.getByRole('button',{name:'放回长椅'})).toBeVisible();
  oldInventory.resolve(response(personal('shade')));await flush();expect(screen.getByRole('button',{name:'放回长椅'})).toBeVisible();expect(screen.queryByRole('button',{name:'放回遮阳棚'})).toBeNull();
 });
 it('accepts two consecutive activities while both personal requests are pending and keeps the newest inventory on reversed replies',async()=>{
  await mount();const older=deferred(),newer=deferred();personalQueue.push(older.promise,newer.promise);
  await arrange('walk');expect(canvas()).toHaveAttribute('data-busy','false');expect(canvas()).toHaveAttribute('data-animate','true');
  await arrange('observe');expect(posts).toBe(2);expect(canvas()).toHaveAttribute('data-revision','6');expect(screen.getByTestId('saved-activity')).toHaveTextContent('observe');expect(canvas()).toHaveAttribute('data-busy','false');expect(canvas()).toHaveAttribute('data-animate','true');
  const revisions=vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='POST').map(([,init])=>JSON.parse(String(init?.body)).expected_revision);expect(revisions).toEqual([4,5]);
  newer.resolve(response(personal('bench')));await flush();inventoryTab();expect(screen.getByRole('button',{name:'放回长椅'})).toBeVisible();
  older.resolve(response(personal('shade')));await flush();expect(screen.getByRole('button',{name:'放回长椅'})).toBeVisible();expect(screen.queryByRole('button',{name:'放回遮阳棚'})).toBeNull();
 });
 it('keeps the committed activity unlocked after the latest personal request fails and permits the next activity',async()=>{
  await mount();personalQueue.push(Promise.resolve(response({error:{code:'synthetic_inventory_unavailable',message:'离线库存请求失败'}},503)));await arrange('walk');
  expect(screen.getByText('活动已保存，库存信息稍后刷新。')).toBeVisible();expect(canvas()).toHaveAttribute('data-revision','5');expect(canvas()).toHaveAttribute('data-busy','false');expect(canvas()).toHaveAttribute('data-animate','true');
  await arrange('observe');expect(posts).toBe(2);expect(canvas()).toHaveAttribute('data-revision','6');expect(canvas()).toHaveAttribute('data-busy','false');expect(canvas()).toHaveAttribute('data-animate','true');expect(screen.queryByText('活动已保存，库存信息稍后刷新。')).toBeNull();
 });
 it('ignores an older personal failure after the next activity already refreshed personal data successfully',async()=>{
  await mount();const older=deferred();personalQueue.push(older.promise);await arrange('walk');defaultInventory='bench';await arrange('observe');
  older.resolve(response({error:{code:'synthetic_old_failure',message:'过时的库存失败'}},503));await flush();expect(posts).toBe(2);expect(canvas()).toHaveAttribute('data-revision','6');expect(canvas()).toHaveAttribute('data-busy','false');expect(canvas()).toHaveAttribute('data-animate','true');expect(screen.queryByText('活动已保存，库存信息稍后刷新。')).toBeNull();inventoryTab();expect(screen.getByRole('button',{name:'放回长椅'})).toBeVisible();
 });
});
