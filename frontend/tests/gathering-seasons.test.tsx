import React from 'react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import GatheringWorld from '@/components/gathering-world';
import Gatherings from '@/components/gatherings';
import { gatherings, parseGathering, type Gathering } from '@/lib/gatherings';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { TOKEN_KEY } from '@/lib/auth';

vi.mock('@/components/private-image', () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/team-shared', () => ({ useTeamSession: () => 'synthetic-session' }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { characters: vi.fn() } }));
vi.mock('@/lib/gatherings', async original => ({ ...await original<typeof import('@/lib/gatherings')>(), gatherings: { list: vi.fn(), personal: vi.fn(), read: vi.fn(), command: vi.fn() } }));

function snapshot(scene = 'home', season: string | null = 'autumn'): Gathering {
  return parseGathering({ id: 'shared-scene', title: '一起看四季', scene_type: scene, revision: 4, closed: false, is_manager: true, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '我', manager: true }, { id: 'other', name: '朋友', manager: false }, { id: 'third', name: '第三位', manager: false }],
    companions: [{ id: 1, name: '小叶', owner_id: 'owner', activity: 'rest', x: .3, y: .5 }],
    items: [{ id: 'tree', kind: 'tree', x: .4, y: .5, mine: true, contributor_name: '我', growth_status: 'growing' }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: season } });
}
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); } });
  vi.clearAllMocks(); history.replaceState(null, '', '/gatherings?space=shared-scene');
  localStorage.setItem(TOKEN_KEY, 'synthetic-session');
  vi.mocked(gatherings.list).mockResolvedValue([]); vi.mocked(api.characters).mockResolvedValue([]);
  vi.mocked(gatherings.personal).mockResolvedValue({ inventory: [], notifications: [], memories: [] });
});
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

it.each(['home', 'forest', 'desert'].flatMap(scene => ['spring', 'summer', 'autumn', 'winter'].map(season => [scene, season])))('uses the saved %s %s artwork and retains positions', (scene, season) => {
  const g = snapshot(scene, season), original = JSON.stringify(g);
  const { container } = render(<GatheringWorld gathering={g} focusedId={null} onSelect={vi.fn()} />);
  expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season', season);
  expect(container.querySelector('img')).toHaveAttribute('src', new URL(scene === 'desert' ? `/oasis/terrain-${season}-v2.png` : `/seasons/${scene}-four-seasons-v1.png`, window.location.href).href);
  expect(container.querySelector('.hub-world-item')).toHaveStyle({ left: '42%', top: '47.5%' });
  expect(JSON.stringify(g)).toBe(original);
  expect(gatherings.command).not.toHaveBeenCalled();
});

it.each([['home', null], ['forest', 'unexpected'], ['unknown', 'winter']])('retains a base background for %s / %s without loading an arbitrary image', (scene, season) => {
  const { container } = render(<GatheringWorld gathering={snapshot(scene!, season)} focusedId={null} onSelect={vi.fn()} />);
  expect(container.querySelector('img')).toBeNull();
});

it.each(['home', 'forest', 'desert'])('keeps the %s companion usable after image failure and retry', scene => {
  const select = vi.fn(); const { container } = render(<GatheringWorld gathering={snapshot(scene)} focusedId={null} onSelect={select} />);
  fireEvent.error(container.querySelector('img')!);
  expect(screen.getByRole('status')).toHaveTextContent('先保留基础景色');
  fireEvent.click(screen.getByRole('button', { name: '重试季节画面' }));
  expect(select).not.toHaveBeenCalled();
  expect(container.querySelector('img')?.getAttribute('src')).toContain('?retry=1');
  fireEvent.click(screen.getByRole('button', { name: '查看小叶的生活近况' }));
  expect(select).toHaveBeenCalledWith(1); expect(gatherings.command).not.toHaveBeenCalled();
});

it('changes the artwork only when an approved server snapshot arrives', async () => {
  const original = snapshot(), pending = { ...original, revision: 5, votes: [{ id: 'vote', kind: 'season', status: 'pending', deadline: 1800000000, electorate: ['owner', 'other', 'third'], choices: { owner: true } }] };
  vi.mocked(gatherings.read).mockResolvedValueOnce(original).mockResolvedValueOnce({ ...pending, season: 'winter', revision: 6, votes: [{ ...pending.votes[0], status: 'passed', choices: { owner: true, other: true } }] });
  vi.mocked(gatherings.command).mockResolvedValueOnce(pending);
  render(<Gatherings />); await screen.findByLabelText('共同生活场景');
  fireEvent.click(screen.getByRole('button', { name: '提议调整四季' }));
  fireEvent.change(screen.getByLabelText('四季方式'), { target: { value: 'virtual' } });
  fireEvent.change(screen.getByLabelText('从哪个季节开始'), { target: { value: 'winter' } });
  expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season', 'autumn');
  fireEvent.click(screen.getByRole('button', { name: '提交提议并投同意票' }));
  await screen.findByText(/1 票同意 \/ 需要 2 票/);
  expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season', 'autumn');
  fireEvent.click(screen.getByRole('button', { name: '刷新近况' }));
  await screen.findByText('已通过', { exact: false });
  expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season', 'winter');
  expect(gatherings.command).toHaveBeenCalledTimes(1);
  expect(gatherings.command).toHaveBeenCalledWith(original, { action: 'propose_season', settings: { mode: 'virtual', weeks: 1, start_season: 'winter' } }, expect.any(String));
  expect(original.items[0].growth_status).toBe('growing');
});

