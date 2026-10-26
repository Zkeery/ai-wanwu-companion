import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedLivingWorld3D from '../components/shared-living-world-3d';
import { parseGathering } from '../lib/gatherings';
import type { HomePresenceSnapshot } from '../lib/living-home-presence';

type CapturedWorld = { emit: (snapshot: HomePresenceSnapshot) => void; disposed: ReturnType<typeof vi.fn>; options: { localRoomTransitions?: boolean } };
const engines = vi.hoisted(() => ({ worlds: [] as CapturedWorld[] }));
vi.mock('../lib/living-world-engine', () => ({
  createLivingWorld: vi.fn((_host: HTMLElement, labels: HTMLElement, _group: unknown, _select: (id: number) => void,
    changed: (id: string, open: boolean) => void, options?: { localRoomTransitions?: boolean; onJourneyChange?: (snapshot: HomePresenceSnapshot) => void }) => {
    const doors: Record<string, boolean> = { 'home-main-entry-door': false, 'home-room-connection-door': true, 'home-courtyard-gate': true };
    const bubble = document.createElement('span'); bubble.className = 'living3d-bubble'; bubble.textContent = '已有交流内容'; labels.append(bubble);
    const instance: CapturedWorld = { emit: snapshot => options?.onJourneyChange?.(snapshot), disposed: vi.fn(() => bubble.remove()), options: options ?? {} }; engines.worlds.push(instance);
    const setDoorOpen = vi.fn((id: string, open: boolean) => { if (doors[id] === open) return; doors[id] = open; changed(id, open); });
    return { update: vi.fn(), setMotion: vi.fn(), setReplay: vi.fn(), setBubbleReceipts: vi.fn(), setHouseView: vi.fn(), setDoorOpen,
      toggleDoor: vi.fn((id: string) => setDoorOpen(id, !doors[id])), setSelectionMenu: vi.fn(), rotate: vi.fn(), zoom: vi.fn(), reset: vi.fn(),
      stopLocalLeisure: vi.fn(), startLocalLeisure: vi.fn(), focusLocalLeisure: vi.fn(), toggleLocalLeisure: vi.fn(), setLifeAudio: vi.fn(), dispose: instance.disposed };
  }),
}));
function gathering(owner = 'account-a', id = 'synthetic-presence-ui') {
  return parseGathering({ id, title: '只读物理区域', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: owner,
    members: [{ id: 'account-a', name: '成员A', manager: true }, { id: 'account-b', name: '成员B', manager: false }],
    companions: [{ id: 4, name: '回屋伙伴', owner_id: 'account-a', activity: 'sleep', area: 'bedroom', x: .5, y: .5,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } },
    { id: 5, name: '朋友伙伴', owner_id: 'account-b', activity: 'rest', area: 'indoor', x: .5, y: .5,
      avatar3d: { version: 1, kind: 'plant', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 5, source: 'procedural_existing_features' } }],
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function projection(owner = 'account-a', area: 'outdoor' | 'indoor' | 'bedroom' = 'outdoor', phase: 'walk' | 'wait-door' | 'idle' = 'walk'): HomePresenceSnapshot {
  return { groupId: 'synthetic-presence-ui', ownerId: owner, actors: [{ id: 4, area, active: phase !== 'idle', phase, targetArea: 'bedroom' },
    { id: 5, area: 'indoor', active: false, phase: 'idle', targetArea: 'indoor' }] };
}
const latest = () => engines.worlds.at(-1)!;
async function emit(snapshot: HomePresenceSnapshot, instance = latest()) { await act(async () => { instance.emit(snapshot); }); }
async function settle() { await act(async () => {}); }
async function revealRooms() { fireEvent.click(screen.getByRole('button', { name: '打开入户门' })); await settle(); }
function counts() {
  const region = within(screen.getByRole('group', { name: '家园镜头' }));
  return ['院子', '客厅', '卧室'].map(name => region.getByRole('button', { name: new RegExp('^' + name) }).querySelector('span')?.textContent);
}
beforeEach(() => { engines.worlds.length = 0; vi.stubGlobal('fetch', vi.fn(() => { throw new Error('presence UI stays offline'); })); });
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('physical presence callback on the real React scene component', () => {
  it('keeps a saved sleep destination outside until physical callbacks cross into each room', async () => {
    const group = gathering(), original = JSON.stringify(group), onActivity = vi.fn();
    render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions onActivity={onActivity} />);
    await settle(); await revealRooms();
    await emit(projection()); expect(counts()).toEqual(['1', '1', '0']);
    expect(screen.getByRole('button', { name: '查看回屋伙伴的生活近况' })).toHaveTextContent('院子 · 走向卧室，准备睡觉');
    await emit(projection('account-a', 'indoor')); expect(counts()).toEqual(['0', '2', '0']);
    await emit(projection('account-a', 'bedroom', 'idle')); expect(counts()).toEqual(['0', '1', '1']);
    expect(screen.getByRole('button', { name: '查看回屋伙伴的生活近况' })).toHaveTextContent('卧室 · 睡觉');
    expect(JSON.stringify(group)).toBe(original); expect(onActivity).not.toHaveBeenCalled();
  });
  it('shows waiting in the list and menu while keeping the existing dialogue bubble untouched', async () => {
    render(<SharedLivingWorld3D gathering={gathering()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions onActivity={vi.fn()} />);
    await settle(); await emit(projection('account-a', 'outdoor', 'wait-door'));
    const entry = screen.getByRole('button', { name: '查看回屋伙伴的生活近况' }); expect(entry).toHaveTextContent('院子 · 门前等候');
    fireEvent.click(entry); await settle(); expect(screen.getByRole('group', { name: '回屋伙伴的活动' })).toHaveTextContent('院子 · 门前等候');
    const bubble = document.querySelector('.living3d-bubble')!; expect(bubble.textContent).toBe('已有交流内容'); expect(bubble.textContent).not.toContain('等候');
  });
  it('does not turn a friend into an actionable owner through physical projection or injected extra fields', async () => {
    const onActivity = vi.fn(), group = gathering();
    render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions onActivity={onActivity} />);
    await settle();
    const initial = projection(), state = { ...initial, actors: initial.actors.map(a => ({ ...a, owner_id: 'account-a' })) };
    await emit(state); fireEvent.click(screen.getByRole('button', { name: '查看朋友伙伴的生活近况' })); await settle();
    const menu = within(screen.getByRole('group', { name: '朋友伙伴的活动' }));
    for (const name of ['安排休息', '安排睡觉', '安排散步', '安排观察', '安排相聚']) expect(menu.queryByRole('button', { name })).toBeNull();
    expect(onActivity).not.toHaveBeenCalled(); expect(group.companions.find(c => c.id === 5)?.owner_id).toBe('account-b');
  });
  it('ignores callbacks from a disposed world when the view is remounted for another account', async () => {
    const view = render(<SharedLivingWorld3D key="a" gathering={gathering()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions />);
    await settle(); const old = latest();
    view.rerender(<SharedLivingWorld3D key="b" gathering={gathering('account-b')} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions />);
    await settle(); expect(old.disposed).toHaveBeenCalledOnce(); await revealRooms(); await emit(projection('account-b'));
    expect(counts()).toEqual(['1', '1', '0']); await emit(projection('account-a', 'bedroom', 'idle'), old);
    expect(counts()).toEqual(['1', '1', '0']);
  });
  it('does not replace current-account physical state with an old-scope callback after a scope-only account change', async () => {
    const view = render(<SharedLivingWorld3D gathering={gathering()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions />);
    await settle(); const old = latest();
    view.rerender(<SharedLivingWorld3D gathering={gathering('account-b')} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions />);
    await settle(); await revealRooms(); await emit(projection('account-b')); expect(counts()).toEqual(['1', '1', '0']);
    await emit(projection('account-a', 'bedroom', 'idle'), old); expect(counts()).toEqual(['1', '1', '0']);
  });
  it('falls back to saved activity and region when the transition gate is false', async () => {
    render(<SharedLivingWorld3D gathering={gathering()} focusedId={null} onSelect={vi.fn()} animate visualStyle="realistic" localLeisurePreview localRoomTransitions={false} />);
    await settle(); await revealRooms(); await emit(projection('account-a', 'outdoor', 'wait-door'));
    expect(counts()).toEqual(['0', '1', '1']);
    expect(screen.getByRole('button', { name: '查看回屋伙伴的生活近况' })).toHaveTextContent('卧室 · 睡觉');
    expect(screen.queryByText(/门前等候/)).toBeNull();
  });
});
