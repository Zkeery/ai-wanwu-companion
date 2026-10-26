import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import type { HomeWorldDoorId } from '@/lib/living-home-world-meshes';

const GATE = 'home-courtyard-gate';
type Stub = { toggleDoor: ReturnType<typeof vi.fn>; setDoorOpen: ReturnType<typeof vi.fn>; setMotion: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; emit: (id: HomeWorldDoorId, open: boolean) => void };
const boundary = vi.hoisted(() => ({ instances: [] as Stub[] }));
vi.mock('@/lib/living-world-engine', () => ({ createLivingWorld: vi.fn((host: HTMLElement, _labels: HTMLElement, _group: Gathering, _selected: (id: number) => void, changed?: (id: HomeWorldDoorId, open: boolean) => void) => {
  const canvas = document.createElement('canvas'); host.append(canvas);
  const doors = new Map<HomeWorldDoorId, boolean>([['home-main-entry-door', true], ['home-room-connection-door', true], ['home-courtyard-gate', true]]);
  let mode = 'interior';
  const set = (id: HomeWorldDoorId, open: boolean) => { if (mode === 'exterior' && id === 'home-room-connection-door' || doors.get(id) === open) return; doors.set(id, open); changed?.(id, open); };
  const result = { toggleDoor: vi.fn((id: HomeWorldDoorId) => set(id, !doors.get(id))), setDoorOpen: vi.fn(set), setMotion: vi.fn(),
    emit: (id: HomeWorldDoorId, open: boolean) => changed?.(id, open), dispose: vi.fn(() => canvas.remove()),
    update: vi.fn(), setHouseView: vi.fn((value: string) => { mode = value; }), setReplay: vi.fn(), setBubbleReceipts: vi.fn(), setSelectionMenu: vi.fn(), rotate: vi.fn(), zoom: vi.fn(), reset: vi.fn() };
  boundary.instances.push(result); return result;
}) }));
function snapshot(scene = 'home') {
  return parseGathering({ id: 'enclosed-home-controls', title: '合成围合家园', scene_type: scene, revision: 4, closed: false, is_manager: true, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '合成成员', manager: true }], companions: [{ id: 4, name: '合成伙伴', owner_id: 'owner', activity: 'walk', area: 'outdoor', x: .2, y: .6,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [{ id: 'saved-bench', kind: 'bench', x: .21, y: .43, mine: true, contributor_name: '合成成员', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
beforeEach(() => { vi.clearAllMocks(); boundary.instances.length = 0; vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected network request')))); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('third independent courtyard gate controls', () => {
  it('toggles the gate and reflects its scene callback without changing either house door or any saved data', () => {
    const group = snapshot(), before = JSON.stringify(group), selected = vi.fn(), activity = vi.fn();
    render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={selected} onActivity={activity} animate={false} />);
    const engine = boundary.instances[0], gate = screen.getByRole('button', { name: '关闭院门' });
    expect(gate).toHaveAttribute('type', 'button'); expect(gate).toHaveAttribute('aria-pressed', 'true'); gate.focus(); expect(gate).toHaveFocus();
    fireEvent.click(gate); expect(engine.toggleDoor).toHaveBeenLastCalledWith(GATE);
    expect(screen.getByRole('button', { name: '打开院门' })).toHaveAttribute('aria-pressed', 'false');
    for (const name of ['关闭入户门', '关闭卧室门']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    act(() => engine.emit(GATE, true)); expect(screen.getByRole('button', { name: '关闭院门' })).toHaveAttribute('aria-pressed', 'true');
    expect(createLivingWorld).toHaveBeenCalledOnce(); expect(activity).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled(); expect(JSON.stringify(group)).toBe(before);
  });

  it('retains a paused gate across snapshots, exterior view and WebGL recovery, while a fresh page defaults open', () => {
    const group = snapshot(), before = JSON.stringify(group), props = { focusedId: null, onSelect: vi.fn(), animate: true };
    const view = render(<SharedLivingWorld3D gathering={group} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '暂停画面' })); expect(boundary.instances[0].setMotion).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: '看外观' }));
    expect(screen.getByRole('button', { name: '关闭卧室门' })).toBeDisabled(); expect(screen.getByRole('button', { name: '关闭院门' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '关闭院门' })); expect(screen.getByRole('button', { name: '打开院门' })).toBeEnabled();
    view.rerender(<SharedLivingWorld3D gathering={{ ...group, revision: 5 }} {...props} />);
    expect(screen.getByRole('button', { name: '打开院门' })).toBeEnabled(); expect(createLivingWorld).toHaveBeenCalledOnce();
    act(() => screen.getByTestId('living3d-canvas').dispatchEvent(new CustomEvent('living3d-lost')));
    expect(screen.getByRole('button', { name: '打开院门' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '重新打开立体画面' }));
    expect(boundary.instances[1].setDoorOpen).toHaveBeenCalledWith(GATE, false); expect(screen.getByRole('button', { name: '打开院门' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '看外观' })).toHaveAttribute('aria-pressed', 'true'); view.unmount();
    render(<SharedLivingWorld3D gathering={group} {...props} />); expect(screen.getByRole('button', { name: '关闭院门' })).toHaveAttribute('aria-pressed', 'true'); expect(JSON.stringify(group)).toBe(before);
  });

  it('does not add a courtyard gate control to a forest scene', () => {
    render(<SharedLivingWorld3D gathering={snapshot('forest')} focusedId={null} onSelect={vi.fn()} animate={false} />);
    expect(screen.queryByRole('button', { name: /(?:关闭|打开)院门/ })).toBeNull();
  });
});
