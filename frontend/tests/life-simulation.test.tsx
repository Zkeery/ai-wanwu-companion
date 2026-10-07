import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import LifeSimulation from '@/components/life-simulation';
import { lifeApi, parseLife, type LifeSnapshot } from '@/lib/life-simulation';

vi.mock('@/lib/life-simulation', async original => ({ ...await original<typeof import('@/lib/life-simulation')>(), lifeApi: { read: vi.fn(), save: vi.fn(), step: vi.fn() } }));
const empty: LifeSnapshot = { mode:'simulation',settings:{enabled:false,activities:[]},revision:0,present:true,observed_at:100,next_allowed_at:100,events:[],outcome:'read' };
const enabled: LifeSnapshot = {...empty,settings:{enabled:true,activities:['rest']},revision:1,outcome:'saved'};
const event: LifeSnapshot = {...enabled,outcome:'executed',events:[{id:'one',mode:'simulation',activity:'rest',target_kind:null,season:'winter',created_at:100,reason:'夜间安静休息',companion_id:'1'}]};
beforeEach(()=>{vi.resetAllMocks();vi.mocked(lifeApi.read).mockResolvedValue(empty);vi.mocked(lifeApi.save).mockResolvedValue(enabled);vi.mocked(lifeApi.step).mockResolvedValue(event);});

it('starts paused with no permission selected and never runs on read',async()=>{
  render(<LifeSimulation spaceId="s" />);
  await screen.findByText('模拟已暂停');
  for(const item of screen.getAllByRole('checkbox'))expect(item).not.toBeChecked();
  expect(screen.getByRole('button',{name:'开启模拟'})).toBeDisabled();
  expect(lifeApi.step).not.toHaveBeenCalled();
});

it('saves explicit scope, shows only confirmed events, pauses and preserves records',async()=>{
  render(<LifeSimulation spaceId="s" />);await screen.findByText('模拟已暂停');
  fireEvent.click(screen.getByLabelText('休息'));fireEvent.click(screen.getByRole('button',{name:'开启模拟'}));
  await screen.findByText('模拟已开启');
  expect(lifeApi.save).toHaveBeenCalledWith('s',0,{enabled:true,activities:['rest']},expect.any(AbortSignal));
  fireEvent.click(screen.getByRole('button',{name:'模拟一步'}));
  await screen.findByText('模拟 · 休息');expect(screen.getByText(/夜间安静休息/)).toHaveTextContent('冬天');
  vi.mocked(lifeApi.save).mockResolvedValue({...event,settings:{enabled:false,activities:['rest']},revision:2,outcome:'saved'});
  fireEvent.click(screen.getByRole('button',{name:'暂停模拟'}));await screen.findByText('模拟已暂停');
  expect(screen.getByText('模拟 · 休息')).toBeInTheDocument();expect(screen.getByRole('button',{name:'模拟一步'})).toBeDisabled();
});

it('reconciles failed writes with one read and does not submit the action twice',async()=>{
  vi.mocked(lifeApi.read).mockResolvedValue(enabled);vi.mocked(lifeApi.step).mockRejectedValue(new Error('timeout'));
  render(<LifeSimulation spaceId="s" />);await screen.findByText('模拟已开启');
  fireEvent.click(screen.getByRole('button',{name:'模拟一步'}));
  await screen.findByText(/已核对服务器记录/);
  expect(lifeApi.step).toHaveBeenCalledTimes(1);expect(lifeApi.read).toHaveBeenCalledTimes(2);
});

it('blocks writes after unknown result until explicit read succeeds',async()=>{
  vi.mocked(lifeApi.read).mockResolvedValueOnce(enabled).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(event);
  vi.mocked(lifeApi.step).mockRejectedValue(new Error('timeout'));
  render(<LifeSimulation spaceId="s" />);await screen.findByText('模拟已开启');
  fireEvent.click(screen.getByRole('button',{name:'模拟一步'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'刷新记录'})).toBeEnabled());
  expect(screen.getByRole('button',{name:'模拟一步'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'刷新记录'}));await screen.findByText('模拟 · 休息');
  expect(lifeApi.step).toHaveBeenCalledTimes(1);
});

it('prevents duplicate submissions and aborts on leaving',async()=>{
  vi.mocked(lifeApi.read).mockResolvedValue(enabled);
  let resolve!: (s:LifeSnapshot)=>void;vi.mocked(lifeApi.step).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const view=render(<LifeSimulation spaceId="s" />);await screen.findByText('模拟已开启');
  const button=screen.getByRole('button',{name:'模拟一步'});fireEvent.click(button);fireEvent.click(button);
  expect(lifeApi.step).toHaveBeenCalledTimes(1);
  const signal=vi.mocked(lifeApi.step).mock.calls[0][1]!;view.unmount();expect(signal.aborted).toBe(true);resolve(event);
});

it('rejects invalid permissions and unlabelled simulated events',()=>{
  expect(()=>parseLife({...empty,settings:{enabled:true,activities:[]}})).toThrow();
  expect(()=>parseLife({...event,events:[{...event.events[0],mode:'real'}]})).toThrow();
  expect(parseLife(event)).toEqual(event);
});
