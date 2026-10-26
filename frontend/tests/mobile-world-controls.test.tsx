import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import { parseGathering, type Gathering } from '@/lib/gatherings';

const engine = vi.hoisted(() => ({
  select: null as null | ((id: number) => void),
  menu: vi.fn(), update: vi.fn(), dispose: vi.fn(), rotate: vi.fn(), zoom: vi.fn(),
}));
vi.mock('@/lib/living-world-engine', () => ({ createLivingWorld: vi.fn((host: HTMLElement, _labels: HTMLElement, _group: Gathering, select: (id: number) => void) => {
  const canvas = document.createElement('canvas'); canvas.tabIndex = 0; host.append(canvas); engine.select = select;
  return { update: engine.update, setSelectionMenu: engine.menu, setMotion: vi.fn(), setReplay: vi.fn(), setBubbleReceipts: vi.fn(),
    setHouseView: vi.fn(), setUpperFloorView: vi.fn(), setDoorOpen: vi.fn(), toggleDoor: vi.fn(), getFloorVisit: () => null,
    stopLocalLeisure: vi.fn(), startLocalLeisure: vi.fn(), setLifeAudio: vi.fn(async () => true),
    rotate: engine.rotate, zoom: engine.zoom, reset: vi.fn(), dispose: () => { canvas.remove(); engine.dispose(); } };
}) }));

