import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LivingScene from '@/components/living-scene';
import LifeActivityHistory from '@/components/life-activity-history';
import { api } from '@/lib/api';
import { AUTH_CHANGED, TOKEN_KEY } from '@/lib/auth';
import { readChatDraft } from '@/lib/chat-draft';
import { readRuntimeHistory, runtimeApi, type RuntimeHistory, type RuntimeSnapshot, type RuntimeTask } from '@/lib/life-runtime';
import type { Character, LivingSpace } from '@/lib/contracts';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/private-image', () => ({ default: () => <span>伙伴头像</span> }));
vi.mock('@/components/season-settings', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/life-journal', () => ({ default: () => null }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
vi.mock('@/lib/life-runtime', async original => ({ ...await original<typeof import('@/lib/life-runtime')>(), readRuntimeHistory: vi.fn(), runtimeApi: { read: vi.fn(), save: vi.fn(), schedule: vi.fn(), run: vi.fn() } }));
const sid = '11111111-1111-4111-8111-111111111111', targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const person: Character = { id: 1, name: '苹果', persona: '', opening_line: '', image_path: null, status: 'ready', created_at: '' };
const space: LivingSpace = { id: sid, scene_type: 'home', mode: 'private', companion_id: '1', revision: 1, observed_at: 100, can_undo: false, items: [{ id: targetId, kind: 'tree', x: 0.3, y: 0.4, stored: false, growth_seconds: 0, stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' }] };
const task: RuntimeTask = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'done', created_at: 50, retry_at: 0, activity: 'observe', target_id: targetId, error_code: null };
const snapshot: RuntimeSnapshot = { origin: 'offline_fixture', space_id: sid, companion_id: '1', present: true, observed_at: 200, next_allowed_at: 700, permission: { enabled: false, activities: ['observe'], revision: 1 }, tasks: [{ ...task, id: 'newest', created_at: 100, activity: 'rest', target_id: null }] };
const page: RuntimeHistory = { origin: snapshot.origin, space_id: sid, companion_id: '1', observed_at: 200, tasks: [task], next_before: null };
const props = { space, companions: [person], onLocate: vi.fn() };
const detail = () => within(screen.getByRole('region', { name: '活动详情' }));
async function open() { fireEvent.click(screen.getByRole('button', { name: '查看活动记录' })); fireEvent.click(await screen.findByRole('button', { name: '查看活动详情' })); }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW', 'true');
  vi.mocked(runtimeApi.read).mockResolvedValue(snapshot); vi.mocked(readRuntimeHistory).mockResolvedValue(page);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { vi.unstubAllEnvs(); localStorage.clear(); sessionStorage.clear(); });

it.each(['home', 'forest', 'desert'] as const)('locates the historical observation in %s without executing or changing the scene', async scene_type => {
  render(<LivingScene space={{ ...space, scene_type }} companion={person} onChange={vi.fn()} />);
  await screen.findByText('歇了一会儿'); await open();
  expect(detail().getByText('苹果 · 这条活动')).toBeInTheDocument();
  expect(detail().getByText('看了看小树')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '活动详情' })).toHaveFocus();
  fireEvent.click(detail().getByRole('button', { name: '看看它观察的物件' }));
  expect(document.querySelector(`[data-living-item-id="${targetId}"]`)).toHaveFocus();
  expect(api.living.action).not.toHaveBeenCalled(); expect(runtimeApi.run).not.toHaveBeenCalled(); expect(runtimeApi.schedule).not.toHaveBeenCalled();
});

it('does not substitute a stored original and removes location when the scene becomes uncertain', async () => {
  const view = render(<LifeActivityHistory snapshot={snapshot} available scene={props} />); await open();
  view.rerender(<LifeActivityHistory snapshot={snapshot} available scene={{ ...props, locatingDisabled: true }} />);
  expect(detail().getByRole('button', { name: '看看它观察的物件' })).toBeDisabled();
  view.rerender(<LifeActivityHistory snapshot={snapshot} available scene={{ ...props, space: { ...space, items: [{ ...space.items[0], stored: true }, { ...space.items[0], id: 'different' }] } }} />);
  expect(detail().getByText('原来观察的物件已收纳或移走。')).toBeInTheDocument();
  expect(detail().queryByRole('button', { name: '看看它观察的物件' })).toBeNull();
});

