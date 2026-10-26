import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GatheringDialogue from '@/components/gathering-dialogue';
import { dialogueApi, type DialogueStatus } from '@/lib/gathering-dialogue';
import { automaticDialogueApi as automaticApi, type AutomaticDialogueStatus } from '@/lib/gathering-automatic';
import { parseGathering } from '@/lib/gatherings';
import { TOKEN_KEY } from '@/lib/auth';

vi.mock('@/lib/gathering-dialogue', async load => ({ ...await load<typeof import('@/lib/gathering-dialogue')>(), dialogueApi: { read: vi.fn(), start: vi.fn() } }));
vi.mock('@/lib/gathering-automatic', async load => ({ ...await load<typeof import('@/lib/gathering-automatic')>(), automaticDialogueApi: { read: vi.fn(), configure: vi.fn(), viewing: vi.fn() } }));
vi.mock('@/components/common', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
function gathering() {
  return parseGathering({ id:'group',title:'家',scene_type:'home',revision:1,closed:false,is_manager:true,me:'owner',invitation:null,
    dialogue_enabled:true,members:[{id:'owner',name:'我',manager:true}],companions:[1,2].map(id=>({id,name:'伙伴'+id,owner_id:'owner',activity:'rest',x:.3,y:.4,dialogue_allowed:true})),
    items:[],votes:[],events:[],stories:[],goal:null,story_enabled:false,season:{current_season:null} });
}
function dialogueStatus(): DialogueStatus { return { available:true,grants:[{id:'grant',character_ids:[1,2],cap_micro:1145600,expires_at:Math.floor(Date.now()/1000)+3600}],tasks:[],exchanges:[] }; }
function automaticStatus(): AutomaticDialogueStatus { return { available:false,enabled:false,revision:0,next_at:0,today_count:0,stop_reason:null,last_task_id:null,last_task_state:null,character_ids:[],authorization:null }; }
beforeEach(() => {
  vi.clearAllMocks(); localStorage.setItem(TOKEN_KEY,'synthetic');
  vi.mocked(dialogueApi.read).mockResolvedValue({...dialogueStatus(),available:false,grants:[]});
  vi.mocked(automaticApi.read).mockResolvedValue(automaticStatus());
  vi.mocked(automaticApi.viewing).mockResolvedValue({active:true});
});
afterEach(() => { localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
function mount() { const command=vi.fn().mockResolvedValue(undefined),refresh=vi.fn();return {command,refresh,...render(<GatheringDialogue compact gathering={gathering()} busy={false} command={command} refresh={refresh}/>)}; }
function expand(label: string, open=true) {
  const details=screen.getByText(label).closest('details')!;
  details.open=open; fireEvent(details,new Event('toggle')); return details;
}

it('keeps unavailable controls mounted but collapsed, and disclosure navigation never writes', async () => {
  const {command}=mount();
  expect(await screen.findByText('暂未开放，可查看已有记录和参与设置。')).toBeVisible();
  await screen.findByText('自动交流默认关闭。');
  const manualRow=screen.getByRole('heading',{name:'AI伙伴交流'}).closest<HTMLElement>('.hub-ai-status-row')!;
  expect(within(manualRow).getByRole('status')).toHaveTextContent('暂未开放');
  const automaticRow=screen.getByRole('heading',{name:'自动聊一会儿'}).closest<HTMLElement>('.hub-ai-status-row')!;
  expect(within(automaticRow).getByRole('status')).toHaveTextContent('暂未开放 · 自动交流默认关闭。');
  expect(screen.getByRole('button',{name:'让他们聊两句',hidden:true})).not.toBeVisible();
  const permission=screen.getByLabelText('允许这个空间开展伙伴交流');
  expect(permission).not.toBeVisible();
  expect(screen.getByRole('button',{name:'开启自动交流',hidden:true})).not.toBeVisible();
  expand('查看交流设置与记录');
  expect(permission).toBeVisible();
  expect(screen.getByRole('button',{name:'让他们聊两句'})).toBeDisabled();
  expand('查看交流设置与记录',false); expand('查看自动交流设置');
  expect(screen.getByRole('button',{name:'开启自动交流'})).toBeDisabled();
  expect(dialogueApi.read).toHaveBeenCalledTimes(1); expect(automaticApi.read).toHaveBeenCalledTimes(1);
  expect(command).not.toHaveBeenCalled(); expect(dialogueApi.start).not.toHaveBeenCalled(); expect(automaticApi.configure).not.toHaveBeenCalled();
});

it('does not claim an unknown state is closed or unavailable', async () => {
  let finishDialogue!: (value:DialogueStatus)=>void, finishAutomatic!: (value:AutomaticDialogueStatus)=>void;
  vi.mocked(dialogueApi.read).mockImplementation(()=>new Promise(resolve=>{finishDialogue=resolve;}));
  vi.mocked(automaticApi.read).mockImplementation(()=>new Promise(resolve=>{finishAutomatic=resolve;}));
  mount(); expect(screen.getByText('正在读取交流状态…')).toBeVisible();
  expect(screen.getByText('正在读取自动安排…')).toBeVisible();
  expect(screen.queryByText('自动交流默认关闭。')).toBeNull();
  expect(screen.queryByText('暂未开放，可查看已有记录和参与设置。')).toBeNull();
  await act(async()=>{finishDialogue({...dialogueStatus(),available:false});finishAutomatic(automaticStatus());});
});

it('keeps an enabled pause outside every disclosure even when the backend is unavailable', async () => {
  const active={...automaticStatus(),enabled:true,revision:3};
  vi.mocked(automaticApi.read).mockResolvedValue(active);
  const paused={...automaticStatus(),revision:4,stop_reason:'paused' as const};
  vi.mocked(automaticApi.configure).mockResolvedValue(paused);
  mount(); await screen.findByText('自动安排已保存，当前后台未运行。');
  const pause=screen.getByRole('button',{name:'暂停自动交流'});
  expect(pause).toBeVisible(); expect(pause.closest('details')).toBeNull(); expect(pause).toBeEnabled();
  expect(pause.closest('.hub-ai-status-row')).toContainElement(screen.getByRole('heading',{name:'自动聊一会儿'}));
  expect(screen.getAllByLabelText('自动伙伴交流')).toHaveLength(1);
  vi.mocked(automaticApi.read).mockResolvedValue(paused);
  fireEvent.click(pause);
  await waitFor(()=>expect(automaticApi.configure).toHaveBeenCalledTimes(1));
  expect(automaticApi.configure).toHaveBeenCalledWith('group',expect.objectContaining({expected_revision:3,enabled:false,session_id:null}),expect.any(AbortSignal));
  expect(dialogueApi.start).not.toHaveBeenCalled();
});

it('preserves selection across collapsing and still requires bounded explicit confirmation', async () => {
  vi.mocked(dialogueApi.read).mockResolvedValue(dialogueStatus());
  mount(); await screen.findByText('交流服务可用，发起前仍需参与许可和费用授权。');
  expand('查看交流设置与记录');
  const first=screen.getByLabelText('选择伙伴1'); fireEvent.click(first); fireEvent.click(screen.getByLabelText('选择伙伴2'));
  expand('查看交流设置与记录',false); expect(first).not.toBeVisible();
  expand('查看交流设置与记录'); expect(screen.getByLabelText('选择伙伴1')).toBe(first); expect(first).toBeChecked();
  fireEvent.click(screen.getByRole('button',{name:'让他们聊两句'}));
  expect(screen.getByRole('dialog')).toHaveTextContent('1.1456'); expect(dialogueApi.start).not.toHaveBeenCalled();
  let finish!: (value:DialogueStatus)=>void;
  vi.mocked(dialogueApi.start).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const confirm=within(screen.getByRole('dialog')).getByRole('button',{name:'确认这一轮'});
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(dialogueApi.start).toHaveBeenCalledTimes(1);
  expect(dialogueApi.start).toHaveBeenCalledWith('group',expect.objectContaining({character_ids:[1,2],grant_id:'grant',expected_revision:1}),expect.any(AbortSignal));
  await act(async()=>finish({...dialogueStatus(),grants:[]}));
});

it('keeps uncertain results and read errors visible outside the collapsed controls without retrying writes', async () => {
  vi.mocked(dialogueApi.read).mockResolvedValue({...dialogueStatus(),tasks:[{id:'task',state:'unknown',created_at:1,dispatched:true}]});
  vi.mocked(automaticApi.read).mockRejectedValue(new Error('offline'));
  mount(); expect(await screen.findByText('上一轮结果未知，已停止且不会重发。')).toBeVisible();
  const alert=await screen.findByRole('alert'); expect(alert).toBeVisible(); expect(alert.closest('details')).toBeNull();
  expect(screen.getByText('自动安排状态暂未核对，请查看下方提示。')).toBeVisible();
  expect(dialogueApi.start).not.toHaveBeenCalled(); expect(automaticApi.configure).not.toHaveBeenCalled();
});