let narrow: boolean, coarse: boolean, reduced: boolean, mediaChanged: (() => void) | undefined;
const scroll = vi.fn();
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
function snapshot(): Gathering {
  return parseGathering({ id: 'synthetic-mobile-world', title: '手机交互免费验证', scene_type: 'home', revision: 1, closed: false, me: 'owner', is_manager: true,
    members: [{ id: 'owner', name: '我', manager: true }, { id: 'friend', name: '朋友', manager: false }],
    companions: [{ id: 1, name: '我的伙伴', owner_id: 'owner' }, { id: 2, name: '朋友的伙伴', owner_id: 'friend' }].map((c, index) => ({
      ...c, area: 'outdoor', activity: 'walk', x: .3 + index * .3, y: .5,
      avatar3d: { version: 1, kind: 'cup', body: '#eeeeee', accent: '#aaaaaa', detail: '#333333', seed: index + 1, source: 'procedural_existing_features' },
    })), items: [], events: [], stories: [], votes: [], story_enabled: false, goal: null, season: { current_season: null } });
}
function mount(group = snapshot(), onActivity = vi.fn()) {
  return { ...render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} onActivity={onActivity} animate />), onActivity };
}
function select(id = 1) { act(() => engine.select?.(id)); return screen.getByRole('group', { name: id === 1 ? '我的伙伴的活动' : '朋友的伙伴的活动' }); }
beforeEach(() => {
  vi.clearAllMocks(); narrow = true; coarse = false; reduced = false; mediaChanged = undefined;
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network prohibited in mobile UI validation'))));
  vi.stubGlobal('matchMedia', vi.fn((query: string) => query.includes('prefers-reduced-motion')
    ? { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    : { get matches() { return narrow || (query.includes('pointer: coarse') && coarse); }, addEventListener: (_event: string, callback: () => void) => { mediaChanged = callback; }, removeEventListener: vi.fn() }));
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll); else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe('mobile world interaction panels', () => {
  it('keeps the one set of room and door controls outside the drawing viewport', () => {
    mount(); const viewport = screen.getByTestId('living3d-canvas').parentElement!;
    const controls = screen.getByRole('group', { name: '家园查看与房门' });
    expect(viewport).not.toContainElement(controls);
    expect(screen.getAllByRole('group', { name: '家园镜头' })).toHaveLength(1);
    expect(screen.getAllByRole('group', { name: '房门开关' })).toHaveLength(1);
    expect(viewport.parentElement).toHaveAttribute('data-controls-layout', 'mobile');
    expect(screen.getByText('单指上下滑动页面 · 双指转动和缩放画面')).toBeVisible();
  });

  it('opens a stable panel and scrolls it into view without requiring a model request', () => {
    const { onActivity } = mount(); const menu = select();
    expect(menu).toHaveAttribute('data-menu-placement', 'panel');
    expect(engine.menu).toHaveBeenLastCalledWith(menu, 1, 'panel');
    expect(screen.getByTestId('living3d-canvas').parentElement).not.toContainElement(menu);
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest', behavior: 'smooth' });
    expect(within(menu).getByText('这些活动免费，不会发起 AI 对话。')).toBeVisible();
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('keeps only owned activity actions, records a single deliberate action and closes accessibly', async () => {
    const activity = vi.fn().mockResolvedValue(undefined); mount(snapshot(), activity); const menu = select();
    await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: '安排相聚' })); });
    expect(activity).toHaveBeenCalledExactlyOnceWith(1, 'talk');
    const friendMenu = select(2);
    expect(within(friendMenu).getByText('这是朋友的伙伴，活动由它的主人安排。')).toBeVisible();
    expect(within(friendMenu).queryByRole('button', { name: /^安排/ })).toBeNull();
    fireEvent.click(within(friendMenu).getByRole('button', { name: '关闭活动菜单' }));
    expect(screen.queryByRole('group', { name: '朋友的伙伴的活动' })).toBeNull();
    expect(screen.getByTestId('living3d-canvas').querySelector('canvas')).toHaveFocus();
    expect(activity).toHaveBeenCalledTimes(1);
  });

  it('respects reduced motion when showing the selected companion panel', () => {
    reduced = true; mount(); select(); expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest', behavior: 'auto' });
  });

  it('keeps the mobile panel and gesture guidance on a wide coarse-pointer phone in landscape', () => {
    narrow = false; coarse = true; mount(); const menu = select();
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 600px), (pointer: coarse)');
    expect(menu).toHaveAttribute('data-menu-placement', 'panel');
    expect(engine.menu).toHaveBeenLastCalledWith(menu, 1, 'panel');
    expect(screen.getByTestId('living3d-canvas').parentElement!.parentElement).toHaveAttribute('data-controls-layout', 'mobile');
    expect(screen.getByText('单指上下滑动页面 · 双指转动和缩放画面')).toBeVisible();
    expect(screen.queryByText('拖动画面旋转 · 双指缩放')).toBeNull();
  });

  it('switches the existing menu between a mobile panel and the desktop anchor on resize', () => {
    mount(); const menu = select();
    act(() => { narrow = false; mediaChanged?.(); });
    expect(screen.getByRole('group', { name: '我的伙伴的活动' })).toBe(menu);
    expect(engine.menu).toHaveBeenLastCalledWith(menu, 1, 'anchor');
    expect(menu).toHaveAttribute('data-menu-placement', 'anchor');
    expect(screen.getByText('拖动画面旋转 · 双指缩放')).toBeVisible();
    act(() => { narrow = true; mediaChanged?.(); });
    expect(engine.menu).toHaveBeenLastCalledWith(menu, 1, 'panel');
    expect(screen.getAllByRole('button', { name: '关闭活动菜单' })).toHaveLength(1);
  });

  it('retains the selected panel after the saved position changes, without issuing another action', () => {
    const group = snapshot(), { rerender, onActivity } = mount(group); const menu = select(); const scrollCount = scroll.mock.calls.length;
    rerender(<SharedLivingWorld3D gathering={{ ...group, revision: 2, companions: group.companions.map(c => ({ ...c, x: c.x + .02 })) }} focusedId={null} onSelect={vi.fn()} onActivity={onActivity} animate />);
    expect(screen.getByRole('group', { name: '我的伙伴的活动' })).toBe(menu);
    expect(engine.menu).toHaveBeenLastCalledWith(menu, 1, 'panel');
    expect(scroll).toHaveBeenCalledTimes(scrollCount); expect(onActivity).not.toHaveBeenCalled();
  });
});
