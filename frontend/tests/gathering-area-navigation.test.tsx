import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GatheringWorld from '@/components/gathering-world';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import { createLivingWorld } from '@/lib/living-world-engine';
import { gatherings, parseGathering, type Gathering } from '@/lib/gatherings';
import type { HomeWorldView } from '@/lib/living-home-world';
import { TOKEN_KEY } from '@/lib/auth';

const boundary = vi.hoisted(() => ({ render: vi.fn(), selections: [] as Array<(id: number) => void> }));
// Keep the real world/controller and the real menu/camera UI. Only the dynamic
// loading and WebGL boundary are replaced; geometry is covered by resource tests.
vi.mock('next/dynamic', () => ({ default: () => function DynamicWorld(props: React.ComponentProps<typeof SharedLivingWorld3D>) { return <SharedLivingWorld3D {...props} />; } }));
vi.mock('@/lib/living-world-engine', () => ({ createLivingWorld: vi.fn((host: HTMLElement, _labels: HTMLElement, initial: Gathering, select: (id: number) => void) => {
  const canvas = document.createElement('canvas'); canvas.tabIndex = 0; host.append(canvas); boundary.selections.push(select);
  return { update: vi.fn((g: Gathering, id: number | null, view?: HomeWorldView) => boundary.render(g, id, view ?? (g.scene_type === 'home' ? 'overview' : 'outdoor'))),
    setMotion: vi.fn(), setReplay: vi.fn(), setBubbleReceipts: vi.fn(), setSelectionMenu: vi.fn(),
    rotate: vi.fn(), zoom: vi.fn(), reset: vi.fn(), dispose: vi.fn(() => canvas.remove()) };
}) }));
// Floor persistence has its own transport suite; camera changes stay free of activity writes.
vi.mock('@/lib/villa-floor-sync', () => ({floorApi: vi.fn(),createFloorSync: () => ({tick: vi.fn(),pause: vi.fn(),dispose: vi.fn()})}));
vi.mock('@/components/private-image', () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));
vi.mock('@/components/motion-player', () => ({ default: () => <span>原动作预览</span> }));
vi.mock('@/lib/gatherings', async original => {
  const actual = await original<typeof import('@/lib/gatherings')>();
  return { ...actual, gatherings: { ...actual.gatherings, command: vi.fn(), read: vi.fn() } };
});

