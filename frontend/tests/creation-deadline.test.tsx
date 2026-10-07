import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CreationDeadline from '@/components/creation-deadline';
import { creationApi } from '@/lib/creation';
vi.mock('@/lib/creation', () => ({ creationApi: { receipt: vi.fn(), byObject: vi.fn() } }));
const record = { requestId: '11111111-1111-4111-8111-111111111111' };
let startedAt: number;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); vi.clearAllMocks(); startedAt = performance.now(); });
afterEach(() => { vi.useRealTimers(); });
async function tick(ms = 8000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function page(extra = {}) { return <CreationDeadline startedAt={startedAt} completedMs={null} active canQuery getRecord={() => record} {...extra} />; }
it('signals at 8000ms, with no automatic request, including when waiting for the image', async () => {
  render(page()); await tick(5000); expect(screen.queryByLabelText('生成等待状态')).not.toBeInTheDocument();
  await tick(2999); expect(screen.queryByLabelText('生成等待状态')).not.toBeInTheDocument();
  await tick(1); expect(screen.getByText('这次等待已超过8秒，伙伴还没完整显示。')).toBeVisible();
  expect(creationApi.receipt).not.toHaveBeenCalled(); expect(creationApi.byObject).not.toHaveBeenCalled();
});
it('only queries the original receipt, does not regenerate, and serializes clicks', async () => {
  let finish!: (value: { status: 'running'; photo: null }) => void;
  vi.mocked(creationApi.receipt).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(page()); await tick(); const button=screen.getByRole('button', {name:'核对已保存状态'});
  fireEvent.click(button); fireEvent.click(button);
  expect(button).toBeDisabled(); expect(creationApi.receipt).toHaveBeenCalledTimes(1);
  expect(creationApi.receipt).toHaveBeenCalledWith(record.requestId, expect.any(AbortSignal));
  await act(async()=>finish({status:'running',photo:null}));
  expect(screen.getByText('照片仍在识别中，不用重复上传。')).toBeVisible();
  expect(screen.getByRole('button',{name:'核对已保存状态'})).toBeEnabled();
});
it('provides a saved companion link using only its original object', async () => {
  vi.mocked(creationApi.byObject).mockResolvedValue({ id: 9, status:'ready' } as never);
  render(page({getRecord:()=>({...record,objectId:4})})); await tick();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'核对已保存状态'})));
  expect(creationApi.byObject).toHaveBeenCalledWith(4,expect.any(AbortSignal));
  expect(screen.getByRole('link',{name:'查看已保存的伙伴'})).toHaveAttribute('href','/companions/9');
  expect(creationApi.receipt).not.toHaveBeenCalled();
});
it('allows a manual recheck after a read failure without losing the original record', async () => {
  vi.mocked(creationApi.receipt).mockRejectedValueOnce(new Error('连接失败')).mockResolvedValue({status:'ready',photo:null});
  render(page()); await tick(); await act(async()=>fireEvent.click(screen.getByRole('button',{name:'核对已保存状态'})));
  expect(screen.getByText(/原请求没有被取消/)).toBeVisible();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'核对已保存状态'})));
  expect(screen.getByText('照片已识别，原流程会继续处理，不用重复上传。')).toBeVisible();
  expect(creationApi.receipt).toHaveBeenCalledTimes(2);
});
it('late successful display remains over budget, while <=8000ms display does not', async () => {
  const view=render(page());await tick();view.rerender(page({completedMs:8000.1}));
  expect(screen.getByText('伙伴已显示，但本次超过了8秒目标。')).toBeVisible();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  view.rerender(page({completedMs:8000}));expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('stops timers when inactive and ignores a read arriving after completion', async () => {
  let finish!: (value: {status:'failed';photo:null})=>void;
  vi.mocked(creationApi.receipt).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(page());await tick();fireEvent.click(screen.getByRole('button',{name:'核对已保存状态'}));
  const signal=vi.mocked(creationApi.receipt).mock.calls[0][1];
  view.rerender(page({completedMs:6000}));expect(signal.aborted).toBe(true);
  await act(async()=>finish({status:'failed',photo:null}));
  expect(screen.queryByText(/服务器确认/)).not.toBeInTheDocument();
  view.rerender(page({active:false}));await tick(20000);expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('cancels only the read on unmount and a new attempt starts with clean feedback', async()=>{
  vi.mocked(creationApi.receipt).mockImplementation(()=>new Promise(()=>{}));
  const view=render(page());await tick();fireEvent.click(screen.getByRole('button',{name:'核对已保存状态'}));
  const signal=vi.mocked(creationApi.receipt).mock.calls[0][1];view.unmount();expect(signal.aborted).toBe(true);
  startedAt=performance.now();render(page());await tick(7999);expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('limits a status query to 3 seconds without cancelling the generation', async()=>{
  const timer=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException('timed out','TimeoutError')),ms);return c.signal;});
  try{
    vi.mocked(creationApi.receipt).mockImplementation((_id,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
    render(page());await tick();fireEvent.click(screen.getByRole('button',{name:'核对已保存状态'}));await tick(3000);
    expect(screen.getByText(/暂时没有查到最新状态/)).toBeVisible();expect(screen.getByRole('button',{name:'核对已保存状态'})).toBeEnabled();
    expect(creationApi.receipt).toHaveBeenCalledTimes(1);
  }finally{timer.mockRestore();}
});
