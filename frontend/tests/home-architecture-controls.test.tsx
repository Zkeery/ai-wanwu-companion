import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GatheringWorld from '@/components/gathering-world';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import { createLivingWorld } from '@/lib/living-world-engine';
import { gatherings, parseGathering, type Gathering } from '@/lib/gatherings';
import { TOKEN_KEY } from '@/lib/auth';

const boundary = vi.hoisted(() => ({ houseView: vi.fn(), update: vi.fn(), upperFloor: vi.fn(), upperDoor: vi.fn(), floorVisit:vi.fn(()=>true), floorState:vi.fn<(id?:number)=>{id:number;phase:string}|null>(()=>null) }));
vi.mock('next/dynamic', () => ({ default: () => function DynamicWorld(props: React.ComponentProps<typeof SharedLivingWorld3D>) { return <SharedLivingWorld3D {...props} />; } }));
vi.mock('@/lib/living-world-engine', () => ({ createLivingWorld: vi.fn((host: HTMLElement) => {
  const canvas = document.createElement('canvas'); host.append(canvas);
  return { requestFloorVisit:boundary.floorVisit,getFloorVisit:boundary.floorState,update: boundary.update, setHouseView: boundary.houseView, setUpperFloorView: boundary.upperFloor, toggleUpperDoor: boundary.upperDoor, setMotion: vi.fn(), setReplay: vi.fn(),
    setBubbleReceipts: vi.fn(), setSelectionMenu: vi.fn(), rotate: vi.fn(), zoom: vi.fn(), reset: vi.fn(), dispose: vi.fn(() => canvas.remove()) };
}) }));
vi.mock('@/components/private-image', () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));
vi.mock('@/components/motion-player', () => ({ default: () => <span>原动作预览</span> }));
vi.mock('@/lib/gatherings', async original => {
  const actual = await original<typeof import('@/lib/gatherings')>();
  return { ...actual, gatherings: { ...actual.gatherings, command: vi.fn(), read: vi.fn() } };
});

function snapshot(scene = 'home'): Gathering {
  return parseGathering({ id: 'coherent-home-mode', title: '完整家园合成验证', scene_type: scene, revision: 8,
    closed: false, is_manager: true, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '我', manager: true }, { id: 'friend', name: '朋友', manager: false }],
    companions: [
      { id: 4, name: '院子伙伴', owner_id: 'owner', activity: 'walk', area: 'outdoor', x: .3, y: .5 },
      { id: 5, name: '客厅朋友', owner_id: 'friend', activity: 'rest', area: 'indoor', x: .7, y: .4 },
      { id: 6, name: '卧室伙伴', owner_id: 'owner', activity: 'sleep', area: 'bedroom', x: .2, y: .6 },
    ].map((c, index) => ({ ...c, avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: index + 4, source: 'procedural_existing_features' } })),
    items: [{ id: 'saved-tree', kind: 'tree', x: .21, y: .43, mine: true, contributor_name: '我', growth_status: 'growing' }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}

