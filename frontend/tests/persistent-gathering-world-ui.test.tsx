import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Gatherings from '@/components/gatherings';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import type { Gathering } from '@/lib/gatherings';
import type { LivingLeisureRequest } from '@/lib/living-persistent-world';
import type { HomeLeisureSnapshot } from '@/lib/living-home-leisure';
import type { GatheringFloorPresence } from '@/lib/gathering-presence';
import { setToken } from '@/lib/auth';
import type { PublicSharedMahjongSnapshot } from '@/lib/shared-mahjong';
import { sharedMahjongFixture } from './shared-mahjong-fixtures';

type EngineOptions = { persistentWorld?: boolean; onLeisureRequest?: (value: LivingLeisureRequest) => void;
  onLeisureChange?: (value: HomeLeisureSnapshot) => void; onFloorLifeChange?: (value: GatheringFloorPresence[]) => void };
type Engine = { group: Gathering; options: EngineOptions; request: (value: LivingLeisureRequest) => void; dispose: ReturnType<typeof vi.fn>; upper: ReturnType<typeof vi.fn>; house: ReturnType<typeof vi.fn>; doors: ReturnType<typeof vi.fn>; sharedMahjong?: PublicSharedMahjongSnapshot };
const engine = vi.hoisted(() => ({ instances: [] as Engine[], session: 'isolated-gathering-session' }));
vi.mock('@/components/team-shared', () => ({ useTeamSession: () => engine.session }));
vi.mock('@/components/gathering-dialogue', () => ({ default: () => <p>本测试不打开AI交流</p> }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('next/dynamic', () => ({ default: () => function DynamicWorld(props: React.ComponentProps<typeof SharedLivingWorld3D>) { return <SharedLivingWorld3D {...props} />; } }));
vi.mock('@/lib/living-world-engine', () => ({ createLivingWorld: vi.fn((_host: HTMLElement, _labels: HTMLElement, group: Gathering, _select: (id: number) => void,
  _door: unknown, options: EngineOptions = {}) => {
  const instance: Engine = { group, options, dispose: vi.fn(), upper: vi.fn(), house: vi.fn(), doors: vi.fn(), request: request => options.onLeisureRequest?.(request) }; engine.instances.push(instance);
  const update = (next: Gathering) => {
    instance.group = next;
    options.onLeisureChange?.({ revision: next.revision, scope: { groupId: next.id, ownerId: next.me, synthetic: false, optIn: true }, permitted: true,
      assignments: next.companions.flatMap(c => c.leisure ? [{ actorId: c.id, seatId: c.leisure.seat_id, activity: c.leisure.activity, originalActivity: c.activity, startedAtElapsed: 0 }] : []),
      television: { powered: false, watchingActorIds: [] } });
  };
  return { update, applyServerFloor: () => true, setFloorDriver: vi.fn(), exportServerFloor: () => ({ checkpoint: {version:1,active:null,states:[]}, applied:0 }), canRequestServerFloor: () => false, setMotion: vi.fn(), setReplay: vi.fn(), setBubbleReceipts: vi.fn(), setHouseView: instance.house, setUpperFloorView: instance.upper, setDoorOpen: instance.doors, toggleDoor: vi.fn(), setSelectionMenu: vi.fn(),
    rotate: vi.fn(), zoom: vi.fn(), reset: vi.fn(), setLifeAudio: vi.fn(), dispose: instance.dispose,
    startLocalLeisure: (activity: LivingLeisureRequest['activity'], actorId?: number) => instance.request({ activity, actorId: actorId ?? group.companions.find(c => c.owner_id === group.me)!.id, seatId: 'tea-1' }),
    stopLocalLeisure: (actorId?: number) => instance.request({ activity: null, actorId: actorId ?? group.companions.find(c => c.owner_id === group.me)!.id }),
    updateSharedMahjong: (snapshot?: PublicSharedMahjongSnapshot) => { instance.sharedMahjong = snapshot; },
    focusLocalLeisure: vi.fn(), toggleLocalLeisure: vi.fn(), restartLocalMahjong: vi.fn() };
}) }));

const avatar = { version: 1, kind: 'cup', body: '#eeeeee', accent: '#aaaaaa', detail: '#333333', seed: 1, source: 'procedural_existing_features' };
function initial() { return { id: 'real-shared-home', title: '正式共同住处', scene_type: 'home', revision: 4, closed: false, is_manager: true, me: 'owner-a', invitation: null, dialogue_enabled: false,
  members: [{ id: 'owner-a', name: '甲', manager: true }, { id: 'owner-b', name: '乙', manager: false }],
  companions: [{ id: 1, name: '甲的伙伴', owner_id: 'owner-a', activity: 'observe', area: 'outdoor', x: .3, y: .5, avatar3d: avatar, leisure: null as null | { activity: string; seat_id: string; station_version: number } },
    { id: 2, name: '乙的伙伴', owner_id: 'owner-b', activity: 'observe', area: 'outdoor', x: .6, y: .5, avatar3d: { ...avatar, seed: 2 }, leisure: null as null | { activity: string; seat_id: string; station_version: number } }],
  items: [], votes: [], events: [], story_enabled: false, stories: [], goal: null, season: { current_season: null } }; }
type HttpCall = { path: string; method: string; body: Record<string, unknown> | null };
let saved: ReturnType<typeof initial>, calls: HttpCall[], failPost: boolean, lostAfterCommit: boolean, failPersonalAfterPost: boolean;
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  saved = initial(); calls = []; failPost = false; lostAfterCommit = false; failPersonalAfterPost = false; engine.instances = []; engine.session = 'isolated-gathering-session';
  history.replaceState(null, '', '/gatherings?space=real-shared-home'); setToken('isolated-gathering-session');
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input), path = raw.slice(raw.indexOf('/api/v1/') + '/api/v1'.length), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ path, method, body });
    if (method === 'GET' && path.startsWith('/living/floors/shared/')) return response({revision:0,seq:0,applied:0,commands:[],checkpoint:{version:1,active:null,states:[]},fingerprint:'isolated',driver:false,lease_until:0,server_time:1});
    if (method === 'GET' && path === '/gatherings') return response([]);
    if (method === 'GET' && path === '/characters') return response([{ id: 1, name: '甲的伙伴', persona: '', opening_line: '', image_path: null, status: 'ready', created_at: '' }]);
    if (method === 'GET' && path === '/gatherings/personal') { if (failPersonalAfterPost && calls.some(c => c.method === 'POST')) throw new Error('isolated inventory outage'); return response({ inventory: [], notifications: [], memories: [] }); }
    if (method === 'GET' && path === '/gatherings/real-shared-home') return response(saved);
    if (method === 'GET' && path === '/gatherings/real-shared-home/mahjong') {
      const snapshot = sharedMahjongFixture(); snapshot.gathering_id = 'real-shared-home'; snapshot.game!.gathering_id = 'real-shared-home'; snapshot.game!.can_advance = false; return response(snapshot);
    }
    if (method === 'POST' && path === '/gatherings/real-shared-home/commands') {
      if (failPost) throw new Error('isolated save failure');
      const command = body.command; saved = { ...saved, revision: saved.revision + 1, companions: saved.companions.map(c => c.id === (command.character_id ?? command.character_ids?.[0]) ? {
        ...c, ...(command.action === 'leisure' ? { leisure: command.activity === null ? null : { activity: command.activity, seat_id: command.seat_id ?? 'tea-1', station_version: 1 } } : { activity: command.activity, area: command.activity === 'sleep' ? 'bedroom' : command.activity === 'rest' ? 'indoor' : 'outdoor', leisure: null }),
      } : c) };
      if (lostAfterCommit) throw new Error('isolated acknowledgement lost'); return response(saved);
    }
    throw new Error('Unexpected network route in isolated gathering test');
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const latest = () => engine.instances.at(-1)!;
const posts = () => calls.filter(call => call.method === 'POST');
async function mount() { render(<Gatherings />); await screen.findByTestId('living3d-canvas'); await act(async () => {}); }
function ownMenu() { fireEvent.click(screen.getByRole('button', { name: '查看甲的伙伴的生活近况' })); }