it('keeps the original season after a failed write and recovers from a read without replaying', async () => {
  vi.mocked(gatherings.read).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot('home', 'winter'));
  vi.mocked(gatherings.command).mockRejectedValueOnce(new Error('连接断开'));
  render(<Gatherings />); await screen.findByLabelText('共同生活场景');
  fireEvent.click(screen.getByRole('button', { name: '提议调整四季' }));
  fireEvent.change(screen.getByLabelText('四季方式'), { target: { value: 'virtual' } });
  fireEvent.click(screen.getByRole('button', { name: '提交提议并投同意票' }));
  await screen.findByText('连接断开');
  expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season', 'autumn');
  fireEvent.click(screen.getByRole('button', { name: /重新加载/ }));
  await screen.findByText('家庭庭院 · 冬天');
  expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season', 'winter');
  expect(gatherings.command).toHaveBeenCalledTimes(1);
});

async function renderSynced() {
  localStorage.setItem(TOKEN_KEY, 'synthetic-session'); vi.useFakeTimers();
  await act(async () => { render(<Gatherings />); });
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it('accepts equal-revision clock changes, rejects an older revision, and retains participant selection', async () => {
  const original = snapshot();
  vi.mocked(gatherings.read).mockResolvedValueOnce(original)
    .mockResolvedValueOnce({ ...snapshot('home', 'winter'), revision: 3 })
    .mockResolvedValueOnce(snapshot('home', 'spring'));
  await renderSynced(); fireEvent.click(screen.getByRole('checkbox', { name: '参与活动' }));
  await advance(15000); expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season', 'autumn');
  await advance(15000); expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season', 'spring');
  expect(screen.getByRole('checkbox', { name: '参与活动' })).toBeChecked();
  expect(gatherings.command).not.toHaveBeenCalled();
});
it('preserves the season draft while the modal is open and reads immediately after closing', async () => {
  vi.mocked(gatherings.read).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot('home', 'winter'));
  await renderSynced(); fireEvent.click(screen.getByRole('button', { name: '提议调整四季' }));
  fireEvent.change(screen.getByLabelText('四季方式'), { target: { value: 'virtual' } });
  fireEvent.change(screen.getByLabelText('从哪个季节开始'), { target: { value: 'summer' } });
  await advance(60000); expect(gatherings.read).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('从哪个季节开始')).toHaveValue('summer');
  fireEvent.click(screen.getByRole('button', { name: '关闭' })); await advance(0);
  expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season', 'winter');
  expect(gatherings.command).not.toHaveBeenCalled();
});
it('removes inaccessible content and reloads the list after membership is revoked', async () => {
  vi.mocked(gatherings.read).mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new ApiError('unavailable', 403, 'forbidden'));
  await renderSynced(); await advance(15000);
  expect(screen.queryByLabelText('共同生活场景')).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent('这个共同住处暂时无法访问');
  expect(location.search).toBe(''); expect(gatherings.list).toHaveBeenCalledTimes(2);
  await advance(60000); expect(gatherings.read).toHaveBeenCalledTimes(2);
});
it('prunes a recalled participant without clearing the remaining selection', async () => {
  const original = snapshot(); original.companions.push({ ...original.companions[0], id: 2, name: '小花' });
  vi.mocked(gatherings.read).mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, revision: 5, companions: [original.companions[1]] });
  await renderSynced(); screen.getAllByRole('checkbox', { name: '参与活动' }).forEach(c => fireEvent.click(c));
  fireEvent.click(screen.getByRole('button', { name: '查看小叶的生活近况' }));
  await advance(15000); expect(screen.queryByLabelText('小叶的生活近况')).toBeNull();
  expect(screen.getByRole('checkbox', { name: '参与活动' })).toBeChecked();
  expect(screen.getByRole('button', { name: '休息' })).toBeEnabled();
});
