import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import type { HomeWorldDoorId } from '@/lib/living-home-world-meshes';

const ENTRY = 'home-main-entry-door', ROOM = 'home-room-connection-door';
type Stub = { setDoorOpen: ReturnType<typeof vi.fn>; toggleDoor: ReturnType<typeof vi.fn>; setMotion: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; emit: (id: HomeWorldDoorId, open: boolean) => void };
const gpu = vi.hoisted(() => ({ instances: [] as Stub[] }));
vi.mock('@/lib/living-world-engine', () => ({ createLivingWorld: vi.fn((host: HTMLElement, _labels: HTMLElement, _group: Gathering, _select: (id: number) => void, changed?: (id: HomeWorldDoorId, open: boolean) => void) => {
  const canvas = document.createElement('canvas'); host.append(canvas);
  const doors = new Map<HomeWorldDoorId, boolean>([['home-main-entry-door', true], ['home-room-connection-door', true]]);
  let mode = 'interior';
  function setDoorOpen(id: HomeWorldDoorId, open: boolean) {
    if (mode === 'exterior' && id === 'home-room-connection-door' || doors.get(id) === open) return;
    doors.set(id, open); changed?.(id, open);
  }
  const stub = { setDoorOpen: vi.fn(setDoorOpen), toggleDoor: vi.fn((id: HomeWorldDoorId) => setDoorOpen(id, !doors.get(id))),
    setMotion: vi.fn(), update: vi.fn(), dispose: vi.fn(() => canvas.remove()), emit: (id: HomeWorldDoorId, open: boolean) => changed?.(id, open),
    setHouseView: vi.fn((value: string) => { mode = value; }), setBubbleReceipts: vi.fn(), setReplay: vi.fn(), setSelectionMenu: vi.fn(), rotate: vi.fn(), zoom: vi.fn(), reset: vi.fn() };
  gpu.instances.push(stub); return stub;
}) }));