it('previews the selected historical fact, cancels without changing a draft and restores focus on close', async () => {
  render(<LifeActivityHistory snapshot={snapshot} available scene={props} />); await open();
  fireEvent.click(detail().getByRole('button', { name: '聊聊这次活动' }));
  expect((screen.getByLabelText('想和伙伴聊的话') as HTMLTextAreaElement).value).toContain('预设活动（离线样例）：看了看小树');
  fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(readChatDraft(1)).toBe(''); expect(push).not.toHaveBeenCalled();
  fireEvent.click(detail().getByRole('button', { name: '关闭活动详情' }));
  expect(screen.queryByRole('region', { name: '活动详情' })).toBeNull(); expect(screen.getByRole('button', { name: '查看活动详情' })).toHaveFocus();
});

it('keeps selected history across older-page reads, disables operations on failure and clears selection on refresh', async () => {
  vi.mocked(readRuntimeHistory).mockResolvedValueOnce({ ...page, next_before: '50:cursor' }).mockRejectedValueOnce(new Error('offline'));
  render(<LifeActivityHistory snapshot={snapshot} available scene={props} />); await open();
  fireEvent.click(screen.getByRole('button', { name: '加载更早记录' })); await screen.findByRole('alert');
  expect(detail().getByRole('button', { name: '聊聊这次活动' })).toBeDisabled();
  expect(detail().getByRole('button', { name: '看看它观察的物件' })).toBeDisabled();
  vi.mocked(readRuntimeHistory).mockResolvedValueOnce({ ...page, tasks: [{ ...task, id: 'older', created_at: 40 }] });
  fireEvent.click(screen.getByRole('button', { name: '加载更早记录' })); await screen.findByText('已加载 2 条记录');
  expect(detail().getByRole('button', { name: '聊聊这次活动' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '更新活动记录' }));
  expect(screen.queryByRole('region', { name: '活动详情' })).toBeNull();
  await screen.findByText('已加载 1 条记录');
});

it.each(['cancelled', 'failed', 'queued', 'running'] as const)('does not present %s as a successful historical experience', async state => {
  vi.mocked(readRuntimeHistory).mockResolvedValue({ ...page, tasks: [{ ...task, state, activity: null, target_id: null, error_code: state === 'cancelled' || state === 'failed' ? 'conflict' : null }] });
  render(<LifeActivityHistory snapshot={snapshot} available scene={props} />); await open();
  expect(detail().queryByText('看了看小树')).toBeNull(); expect(detail().queryByRole('button', { name: '聊聊这次活动' })).toBeNull();
  expect(detail().getByText(/记录读取于/)).toBeInTheDocument();
});

it('clears the selected private detail and chat preview when the account changes', async () => {
  localStorage.setItem(TOKEN_KEY, 'first');
  render(<LivingScene space={space} companion={person} onChange={vi.fn()} />); await screen.findByText('歇了一会儿'); await open();
  fireEvent.click(detail().getByRole('button', { name: '聊聊这次活动' }));
  act(() => { localStorage.setItem(TOKEN_KEY, 'second'); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('region', { name: '活动详情' })).toBeNull();
});

it('hides private details when the current companion is absent', async () => {
  const view = render(<LifeActivityHistory snapshot={snapshot} available scene={props} />); await open();
  view.rerender(<LifeActivityHistory snapshot={{ ...snapshot, present: false }} available scene={props} />);
  expect(screen.queryByRole('region', { name: '活动详情' })).toBeNull(); expect(screen.queryByRole('button', { name: '查看活动详情' })).toBeNull();
});
