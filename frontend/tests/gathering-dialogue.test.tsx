import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import GatheringDialogue from '@/components/gathering-dialogue';
import { dialogueApi, parseDialogue } from '@/lib/gathering-dialogue';
import { parseGathering } from '@/lib/gatherings';
import { TOKEN_KEY } from '@/lib/auth';

vi.mock('@/lib/gathering-dialogue', async load => ({ ...await load<typeof import('@/lib/gathering-dialogue')>(), dialogueApi: { read: vi.fn(), start: vi.fn() } }));
vi.mock('@/components/common', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
function gathering() {
  return parseGathering({ id:'group',title:'家',scene_type:'home',revision:1,closed:false,is_manager:true,me:'owner',invitation:null,
    dialogue_enabled:true, members:[{id:'owner',name:'我',manager:true}],companions:[1,2].map(id=>({id,name:`伙伴${id}`,owner_id:'owner',activity:'rest',x:.3,y:.4,dialogue_allowed:true})),
    items:[],votes:[],events:[],stories:[],goal:null,story_enabled:false,season:{current_season:null} });
}
function status() { return { available:true,grants:[{id:'grant',character_ids:[1,2],cap_micro:1145600,expires_at:Math.floor(Date.now()/1000)+3600}],tasks:[],exchanges:[] }; }
beforeEach(() => { vi.clearAllMocks(); localStorage.setItem(TOKEN_KEY,'synthetic'); vi.mocked(dialogueApi.read).mockResolvedValue(status()); });
afterEach(() => { localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
function mount() { const command=vi.fn().mockResolvedValue(undefined),refresh=vi.fn(); const view=render(<GatheringDialogue gathering={gathering()} busy={false} command={command} refresh={refresh}/>);return {command,refresh,...view}; }

it('requires an available matching grant and confirmation; double click sends once', async () => {
  const {refresh}=mount(); await screen.findByText('还没有保存的 AI 交流。');
  expect(screen.getByRole('button',{name:'让他们聊两句'})).toBeDisabled();
  fireEvent.click(screen.getByLabelText('选择伙伴1'));fireEvent.click(screen.getByLabelText('选择伙伴2'));
  fireEvent.click(screen.getByRole('button',{name:'让他们聊两句'}));expect(dialogueApi.start).not.toHaveBeenCalled();
  let finish!:(value:ReturnType<typeof status>)=>void;
  vi.mocked(dialogueApi.start).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const confirm=screen.getByRole('button',{name:'确认这一轮'});fireEvent.click(confirm);fireEvent.click(confirm);
  expect(dialogueApi.start).toHaveBeenCalledTimes(1);
  expect(dialogueApi.start).toHaveBeenCalledWith('group',expect.objectContaining({expected_revision:1,character_ids:[1,2],grant_id:'grant'}),expect.any(AbortSignal));
  await act(async()=>finish({...status(),grants:[]}));expect(refresh).toHaveBeenCalledTimes(1);
});

it('does not send without funding or when the provider is unavailable', async () => {
  vi.mocked(dialogueApi.read).mockResolvedValue({...status(),available:false,grants:[]});mount();
  await screen.findByText('真实交流尚未开放，参与许可和已有记录仍可查看。');
  fireEvent.click(screen.getByLabelText('选择伙伴1'));fireEvent.click(screen.getByLabelText('选择伙伴2'));
  expect(screen.getByRole('button',{name:'让他们聊两句'})).toBeDisabled();expect(dialogueApi.start).not.toHaveBeenCalled();
});

it('saves owner permissions with explicit commands and never gives another owner a toggle', async () => {
  const g=gathering();g.companions[1].owner_id='other';const command=vi.fn();
  render(<GatheringDialogue gathering={g} busy={false} command={command} refresh={vi.fn()}/>);
  await screen.findByText('还没有保存的 AI 交流。');
  fireEvent.click(screen.getByLabelText('允许伙伴1在这次相聚中参与交流'));
  expect(command).toHaveBeenCalledWith({action:'dialogue_consent',character_id:1,enabled:false});
  expect(screen.queryByLabelText('允许伙伴2在这次相聚中参与交流')).toBeNull();
});

it('frees a selection slot when a selected companion leaves or revokes consent', async () => {
  const {rerender,command,refresh}=mount();
  await screen.findByText('还没有保存的 AI 交流。');
  fireEvent.click(screen.getByLabelText('选择伙伴1'));fireEvent.click(screen.getByLabelText('选择伙伴2'));
  const g=gathering();g.revision++;g.companions[1].dialogue_allowed=false;
  g.companions.push({...g.companions[0],id:3,name:'伙伴3'});
  rerender(<GatheringDialogue gathering={g} busy={false} command={command} refresh={refresh}/>);
  expect(screen.queryByLabelText('选择伙伴2')).toBeNull();
  expect(screen.getByLabelText('选择伙伴3')).toBeEnabled();
  fireEvent.click(screen.getByLabelText('选择伙伴3'));
  expect(screen.getByLabelText('选择伙伴3')).toBeChecked();
  expect(dialogueApi.start).not.toHaveBeenCalled();
});

it('recovers after an uncertain POST by reading; never replays the POST', async () => {
  vi.mocked(dialogueApi.start).mockRejectedValue(new Error('timeout'));mount();
  await screen.findByText('还没有保存的 AI 交流。');
  fireEvent.click(screen.getByLabelText('选择伙伴1'));fireEvent.click(screen.getByLabelText('选择伙伴2'));
  fireEvent.click(screen.getByRole('button',{name:'让他们聊两句'}));
  vi.mocked(dialogueApi.read).mockResolvedValue({...status(),grants:[],tasks:[{id:'task',state:'unknown',created_at:1,dispatched:true}]});
  fireEvent.click(screen.getByRole('button',{name:'确认这一轮'}));
  await screen.findByText('上一轮结果未知，已停止且不会重发。');
  fireEvent.click(screen.getByRole('button',{name:'更新交流记录'}));
  await waitFor(()=>expect(dialogueApi.read).toHaveBeenCalledTimes(3));
  expect(dialogueApi.start).toHaveBeenCalledTimes(1);
});

it('restores saved exchanges without a new call and rejects offline-origin results', async () => {
  const result={...status(),grants:[],exchanges:[{id:'event',at:1,lines:[{character_id:1,name:'伙伴1',text:'风吹过来了。'},{character_id:2,name:'伙伴2',text:'在这里歇一会儿吧。'}]}]};
  vi.mocked(dialogueApi.read).mockResolvedValue(result);mount();await screen.findByText('风吹过来了。',{exact:false});
  expect(dialogueApi.start).not.toHaveBeenCalled();
  expect(()=>parseDialogue({...result,exchanges:[{...result.exchanges[0],origin:'offline_fixture'}]})).toThrow();
});

it.each(['done', 'running'] as const)('does not label an older failure as the last round after %s', async state => {
  vi.mocked(dialogueApi.read).mockResolvedValue({...status(), tasks:[
    {id:'new',state,created_at:2,dispatched:true},
    {id:'old',state:'failed',created_at:1,dispatched:true},
  ]});
  mount(); await screen.findByText('还没有保存的 AI 交流。');
  expect(screen.queryByText('上一轮未发布对话，已停止；可核对参与许可与场景。')).toBeNull();
  expect(dialogueApi.start).not.toHaveBeenCalled();
});

it('keeps the latest failed round visible after an older success', async () => {
  vi.mocked(dialogueApi.read).mockResolvedValue({...status(), tasks:[
    {id:'new',state:'failed',created_at:2,dispatched:true},
    {id:'old',state:'done',created_at:1,dispatched:true},
  ]});
  mount(); await screen.findByText('上一轮未发布对话，已停止；可核对参与许可与场景。');
  expect(dialogueApi.start).not.toHaveBeenCalled();
});

it('reads again after rapid hide and show without waiting for an aborted request', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  let old!: (value: ReturnType<typeof status>) => void;
  vi.mocked(dialogueApi.read).mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
  mount();
  const signal = vi.mocked(dialogueApi.read).mock.calls[0][1];
  hidden.mockReturnValue(true);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  hidden.mockReturnValue(false);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(signal?.aborted).toBe(true);
  expect(dialogueApi.read).toHaveBeenCalledTimes(2);
  expect(screen.getByText('还没有保存的 AI 交流。')).toBeVisible();
  await act(async () => old({ ...status(), available: false }));
  expect(screen.queryByText('真实交流尚未开放，参与许可和已有记录仍可查看。')).toBeNull();
  expect(dialogueApi.start).not.toHaveBeenCalled();
});

it('stops reading on pagehide and resumes saved running work on pageshow without posting', async () => {
  vi.useFakeTimers();
  vi.mocked(dialogueApi.read).mockResolvedValue({ ...status(), grants: [], tasks: [{id:'task',state:'running',created_at:1,dispatched:true}] });
  await act(async () => { mount(); });
  act(() => window.dispatchEvent(new Event('pagehide')));
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(dialogueApi.read).toHaveBeenCalledTimes(1);
  vi.mocked(dialogueApi.read).mockResolvedValue({ ...status(), grants: [], exchanges: [{id:'event',at:1,lines:[{character_id:1,name:'伙伴1',text:'恢复后的共同记录。'},{character_id:2,name:'伙伴2',text:'我们已经聊完啦。'}]}] });
  await act(async () => window.dispatchEvent(new Event('pageshow')));
  expect(screen.getByText('恢复后的共同记录。', {exact:false})).toBeVisible();
  expect(dialogueApi.read).toHaveBeenCalledTimes(2);
  expect(dialogueApi.start).not.toHaveBeenCalled();
});
