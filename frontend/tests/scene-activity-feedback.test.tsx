import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LivingScene from '@/components/living-scene';
import SceneActivityFeedback from '@/components/scene-activity-feedback';
import { api, ApiError } from '@/lib/api';
import { AUTH_CHANGED, TOKEN_KEY } from '@/lib/auth';
import { runtimeApi, type RuntimeSnapshot, type RuntimeTask } from '@/lib/life-runtime';
import type { Character, LivingSpace } from '@/lib/contracts';

vi.mock('@/components/private-image', () => ({ default: () => <span>伙伴头像</span> }));
vi.mock('@/components/season-settings', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/life-journal', () => ({ default: () => null }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
vi.mock('@/lib/life-runtime', async original => ({ ...await original<typeof import('@/lib/life-runtime')>(), runtimeApi: { read: vi.fn(), save: vi.fn(), schedule: vi.fn(), run: vi.fn() } }));

const sid = '11111111-1111-4111-8111-111111111111';
const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const space: LivingSpace = { id: sid, scene_type: 'home', mode: 'private', companion_id: '1', revision: 1, observed_at: 100, can_undo: false, items: [{ id: targetId, kind: 'tree', x: 0.3, y: 0.4, stored: false, growth_seconds: 0, stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' }] };
const person: Character = { id: 1, name: '苹果', persona: '', opening_line: '', image_path: null, status: 'ready', created_at: '' };
const task: RuntimeTask = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'done', created_at: 100, retry_at: 0, activity: 'observe', target_id: targetId, error_code: null, dispatch_requested: true };
const snapshot: RuntimeSnapshot = { origin: 'offline_fixture', space_id: sid, companion_id: '1', present: true, observed_at: 200, next_allowed_at: 700, permission: { enabled: true, activities: ['observe'], revision: 1 }, tasks: [task] };
const locate = vi.fn();
const props = { space, companions: [person], onLocate: locate };
const feedback = () => within(screen.getByRole('complementary', { name: '伙伴的最近活动' }));
const refresh = () => fireEvent.click(within(screen.getByRole('region', { name: '自主生活离线体验' })).getByRole('button', { name: '刷新状态' }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW', 'true');
  vi.mocked(runtimeApi.read).mockResolvedValue(snapshot);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); localStorage.clear(); });

it.each(['home', 'forest', 'desert'] as const)('links %s observation to the original item with focus and no writes', async scene_type => {
  const change = vi.fn();
  render(<LivingScene space={{ ...space, scene_type }} companion={person} onChange={change} />);
  await screen.findByText('看了看小树');
  expect(feedback().getByText('离线样例')).toBeInTheDocument();
  fireEvent.click(feedback().getByRole('button', { name: '看看它观察的物件' }));
  const target = document.querySelector(`[data-living-item-id="${targetId}"]`);
  expect(target).toHaveFocus(); expect(target).toHaveAttribute('aria-pressed', 'true');
  expect(runtimeApi.read).toHaveBeenCalledTimes(1);
  expect(api.living.action).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  expect(runtimeApi.run).not.toHaveBeenCalled(); expect(runtimeApi.schedule).not.toHaveBeenCalled();
});

it('does not redirect a stored observation to another item of the same kind', () => {
  render(<SceneActivityFeedback {...props} space={{ ...space, items: [{ ...space.items[0], stored: true }, { ...space.items[0], id: 'another-tree' }] }} view={{ snapshot, stale: false }} />);
  expect(feedback().getByText('原来观察的物件已收纳或移走。')).toBeInTheDocument();
  expect(feedback().queryByRole('button', { name: '看看它观察的物件' })).toBeNull(); expect(locate).not.toHaveBeenCalled();
});

it.each([
  { ...snapshot, space_id: 'another' }, { ...snapshot, companion_id: '2' }, { ...snapshot, present: false },
])('rejects feedback outside the current private companion scope', value => {
  render(<SceneActivityFeedback {...props} view={{ snapshot: value, stale: false }} />);
  expect(screen.queryByRole('complementary')).toBeNull();
});

it('hides absent, readonly, shared and hidden-tab feedback without opening private runtime reads', async () => {
  const change = vi.fn();
  const view = render(<LivingScene space={space} companion={person} readOnly onChange={change} />);
  expect(runtimeApi.read).not.toHaveBeenCalled();
  view.rerender(<LivingScene space={{ ...space, mode: 'shared' }} companion={person} onChange={change} />);
  expect(runtimeApi.read).not.toHaveBeenCalled();
  view.rerender(<LivingScene space={space} companion={person} onChange={change} />);
  await screen.findByText('看了看小树');
  view.rerender(<LivingScene space={space} companions={[]} onChange={change} />);
  expect(screen.queryByRole('complementary')).toBeNull();
  view.rerender(<LivingScene space={space} companion={person} visible={false} onChange={change} />);
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(vi.mocked(runtimeApi.read).mock.calls[0][1]?.aborted).toBe(true);
  view.rerender(<LivingScene space={space} companion={person} onChange={change} />);
  await screen.findByText('看了看小树'); expect(runtimeApi.read).toHaveBeenCalledTimes(2);
});

it('waits for a persisted completion, updates the scene automatically and retains an activity draft', async () => {
  vi.useFakeTimers();
  const accepted: RuntimeSnapshot = { ...snapshot, tasks: [{ ...task, state: 'queued', activity: null, target_id: null }] };
  vi.mocked(runtimeApi.read).mockResolvedValueOnce(accepted).mockResolvedValue(snapshot);
  await act(async () => { render(<LivingScene space={space} companion={person} onChange={vi.fn()} />); });
  expect(feedback().getByText('这轮活动正在等候处理')).toBeInTheDocument();
  expect(feedback().queryByText('看了看小树')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: '休息' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(feedback().getByText('看了看小树')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '休息' })).toBeChecked();
  expect(runtimeApi.run).not.toHaveBeenCalled(); expect(api.living.action).not.toHaveBeenCalled();
});

it('preserves an old record as stale on network failure and clears it after access is lost', async () => {
  render(<LivingScene space={space} companion={person} onChange={vi.fn()} />);
  await screen.findByText('看了看小树');
  vi.mocked(runtimeApi.read).mockRejectedValueOnce(new Error('offline'));
  refresh(); await screen.findByText(/暂时连不上，这是上次读取/);
  expect(feedback().getByRole('button', { name: '看看它观察的物件' })).toBeDisabled();
  vi.mocked(runtimeApi.read).mockRejectedValueOnce(new ApiError('no access', 403, 'forbidden'));
  refresh(); await screen.findByText('活动状态暂时无法核对，请在自主生活里刷新。');
  expect(screen.queryByText('看了看小树')).toBeNull();
});

it('clears existing feedback when an account changes and ignores late reads', async () => {
  localStorage.setItem(TOKEN_KEY, 'first');
  render(<LivingScene space={space} companion={person} onChange={vi.fn()} />); await screen.findByText('看了看小树');
  let resolve!: (value: RuntimeSnapshot) => void;
  vi.mocked(runtimeApi.read).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  refresh();
  await act(async () => { localStorage.setItem(TOKEN_KEY, 'second'); window.dispatchEvent(new Event(AUTH_CHANGED)); resolve(snapshot); });
  expect(screen.queryByText('看了看小树')).toBeNull();
  expect(vi.mocked(runtimeApi.read).mock.calls[1][1]?.aborted).toBe(true);
});

it('keeps historical success after pause but never portrays cancelled or failed tasks as completed', () => {
  const view = render(<SceneActivityFeedback {...props} view={{ snapshot: { ...snapshot, permission: { ...snapshot.permission, enabled: false } }, stale: false }} />);
  expect(feedback().getByText('看了看小树')).toBeInTheDocument(); expect(feedback().getByText(/自主生活已暂停/)).toBeInTheDocument();
  for (const state of ['cancelled', 'failed'] as const) {
    view.rerender(<SceneActivityFeedback {...props} view={{ snapshot: { ...snapshot, tasks: [{ ...task, state, activity: null, target_id: null, error_code: 'conflict' }] }, stale: false }} />);
    expect(feedback().queryByText('看了看小树')).toBeNull(); expect(feedback().queryByRole('button', { name: '看看它观察的物件' })).toBeNull();
  }
});

it('marks actual AI records distinctly and uses scheduling time rather than inventing completion time', () => {
  render(<SceneActivityFeedback {...props} view={{ snapshot: { ...snapshot, origin: 'real_provider', tasks: [{ ...task, activity: 'rest', target_id: null }] }, stale: false }} />);
  expect(feedback().getByText('AI活动记录')).toBeInTheDocument();
  expect(feedback().getByText('歇了一会儿')).toBeInTheDocument();
  expect(feedback().getByText(/本轮安排于/)).toBeInTheDocument(); expect(feedback().queryByText('离线样例')).toBeNull();
});

it('disables object location during an oasis layout preview and restores it on cancel', async () => {
  render(<LivingScene space={{ ...space, scene_type: 'desert' }} companion={person} onChange={vi.fn()} />);
  await screen.findByText('看了看小树'); fireEvent.click(screen.getByRole('button', { name: '布置场景' })); fireEvent.click(screen.getByRole('button', { name: '预览水边小憩' }));
  expect(feedback().getByRole('button', { name: '看看它观察的物件' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '取消预览' })); expect(feedback().getByRole('button', { name: '看看它观察的物件' })).toBeEnabled();
  expect(api.living.action).not.toHaveBeenCalled();
});
