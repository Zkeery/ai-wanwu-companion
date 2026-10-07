import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SceneLifeNow from '@/components/scene-life-now';
import LivingScene from '@/components/living-scene';
import { parseRuntime, runtimeApi, type RuntimeSnapshot } from '@/lib/life-runtime';
import { AUTH_CHANGED, TOKEN_KEY } from '@/lib/auth';
import { api } from '@/lib/api';
import type { Character, LivingSpace } from '@/lib/contracts';
import { readChatDraft, writeChatDraft } from '@/lib/chat-draft';
import { activityChatDraft } from '@/lib/life-activity-draft';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/components/private-image', () => ({ default: ({ alt }: { alt: string }) => <span>{alt}</span> }));
vi.mock('@/components/private-motion-player', () => ({ default: ({ onSceneStill }: { onSceneStill?: (png: string) => void }) =>
  <span data-testid="scene-motion-frame" onClick={event => { event.stopPropagation(); onSceneStill?.('data:image/png;base64,c3RpbGw='); }}>记录场景首帧</span> }));
vi.mock('@/components/season-settings', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/life-journal', () => ({ default: () => null }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
vi.mock('@/lib/life-runtime', async original => ({ ...await original<typeof import('@/lib/life-runtime')>(), runtimeApi: { read: vi.fn(), save: vi.fn(), schedule: vi.fn(), run: vi.fn() } }));
const sid = '11111111-1111-4111-8111-111111111111', tid = '22222222-2222-4222-8222-222222222222', targetId = '33333333-3333-4333-8333-333333333333';
const person: Character = { id: 1, name: '小满', persona: '', opening_line: '', image_path: null, status: 'ready', created_at: '' };
const space: LivingSpace = { id: sid, scene_type: 'home', mode: 'private', companion_id: '1', revision: 1, observed_at: 100, can_undo: false, items: [{ id: targetId, kind: 'tree', x: .4, y: .5, stored: false, growth_seconds: 0, stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' }] };
const snapshot: RuntimeSnapshot = { origin: 'offline_fixture', space_id: sid, companion_id: '1', present: true, observed_at: 200, next_allowed_at: 700, permission: { enabled: true, activities: ['rest', 'walk', 'observe'], revision: 3 }, tasks: [{ id: tid, state: 'done', created_at: 100, retry_at: 0, activity: 'observe', target_id: targetId, error_code: null }], current_activity: { task_id: tid, activity: 'observe', target_id: targetId, started_at: 105, expires_at: 705, source: 'viewing' } };
const paused: RuntimeSnapshot = { ...snapshot, permission: { ...snapshot.permission, enabled: false, revision: 4 }, current_activity: null };
const callbacks = { onLocate: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn() };
const props = { view: { snapshot, stale: false }, space, companions: [person], editing: false, ...callbacks };
const layer = () => screen.getByLabelText('伙伴当前活动画面');
const open = () => fireEvent.click(screen.getByRole('button', { name: '此刻在做什么' }));
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW', 'true');
  writeChatDraft(1, '');
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(runtimeApi.read).mockResolvedValue(snapshot); vi.mocked(runtimeApi.save).mockResolvedValue(paused);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); writeChatDraft(1, ''); });

it.each(['home', 'forest', 'desert'] as const)('reads formal life in %s with preview disabled without starting work', async scene_type => {
  vi.stubEnv('NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW', 'false');
  vi.stubEnv('NEXT_PUBLIC_LIFE_RUNTIME_ENABLED', 'true');
  vi.mocked(runtimeApi.read).mockResolvedValue({ ...snapshot, origin: 'real_provider' });
  render(<LivingScene space={{ ...space, scene_type }} companion={person} onChange={vi.fn()} />);
  await screen.findByRole('button', { name: '看看小满此刻在做什么' });
  expect(runtimeApi.read).toHaveBeenCalled();
  expect(runtimeApi.save).not.toHaveBeenCalled();
  expect(runtimeApi.schedule).not.toHaveBeenCalled();
  expect(runtimeApi.run).not.toHaveBeenCalled();
});

it.each(['home', 'forest', 'desert'] as const)('keeps formal life private and inactive in hidden or read-only %s', scene_type => {
  vi.stubEnv('NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW', 'false');
  vi.stubEnv('NEXT_PUBLIC_LIFE_RUNTIME_ENABLED', 'true');
  const view = render(<LivingScene space={{ ...space, scene_type }} companion={person} visible={false} onChange={vi.fn()} />);
  view.rerender(<LivingScene space={{ ...space, scene_type }} companion={person} readOnly onChange={vi.fn()} />);
  view.rerender(<LivingScene space={{ ...space, scene_type, mode: 'shared' }} companion={person} onChange={vi.fn()} />);
  expect(runtimeApi.read).not.toHaveBeenCalled();
  expect(runtimeApi.save).not.toHaveBeenCalled();
});

it.each(['home', 'forest', 'desert'] as const)('shows saved current activity inside %s and stops drawing while editing', async scene_type => {
  render(<LivingScene space={{ ...space, scene_type }} companion={person} onChange={vi.fn()} />);
  await screen.findByRole('button', { name: '看看小满此刻在做什么' });
  expect(layer()).toHaveAttribute('data-motion', 'playing');
  fireEvent.click(screen.getByRole('button', { name: '布置场景' }));
  expect(screen.queryByRole('button', { name: '看看小满此刻在做什么' })).toBeNull();
  expect(layer()).toHaveAttribute('data-motion', 'paused');
  expect(api.living.action).not.toHaveBeenCalled(); expect(runtimeApi.save).not.toHaveBeenCalled();
});

it('separates pausing the drawing from pausing autonomous work', () => {
  render(<SceneLifeNow {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '暂停画面' }));
  expect(layer()).toHaveAttribute('data-motion', 'paused'); expect(runtimeApi.save).not.toHaveBeenCalled();
  open(); expect(screen.getByText('你暂停的是画面，后台活动设置没有改变。')).toBeVisible();
  expect(screen.getByRole('link', { name: '和小满聊聊' })).toHaveAttribute('href', '/companions/1?tab=chat');
});