it('defaults the real shared ID to persistent mode with the server owner and does not call AI', async () => {
  await mount(); expect(latest().group.id).toBe('real-shared-home'); expect(latest().group.me).toBe('owner-a'); expect(latest().options.persistentWorld).toBe(true);
  expect(screen.getByRole('region', { name: '共同生活场景' })).toHaveAttribute('data-world-mode', 'saved');
  expect(screen.getByTestId('living3d-canvas').parentElement).toHaveAttribute('data-visual-style', 'realistic'); expect(posts()).toHaveLength(0);
  expect(calls.every(call => call.path.startsWith('/gatherings') || call.path === '/characters' || (call.method === 'GET' && call.path.startsWith('/living/floors/shared/')))).toBe(true);
});
it('saves one leisure command with station version and shows only the returned overlay', async () => {
  await mount(); ownMenu(); fireEvent.click(screen.getByRole('button', { name: '安排喝茶' }));
  await waitFor(() => expect(latest().group.companions[0].leisure?.activity).toBe('tea'));
  expect(posts()).toHaveLength(1); expect(posts()[0].body).toMatchObject({ expected_revision: 4, command: { action: 'leisure', character_id: 1, activity: 'tea', seat_id: 'tea-1', station_version: 1 } });
  expect(latest().group.companions[1].leisure).toBeUndefined();
});
it('blocks another owners activity and leisure through both rendered UI and callback boundary', async () => {
  await mount(); fireEvent.click(screen.getByRole('button', { name: '查看乙的伙伴的生活近况' }));
  expect(screen.getByText('这是朋友的伙伴，活动由它的主人安排。')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '安排喝茶' })).toBeNull();
  await act(async () => { latest().request({ actorId: 2, activity: 'tea', seatId: 'tea-1' }); }); expect(posts()).toHaveLength(0);
});
it('keeps the previous pose on failed POST, reads back and never automatically resends', async () => {
  failPost = true; await mount(); ownMenu(); fireEvent.click(screen.getByRole('button', { name: '安排喝茶' }));
  await screen.findAllByText('isolated save failure');
  expect(posts()).toHaveLength(1); expect(latest().group.companions[0].leisure).toBeUndefined();
  expect(calls.filter(c => c.path === '/gatherings/real-shared-home' && c.method === 'GET').length).toBeGreaterThan(1);
  expect(screen.queryByText(/活动已保存/)).toBeNull(); await act(async () => {}); expect(posts()).toHaveLength(1);
});
it('restores a committed unknown result from GET without another POST', async () => {
  lostAfterCommit = true; await mount(); ownMenu(); fireEvent.click(screen.getByRole('button', { name: '安排喝茶' }));
  await waitFor(() => expect(latest().group.companions[0].leisure?.activity).toBe('tea')); expect(posts()).toHaveLength(1);
  expect(calls.filter(c => c.path === '/gatherings/real-shared-home' && c.method === 'GET').length).toBeGreaterThan(1);
});
it('keeps a saved activity if the subsequent personal inventory GET fails', async () => {
  failPersonalAfterPost = true; await mount(); ownMenu(); fireEvent.click(screen.getByRole('button', { name: '安排睡觉' }));
  await screen.findByText('活动已保存，库存信息稍后刷新。'); expect(latest().group.companions[0].activity).toBe('sleep'); expect(posts()).toHaveLength(1);
  expect(posts()[0].body).toMatchObject({ command: { action: 'activity', character_ids: [1], activity: 'sleep' } });
  expect(screen.queryByText('活动保存尚未确认，请核对页面提示和最新近况。')).toBeNull();
  expect(calls.every(call => call.path.startsWith('/gatherings') || call.path === '/characters' || (call.method === 'GET' && call.path.startsWith('/living/floors/shared/')))).toBe(true);
});
it('reads the shared game only with server capability and sends no own hand into the canvas', async () => {
  Object.assign(saved, { mahjong_available: true }); await mount();
  await waitFor(() => expect(latest().sharedMahjong?.game?.revision).toBe(1));
  expect(latest().sharedMahjong?.game).not.toHaveProperty('own_hands'); expect(latest().sharedMahjong?.gathering_id).toBe('real-shared-home');
  expect(screen.getByRole('region', { name: '共同麻将桌' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: '查看我的手牌' })).toBeInTheDocument();
  expect(posts()).toHaveLength(0); expect(calls.some(c => c.path.endsWith('/mahjong'))).toBe(true);
});

