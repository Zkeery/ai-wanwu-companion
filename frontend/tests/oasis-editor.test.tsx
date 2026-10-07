import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LivingScene from '@/components/living-scene';
import { api } from '@/lib/api';
import { groundPoint } from '@/lib/oasis';
import type { LivingSpace } from '@/lib/contracts';
vi.mock('@/components/season-settings',()=>({default:()=>null}));
vi.mock('@/components/space-decorations',()=>({default:()=>null}));
vi.mock('@/lib/api',async original=>({...await original<typeof import('@/lib/api')>(),api:{living:{action:vi.fn(),space:vi.fn()}}}));
const space:LivingSpace={id:'oasis',scene_type:'desert',mode:'private',companion_id:'6',revision:3,observed_at:1,can_undo:true,items:[{id:'palm',kind:'palm',x:.3,y:.4,stored:false,growth_seconds:0,stage:null,care_remaining_seconds:null,growth_status:null}]};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.living.action).mockResolvedValue({...space,revision:4});});
it('previews without writing, cancels, and applies only one atomic layout command',async()=>{
 const change=vi.fn();render(<LivingScene space={space} onChange={change}/>);fireEvent.click(screen.getByRole('button',{name:'布置场景'}));
 expect(screen.getAllByRole('button',{name:/^放置/})).toHaveLength(13);
 fireEvent.click(screen.getByText('预览水边小憩'));expect(api.living.action).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('取消预览'));expect(api.living.action).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('预览星光营地'));fireEvent.click(screen.getByText('应用这套布置'));
 await waitFor(()=>expect(change).toHaveBeenCalled());
 expect(api.living.action).toHaveBeenCalledExactlyOnceWith('oasis',expect.any(String),3,{action:'layout',template:'camp'});
});
it('translates ground coordinates and rejects sky or outside clicks',()=>{
 const rect={left:0,top:0,width:1000,height:1000};expect(groundPoint(500,685,rect)).toEqual({x:.5,y:.5});expect(groundPoint(500,100,rect)).toBeNull();expect(groundPoint(999,900,rect)).toBeNull();
});
it('places on a chosen point and sends turn with current revision',async()=>{
 render(<LivingScene space={space} onChange={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'布置场景'}));
 fireEvent.click(screen.getByRole('button',{name:'放置棕榈树'}));expect(api.living.action).not.toHaveBeenCalled();
 const board=screen.getByRole('group',{name:'绿洲沙地'});vi.spyOn(board,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:1000} as DOMRect);
 fireEvent.click(board,{clientX:500,clientY:685});await waitFor(()=>expect(api.living.action).toHaveBeenCalledTimes(1));
 expect(vi.mocked(api.living.action).mock.calls[0][3]).toEqual({action:'place',kind:'palm',x:.5,y:.5});
 await waitFor(()=>expect(screen.getByRole('button',{name:'选择棕榈树'})).not.toBeDisabled());
 fireEvent.click(screen.getByRole('button',{name:'选择棕榈树'}));fireEvent.click(screen.getByText('转向'));
 await waitFor(()=>expect(api.living.action).toHaveBeenCalledTimes(2));expect(vi.mocked(api.living.action).mock.calls[1][3]).toEqual({action:'turn',item_id:'palm'});
});
it('reconciles failed saves and blocks further writes until a successful refresh',async()=>{
 vi.mocked(api.living.action).mockRejectedValue(new Error('connection lost'));vi.mocked(api.living.space).mockRejectedValue(new Error('offline'));
 render(<LivingScene space={space} onChange={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'布置场景'}));fireEvent.click(screen.getByText('撤销一步'));
 await screen.findByText(/保存结果暂时无法确认/);expect(screen.getByText('预览水边小憩')).toBeDisabled();
 expect(api.living.action).toHaveBeenCalledTimes(1);expect(api.living.space).toHaveBeenCalledTimes(1);
 vi.mocked(api.living.space).mockResolvedValue(space);fireEvent.click(screen.getByText('刷新状态'));await waitFor(()=>expect(screen.getByText('预览水边小憩')).not.toBeDisabled());
});
it('cancels placement when hidden and never exposes writes in a former residence',()=>{
 const props={space,onChange:vi.fn()};const view=render(<LivingScene {...props}/>);fireEvent.click(screen.getByRole('button',{name:'布置场景'}));
 fireEvent.click(screen.getByRole('button',{name:'放置仙人掌'}));view.rerender(<LivingScene {...props} visible={false}/>);view.rerender(<LivingScene {...props} visible/>);
 expect(screen.queryByText('取消放置')).not.toBeInTheDocument();
 view.rerender(<LivingScene {...props} readOnly/>);expect(screen.queryByText('预览水边小憩')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:/^放置/})).not.toBeInTheDocument();
 expect(api.living.action).not.toHaveBeenCalled();
});

it('keeps enabled real records outside settings and stops reads while life is hidden', async () => {
 vi.stubEnv('NEXT_PUBLIC_LIFE_JOURNAL','true');
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({space_id:'oasis',events:[],next_before_revision:null}),{status:200,headers:{'Content-Type':'application/json'}}));
 try {
  const view=render(<LivingScene space={space} onChange={vi.fn()} visible={false}/>);
  expect(screen.queryByRole('region',{name:'私人生活记录'})).not.toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  view.rerender(<LivingScene space={space} onChange={vi.fn()} visible/>);
  const region=await screen.findByRole('region',{name:'私人生活记录'});
  expect(region.closest('details')).toBeNull();
  await screen.findByText(/还没有生活记录/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  view.rerender(<LivingScene space={space} onChange={vi.fn()} visible={false}/>);
  expect(screen.queryByRole('region',{name:'私人生活记录'})).not.toBeInTheDocument();
 } finally {fetcher.mockRestore();vi.unstubAllEnvs();}
});
