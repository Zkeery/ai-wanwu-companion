import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SceneActivityFeedback from '@/components/scene-activity-feedback';
import { readChatDraft, writeChatDraft } from '@/lib/chat-draft';
import { AUTH_CHANGED, TOKEN_KEY } from '@/lib/auth';
import type { RuntimeSnapshot, RuntimeTask } from '@/lib/life-runtime';
import type { Character, LivingSpace } from '@/lib/contracts';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
const space: LivingSpace = { id: 'home', scene_type: 'home', mode: 'private', companion_id: '1', revision: 1, observed_at: 100, can_undo: false, items: [] };
const person: Character = { id: 1, name: '苹果', persona: '', opening_line: '', image_path: null, status: 'ready', created_at: '' };
const task: RuntimeTask = { id: 'saved-task', state: 'done', created_at: 100, retry_at: 0, activity: 'rest', target_id: null, error_code: null };
const snapshot: RuntimeSnapshot = { origin: 'offline_fixture', space_id: space.id, companion_id: '1', present: true, observed_at: 200, next_allowed_at: 700, permission: { enabled: false, activities: ['rest'], revision: 1 }, tasks: [task] };
const props = { space, companions: [person], onLocate: vi.fn() };
const entry = () => screen.getByRole('button', { name: '聊聊这次活动' });
const field = () => screen.getByLabelText('想和伙伴聊的话');
function mount(value = snapshot) { return render(<SceneActivityFeedback {...props} view={{ snapshot: value, stale: false }} />); }
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); writeChatDraft(1, ''); writeChatDraft(2, '另外一位伙伴的草稿');
  vi.stubGlobal('fetch', vi.fn());
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); writeChatDraft(1, ''); writeChatDraft(2, ''); });

it.each([['rest', '歇了一会儿'], ['walk', '散了会儿步'], ['observe', '观察了一会儿']] as const)('previews %s with an explicit offline source and cancellation has no effects', (activity, text) => {
  mount({ ...snapshot, tasks: [{ ...task, activity, target_id: activity === 'observe' ? 'missing' : null }] });
  fireEvent.click(entry());
  expect((field() as HTMLTextAreaElement).value).toContain(`预设活动（离线样例）：${text}。`);
  expect((field() as HTMLTextAreaElement).value).toContain('本轮安排于');
  expect((field() as HTMLTextAreaElement).value).toContain('家庭庭院');
  if (activity === 'observe') expect((field() as HTMLTextAreaElement).value).toContain('原来观察的物件已收纳或移走');
  fireEvent.change(field(), { target: { value: '暂时不聊了' } }); fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(readChatDraft(1)).toBe('');
  expect(push).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('distinguishes real-provider records and transfers edited text once to the correct chat', () => {
  mount({ ...snapshot, origin: 'real_provider' }); fireEvent.click(entry());
  expect((field() as HTMLTextAreaElement).value).toContain('已保存的AI活动：歇了一会儿。');
  expect((field() as HTMLTextAreaElement).value).not.toContain('预设活动');
  fireEvent.change(field(), { target: { value: '  休息得怎么样呀？  ' } });
  const confirm = screen.getByRole('button', { name: '带到聊天' }); fireEvent.click(confirm); fireEvent.click(confirm);
  expect(readChatDraft(1)).toBe('休息得怎么样呀？'); expect(readChatDraft(2)).toBe('另外一位伙伴的草稿');
  expect(push).toHaveBeenCalledExactlyOnceWith('/companions/1?tab=chat#chat-draft');
  expect(fetch).not.toHaveBeenCalled();
});

it('preserves the latest original draft and blocks an oversized merge', () => {
  writeChatDraft(1, '原来想说的话'); mount(); fireEvent.click(entry());
  fireEvent.change(field(), { target: { value: '🌱🌱' } });
  act(() => writeChatDraft(1, '🌱'.repeat(3997)));
  expect(screen.getByRole('button', { name: '接在原草稿后面' })).toBeDisabled();
  fireEvent.submit(field().closest('form')!); expect(push).not.toHaveBeenCalled();
  act(() => writeChatDraft(1, '后来补充的草稿'));
  fireEvent.click(screen.getByRole('button', { name: '接在原草稿后面' }));
  expect(readChatDraft(1)).toBe('后来补充的草稿\n\n🌱🌱'); expect(fetch).not.toHaveBeenCalled();
});

it.each(['queued', 'running', 'cancelled', 'failed'] as const)('does not offer a completed-activity draft for %s', state => {
  mount({ ...snapshot, tasks: [{ ...task, state, activity: null }] });
  expect(screen.queryByRole('button', { name: '聊聊这次活动' })).toBeNull();
});

it('closes the preview when the task changes, then opens the new fact without the old edit', () => {
  const view = mount(); fireEvent.click(entry()); fireEvent.change(field(), { target: { value: '旧记录编辑' } });
  view.rerender(<SceneActivityFeedback {...props} view={{ snapshot: { ...snapshot, tasks: [{ ...task, id: 'next-task', activity: 'walk' }] }, stale: false }} />);
  expect(screen.queryByRole('dialog')).toBeNull(); fireEvent.click(entry());
  expect((field() as HTMLTextAreaElement).value).toContain('散了会儿步'); expect((field() as HTMLTextAreaElement).value).not.toContain('旧记录编辑');
  expect(readChatDraft(1)).toBe('');
});

it('closes a preview on stale or lost access and does not reopen it after recovery', () => {
  const view = mount(); fireEvent.click(entry());
  view.rerender(<SceneActivityFeedback {...props} view={{ snapshot, stale: true }} />);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(entry()).toBeDisabled();
  view.rerender(<SceneActivityFeedback {...props} view={{ snapshot, stale: false }} />);
  expect(screen.queryByRole('dialog')).toBeNull(); fireEvent.click(entry());
  view.rerender(<SceneActivityFeedback {...props} view={{ snapshot: null, stale: true }} />);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(readChatDraft(1)).toBe('');
});

it('closes on account change and checks identity again even without a notification event', () => {
  localStorage.setItem(TOKEN_KEY, 'first'); mount(); fireEvent.click(entry());
  act(() => { localStorage.setItem(TOKEN_KEY, 'second'); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(readChatDraft(1)).toBe('');
  fireEvent.click(entry()); localStorage.setItem(TOKEN_KEY, 'third');
  fireEvent.click(screen.getByRole('button', { name: '带到聊天' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(push).not.toHaveBeenCalled(); expect(readChatDraft(1)).toBe('');
});