function snapshot(scene = 'home'): Gathering {
  return parseGathering({ id: 'synthetic-door-controls', title: '门开合合成测试', scene_type: scene, revision: 9, closed: false, is_manager: true, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '我', manager: true }, { id: 'friend', name: '朋友', manager: false }],
    companions: [
      { id: 4, name: '院子伙伴', owner_id: 'owner', area: 'outdoor', activity: 'walk', x: .3, y: .5 },
      { id: 5, name: '客厅朋友', owner_id: 'friend', area: 'indoor', activity: 'rest', x: .7, y: .4 },
    ].map((c, index) => ({ ...c, avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: index + 4, source: 'procedural_existing_features' } })),
    items: [{ id: 'saved-bench', kind: 'bench', x: .21, y: .43, mine: true, contributor_name: '我', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
beforeEach(() => { vi.clearAllMocks(); gpu.instances.length = 0; vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected network request')))); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('accessible local home door controls', () => {
  it('operates both doors through keyboard-focusable controls and reflects direct scene callbacks without saving activity', () => {
    const group = snapshot(), before = JSON.stringify(group), select = vi.fn(), activity = vi.fn();
    render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={select} onActivity={activity} animate />);
    const engine = gpu.instances[0], entry = screen.getByRole('button', { name: '关闭入户门' }), room = screen.getByRole('button', { name: '关闭卧室门' });
    expect(entry).toHaveAttribute('type', 'button'); expect(entry).toHaveAttribute('aria-pressed', 'true'); expect(room).toHaveAttribute('aria-pressed', 'true');
    entry.focus(); expect(entry).toHaveFocus(); fireEvent.click(entry);
    expect(engine.toggleDoor.mock.calls.some(([id]) => id === ENTRY) || engine.setDoorOpen.mock.calls.some(([id, open]) => id === ENTRY && open === false)).toBe(true);
    expect(screen.getByRole('button', { name: '打开入户门' })).toBeEnabled(); expect(screen.getByRole('button', { name: '打开入户门' })).toHaveAttribute('aria-pressed', 'false');
    room.focus(); expect(room).toHaveFocus(); fireEvent.click(room); expect(screen.getByRole('button', { name: '打开卧室门' })).toBeEnabled();
    act(() => engine.emit(ENTRY, true)); expect(screen.getByRole('button', { name: '关闭入户门' })).toBeEnabled();
    expect(createLivingWorld).toHaveBeenCalledOnce(); expect(select).not.toHaveBeenCalled(); expect(activity).not.toHaveBeenCalled(); expect(JSON.stringify(group)).toBe(before);
  });

  it('disables the hidden interior door in exterior view while keeping the visible main entry usable', () => {
    const group = snapshot(); render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} animate />);
    const engine = gpu.instances[0]; fireEvent.click(screen.getByRole('button', { name: '看外观' }));
    expect(screen.getByRole('button', { name: '关闭卧室门' })).toBeDisabled(); expect(screen.getByRole('button', { name: '关闭入户门' })).toBeEnabled();
    engine.toggleDoor.mockClear(); engine.setDoorOpen.mockClear(); fireEvent.click(screen.getByRole('button', { name: '关闭卧室门' }));
    expect(engine.toggleDoor).not.toHaveBeenCalled(); expect(engine.setDoorOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭入户门' })); expect(screen.getByRole('button', { name: '打开入户门' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '看室内' })); expect(screen.getByRole('button', { name: '关闭卧室门' })).toBeEnabled();
  });

  it('retains local door targets across snapshots and camera focus while paused doors remain operable', () => {
    const group = snapshot(), before = JSON.stringify(group), paused = vi.fn();
    const view = render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} onPausedChange={paused} animate />);
    const engine = gpu.instances[0]; fireEvent.click(screen.getByRole('button', { name: '关闭入户门' }));
    fireEvent.click(screen.getByRole('button', { name: '暂停画面' })); expect(paused).toHaveBeenCalledWith(true); expect(engine.setMotion).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: '关闭卧室门' })); expect(screen.getByRole('button', { name: '打开卧室门' })).toBeEnabled();
    const next = { ...group, revision: group.revision + 1 };
    view.rerender(<SharedLivingWorld3D gathering={next} focusedId={5} onSelect={vi.fn()} onPausedChange={paused} animate view="indoor" />);
    expect(screen.getByRole('button', { name: '打开入户门' })).toBeEnabled(); expect(screen.getByRole('button', { name: '打开卧室门' })).toBeEnabled();
    fireEvent.click(within(screen.getByRole('group', { name: '家园镜头' })).getByRole('button', { name: '看全景' }));
    expect(screen.getByRole('button', { name: '打开入户门' })).toBeEnabled(); expect(createLivingWorld).toHaveBeenCalledOnce(); expect(JSON.stringify(group)).toBe(before);
  });

  it('restores page-local closed doors after WebGL recovery but resets to open on a fresh page mount', () => {
    const group = snapshot(), before = JSON.stringify(group), view = render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} animate={false} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭入户门' })); fireEvent.click(screen.getByRole('button', { name: '关闭卧室门' }));
    act(() => screen.getByTestId('living3d-canvas').dispatchEvent(new CustomEvent('living3d-lost')));
    expect(screen.getByRole('button', { name: '打开入户门' })).toBeDisabled(); expect(screen.getByRole('button', { name: '打开卧室门' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新打开立体画面' }));
    expect(createLivingWorld).toHaveBeenCalledTimes(2); expect(gpu.instances[0].dispose).toHaveBeenCalledOnce();
    expect(gpu.instances[1].setDoorOpen).toHaveBeenCalledWith(ENTRY, false); expect(gpu.instances[1].setDoorOpen).toHaveBeenCalledWith(ROOM, false);
    expect(screen.getByRole('button', { name: '打开入户门' })).toBeEnabled(); view.unmount();
    render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} animate={false} />);
    expect(screen.getByRole('button', { name: '关闭入户门' })).toBeEnabled(); expect(screen.getByRole('button', { name: '关闭卧室门' })).toBeEnabled(); expect(JSON.stringify(group)).toBe(before);
  });

  it('adds no cottage door controls to forest scenes', () => {
    render(<SharedLivingWorld3D gathering={snapshot('forest')} focusedId={null} onSelect={vi.fn()} animate={false} />);
    expect(screen.queryByRole('button', { name: /(?:打开|关闭)(?:入户门|卧室门)/ })).toBeNull();
  });
});