function snapshot(scene = 'home', legacy = false): Gathering {
  return parseGathering({ id: 'area-view-space', title: '连续共同家园', scene_type: scene, revision: 5, closed: false, is_manager: true, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '我', manager: true }, { id: 'friend', name: '朋友', manager: false }],
    companions: [
      { id: 4, name: '杯子伙伴', owner_id: 'owner', activity: 'walk', x: .25, y: .56, ...(!legacy ? { area: 'outdoor' } : {}),
        avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } },
      { id: 5, name: '花束伙伴', owner_id: 'friend', activity: 'rest', x: .7, y: .4, ...(!legacy ? { area: 'indoor' } : {}),
        avatar3d: { version: 1, kind: 'bouquet', body: '#b190ca', accent: '#f1d7ef', detail: '#605060', seed: 5, source: 'procedural_existing_features' } }],
    items: [{ id: 'saved-outdoor-tree', kind: 'tree', x: .2, y: .4, mine: true, contributor_name: '我', growth_status: 'growing' }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function areaButton(area: 'outdoor' | 'indoor' | 'bedroom' | 'overview') { return within(screen.getByRole('group', { name: '家园镜头' })).getByRole('button', { name: area === 'overview' ? '看全景' : new RegExp('^' + ({ outdoor: '院子', indoor: '客厅', bedroom: '卧室' }[area])) }); }
function enterInterior() { fireEvent.click(screen.getByRole('button', { name: /^(打开入户门|进入客厅)$/ })); }
function stage() { return screen.getByLabelText('共同生活场景'); }
function latest() { return boundary.render.mock.lastCall as [Gathering, number | null, HomeWorldView]; }
function noRequests() { expect(gatherings.command).not.toHaveBeenCalled(); expect(gatherings.read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); }
beforeEach(() => { vi.clearAllMocks(); boundary.selections.length = 0; localStorage.setItem(TOKEN_KEY, 'synthetic-area-view-session'); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { noRequests(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('one continuous home with local camera focus', () => {
  it('shows counts and saved names while every region and companion remains in one world', () => {
    const g = snapshot(), before = JSON.stringify(g); render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={vi.fn()} />);
    expect(areaButton('overview')).toHaveAttribute('aria-pressed', 'true');
    enterInterior();
    expect(areaButton('outdoor')).toHaveTextContent('1'); expect(areaButton('indoor')).toHaveTextContent('1'); expect(areaButton('bedroom')).toHaveTextContent('0');
    expect(screen.queryByText('院子：杯子伙伴 · 客厅：花束伙伴 · 卧室：暂无伙伴')).toBeNull();
    expect(latest()[0]).toBe(g); expect(latest()[0].companions.map(c => c.id)).toEqual([4, 5]);
    for (const name of ['杯子伙伴', '花束伙伴']) expect(within(stage()).getAllByRole('button', { name: '查看' + name + '的生活近况' })).toHaveLength(1);
    expect(JSON.stringify(g)).toBe(before); noRequests();
  });

  it('changes only the camera on focus, retaining the same full snapshot, items and engine instance', () => {
    const g = snapshot(), before = JSON.stringify(g), chosen = vi.fn(); render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={chosen} />);
    enterInterior();
    for (const area of ['indoor', 'bedroom', 'outdoor', 'overview'] as const) {
      fireEvent.click(areaButton(area)); expect(areaButton(area)).toHaveAttribute('aria-pressed', 'true'); expect(latest()[2]).toBe(area);
      expect(latest()[0]).toBe(g); expect(latest()[0].items).toBe(g.items); expect(latest()[0].companions).toBe(g.companions);
    }
    expect(createLivingWorld).toHaveBeenCalledOnce(); expect(chosen).not.toHaveBeenCalled(); expect(JSON.stringify(g)).toBe(before); noRequests();
  });

  it('follows an owned saved rest and later walk in a focused view without hiding other residents', () => {
    const g = snapshot(), before = JSON.stringify(g); const view = render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={vi.fn()} />);
    enterInterior();
    fireEvent.click(areaButton('outdoor'));
    const resting = { ...g, revision: 6, companions: g.companions.map(c => c.id === 4 ? { ...c, area: 'indoor' as const, activity: 'rest' } : c) };
    view.rerender(<GatheringWorld onLeisureAction={vi.fn()} gathering={resting} focusedId={null} onSelect={vi.fn()} />);
    expect(areaButton('indoor')).toHaveAttribute('aria-pressed', 'true'); expect(areaButton('indoor')).toHaveTextContent('2'); expect(latest()[0].companions).toHaveLength(2);
    const walking = { ...resting, revision: 7, companions: resting.companions.map(c => c.id === 4 ? { ...c, area: 'outdoor' as const, activity: 'walk' } : c) };
    view.rerender(<GatheringWorld onLeisureAction={vi.fn()} gathering={walking} focusedId={null} onSelect={vi.fn()} />);
    expect(areaButton('outdoor')).toHaveAttribute('aria-pressed', 'true'); expect(latest()[0].companions.map(c => c.id)).toEqual([4, 5]);
    expect(JSON.stringify(g)).toBe(before); noRequests();
  });

  it('focuses another room when keyboard/list selection changes, including a repeated selected ID after camera navigation', () => {
    const g = snapshot(), before = JSON.stringify(g), selected = vi.fn(); const view = render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={4} onSelect={selected} />);
    enterInterior();
    fireEvent.click(areaButton('outdoor')); view.rerender(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={5} onSelect={selected} />);
    expect(areaButton('indoor')).toHaveAttribute('aria-pressed', 'true'); fireEvent.click(areaButton('outdoor'));
    fireEvent.click(within(stage()).getByRole('button', { name: '查看花束伙伴的生活近况' }));
    expect(selected).toHaveBeenCalledWith(5); expect(areaButton('indoor')).toHaveAttribute('aria-pressed', 'true'); expect(latest()[0].companions).toHaveLength(2);
    expect(JSON.stringify(g)).toBe(before); noRequests();
  });

  it('keeps legacy residents outdoors until a server snapshot explicitly supplies their room area', () => {
    const g = snapshot('home', true); render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={vi.fn()} />);
    enterInterior();
    expect(areaButton('outdoor')).toHaveTextContent('2'); expect(areaButton('indoor')).toHaveTextContent('0');
    fireEvent.click(areaButton('indoor')); expect(latest()[0]).toBe(g); expect(latest()[0].companions.every(c => c.area === undefined)).toBe(true);
    expect(within(stage()).getByRole('button', { name: '查看杯子伙伴的生活近况' })).toBeVisible(); noRequests();
  });

  it('keeps bedroom, living-room and courtyard residents distinct within the same persistent scene', () => {
    const original = snapshot(), g = { ...original, companions: [...original.companions, { ...original.companions[1], id: 6, name: '午睡伙伴', area: 'bedroom' as const, activity: 'sleep' }] }, before = JSON.stringify(original);
    render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={vi.fn()} />);
    enterInterior();
    for (const area of ['outdoor', 'indoor', 'bedroom'] as const) { expect(areaButton(area)).toHaveTextContent('1'); fireEvent.click(areaButton(area)); expect(latest()[0].companions.map(c => c.id)).toEqual([4, 5, 6]); expect(latest()[0].items).toBe(original.items); }
    expect(within(stage()).getByRole('button', { name: '查看午睡伙伴的生活近况' })).toBeVisible(); expect(createLivingWorld).toHaveBeenCalledOnce(); expect(JSON.stringify(original)).toBe(before); noRequests();
  });

  it('restores saved sleep on refresh and follows later rest and walking without changing the saved positions', () => {
    const g = snapshot(), before = JSON.stringify(g); let view = render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={4} onSelect={vi.fn()} />); enterInterior(); fireEvent.click(areaButton('outdoor'));
    const sleeping = { ...g, revision: 6, companions: g.companions.map(c => c.id === 4 ? { ...c, area: 'bedroom' as const, activity: 'sleep' } : c) };
    view.rerender(<GatheringWorld onLeisureAction={vi.fn()} gathering={sleeping} focusedId={4} onSelect={vi.fn()} />); expect(areaButton('bedroom')).toHaveAttribute('aria-pressed', 'true'); view.unmount();
    view = render(<GatheringWorld onLeisureAction={vi.fn()} gathering={sleeping} focusedId={null} onSelect={vi.fn()} />); expect(areaButton('overview')).toHaveAttribute('aria-pressed', 'true'); expect(latest()[0].companions.find(c => c.id === 4)?.activity).toBe('sleep');
    enterInterior();
    fireEvent.click(areaButton('bedroom')); const resting = { ...sleeping, revision: 7, companions: sleeping.companions.map(c => c.id === 4 ? { ...c, area: 'indoor' as const, activity: 'rest' } : c) };
    view.rerender(<GatheringWorld onLeisureAction={vi.fn()} gathering={resting} focusedId={null} onSelect={vi.fn()} />); expect(areaButton('indoor')).toHaveAttribute('aria-pressed', 'true');
    const walking = { ...resting, revision: 8, companions: resting.companions.map(c => c.id === 4 ? { ...c, area: 'outdoor' as const, activity: 'walk' } : c) };
    view.rerender(<GatheringWorld onLeisureAction={vi.fn()} gathering={walking} focusedId={null} onSelect={vi.fn()} />); expect(areaButton('outdoor')).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.stringify(g)).toBe(before); expect(latest()[0].companions.map(c => [c.id, c.x, c.y])).toEqual(g.companions.map(c => [c.id, c.x, c.y])); noRequests();
  });

  it('can focus a sleeping friend without moving the friend or any other owner partner', () => {
    const original = snapshot(), g = { ...original, companions: original.companions.map(c => c.id === 5 ? { ...c, area: 'bedroom' as const, activity: 'sleep' } : c) }, before = JSON.stringify(original);
    const view = render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={4} onSelect={vi.fn()} />); enterInterior(); fireEvent.click(areaButton('outdoor'));
    view.rerender(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={5} onSelect={vi.fn()} />); expect(areaButton('bedroom')).toHaveAttribute('aria-pressed', 'true'); expect(latest()[0]).toBe(g); expect(JSON.stringify(original)).toBe(before); noRequests();
  });

  it.each(['forest', 'desert'])('keeps saved %s indoor and outdoor residents in the same persistent world', scene => {
    const g = snapshot(scene); render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('group', { name: '家园镜头' })).toBeInTheDocument(); enterInterior();
    expect(within(screen.getByRole('group', { name: '家园镜头' })).getByRole('button', { name: /^休息间/ })).toHaveTextContent('1');
    expect(latest()[0]).toBe(g); expect(latest()[0].companions).toHaveLength(2); noRequests();
  });
  it.each(['forest', 'desert'])('does not infer rooms for legacy %s residents without saved areas', scene => {
    const g = snapshot(scene, true), before = JSON.stringify(g); render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={vi.fn()} />);
    expect(within(screen.getByRole('group', { name: '家园镜头' })).getByRole('button', { name: scene === 'forest' ? /^林地/ : /^绿洲/ })).toHaveTextContent('2');
    expect(g.companions.every(c => c.area === undefined)).toBe(true); expect(JSON.stringify(g)).toBe(before); noRequests();
  });

  it('opens a real owned menu from the world selection and dispatches one free activity while locking repeated clicks', async () => {
    const g = snapshot(), before = JSON.stringify(g), choose = vi.fn(); let finish!: () => void;
    const activity = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })); render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={choose} onActivity={activity} />);
    act(() => boundary.selections[0](4)); const menu = screen.getByRole('group', { name: '杯子伙伴的活动' });
    expect(choose).toHaveBeenCalledWith(4); expect(within(menu).getByText('这些活动免费，不会发起 AI 对话。')).toBeVisible();
    for (const label of ['休息', '睡觉', '散步', '观察', '相聚']) expect(within(menu).getByRole('button', { name: '安排' + label })).toBeEnabled();
    const walk = within(menu).getByRole('button', { name: '安排散步' }); fireEvent.click(walk); fireEvent.click(walk);
    expect(activity).toHaveBeenCalledTimes(1); expect(activity).toHaveBeenCalledWith(4, 'walk');
    for (const label of ['休息', '睡觉', '散步', '观察', '相聚']) expect(within(menu).getByRole('button', { name: '安排' + label })).toBeDisabled();
    await act(async () => finish()); expect(walk).toBeEnabled(); expect(JSON.stringify(g)).toBe(before); noRequests();
  });

  it('keeps friends read-only and supports keyboard focus, Escape and explicit close without commands', () => {
    const activity = vi.fn(), g = snapshot(); render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={vi.fn()} onActivity={activity} />);
    const friend = within(stage()).getByRole('button', { name: '查看花束伙伴的生活近况' }); friend.focus(); expect(friend).toHaveFocus(); fireEvent.click(friend);
    const menu = screen.getByRole('group', { name: '花束伙伴的活动' }); expect(within(menu).getByText('这是朋友的伙伴，活动由它的主人安排。')).toBeVisible(); expect(within(menu).queryByRole('button', { name: /^安排/ })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('group', { name: '花束伙伴的活动' })).toBeNull(); expect(stage().querySelector('canvas')).toHaveFocus();
    fireEvent.click(within(stage()).getByRole('button', { name: '查看杯子伙伴的生活近况' })); fireEvent.click(screen.getByRole('button', { name: '关闭活动菜单' }));
    expect(screen.queryByRole('group', { name: '杯子伙伴的活动' })).toBeNull(); expect(activity).not.toHaveBeenCalled(); noRequests();
  });

  it('disables every owned menu action while a parent save is busy', () => {
    const activity = vi.fn(); render(<GatheringWorld onLeisureAction={vi.fn()} gathering={snapshot()} focusedId={null} onSelect={vi.fn()} busy onActivity={activity} />);
    fireEvent.click(within(stage()).getByRole('button', { name: '查看杯子伙伴的生活近况' })); const menu = screen.getByRole('group', { name: '杯子伙伴的活动' });
    for (const label of ['休息', '睡觉', '散步', '观察', '相聚']) { const button = within(menu).getByRole('button', { name: '安排' + label }); expect(button).toBeDisabled(); fireEvent.click(button); }
    expect(activity).not.toHaveBeenCalled(); noRequests();
  });

  it.each(['empty', 'unavailable'])('keeps the full home available with %s character meshes without inventing a substitute person', mode => {
    const original = snapshot(), g = { ...original, companions: mode === 'empty' ? [] : original.companions.map(c => ({ ...c, avatar3d: undefined })) };
    render(<GatheringWorld onLeisureAction={vi.fn()} gathering={g} focusedId={null} onSelect={vi.fn()} />); expect(areaButton('overview')).toHaveAttribute('aria-pressed', 'true'); expect(createLivingWorld).toHaveBeenCalledOnce(); expect(latest()[0]).toBe(g);
    if (mode === 'empty') expect(screen.getByText('家园已准备好，从下方带一位已有伙伴来相聚。')).toBeVisible();
    else { expect(within(stage()).getAllByText('立体形象待准备')).toHaveLength(2); expect(within(stage()).getAllByRole('button', { name: /^查看.+的生活近况$/ })).toHaveLength(2); }
    noRequests();
  });
});