it('shows only the saved reason for the current completed task', () => {
  const reason = '这棵小树正在眼前，先看看它。';
  const real = { ...snapshot, origin: 'real_provider' as const, tasks: [{ ...snapshot.tasks[0], reason }] };
  const view = render(<SceneLifeNow {...props} view={{ snapshot: real, stale: false }} />);
  open();
  expect(screen.getByText(`已保存的 AI 选择理由：${reason}`)).toBeVisible();
  view.rerender(<SceneLifeNow {...props} view={{ snapshot: { ...real, tasks: [{ ...real.tasks[0], id: '44444444-4444-4444-8444-444444444444' }] }, stale: false }} />);
  expect(screen.queryByText(`已保存的 AI 选择理由：${reason}`)).toBeNull();
});

it('holds the verified scene sprite still on pause and drops it when the task changes', () => {
  const withImage = { ...props, companions: [{ ...person, image_path: 'portraits/test.png' }] };
  const view = render(<SceneLifeNow {...withImage} />);
  fireEvent.click(screen.getByTestId('scene-motion-frame'));
  fireEvent.click(screen.getByRole('button', { name: '暂停画面' }));
  expect(layer()).toHaveAttribute('data-motion', 'paused');
  expect(screen.getByRole('img', { name: '小满' })).toHaveAttribute('src', 'data:image/png;base64,c3RpbGw=');
  expect(screen.queryByTestId('scene-motion-frame')).toBeNull();
  const nextTask = '44444444-4444-4444-8444-444444444444';
  const next = { ...snapshot, tasks: [{ ...snapshot.tasks[0], id: nextTask }],
    current_activity: { ...snapshot.current_activity!, task_id: nextTask } };
  view.rerender(<SceneLifeNow {...withImage} view={{ snapshot: next, stale: false }} />);
  expect(screen.queryByRole('img', { name: '小满' })).toBeNull();
  expect(screen.getByRole('button', { name: '继续画面' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '继续画面' }));
  fireEvent.click(screen.getByTestId('scene-motion-frame'));
  fireEvent.click(screen.getByRole('button', { name: '暂停画面' }));
  expect(screen.getByRole('img', { name: '小满' })).toHaveAttribute('src', 'data:image/png;base64,c3RpbGw=');
  act(() => { localStorage.setItem(TOKEN_KEY, 'another-account'); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  expect(screen.queryByLabelText('伙伴当前活动画面')).toBeNull();
});

it('locates only the original target and stops observation when it is stored', async () => {
  vi.useFakeTimers();
  const view = render(<SceneLifeNow {...props} />); open();
  fireEvent.click(screen.getByRole('button', { name: '看看这个物件' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(callbacks.onLocate).toHaveBeenCalledExactlyOnceWith(targetId);
  view.rerender(<SceneLifeNow {...props} space={{ ...space, items: [{ ...space.items[0], stored: true }, { ...space.items[0], id: 'different' }] }} />);
  expect(screen.queryByRole('button', { name: '看看小满此刻在做什么' })).toBeNull();
  open(); expect(screen.queryByRole('button', { name: '看看这个物件' })).toBeNull();
});

it('expires without a further network response and a stale poll cannot extend the first deadline', async () => {
  vi.useFakeTimers();
  const value = { ...snapshot, observed_at: 704 };
  const view = render(<SceneLifeNow {...props} view={{ snapshot: value, stale: false }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  view.rerender(<SceneLifeNow {...props} view={{ snapshot: { ...value, observed_at: 700 }, stale: false }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(501); });
  expect(screen.queryByRole('button', { name: '看看小满此刻在做什么' })).toBeNull();
  expect(runtimeApi.save).not.toHaveBeenCalled();
});

it('disables animation for reduced motion and hidden pages', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const first = render(<SceneLifeNow {...props} />);
  visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(layer()).toHaveAttribute('data-motion', 'paused'); first.unmount(); visibility.mockRestore();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  render(<SceneLifeNow {...props} />);
  expect(layer()).toHaveAttribute('data-motion', 'paused'); expect(screen.getByRole('button', { name: '已减少动态' })).toBeDisabled();
});

it('stops stale animation and never allows stale quick writes or object location', () => {
  render(<SceneLifeNow {...props} view={{ snapshot, stale: true }} />); open();
  expect(layer()).toHaveAttribute('data-motion', 'paused');
  expect(screen.getByRole('button', { name: '暂停自主活动' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '看看这个物件' })).toBeNull();
});

it('quick pause updates the original settings and preserves the unsaved activity draft', async () => {
  render(<LivingScene space={space} companion={person} onChange={vi.fn()} />);
  await screen.findByRole('button', { name: '看看小满此刻在做什么' });
  fireEvent.click(screen.getByRole('checkbox', { name: '散步' }));
  fireEvent.click(screen.getByRole('button', { name: '布置场景' }));
  fireEvent.click(screen.getByRole('button', { name: '完成布置' }));
  expect(screen.getByRole('checkbox', { name: '散步' })).not.toBeChecked();
  vi.mocked(runtimeApi.read).mockResolvedValue(paused); open();
  const button = screen.getByRole('button', { name: '暂停自主活动' }); fireEvent.click(button); fireEvent.click(button);
  await screen.findByText('自主活动已暂停，已有记录会保留。');
  expect(runtimeApi.save).toHaveBeenCalledExactlyOnceWith(sid, 3, false, ['rest', 'walk', 'observe'], expect.any(AbortSignal));
  expect(screen.getByRole('checkbox', { name: '散步' })).not.toBeChecked();
  expect(await within(screen.getByRole('region', { name: '自主生活离线体验' })).findByText('体验已暂停')).toBeVisible();
  expect(screen.getByText('看了看小树')).toBeVisible();
});

it('reconciles an uncertain pause without repeating the write', async () => {
  vi.mocked(runtimeApi.save).mockRejectedValue(new Error('lost response')); vi.mocked(runtimeApi.read).mockResolvedValue(paused);
  render(<SceneLifeNow {...props} />); open(); fireEvent.click(screen.getByRole('button', { name: '暂停自主活动' }));
  await screen.findByText('已核对：自主活动已暂停。');
  expect(runtimeApi.save).toHaveBeenCalledTimes(1); expect(callbacks.onUpdated).toHaveBeenCalledWith(paused);
});

it('blocks uncertain writes after failed reconciliation and clears on account change', async () => {
  localStorage.setItem(TOKEN_KEY, 'first');
  vi.mocked(runtimeApi.save).mockRejectedValue(new Error('offline')); vi.mocked(runtimeApi.read).mockRejectedValue(new Error('offline'));
  render(<SceneLifeNow {...props} />); open(); fireEvent.click(screen.getByRole('button', { name: '暂停自主活动' }));
  await screen.findByText(/暂时连不上，请先关闭弹窗/);
  expect(screen.getByRole('button', { name: '暂停自主活动' })).toBeDisabled();
  act(() => { localStorage.setItem(TOKEN_KEY, 'other'); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByLabelText('伙伴当前活动画面')).toBeNull();
});

it.each([{ present: false }, { companion_id: '2' }, { space_id: 'other' }])('does not show another scope or an absent companion', change => {
  render(<SceneLifeNow {...props} view={{ snapshot: { ...snapshot, ...change }, stale: false }} />);
  expect(screen.queryByLabelText('伙伴当前活动画面')).toBeNull();
});

it('unblocks a previously uncertain pause after the parent obtains a fresh snapshot', async () => {
  vi.mocked(runtimeApi.save).mockRejectedValue(new Error('offline')); vi.mocked(runtimeApi.read).mockRejectedValue(new Error('offline'));
  const view = render(<SceneLifeNow {...props} />); open(); fireEvent.click(screen.getByRole('button', { name: '暂停自主活动' }));
  await screen.findByText(/暂时连不上，请先关闭弹窗/);
  view.rerender(<SceneLifeNow {...props} view={{ snapshot: { ...snapshot, observed_at: 201 }, stale: false }} />);
  expect(await screen.findByText('状态已重新核对，请按当前设置继续。')).toBeVisible();
  expect(screen.getByRole('button', { name: '暂停自主活动' })).toBeEnabled();
  expect(runtimeApi.save).toHaveBeenCalledTimes(1);
});

it('accepts legacy snapshots and rejects current activity inconsistent with saved tasks or lifetime', () => {
  expect(parseRuntime(snapshot, sid)).toEqual(snapshot);
  expect(parseRuntime({ ...snapshot, current_activity: undefined }, sid).current_activity).toBeUndefined();
  for (const change of [{ expires_at: 200 }, { started_at: 201 }, { expires_at: 706 }, { task_id: sid }, { activity: 'walk' }, { source: 'manual' }, { target_id: sid }]) {
    expect(() => parseRuntime({ ...snapshot, current_activity: { ...snapshot.current_activity, ...change } }, sid)).toThrow();
  }
  expect(() => parseRuntime({ ...snapshot, present: false }, sid)).toThrow();
});

it.each(['home', 'forest', 'desert'] as const)('navigates %s sections and back without resetting the activity draft or writing', async scene_type => {
  vi.stubEnv('NEXT_PUBLIC_LIFE_JOURNAL', 'true');
  render(<LivingScene space={{ ...space, scene_type }} companion={person} onChange={vi.fn()} />);
  await screen.findByRole('button', { name: '看看小满此刻在做什么' });
  const nav = within(screen.getByRole('navigation', { name: '场景快捷入口' }));
  fireEvent.click(nav.getByRole('button', { name: '活动设置' }));
  expect(screen.getByRole('region', { name: '活动设置区域' })).toHaveFocus();
  fireEvent.click(screen.getByRole('checkbox', { name: '散步' }));
  fireEvent.click(screen.getByRole('button', { name: '从活动设置回到场景' }));
  expect(screen.getByRole('group', { name: scene_type === 'desert' ? '绿洲沙地' : '场景' })).toHaveFocus();
  fireEvent.click(nav.getByRole('button', { name: '生活记录' }));
  expect(screen.getByRole('region', { name: '生活记录区域' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: '从生活记录回到场景' }));
  fireEvent.click(nav.getByRole('button', { name: '四季' }));
  const season = screen.getByLabelText('四季区域'); expect(season).toHaveFocus();
  if (scene_type === 'desert') expect(season).toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: '从四季回到场景' }));
  expect(screen.getByRole('checkbox', { name: '散步' })).not.toBeChecked();
  expect(runtimeApi.read).toHaveBeenCalledTimes(1);
  expect(runtimeApi.save).not.toHaveBeenCalled(); expect(runtimeApi.schedule).not.toHaveBeenCalled();
  expect(api.living.action).not.toHaveBeenCalled();
});

it('offers only existing navigation sections and hides shortcuts when the scene is hidden', () => {
  vi.stubEnv('NEXT_PUBLIC_LIFE_JOURNAL', 'false'); vi.stubEnv('NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW', 'false');
  const view = render(<LivingScene space={space} companion={person} readOnly onChange={vi.fn()} />);
  const nav = within(screen.getByRole('navigation', { name: '场景快捷入口' }));
  expect(nav.queryByRole('button', { name: '活动设置' })).toBeNull();
  expect(nav.queryByRole('button', { name: '生活记录' })).toBeNull();
  expect(nav.getByRole('button', { name: '四季' })).toBeVisible();
  view.rerender(<LivingScene space={space} companion={person} visible={false} onChange={vi.fn()} />);
  expect(screen.queryByRole('navigation', { name: '场景快捷入口' })).toBeNull();
  expect(runtimeApi.read).not.toHaveBeenCalled();
});

it('closes the detail before navigating to settings without granting or scheduling an activity', async () => {
  vi.useFakeTimers(); const settings = vi.fn();
  render(<SceneLifeNow {...props} onSettings={settings} />); open();
  fireEvent.click(screen.getByRole('button', { name: '去活动设置' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(settings).toHaveBeenCalledTimes(1);
  expect(runtimeApi.save).not.toHaveBeenCalled(); expect(runtimeApi.schedule).not.toHaveBeenCalled();
});

const chat = () => { open(); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '聊聊这次活动' })); };
const draftField = () => screen.getByRole('textbox', { name: '想和伙伴聊的话' });

it.each(['offline_fixture', 'real_provider'] as const)('previews the same saved %s fact as history and cancel does not save', origin => {
  const value = { ...snapshot, origin };
  writeChatDraft(1, '原来想说的话');
  render(<SceneLifeNow {...props} view={{ snapshot: value, stale: false }} />); chat();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(draftField()).toHaveValue(activityChatDraft(space, origin, snapshot.tasks[0]));
  fireEvent.change(draftField(), { target: { value: '先不聊了' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(readChatDraft(1)).toBe('原来想说的话'); expect(push).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull(); expect(runtimeApi.run).not.toHaveBeenCalled();
});

it('keeps edits through ordinary polling and merges the latest chat draft exactly once', () => {
  const view = render(<SceneLifeNow {...props} />); chat();
  fireEvent.change(draftField(), { target: { value: '看小树的时候想到什么啦？' } });
  view.rerender(<SceneLifeNow {...props} view={{ snapshot: { ...snapshot, observed_at: 201 }, stale: false }} />);
  expect(draftField()).toHaveValue('看小树的时候想到什么啦？');
  act(() => writeChatDraft(1, '刚补充的原草稿'));
  const confirm = screen.getByRole('button', { name: '接在原草稿后面' }); fireEvent.click(confirm); fireEvent.click(confirm);
  expect(readChatDraft(1)).toBe('刚补充的原草稿\n\n看小树的时候想到什么啦？');
  expect(push).toHaveBeenCalledExactlyOnceWith('/companions/1?tab=chat#chat-draft');
  expect(runtimeApi.save).not.toHaveBeenCalled(); expect(runtimeApi.run).not.toHaveBeenCalled();
});

it.each(['stale', 'task', 'stored', 'paused', 'account'] as const)('closes current-activity chat on %s and never revives the old edit', reason => {
  localStorage.setItem(TOKEN_KEY, 'first');
  const view = render(<SceneLifeNow {...props} />); chat();
  fireEvent.change(draftField(), { target: { value: '旧活动编辑' } });
  if (reason === 'account') act(() => { localStorage.setItem(TOKEN_KEY, 'second'); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  else if (reason === 'stored') view.rerender(<SceneLifeNow {...props} space={{ ...space, items: [{ ...space.items[0], stored: true }] }} />);
  else {
    const value = reason === 'paused' ? paused : reason === 'task' ? { ...snapshot, tasks: [{ ...snapshot.tasks[0], id: sid }], current_activity: { ...snapshot.current_activity!, task_id: sid } } : snapshot;
    view.rerender(<SceneLifeNow {...props} view={{ snapshot: value, stale: reason === 'stale' }} />);
  }
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<SceneLifeNow {...props} />);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(readChatDraft(1)).toBe('');
  expect(push).not.toHaveBeenCalled();
});

it('closes an unfinished preview when the current activity expires', async () => {
  vi.useFakeTimers();
  render(<SceneLifeNow {...props} view={{ snapshot: { ...snapshot, observed_at: 704 }, stale: false }} />); chat();
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(readChatDraft(1)).toBe('');
});