for (const scene of ['home','forest','desert']) it(scene+' keeps its real 3D environment when no companion is present',async()=>{
 saved.scene_type=scene;saved.companions=[];await mount();expect(latest().group.scene_type).toBe(scene);expect(latest().group.companions).toHaveLength(0);expect(latest().options.persistentWorld).toBe(true);expect(screen.getByTestId('living3d-canvas').parentElement).toHaveAttribute('data-visual-style','realistic');expect(posts()).toHaveLength(0);
});


const floor = (id: number, phase = 'upper', activity: GatheringFloorPresence['activity'] = 'sleep'): GatheringFloorPresence => ({ id, phase, floor: phase === 'upper' ? 2 : 1, activity });
async function showFloor(states: GatheringFloorPresence[]) { await act(async () => { latest().options.onFloorLifeChange?.(states); }); }
const detail = (name: string) => screen.getByRole('region', { name: name+'的生活近况' });

it('uses the live upstairs state in the older friend detail as well as the 3D card without saving it', async () => {
  saved.companions[1].activity = 'talk'; const before = JSON.stringify(saved); await mount(); const instance = latest();
  await showFloor([floor(2)]); fireEvent.click(screen.getByRole('button', { name: '查看乙的伙伴的生活近况' }));
  expect(within(detail('乙的伙伴')).getByRole('heading')).toHaveTextContent('睡觉');
  expect(detail('乙的伙伴')).toHaveTextContent('二楼'); expect(detail('乙的伙伴')).not.toHaveTextContent('院子');
  expect(screen.getByRole('button', { name: '查看乙的伙伴的生活近况' })).toHaveTextContent('二楼');
  expect(screen.getByText('这是朋友的伙伴，活动由它的主人安排。')).toBeInTheDocument();
  expect(within(detail('乙的伙伴')).queryByRole('button', { name: '选中安排活动' })).toBeNull();
  expect(latest()).toBe(instance); expect(engine.instances).toHaveLength(1); expect(JSON.stringify(saved)).toBe(before); expect(posts()).toHaveLength(0);
});

