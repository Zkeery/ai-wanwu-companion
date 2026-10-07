import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import LifeChatDraft from '@/components/life-chat-draft';
import { readChatDraft, writeChatDraft } from '@/lib/chat-draft';
import type { JournalEvent } from '@/lib/life-journal';
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
const event: JournalEvent = { revision: 4, request_id: 'saved-event', created_at: 1790467200, source: 'user', action: 'place', target_kind: 'palm', weather: null };
const mount = () => { const close = vi.fn(); render(<LifeChatDraft companionId={6} sceneType="desert" event={event} close={close} />); return close; };
beforeEach(() => {
  vi.clearAllMocks(); writeChatDraft(6, ''); writeChatDraft(2, '另一个伙伴的草稿');
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
it('previews a dated user fact, and cancellation leaves stored drafts untouched', () => {
  const close = mount(); const field = screen.getByLabelText('想和伙伴聊的话');
  expect((field as HTMLTextAreaElement).value).toContain('用户操作：放置了棕榈树。');
  expect((field as HTMLTextAreaElement).value).toContain('上海时间');
  fireEvent.change(field, { target: { value: '取消这段话' } }); fireEvent.click(screen.getByText('取消'));
  expect(close).toHaveBeenCalledOnce(); expect(readChatDraft(6)).toBe(''); expect(push).not.toHaveBeenCalled();
});
it('transfers edited text once to the correct companion without touching another draft', () => {
  const close = mount(); fireEvent.change(screen.getByLabelText('想和伙伴聊的话'), { target: { value: '  这棵树放这里怎么样？  ' } });
  const button = screen.getByText('带到聊天'); fireEvent.click(button); fireEvent.click(button);
  expect(readChatDraft(6)).toBe('这棵树放这里怎么样？'); expect(readChatDraft(2)).toBe('另一个伙伴的草稿');
  expect(push).toHaveBeenCalledExactlyOnceWith('/companions/6?tab=chat#chat-draft'); expect(close).toHaveBeenCalledOnce();
});
it('appends to the latest existing draft without replacing its whitespace', () => {
  writeChatDraft(6, '原草稿'); mount();
  fireEvent.change(screen.getByLabelText('想和伙伴聊的话'), { target: { value: '新的生活小事' } });
  act(() => writeChatDraft(6, '  刚补充的原草稿\n'));
  fireEvent.click(screen.getByText('接在原草稿后面'));
  expect(readChatDraft(6)).toBe('  刚补充的原草稿\n\n\n新的生活小事');
});
it('retains oversized emoji text, blocks submission, and permits an exact combined boundary', () => {
  writeChatDraft(6, '🌱'.repeat(3997)); mount();
  const field = screen.getByLabelText('想和伙伴聊的话');
  fireEvent.change(field, { target: { value: '🌱🌱' } });
  expect(screen.getByRole('alert')).toHaveTextContent('消息不能超过 4000 字');
  expect(screen.getByText('接在原草稿后面')).toBeDisabled(); fireEvent.submit(field.closest('form')!);
  expect(readChatDraft(6)).toBe('🌱'.repeat(3997)); expect(field).toHaveValue('🌱🌱'); expect(push).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: '🌱' } }); fireEvent.click(screen.getByText('接在原草稿后面'));
  expect(Array.from(readChatDraft(6))).toHaveLength(4000);
});
it('rechecks storage at confirmation even if no local update event arrived', () => {
  mount(); sessionStorage.setItem('companion-chat-draft:6', '字'.repeat(4000));
  fireEvent.click(screen.getByText('带到聊天'));
  expect(push).not.toHaveBeenCalled(); expect(readChatDraft(6)).toBe('字'.repeat(4000));
  expect(screen.getByRole('alert')).toHaveTextContent('4000');
});
it('does not transfer an empty draft or submit during composition', () => {
  mount(); const field = screen.getByLabelText('想和伙伴聊的话');
  fireEvent.compositionStart(field); fireEvent.submit(field.closest('form')!); expect(push).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field); fireEvent.change(field, { target: { value: '   ' } });
  fireEvent.submit(field.closest('form')!); expect(push).not.toHaveBeenCalled(); expect(readChatDraft(6)).toBe('');
});
