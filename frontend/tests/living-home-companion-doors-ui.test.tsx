import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedLivingWorld3D from '../components/shared-living-world-3d';
import { parseGathering } from '../lib/gatherings';

type DoorSource = 'manual' | 'companion';
type DoorInstance = { emitDoor: (id: string, open: boolean, source?: DoorSource) => void; dispose: ReturnType<typeof vi.fn>;
  setDoorOpen: ReturnType<typeof vi.fn>; options: { localLeisurePreview?: boolean; localCompanionDoors?: boolean; localReferenceVilla?: boolean } };
const doorsEngine = vi.hoisted(() => ({ worlds: [] as DoorInstance[] }));
vi.mock('../lib/living-world-engine', () => ({
  createLivingWorld: vi.fn((_host: HTMLElement, _labels: HTMLElement, _group: unknown, _select: (id: number) => void,
    changed: (id: string, open: boolean, source?: DoorSource) => void, options?: { localLeisurePreview?: boolean; localCompanionDoors?: boolean; localReferenceVilla?: boolean }) => {
    const states: Record<string, boolean> = { 'home-main-entry-door': !options?.localLeisurePreview, 'home-room-connection-door': !options?.localCompanionDoors, 'home-courtyard-gate': true };
    const setDoorOpen = vi.fn((id: string, open: boolean) => { if (states[id] === open) return; states[id] = open; changed(id, open, 'manual'); });
    const instance: DoorInstance = { options: options ?? {}, dispose: vi.fn(), setDoorOpen,
      emitDoor: (id, open, source) => { states[id] = open; changed(id, open, source); } }; doorsEngine.worlds.push(instance);
    return { update: vi.fn(), setMotion: vi.fn(), setReplay: vi.fn(), setBubbleReceipts: vi.fn(), setHouseView: vi.fn(), setDoorOpen,
      toggleDoor: vi.fn((id: string) => setDoorOpen(id, !states[id])), setSelectionMenu: vi.fn(), rotate: vi.fn(), zoom: vi.fn(), reset: vi.fn(),
      stopLocalLeisure: vi.fn(), startLocalLeisure: vi.fn(), focusLocalLeisure: vi.fn(), toggleLocalLeisure: vi.fn(), setLifeAudio: vi.fn(), dispose: instance.dispose };
  }),
}));
function group(owner = 'owner-a', id = 'synthetic-auto-door-ui') {
  return parseGathering({ id, title: '伙伴自主开门', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: owner,
    members: [{ id: 'owner-a', name: '成员A', manager: true }, { id: 'owner-b', name: '成员B', manager: false }],
    companions: [{ id: 4, owner_id: 'owner-a', name: '已有伙伴', activity: 'observe', area: 'outdoor', x: .5, y: .5,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
const latest = () => doorsEngine.worlds.at(-1)!;
const viewState = () => { const element = screen.getByTestId('living3d-canvas').parentElement!; return { house: element.dataset.houseView, camera: element.dataset.focusView }; };
async function settled() { await act(async () => {}); }
async function doorEvent(id: string, open: boolean, source?: DoorSource, instance = latest()) { await act(async () => { instance.emitDoor(id, open, source); }); }
const mainDoorButton = () => screen.getByRole('button', { name: /^(打开入户门|关闭入户门|进入客厅)$/ });
beforeEach(() => { doorsEngine.worlds.length = 0; vi.stubGlobal('fetch', vi.fn(() => { throw new Error('autonomous door UI must stay offline'); })); });
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('companion door events on the real React component', () => {
  it('keeps the new switch off by default and retains the old room-open default', async () => {
    render(<SharedLivingWorld3D gathering={group()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions />);
    await settled(); expect(latest().options.localCompanionDoors).not.toBe(true);
    expect(screen.getByRole('button', { name: '关闭卧室门' })).toHaveAttribute('aria-pressed', 'true');
  });
  it.each([
    { id: 'synthetic-auto-door-ui', transitions: false, style: 'realistic' as const },
    { id: 'production-space', transitions: true, style: 'realistic' as const },
    { id: 'synthetic-auto-door-ui', transitions: true, style: 'classic' as const },
  ])('requires every local gate before changing room defaults or enabling autonomous doors', async ({ id, transitions, style }) => {
    render(<SharedLivingWorld3D gathering={group('owner-a', id)} focusedId={null} onSelect={vi.fn()} animate visualStyle={style} localLeisurePreview localRoomTransitions={transitions} localCompanionDoors />);
    await settled(); expect(latest().options.localCompanionDoors).not.toBe(true);
    expect(screen.getByRole('button', { name: '关闭卧室门' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('starts with the bedroom closed only when autonomous local doors are fully enabled', async () => {
    render(<SharedLivingWorld3D gathering={group()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors />);
    await settled(); expect(latest().options.localCompanionDoors).toBe(true);
    expect(screen.getByRole('button', { name: '打开卧室门' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('updates companion door state without grabbing the camera or echoing a manual policy command', async () => {
    const focus = vi.fn();
    render(<SharedLivingWorld3D gathering={group()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors onFocusView={focus} />);
    await settled(); const engine = latest(); engine.setDoorOpen.mockClear(); const before = viewState();
    await doorEvent('home-main-entry-door', true, 'companion');
    expect(mainDoorButton()).toHaveAttribute('aria-pressed', 'true'); expect(viewState()).toEqual(before); expect(focus).not.toHaveBeenCalled();
    expect(engine.setDoorOpen).not.toHaveBeenCalled();
    await doorEvent('home-room-connection-door', true, 'companion');
    expect(screen.getByRole('button', { name: '关闭卧室门' })).toHaveAttribute('aria-pressed', 'true');
    expect(viewState()).toEqual(before); expect(engine.setDoorOpen).not.toHaveBeenCalled();
  });
  it('lets a user enter manually even if the companion already opened the front door', async () => {
    const focus = vi.fn();
    render(<SharedLivingWorld3D gathering={group()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors onFocusView={focus} />);
    await settled(); await doorEvent('home-main-entry-door', true, 'companion'); expect(viewState().house).toBe('exterior');
    fireEvent.click(mainDoorButton()); await settled(); expect(viewState().house).toBe('interior'); expect(viewState().camera).toBe('indoor'); expect(focus).toHaveBeenLastCalledWith('indoor');
  });
  it('keeps manual opening and an omitted source compatible with the previous entry flow', async () => {
    const focus = vi.fn();
    render(<SharedLivingWorld3D gathering={group()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors onFocusView={focus} />);
    await settled(); fireEvent.click(mainDoorButton()); await settled(); expect(viewState().house).toBe('interior'); expect(focus).toHaveBeenLastCalledWith('indoor');
    fireEvent.click(screen.getByRole('button', { name: '回到院子' })); await settled(); expect(viewState().house).toBe('exterior');
    await doorEvent('home-main-entry-door', true); expect(viewState().house).toBe('interior'); expect(focus).toHaveBeenLastCalledWith('indoor');
  });
  it('ignores disposed scope callbacks and resets the new account room to its gated default', async () => {
    const focus = vi.fn(), view = render(<SharedLivingWorld3D gathering={group()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors onFocusView={focus} />);
    await settled(); const previous = latest(); await doorEvent('home-room-connection-door', true, 'companion');
    view.rerender(<SharedLivingWorld3D gathering={group('owner-b')} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors onFocusView={focus} />);
    await settled(); expect(previous.dispose).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: '打开卧室门' })).toHaveAttribute('aria-pressed', 'false');
    const before = viewState(); focus.mockClear(); await doorEvent('home-main-entry-door', true, 'manual', previous); await doorEvent('home-room-connection-door', true, 'companion', previous);
    expect(viewState()).toEqual(before); expect(focus).not.toHaveBeenCalled(); expect(mainDoorButton()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '打开卧室门' })).toHaveAttribute('aria-pressed', 'false');
  });
});


describe('reference villa variant is local and resets its own door scope', () => {
  it('keeps the reference variant off unless explicitly requested', async () => {
    render(<SharedLivingWorld3D gathering={group()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors />);
    await settled(); expect(latest().options.localReferenceVilla).not.toBe(true);
  });
  it.each([
    { id: 'synthetic-auto-door-ui', transitions: false, style: 'realistic' as const },
    { id: 'production-space', transitions: true, style: 'realistic' as const },
    { id: 'synthetic-auto-door-ui', transitions: true, style: 'classic' as const },
  ])('does not enable a reference villa when any existing local guard is closed', async ({ id, transitions, style }) => {
    render(<SharedLivingWorld3D gathering={group('owner-a', id)} focusedId={null} onSelect={vi.fn()} animate visualStyle={style} localLeisurePreview localRoomTransitions={transitions} localCompanionDoors localReferenceVilla />);
    await settled(); expect(latest().options.localReferenceVilla).not.toBe(true);
  });
  it('recreates the world and resets acknowledged door states when the reference variant changes', async () => {
    const focus = vi.fn(), view = render(<SharedLivingWorld3D gathering={group()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors localReferenceVilla onFocusView={focus} />);
    await settled(); const original = latest(); expect(original.options.localReferenceVilla).toBe(true);
    await doorEvent('home-main-entry-door', true, 'companion'); await doorEvent('home-room-connection-door', true, 'companion');
    expect(mainDoorButton()).toHaveAttribute('aria-pressed', 'true');
    view.rerender(<SharedLivingWorld3D gathering={group()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions localCompanionDoors localReferenceVilla={false} onFocusView={focus} />);
    await settled(); expect(original.dispose).toHaveBeenCalledOnce(); const next = latest(); expect(next).not.toBe(original); expect(next.options.localReferenceVilla).toBe(false);
    expect(mainDoorButton()).toHaveAttribute('aria-pressed', 'false'); expect(screen.getByRole('button', { name: '打开卧室门' })).toHaveAttribute('aria-pressed', 'false');
    const before = viewState(); focus.mockClear(); next.setDoorOpen.mockClear();
    await doorEvent('home-main-entry-door', true, 'manual', original); await doorEvent('home-room-connection-door', true, 'companion', original);
    expect(viewState()).toEqual(before); expect(focus).not.toHaveBeenCalled(); expect(next.setDoorOpen).not.toHaveBeenCalled();
    expect(mainDoorButton()).toHaveAttribute('aria-pressed', 'false'); expect(screen.getByRole('button', { name: '打开卧室门' })).toHaveAttribute('aria-pressed', 'false');
  });
});
