import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Activities from '@/components/activities';
import Gatherings from '@/components/gatherings';
import { activities, parseMatch } from '@/lib/activities';
import { gatherings, parseGathering } from '@/lib/gatherings';
import { api } from '@/lib/api';
import { TOKEN_KEY } from '@/lib/auth';
import type { Character } from '@/lib/contracts';

vi.mock('@/components/team-shared', () => ({ useTeamSession: () => 'flow-session' }));
vi.mock('@/components/gathering-world', () => ({ default: () => null }));
vi.mock('@/components/gathering-dialogue', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { characters: vi.fn(), living: { spaces: vi.fn() } } }));
vi.mock('@/lib/activities', async original => ({ ...await original<typeof import('@/lib/activities')>(), activities: { list: vi.fn(), inventory: vi.fn(), read: vi.fn(), preview: vi.fn(), create: vi.fn(), command: vi.fn(), join: vi.fn(), exchange: vi.fn(), place: vi.fn() } }));
vi.mock('@/lib/gatherings', async original => ({ ...await original<typeof import('@/lib/gatherings')>(), gatherings: { list: vi.fn(), personal: vi.fn(), read: vi.fn(), preview: vi.fn(), create: vi.fn(), command: vi.fn(), join: vi.fn() } }));

const match = parseMatch({ id: 'match-one', kind: 'observe', status: 'registration', me: 'owner', is_organizer: true, invitation: null, phase_end: null, end_at: null, observed_at: 100, participants: {}, votes: {}, events: [], rewards: {} });
const space = parseGathering({ id: 'space-one', title: '伙伴花园', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'owner', invitation: null, members: [{ id: 'owner', name: '我', manager: true }], companions: [], items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: null } });
const wallet = { balance: 20, shop: { colorful_pot: 20 }, decorations: [] };

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); localStorage.setItem(TOKEN_KEY, 'flow-session');
  history.replaceState(null, '', '/activities');
  vi.mocked(api.characters).mockResolvedValue([{ id: 4, name: '小苹果', status: 'ready' } as Character]);
  vi.mocked(api.living.spaces).mockResolvedValue([{ id: 'home-one', scene_type: 'home' }] as Awaited<ReturnType<typeof api.living.spaces>>);
  vi.mocked(activities.list).mockResolvedValue([{ id: match.id, kind: match.kind, status: match.status }]);
  vi.mocked(activities.inventory).mockResolvedValue(wallet);
  vi.mocked(activities.read).mockResolvedValue(match);
  vi.mocked(activities.preview).mockResolvedValue({ id: match.id, kind: match.kind, duration: 180, participants: 2 });
  vi.mocked(gatherings.list).mockResolvedValue([{ id: space.id, title: space.title, scene_type: 'home', member_count: 1 }] as Awaited<ReturnType<typeof gatherings.list>>);
  vi.mocked(gatherings.personal).mockResolvedValue({ inventory: [{ id: 'saved-tree', kind: 'tree' }], memories: [], notifications: [] });
  vi.mocked(gatherings.read).mockResolvedValue(space);
  vi.mocked(gatherings.preview).mockResolvedValue({ id: space.id, title: '邀请的花园', scene_type: 'home', member_count: 1, season: '尚未选择四季' } as Awaited<ReturnType<typeof gatherings.preview>>);
});

function noWrites() {
  for (const call of [activities.create, activities.command, activities.join, activities.exchange, activities.place, gatherings.create, gatherings.command, gatherings.join]) expect(call).not.toHaveBeenCalled();
}
async function retry() {
  await screen.findByText('网络暂时中断');
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
}

it('restores all activity dependencies after one initial read failed, so registration and placement remain usable', async () => {
  vi.mocked(api.living.spaces).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Activities />); await retry();
  expect(await screen.findByRole('option', { name: '家庭庭院 · 我的住处' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: '伙伴花园' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /查看比赛与回忆/ }));
  expect(await screen.findByRole('button', { name: '报名 小苹果' })).toBeEnabled();
  expect(api.characters).toHaveBeenCalledTimes(2); expect(api.living.spaces).toHaveBeenCalledTimes(2);
  noWrites();
});

it('retries the match in a failed deep link and refreshes the wallet after reading its result', async () => {
  history.replaceState(null, '', '/activities?match=match-one');
  vi.mocked(activities.read).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Activities />); await retry();
  expect(await screen.findByRole('button', { name: '报名 小苹果' })).toBeEnabled();
  await waitFor(() => expect(activities.inventory).toHaveBeenCalledTimes(1));
  expect(activities.read).toHaveBeenLastCalledWith('match-one');
  expect(vi.mocked(activities.inventory).mock.invocationCallOrder.at(-1)).toBeGreaterThan(vi.mocked(activities.read).mock.invocationCallOrder.at(-1)!);
  expect(location.search).toBe('?match=match-one'); noWrites();
});

it('retries an activity invitation preview without accepting or creating a match', async () => {
  history.replaceState(null, '', '/activities?invite=synthetic-invite');
  vi.mocked(activities.preview).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Activities />); await retry();
  expect(await screen.findByRole('button', { name: '接受邀请，再选择伙伴' })).toBeInTheDocument();
  expect(screen.getByLabelText('邀请链接或邀请码')).toHaveValue('synthetic-invite');
  expect(activities.preview).toHaveBeenLastCalledWith('synthetic-invite'); noWrites();
});