function mode(name: '看室内' | '看外观') { return within(screen.getByRole('group', { name: '房屋展示' })).getByRole('button', { name }); }
function noRequests() { expect(gatherings.command).not.toHaveBeenCalled(); expect(gatherings.read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); }
beforeEach(() => { vi.clearAllMocks(); boundary.floorState.mockReset().mockReturnValue(null); localStorage.setItem(TOKEN_KEY, 'synthetic-home-view-session'); vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected network request')))); });
afterEach(() => { noRequests(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('local complete-house exterior and cutaway controls', () => {
  it('starts inside and switches only the local house view without rebuilding or saving anything', () => {
    const group = snapshot(), before = JSON.stringify(group), selected = vi.fn(), activity = vi.fn();
    render(<GatheringWorld gathering={group} focusedId={null} onSelect={selected} onActivity={activity} />);
    expect(mode('看室内')).toHaveAttribute('aria-pressed', 'true'); expect(mode('看外观')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(mode('看外观'));
    expect(mode('看外观')).toHaveAttribute('aria-pressed', 'true'); expect(mode('看室内')).toHaveAttribute('aria-pressed', 'false');
    expect(boundary.houseView).toHaveBeenLastCalledWith('exterior');
    expect(screen.getByLabelText('共同生活场景').querySelector('[data-house-view="exterior"]')).not.toBeNull();
    fireEvent.click(mode('看室内')); expect(boundary.houseView).toHaveBeenLastCalledWith('interior');
    expect(createLivingWorld).toHaveBeenCalledOnce(); expect(selected).not.toHaveBeenCalled(); expect(activity).not.toHaveBeenCalled();
    expect(boundary.update.mock.lastCall?.[0]).toBe(group); expect(JSON.stringify(group)).toBe(before); noRequests();
  });

  it('opens the cutaway before focusing an indoor room or a friend, preserving owner permissions', () => {
    const group = snapshot(), before = JSON.stringify(group), selected = vi.fn(), activity = vi.fn();
    render(<GatheringWorld gathering={group} focusedId={null} onSelect={selected} onActivity={activity} />);
    fireEvent.click(mode('看外观'));
    fireEvent.click(within(screen.getByRole('group', { name: '家园镜头' })).getByRole('button', { name: /^客厅/ }));
    expect(mode('看室内')).toHaveAttribute('aria-pressed', 'true'); expect(boundary.houseView).toHaveBeenLastCalledWith('interior');
    fireEvent.click(mode('看外观'));
    fireEvent.click(screen.getByRole('button', { name: '查看客厅朋友的生活近况' }));
    expect(selected).toHaveBeenCalledWith(5); expect(mode('看室内')).toHaveAttribute('aria-pressed', 'true');
    const menu = screen.getByRole('group', { name: '客厅朋友的活动' });
    expect(within(menu).getByText('这是朋友的伙伴，活动由它的主人安排。')).toBeVisible();
    expect(within(menu).queryByRole('button', { name: /^安排/ })).toBeNull();
    fireEvent.click(mode('看外观'));
    fireEvent.click(screen.getByRole('button', { name: '查看客厅朋友的生活近况' }));
    expect(selected).toHaveBeenCalledTimes(2); expect(mode('看室内')).toHaveAttribute('aria-pressed', 'true');
    expect(createLivingWorld).toHaveBeenCalledOnce(); expect(activity).not.toHaveBeenCalled(); expect(JSON.stringify(group)).toBe(before); noRequests();
  });

  it('does not add house display controls to the ordinary forest', () => {
    const group = snapshot('forest'), before = JSON.stringify(group);
    render(<GatheringWorld gathering={group} focusedId={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole('group', { name: '房屋展示' })).toBeNull();
    for (const name of ['向左看', '向右看', '拉近', '拉远', '恢复视角']) expect(screen.getByRole('button', { name })).toBeEnabled();
    expect(JSON.stringify(group)).toBe(before); noRequests();
  });

  it('returns a room close-up to the overview when choosing the complete exterior', () => {
    const group = snapshot(), before = JSON.stringify(group);
    render(<GatheringWorld gathering={group} focusedId={null} onSelect={vi.fn()} />);
    const views = within(screen.getByRole('group', { name: '家园镜头' }));
    fireEvent.click(views.getByRole('button', { name: /^卧室/ }));
    expect(views.getByRole('button', { name: /^卧室/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(mode('看外观'));
    expect(views.getByRole('button', { name: '看全景' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('共同生活场景').querySelector('[data-focus-view="overview"]')).not.toBeNull();
    expect(boundary.update.mock.lastCall?.[2]).toBe('overview'); expect(boundary.houseView).toHaveBeenLastCalledWith('exterior');
    expect(createLivingWorld).toHaveBeenCalledOnce(); expect(JSON.stringify(group)).toBe(before); noRequests();
  });

  it.each([['rest', 'indoor', '安排休息'], ['sleep', 'bedroom', '安排睡觉']] as const)('reopens the cutaway after the same owned menu receives saved %s indoors', (activity, area, label) => {
    const group = snapshot(), before = JSON.stringify(group), selected = vi.fn(), arrange = vi.fn();
    const view = render(<GatheringWorld gathering={group} focusedId={4} onSelect={selected} onActivity={arrange} />);
    fireEvent.click(screen.getByRole('button', { name: '查看院子伙伴的生活近况' }));
    fireEvent.click(mode('看外观')); expect(mode('看外观')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(screen.getByRole('group', { name: '院子伙伴的活动' })).getByRole('button', { name: label }));
    expect(arrange).toHaveBeenCalledOnce(); expect(arrange).toHaveBeenCalledWith(4, activity);
    const saved = { ...group, revision: group.revision + 1, companions: group.companions.map(c => c.id === 4 ? { ...c, area, activity } : c) };
    view.rerender(<GatheringWorld gathering={saved} focusedId={4} onSelect={selected} onActivity={arrange} />);
    expect(mode('看室内')).toHaveAttribute('aria-pressed', 'true'); expect(boundary.houseView).toHaveBeenLastCalledWith('interior');
    expect(screen.getByRole('group', { name: '院子伙伴的活动' })).toBeVisible();
    expect(saved.companions.find(c => c.id === 5)).toBe(group.companions.find(c => c.id === 5));
    expect(saved.companions.map(c => [c.id, c.x, c.y])).toEqual(group.companions.map(c => [c.id, c.x, c.y]));
    expect(createLivingWorld).toHaveBeenCalledOnce(); expect(JSON.stringify(group)).toBe(before); noRequests();
  });
});


it('offers the upstairs preview only after entering the reference villa and returns without issuing activity requests',()=>{
 const group={...snapshot(),id:'synthetic-upper-test'},selected=vi.fn(),activity=vi.fn(),before=JSON.stringify(group);
 const props={animate:true,focusedId:null,onSelect:selected,onActivity:activity,visualStyle:'realistic' as const,localLeisurePreview:true,localRoomTransitions:true,localCompanionDoors:true,localReferenceVilla:true};
 const page=render(<SharedLivingWorld3D gathering={group} {...props}/>);expect(screen.queryByRole('button',{name:'查看二楼'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'打开入户门'}));fireEvent.click(screen.getByRole('button',{name:'查看二楼'}));expect(boundary.upperFloor).toHaveBeenLastCalledWith(true);expect(screen.getByText('二楼查看 · 点伙伴可上下楼')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'开关二楼卧室门'}));expect(boundary.upperDoor).toHaveBeenCalledOnce();expect(screen.queryByRole('group',{name:'房门开关'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'返回一楼'}));expect(boundary.upperFloor).toHaveBeenLastCalledWith(false);expect(screen.getByRole('group',{name:'房门开关'})).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'查看二楼'}));page.rerender(<SharedLivingWorld3D gathering={snapshot('forest')} {...props}/>);expect(screen.queryByRole('group',{name:'楼层查看'})).toBeNull();expect(boundary.upperFloor).toHaveBeenLastCalledWith(false);
 expect(activity).not.toHaveBeenCalled();expect(selected).not.toHaveBeenCalled();expect(JSON.stringify(group)).toBe(before);noRequests();
});

it('offers owner-only local upstairs visits without saving or invoking model actions',()=>{
 const group={...snapshot(),id:'synthetic-stair-controls'},before=JSON.stringify(group),activity=vi.fn();
 render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors localReferenceVilla onActivity={activity}/>);
 act(()=>{vi.mocked(createLivingWorld).mock.calls.at(-1)![3](6);});
 fireEvent.click(screen.getByRole('button',{name:'上楼看看'}));expect(boundary.floorVisit).toHaveBeenLastCalledWith(6,true);
 // The real renderer publishes route state on the next frame. Pump that existing
 // callback before requesting a return, instead of pretending the actor stayed downstairs.
 act(()=>{vi.mocked(createLivingWorld).mock.calls.at(-1)![5]?.onFloorLifeChange?.([{id:6,phase:'approach',floor:1,activity:'observe'}]);});
 fireEvent.click(screen.getByRole('button',{name:'下楼返回原活动'}));expect(boundary.floorVisit).toHaveBeenLastCalledWith(6,false);
 act(()=>{vi.mocked(createLivingWorld).mock.calls.at(-1)![5]?.onFloorLifeChange?.([{id:6,phase:'walking',floor:2,activity:'observe'}]);});
 act(()=>{vi.mocked(createLivingWorld).mock.calls.at(-1)![3](5);});expect(screen.queryByRole('button',{name:'上楼看看'})).not.toBeInTheDocument();
 expect(activity).not.toHaveBeenCalled();expect(JSON.stringify(group)).toBe(before);noRequests();
});


it('keeps another downstairs companion usable while one owned companion is upstairs',async()=>{
 const group=snapshot(),arrange=vi.fn().mockResolvedValue(undefined);boundary.floorState.mockImplementation(id=>id===undefined||id===6?{id:6,phase:'upper'}:null);
 render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors localReferenceVilla onActivity={arrange}/>);
 act(()=>{vi.mocked(createLivingWorld).mock.calls.at(-1)![3](4);});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'安排观察'}));});expect(arrange).toHaveBeenCalledExactlyOnceWith(4,'observe');expect(boundary.floorState).toHaveBeenLastCalledWith(4);
 act(()=>{vi.mocked(createLivingWorld).mock.calls.at(-1)![3](6);});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'安排观察'}));});expect(arrange).toHaveBeenCalledTimes(1);expect(screen.getByText('请先让伙伴下楼，再调整一楼活动。')).toBeVisible();
});