it('uses upstairs status in the owned management row without turning a display event into a command', async () => {
  const before = JSON.stringify(saved); await mount(); await showFloor([floor(1,'upper','rest')]); ownMenu();
  expect(within(detail('甲的伙伴')).getByRole('heading')).toHaveTextContent('休息'); expect(detail('甲的伙伴')).toHaveTextContent('二楼');
  fireEvent.click(screen.getByText('伙伴管理与更多活动'));
  const row = screen.getByRole('checkbox', { name: '参与活动' }).closest('label')!;
  expect(row).toHaveTextContent('休息'); expect(row).toHaveTextContent('二楼'); expect(row).not.toHaveTextContent('院子');
  expect(JSON.stringify(saved)).toBe(before); expect(posts()).toHaveLength(0);
});

it('locates an upstairs friend and then a downstairs companion through camera controls only', async () => {
  const before = JSON.stringify(saved); await mount(); const instance = latest(); await showFloor([floor(2)]); instance.doors.mockClear();
  fireEvent.click(screen.getByRole('button', { name: '查看乙的伙伴的生活近况' }));
  await waitFor(() => expect(instance.upper).toHaveBeenLastCalledWith(true)); expect(instance.house).toHaveBeenLastCalledWith('interior');
  ownMenu(); await waitFor(() => expect(instance.upper).toHaveBeenLastCalledWith(false));
  expect(instance.doors).not.toHaveBeenCalled(); expect(engine.instances).toHaveLength(1); expect(JSON.stringify(saved)).toBe(before); expect(posts()).toHaveLength(0);
});

for (const states of [[], [floor(2,'returned')]]) it('removes the old upstairs detail when the floor state is '+(states.length ? 'returned' : 'removed'), async () => {
  saved.companions[1].activity='talk'; await mount(); await showFloor([floor(2)]); fireEvent.click(screen.getByRole('button', { name: '查看乙的伙伴的生活近况' }));
  expect(detail('乙的伙伴')).toHaveTextContent('二楼'); await showFloor(states);
  expect(within(detail('乙的伙伴')).getByRole('heading')).toHaveTextContent('相聚'); expect(detail('乙的伙伴')).toHaveTextContent('院子'); expect(detail('乙的伙伴')).not.toHaveTextContent('二楼'); expect(posts()).toHaveLength(0);
});

it('keeps current upstairs display across an unrelated saved revision refresh', async () => {
  await mount(); const instance=latest(); await showFloor([floor(2)]); fireEvent.click(screen.getByRole('button', { name: '查看乙的伙伴的生活近况' }));
  saved={...saved,revision:saved.revision+1}; fireEvent.click(screen.getByRole('button', { name: '刷新近况' }));
  await waitFor(()=>expect(latest().group.revision).toBe(5));
  expect(detail('乙的伙伴')).toHaveTextContent('二楼'); expect(within(detail('乙的伙伴')).getByRole('heading')).toHaveTextContent('睡觉'); expect(latest()).toBe(instance); expect(posts()).toHaveLength(0);
});

it('does not let a disposed previous account publish upstairs presence into the next account', async () => {
  const view=render(<Gatherings />); await screen.findByTestId('living3d-canvas'); await act(async()=>{}); const old=latest();
  await showFloor([floor(2)]); fireEvent.click(screen.getByRole('button', { name: '查看乙的伙伴的生活近况' })); expect(detail('乙的伙伴')).toHaveTextContent('二楼');
  saved={...saved,me:'owner-b'}; engine.session='next-isolated-session'; setToken(engine.session); view.rerender(<Gatherings />);
  await waitFor(()=>expect(latest()).not.toBe(old)); expect(old.dispose).toHaveBeenCalledOnce();
  await act(async()=>{old.options.onFloorLifeChange?.([floor(2)]);}); fireEvent.click(screen.getByRole('button', { name: '查看乙的伙伴的生活近况' }));
  expect(detail('乙的伙伴')).not.toHaveTextContent('二楼'); expect(detail('乙的伙伴')).toHaveTextContent('院子'); expect(posts()).toHaveLength(0);
});