it('shows newly earned resources when opening a match whose first read settles the result', async () => {
  history.replaceState(null, '', '/activities?match=match-one');
  let settle!: () => void, balance = 0;
  vi.mocked(activities.inventory).mockImplementation(async () => ({ ...wallet, balance }));
  vi.mocked(activities.read).mockImplementationOnce(() => new Promise(done => { settle = () => { balance = 20; done({ ...match, status: 'completed' }); }; }));
  render(<Activities />);
  await act(async () => settle());
  expect(await screen.findByRole('button', { name: '彩色花盆 · 20 点' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /彩色花盆.*资源不足/ })).not.toBeInTheDocument();
  noWrites();
});

it('refreshes participants and destinations even when match detail succeeded before the catalog failed', async () => {
  history.replaceState(null, '', '/activities?match=match-one');
  vi.mocked(api.characters).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Activities />); await retry();
  expect(await screen.findByRole('button', { name: '报名 小苹果' })).toBeEnabled();
  expect(screen.getByRole('option', { name: '伙伴花园' })).toBeInTheDocument(); noWrites();
});

it('ignores a late initial match after recovery has read a newer result', async () => {
  history.replaceState(null, '', '/activities?match=match-one');
  let resolve!: (value: typeof match) => void;
  vi.mocked(activities.read).mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue({ ...match, status: 'completed' });
  vi.mocked(api.characters).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Activities />); await retry();
  await screen.findByText('已完成', { selector: 'strong' });
  await act(async () => resolve(match));
  expect(screen.getByText('已完成', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '报名 小苹果' })).not.toBeInTheDocument(); noWrites();
});

it('restores a failed gathering deep link and its companion and inventory choices', async () => {
  history.replaceState(null, '', '/gatherings?space=space-one');
  vi.mocked(gatherings.read).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Gatherings />); await retry();
  expect(await screen.findByRole('heading', { name: '伙伴花园', level: 1 })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: '带 小苹果 来' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '放回树' })).toBeEnabled();
  expect(api.characters).toHaveBeenCalledTimes(2); noWrites();
});

it.each(['leave', 'account'])('does not let a late activity recovery rewrite navigation after %s', async kind => {
  history.replaceState(null, '', '/activities?match=match-one');
  let resolve!: (value: typeof match) => void;
  vi.mocked(activities.read).mockRejectedValueOnce(new Error('网络暂时中断')).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const view = render(<Activities />); await retry();
  await waitFor(() => expect(activities.read).toHaveBeenCalledTimes(2));
  if (kind === 'leave') view.unmount(); else localStorage.setItem(TOKEN_KEY, 'another-session');
  history.replaceState(null, '', '/discover');
  await act(async () => resolve(match));
  expect(location.pathname).toBe('/discover');
  expect(location.search).toBe(''); noWrites();
});

it('retries a gathering invitation without joining and keeps the original target', async () => {
  history.replaceState(null, '', '/gatherings?invite=synthetic-invite');
  vi.mocked(gatherings.preview).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Gatherings />); await retry();
  expect(await screen.findByRole('heading', { name: '邀请的花园' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '确认加入' })).toBeInTheDocument();
  expect(gatherings.preview).toHaveBeenLastCalledWith('synthetic-invite'); noWrites();
});

it('refreshes the gathering catalog after a successful detail read and a failed companion read', async () => {
  history.replaceState(null, '', '/gatherings?space=space-one');
  vi.mocked(api.characters).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Gatherings />); await screen.findByRole('heading', { name: '伙伴花园', level: 1 });
  await retry();
  expect(await screen.findByRole('button', { name: '带 小苹果 来' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '放回树' })).toBeEnabled(); noWrites();
});

it('ignores the late original gathering snapshot after a successful recovery', async () => {
  history.replaceState(null, '', '/gatherings?space=space-one');
  let resolve!: (value: typeof space) => void;
  vi.mocked(gatherings.read).mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue({ ...space, title: '恢复后的花园', revision: 2 });
  vi.mocked(api.characters).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Gatherings />); await retry();
  await screen.findByRole('heading', { name: '恢复后的花园', level: 1 });
  await act(async () => resolve(space));
  expect(screen.getByRole('heading', { name: '恢复后的花园', level: 1 })).toBeInTheDocument(); noWrites();
});

it.each(['activity', 'gathering'])('keeps recovered companion choices when an older %s catalog arrives late', async kind => {
  let resolve!: (value: Character[]) => void;
  vi.mocked(api.characters).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  if (kind === 'activity') {
    history.replaceState(null, '', '/activities?match=match-one');
    vi.mocked(activities.read).mockRejectedValueOnce(new Error('网络暂时中断'));
    render(<Activities />);
  } else {
    history.replaceState(null, '', '/gatherings?space=space-one');
    vi.mocked(gatherings.read).mockRejectedValueOnce(new Error('网络暂时中断'));
    render(<Gatherings />);
  }
  await retry();
  const name = kind === 'activity' ? '报名 小苹果' : '带 小苹果 来';
  await screen.findByRole('button', { name });
  await act(async () => resolve([]));
  expect(screen.getByRole('button', { name })).toBeEnabled(); noWrites();
});
