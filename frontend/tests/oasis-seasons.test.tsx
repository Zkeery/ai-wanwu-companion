import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LivingScene from '@/components/living-scene';
import OasisBackdrop, { oasisBackground } from '@/components/oasis-backdrop';
import { seasonApi, type Season, type SeasonSnapshot } from '@/lib/seasons';
import { api } from '@/lib/api';
import type { LivingSpace } from '@/lib/contracts';
vi.mock('@/components/space-decorations',()=>({default:()=>null}));
vi.mock('@/lib/seasons',async original=>({...await original<typeof import('@/lib/seasons')>(),seasonApi:{read:vi.fn(),preview:vi.fn(),save:vi.fn()}}));
vi.mock('@/lib/api',async original=>({...await original<typeof import('@/lib/api')>(),api:{living:{action:vi.fn(),space:vi.fn()}}}));
const empty:SeasonSnapshot={settings:null,current_season:null,started_at:null,next_change_at:null,revision:0,observed_at:100,timezone:'Asia/Shanghai'};
const autumn:SeasonSnapshot={...empty,settings:{mode:'virtual',weeks:2,start_season:'autumn'},current_season:'autumn',started_at:100,next_change_at:1209700};
const space:LivingSpace={id:'oasis',scene_type:'desert',mode:'private',companion_id:'6',revision:3,observed_at:100,can_undo:true,items:[{id:'tree',kind:'tree',x:.3,y:.4,stored:false,flipped:true,growth_seconds:40,stage:'growing',care_remaining_seconds:100,growth_status:'growing'}]};
beforeEach(()=>{vi.clearAllMocks();HTMLElement.prototype.scrollIntoView=vi.fn();vi.mocked(seasonApi.read).mockResolvedValue(empty);vi.mocked(seasonApi.preview).mockResolvedValue(autumn);vi.mocked(seasonApi.save).mockResolvedValue({...autumn,revision:1});});
async function open(){fireEvent.click(screen.getByRole('button',{name:'四季设置'}));await waitFor(()=>expect(screen.getByRole('button',{name:'设置四季'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'设置四季'}));fireEvent.click(screen.getByLabelText('虚拟四季'));fireEvent.change(screen.getByLabelText('每季多久'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('从哪个季节开始'),{target:{value:'autumn'}});fireEvent.click(screen.getByRole('button',{name:'预览效果'}));await screen.findByRole('button',{name:'确认设置'});}
it('previews artwork without changing the saved canvas and cancels without writes',async()=>{
 render(<LivingScene space={space} onChange={vi.fn()}/>);await open();
 const board=screen.getByRole('group',{name:'绿洲沙地'});
 expect(board).toHaveAttribute('data-season','base');expect(board.querySelector('img')).toHaveAttribute('src',new URL('/oasis/terrain.png',window.location.href).href);
 expect(screen.getByText(/秋天的绿洲 · 确认后/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'稍后选择'}));
 expect(screen.queryByText(/秋天的绿洲 · 确认后/)).not.toBeInTheDocument();expect(board).toHaveAttribute('data-season','base');expect(seasonApi.save).not.toHaveBeenCalled();expect(api.living.action).not.toHaveBeenCalled();
});
it('uses the confirmed season while retaining object position and leaving layout untouched',async()=>{
 const change=vi.fn();render(<LivingScene space={space} onChange={change}/>);const tree=screen.getByRole('button',{name:'选择小树'});const before=tree.getAttribute('style');await open();fireEvent.click(screen.getByRole('button',{name:'确认设置'}));
 await screen.findByText('四季已保存，场景现在生效。');const board=screen.getByRole('group',{name:'绿洲沙地'});expect(board).toHaveAttribute('data-season','autumn');expect(board.querySelector('img')).toHaveAttribute('src',new URL('/oasis/terrain-autumn-v2.png',window.location.href).href);expect(tree.getAttribute('style')).toEqual(before);expect(change).not.toHaveBeenCalled();expect(api.living.action).not.toHaveBeenCalled();expect(seasonApi.save).toHaveBeenCalledExactlyOnceWith('oasis',autumn.settings,0,expect.any(String),expect.any(AbortSignal));
});
it.each(['spring','summer','autumn','winter'] as Season[])('restores %s from the server without saving or reselecting',async season=>{
 vi.mocked(seasonApi.read).mockResolvedValue({...autumn,current_season:season});render(<LivingScene space={space} onChange={vi.fn()} readOnly/>);
 await waitFor(()=>expect(screen.getByRole('group',{name:'绿洲沙地'})).toHaveAttribute('data-season',season));
 expect(screen.getByRole('group',{name:'绿洲沙地'}).querySelector('img')).toHaveAttribute('src',new URL(oasisBackground(season),window.location.href).href);expect(seasonApi.save).not.toHaveBeenCalled();
});
it('falls back on image failure, supports manual retry and clears failure for a different season',()=>{
 const view=render(<OasisBackdrop season="winter"/>);fireEvent.error(view.container.querySelector('img')!);
 expect(screen.getByRole('status')).toHaveTextContent('保留基础景色');expect(view.container.querySelector('img')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'重试季节画面'}));expect(view.container.querySelector('img')).toHaveAttribute('src',new URL('/oasis/terrain-winter-v2.png?retry=1',window.location.href).href);
 fireEvent.error(view.container.querySelector('img')!);view.rerender(<OasisBackdrop season="spring"/>);expect(screen.queryByRole('status')).not.toBeInTheDocument();expect(view.container.querySelector('img')).toHaveAttribute('src',new URL('/oasis/terrain-spring-v2.png',window.location.href).href);
});
it('keeps the last confirmed background when a failed save is reconciled to old settings',async()=>{
 vi.mocked(seasonApi.save).mockRejectedValue(new Error('offline'));render(<LivingScene space={space} onChange={vi.fn()}/>);await open();fireEvent.click(screen.getByRole('button',{name:'确认设置'}));await screen.findByText(/已核对服务器设置/);expect(screen.getByRole('group',{name:'绿洲沙地'})).toHaveAttribute('data-season','base');expect(seasonApi.save).toHaveBeenCalledTimes(1);
});
