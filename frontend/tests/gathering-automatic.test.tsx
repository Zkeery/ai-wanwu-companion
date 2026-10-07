import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import GatheringAutomatic from '@/components/gathering-automatic';
import { automaticDialogueApi as api, parseAutomatic } from '@/lib/gathering-automatic';
import { parseGathering } from '@/lib/gatherings';
import { TOKEN_KEY } from '@/lib/auth';
import { ApiError } from '@/lib/api';

vi.mock('@/lib/gathering-automatic', async load => ({ ...await load<typeof import('@/lib/gathering-automatic')>(),
  automaticDialogueApi: { read: vi.fn(), configure: vi.fn(), viewing: vi.fn() } }));
vi.mock('@/components/common', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
function gathering() {
  return parseGathering({ id:'group',title:'家',scene_type:'home',revision:1,closed:false,is_manager:true,me:'owner',invitation:null,
    dialogue_enabled:true, members:[{id:'owner',name:'我',manager:true}],companions:[1,2].map(id=>({id,name:`伙伴${id}`,owner_id:'owner',activity:'rest',x:.3,y:.4,dialogue_allowed:true})),
    items:[],votes:[],events:[],stories:[],goal:null,story_enabled:false,season:{current_season:null} });
}
function status() { return { available:true,enabled:false,revision:0,next_at:0,today_count:0,stop_reason:null,last_task_id:null,last_task_state:null,character_ids:[],
  authorization:{id:'batch',character_ids:[1,2],max_rounds:2,used_rounds:0,cap_micro:2291200,expires_at:Math.floor(Date.now()/1000)+3600} }; }
beforeEach(() => {
  vi.clearAllMocks(); localStorage.setItem(TOKEN_KEY,'synthetic');
  vi.mocked(api.read).mockResolvedValue(status()); vi.mocked(api.viewing).mockResolvedValue({active:true});
});
afterEach(() => { localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
function mount() { const onState=vi.fn(),refresh=vi.fn();return {onState,refresh,...render(<GatheringAutomatic gathering={gathering()} busy={false} onState={onState} refresh={refresh}/>)}; }

it('requires explicit bounded confirmation and sends once on double click', async () => {
  mount(); await screen.findByText('自动交流默认关闭。');
  fireEvent.click(screen.getByRole('button',{name:'开启自动交流'}));
  expect(screen.getByRole('dialog')).toHaveTextContent('2.2912');
  expect(api.configure).not.toHaveBeenCalled();
  let finish!:(value:ReturnType<typeof status>)=>void;
  vi.mocked(api.configure).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const confirm=screen.getByRole('button',{name:'确认开启自动交流'});
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(api.configure).toHaveBeenCalledTimes(1);
  expect(api.configure).toHaveBeenCalledWith('group',expect.objectContaining({expected_revision:0,enabled:true,session_id:'batch'}),expect.any(AbortSignal));
  vi.mocked(api.read).mockResolvedValue({...status(),enabled:true,revision:1});
  await act(async()=>finish({...status(),enabled:true,revision:1}));
  expect(screen.getByText('自动交流已开启。')).toBeVisible();
});

it.each(['no_batch','permission','feature'] as const)('does not enable with %s', async missing => {
  if(missing==='no_batch')vi.mocked(api.read).mockResolvedValue({...status(),authorization:null});
  if(missing==='feature')vi.mocked(api.read).mockResolvedValue({...status(),available:false});
  const g=gathering(); if(missing==='permission')g.companions[1].dialogue_allowed=false;
  render(<GatheringAutomatic gathering={g} busy={false} onState={vi.fn()} refresh={vi.fn()}/>);
  await screen.findByText('自动交流默认关闭。');
  expect(screen.getByRole('button',{name:'开启自动交流'})).toBeDisabled();
  expect(api.configure).not.toHaveBeenCalled();
});

it('allows pause when new automatic execution is unavailable', async () => {
  vi.mocked(api.read).mockResolvedValue({...status(),enabled:true,available:false,revision:3});
  vi.mocked(api.configure).mockResolvedValue({...status(),stop_reason:'paused',revision:4,available:false});
  mount(); await screen.findByText('自动安排已保存，当前后台未运行。');
  fireEvent.click(screen.getByRole('button',{name:'暂停自动交流'}));
  await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(1));
  expect(api.configure).toHaveBeenCalledWith('group',expect.objectContaining({expected_revision:3,enabled:false,session_id:null}),expect.any(AbortSignal));
});

it('uncertain mutation only reads status and never repeats the mutation', async () => {
  mount(); await screen.findByText('自动交流默认关闭。');
  vi.mocked(api.configure).mockRejectedValue(new Error('timeout'));
  fireEvent.click(screen.getByRole('button',{name:'开启自动交流'}));
  fireEvent.click(screen.getByRole('button',{name:'确认开启自动交流'}));
  await waitFor(()=>expect(api.read).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button',{name:'核对自动安排'}));
  await waitFor(()=>expect(api.read).toHaveBeenCalledTimes(3));
  expect(api.configure).toHaveBeenCalledTimes(1);
});

it('stops heartbeats on pagehide and uses a new lease on pageshow', async () => {
  vi.useFakeTimers();
  await act(async()=>{mount();});
  const first=vi.mocked(api.viewing).mock.calls[0][1];
  act(()=>window.dispatchEvent(new Event('pagehide')));
  expect(api.viewing).toHaveBeenLastCalledWith('group',first,false);
  await act(async()=>{await vi.advanceTimersByTimeAsync(90000);});
  expect(vi.mocked(api.viewing).mock.calls.filter(c=>c[2])).toHaveLength(1);
  await act(async()=>{window.dispatchEvent(new Event('pageshow'));});
  const active=vi.mocked(api.viewing).mock.calls.filter(c=>c[2]);
  expect(active).toHaveLength(2);expect(active[1][1]).not.toBe(first);
  expect(api.configure).not.toHaveBeenCalled();
});

it('ignores a late read after rapid hide/show and after switching account', async () => {
  const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(false);
  let finish!:(value:ReturnType<typeof status>)=>void;
  vi.mocked(api.read).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  mount(); hidden.mockReturnValue(true);act(()=>document.dispatchEvent(new Event('visibilitychange')));
  hidden.mockReturnValue(false);await act(async()=>document.dispatchEvent(new Event('visibilitychange')));
  await screen.findByText('自动交流默认关闭。');
  await act(async()=>finish({...status(),enabled:true}));
  expect(screen.queryByText('自动交流已开启。')).toBeNull();
  localStorage.setItem(TOKEN_KEY,'different');
  const count=vi.mocked(api.viewing).mock.calls.length;
  act(()=>window.dispatchEvent(new Event('focus')));
  expect(api.viewing).toHaveBeenCalledTimes(count);
});

it('refreshes saved dialogue after an automatic task completes without posting', async () => {
  vi.useFakeTimers();
  vi.mocked(api.read).mockResolvedValue({...status(),enabled:true,last_task_id:'task',last_task_state:'running'});
  let controls!:ReturnType<typeof mount>;
  await act(async()=>{controls=mount();});
  vi.mocked(api.read).mockResolvedValue({...status(),enabled:false,authorization:null,stop_reason:'completed',last_task_id:'task',last_task_state:'done'});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(controls.refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByText('本批次数已用完，自动交流已结束。')).toBeVisible();
  expect(api.configure).not.toHaveBeenCalled();
});

it('rejects malformed quota or unknown stop states before offering enablement', () => {
  expect(()=>parseAutomatic({...status(),stop_reason:'not-a-known-state'})).toThrow();
  expect(()=>parseAutomatic({...status(),authorization:{...status().authorization,used_rounds:3}})).toThrow();
});

it('recovers failed reads with bounded backoff, preserves the last result and never reposts', async () => {
  vi.useFakeTimers();
  vi.mocked(api.read).mockResolvedValueOnce({...status(),enabled:true})
    .mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({...status(),enabled:false,stop_reason:'paused',revision:2});
  await act(async()=>{mount();});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(screen.getByText('自动交流已开启。')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('暂未更新');
  await act(async()=>{await vi.advanceTimersByTimeAsync(29999);});
  expect(api.read).toHaveBeenCalledTimes(2);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
  expect(api.read).toHaveBeenCalledTimes(3);
  await act(async()=>{await vi.advanceTimersByTimeAsync(59999);});
  expect(api.read).toHaveBeenCalledTimes(3);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
  expect(screen.getByText('自动交流已暂停，保存的对话仍可查看。')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
  expect(api.read).toHaveBeenCalledTimes(5);
  expect(api.configure).not.toHaveBeenCalled();
});

it('a paused page discovers another member enabling and completing an arrangement', async () => {
  vi.useFakeTimers();
  const controls=mount(); await act(async()=>{});
  vi.mocked(api.read).mockResolvedValue({...status(),enabled:true,revision:1,last_task_id:'remote',last_task_state:'running'});
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
  expect(screen.getByText('自动交流已开启。')).toBeVisible();
  vi.mocked(api.read).mockResolvedValue({...status(),enabled:false,revision:2,stop_reason:'completed',authorization:null,last_task_id:'remote',last_task_state:'done'});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(screen.getByText('本批次数已用完，自动交流已结束。')).toBeVisible();
  expect(controls.onState).toHaveBeenLastCalledWith(false);
  expect(controls.refresh).toHaveBeenCalledTimes(2);
  expect(api.configure).not.toHaveBeenCalled();
});

it('online immediately supersedes a hung read and ignores its late response', async () => {
  vi.useFakeTimers();
  let finish!:(value:ReturnType<typeof status>)=>void;
  vi.mocked(api.read).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await act(async()=>{mount();});
  const signal=vi.mocked(api.read).mock.calls[0][1]!;
  await act(async()=>{window.dispatchEvent(new Event('online'));});
  expect(signal.aborted).toBe(true);
  expect(api.read).toHaveBeenCalledTimes(2);
  await act(async()=>finish({...status(),enabled:true}));
  expect(screen.queryByText('自动交流已开启。')).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
  expect(api.read).toHaveBeenCalledTimes(3);
  expect(api.configure).not.toHaveBeenCalled();
});

it('a timed out read cannot publish a late success and recovers without a write', async () => {
  vi.useFakeTimers();
  const timeout=new AbortController();
  vi.spyOn(AbortSignal,'timeout').mockReturnValueOnce(timeout.signal);
  let finish!:(value:ReturnType<typeof status>)=>void;
  vi.mocked(api.read).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await act(async()=>{mount();});
  expect(AbortSignal.timeout).toHaveBeenCalledWith(3000);
  timeout.abort(new DOMException('timeout','TimeoutError'));
  await act(async()=>finish({...status(),enabled:true}));
  expect(screen.queryByText('自动交流已开启。')).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent('暂未更新');
  await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});
  expect(screen.getByText('自动交流默认关闭。')).toBeVisible();
  expect(api.configure).not.toHaveBeenCalled();
});

it('stops a pending retry while hidden, resumes immediately and cancels on unmount', async () => {
  vi.useFakeTimers(); const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(false);
  vi.mocked(api.read).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(status());
  let controls!:ReturnType<typeof mount>;await act(async()=>{controls=mount();});
  hidden.mockReturnValue(true);act(()=>document.dispatchEvent(new Event('visibilitychange')));
  await act(async()=>{await vi.advanceTimersByTimeAsync(90000);});
  expect(api.read).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));});
  expect(api.read).toHaveBeenCalledTimes(2);
  controls.unmount();await act(async()=>{await vi.advanceTimersByTimeAsync(90000);window.dispatchEvent(new Event('online'));});
  expect(api.read).toHaveBeenCalledTimes(2);
  expect(api.configure).not.toHaveBeenCalled();
});

it.each([401,403,404])('clears stale state and stops recovery after access error %s', async code => {
  vi.useFakeTimers();
  vi.mocked(api.read).mockResolvedValueOnce({...status(),enabled:true}).mockRejectedValue(new ApiError('无权查看',code,'unavailable'));
  let controls!:ReturnType<typeof mount>;await act(async()=>{controls=mount();});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(screen.queryByText('自动交流已开启。')).toBeNull();
  expect(controls.onState).toHaveBeenLastCalledWith(false);
  await act(async()=>{await vi.advanceTimersByTimeAsync(90000);window.dispatchEvent(new Event('online'));});
  expect(api.read).toHaveBeenCalledTimes(2);
  expect(api.configure).not.toHaveBeenCalled();
});

it('does not periodically poll a closed unavailable feature', async () => {
  vi.useFakeTimers();vi.mocked(api.read).mockResolvedValue({...status(),available:false,authorization:null});
  await act(async()=>{mount();await vi.advanceTimersByTimeAsync(90000);});
  expect(api.read).toHaveBeenCalledTimes(1);
  expect(api.viewing).not.toHaveBeenCalled();
  expect(api.configure).not.toHaveBeenCalled();
});
