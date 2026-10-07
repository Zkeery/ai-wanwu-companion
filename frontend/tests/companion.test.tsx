import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Companion from '@/components/companion';
import { api } from '@/lib/api';
import { sendChat } from '@/lib/stream';
import { writeChatDraft } from '@/lib/chat-draft';
import { clearPendingChat, reserveChat } from '@/lib/chat-recovery';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock('@/lib/api', () => ({ api: { character: vi.fn(), characterOverview: vi.fn(), messages: vi.fn(), scene: vi.fn(), decide: vi.fn(), sceneAction: vi.fn(), undo: vi.fn(), clearHistory: vi.fn(), chatRequest: vi.fn() }, errorText: (e: Error) => e.message }));
vi.mock('@/lib/stream', () => ({ sendChat: vi.fn() }));
vi.mock('@/components/garden', () => ({ default: () => <div>小花园</div> }));
vi.mock('@/components/recreate-companion', () => ({ default: () => null }));
const character = { id: 1, name: '小叶', persona: '一株温柔的植物', opening_line: '坐一会吧', image_path: null, status: 'ready' as const, created_at: '' };
const scene = { scene_name: '小花园', elements: { rain: 0, tree: 0, cloud: 0, sound: 1 }, can_undo: false, feedback: null, proposal: null };
it('retains oversized pasted text and blocks click, Enter and form submission', async () => {
  render(<Companion id={1} />);
  const field = await screen.findByLabelText('想对伙伴说的话');
  const value = '🌱'.repeat(4001);
  fireEvent.change(field, { target: { value } });
  expect(field).toHaveValue(value);
  expect(field).not.toHaveAttribute('maxlength');
  expect(screen.getByText('4001/4000')).toBeInTheDocument();
  expect(screen.getByText('消息不能超过 4000 字')).toBeInTheDocument();
  expect(screen.getByLabelText('发送消息')).toBeDisabled();
  fireEvent.click(screen.getByLabelText('发送消息'));
  fireEvent.keyDown(field, { key: 'Enter' });
  fireEvent.submit(field.closest('form')!);
  expect(sendChat).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: '🌱'.repeat(4000) } });
  expect(screen.getByLabelText('发送消息')).toBeEnabled();
});
it('sends the full normalized emoji boundary and guards composition form submission', async () => {
  vi.mocked(sendChat).mockResolvedValue({ message: { id: 1, role: 'assistant', content: '收到', created_at: '' }, proposal: null });
  render(<Companion id={1} />);
  const field = await screen.findByLabelText('想对伙伴说的话');
  fireEvent.change(field, { target: { value: ' \ufeff' + '🌱'.repeat(4000) + '　' } });
  fireEvent.compositionStart(field);
  fireEvent.submit(field.closest('form')!);
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(sendChat).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field);
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(sendChat).toHaveBeenCalledWith(1, '🌱'.repeat(4000), expect.any(AbortSignal), expect.any(Function)));
  await waitFor(() => expect(field).toHaveValue(''));
});
it('preserves a draft when the server rejects a message', async () => {
  vi.mocked(sendChat).mockRejectedValue(new Error('消息不能超过 4000 字'));
  render(<Companion id={1} />);
  const field = await screen.findByLabelText('想对伙伴说的话');
  fireEvent.change(field, { target: { value: '保留草稿' } });
  fireEvent.click(screen.getByLabelText('发送消息'));
  expect(await screen.findByRole('alert')).toHaveTextContent('消息不能超过 4000 字');
  expect(field).toHaveValue('保留草稿');
});
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/companions/1'); clearPendingChat(1); writeChatDraft(1, ''); vi.mocked(api.character).mockResolvedValue(character); vi.mocked(api.characterOverview).mockResolvedValue([]); vi.mocked(api.messages).mockResolvedValue([]); vi.mocked(api.scene).mockResolvedValue(scene); Element.prototype.scrollIntoView = vi.fn(); });
it('keeps chat and the gathering route available while the companion is away', async () => {
  window.history.replaceState(null, '', '/companions/1?tab=life');
  vi.mocked(api.characterOverview).mockResolvedValue([{ character, residence: null, gathering: { id: 'group-1', title: '朋友的小院' }, last_interaction_at: null, recent_activity: [] }]);
  const view = render(<Companion id={1} />);
  expect(await screen.findByText('正在“朋友的小院”相聚', { selector: '.companion-residence' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '去共同空间看看 →' })).toHaveAttribute('href', '/gatherings?space=group-1');
  expect(screen.queryByText('还没有选择住处')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '聊天' }));
  view.rerender(<Companion id={1} />);
  expect(screen.getByLabelText('想对伙伴说的话')).toBeVisible();
});
it('queries a running request on mount and only resumes after an explicit click', async () => {
  reserveChat(1, '一起种树'); writeChatDraft(1, '一起种树');
  vi.mocked(api.chatRequest).mockResolvedValue('running');
  vi.mocked(sendChat).mockResolvedValue({ message: { id: 2, role: 'assistant', content: '一起吧', created_at: '' }, proposal: null });
  render(<Companion id={1} />);
  expect(await screen.findByLabelText('想对伙伴说的话')).toHaveValue('一起种树');
  expect(screen.getByLabelText('发送消息')).toBeDisabled();
  expect(sendChat).not.toHaveBeenCalled();
  vi.mocked(api.chatRequest).mockResolvedValue('completed');
  fireEvent.click(screen.getByText('继续处理原消息'));
  await waitFor(() => expect(sendChat).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByLabelText('想对伙伴说的话')).toHaveValue(''));
});
it('restores an unsent draft after the page is remounted for re-authentication', async () => {
  const view = render(<Companion id={1} />);
  fireEvent.change(await screen.findByLabelText('想对伙伴说的话'), { target: { value: '重新登录后保留' } });
  view.unmount(); render(<Companion id={1} />);
  expect(await screen.findByLabelText('想对伙伴说的话')).toHaveValue('重新登录后保留');
  expect(sendChat).not.toHaveBeenCalled();
});
it('prevents duplicate Enter/click while streaming and uses saved history', async () => {
  let done!: (value: Awaited<ReturnType<typeof sendChat>>) => void;
  vi.mocked(sendChat).mockImplementation(() => new Promise(resolve => { done = resolve; }));
  render(<Companion id={1} />); const field = await screen.findByLabelText('想对伙伴说的话');
  fireEvent.change(field, { target: { value: '你好' } }); fireEvent.keyDown(field, { key: 'Enter' }); fireEvent.keyDown(field, { key: 'Enter' }); fireEvent.click(screen.getByLabelText('发送消息'));
  expect(sendChat).toHaveBeenCalledTimes(1);
  const saved = { id: 7, role: 'assistant' as const, content: '后端保存的回复', created_at: '2026-09-18T12:00:00' };
  vi.mocked(api.messages).mockResolvedValue([saved]); done({ message: saved, proposal: null });
  expect(await screen.findByText('后端保存的回复')).toBeInTheDocument(); expect(field).toHaveValue('');
});
it('keeps input and reloads persisted history on stream failure', async () => {
  vi.mocked(sendChat).mockRejectedValue(new Error('连接已中断'));
  render(<Companion id={1} />); const field = await screen.findByLabelText('想对伙伴说的话'); fireEvent.change(field, { target: { value: '保留这句话' } }); fireEvent.click(screen.getByLabelText('发送消息'));
  expect(await screen.findByRole('alert')).toHaveTextContent('已保留输入'); expect(field).toHaveValue('保留这句话'); await waitFor(() => expect(api.messages).toHaveBeenCalledTimes(2));
});
it('refresh restores pending proposal and rejection uses its persisted token', async () => {
  vi.mocked(api.scene).mockResolvedValue({ ...scene, proposal: { id: 'saved-token', action: 'light_rain' } }); vi.mocked(api.decide).mockResolvedValue(scene);
  render(<Companion id={1} />); fireEvent.click(await screen.findByText('先不了')); await waitFor(() => expect(api.decide).toHaveBeenCalledWith(1, 'saved-token', 'reject')); await waitFor(() => expect(screen.queryByText('先不了')).not.toBeInTheDocument());
});
it('does not send while Chinese IME is composing', async () => { render(<Companion id={1} />); const field = await screen.findByLabelText('想对伙伴说的话'); fireEvent.change(field, { target: { value: '输入法' } }); fireEvent.keyDown(field, { key: 'Enter', isComposing: true }); expect(sendChat).not.toHaveBeenCalled(); });
it('aborts a pending chat on leaving the companion', async () => { let signal: AbortSignal | undefined; vi.mocked(sendChat).mockImplementation((_id, _text, s) => { signal = s; return new Promise(() => {}); }); const view = render(<Companion id={1} />); const field = await screen.findByLabelText('想对伙伴说的话'); fireEvent.change(field, { target: { value: '再见' } }); fireEvent.click(screen.getByLabelText('发送消息')); view.unmount(); expect(signal?.aborted).toBe(true); });
it('preserves an unsent draft across URL tabs without fetching again', async () => {
  const view = render(<Companion id={1} />);
  const field = await screen.findByLabelText('想对伙伴说的话');
  fireEvent.change(field, { target: { value: '等会再告诉你' } });
  fireEvent.click(screen.getByRole('tab', { name: '生活' })); view.rerender(<Companion id={1} />);
  expect(window.location.search).toBe('?tab=life');
  expect(screen.getByRole('tabpanel', { name: '生活' })).toBeVisible();
  expect(field).not.toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: '聊天' })); view.rerender(<Companion id={1} />);
  expect(field).toBeVisible(); expect(field).toHaveValue('等会再告诉你');
  expect(api.character).toHaveBeenCalledTimes(1); expect(sendChat).not.toHaveBeenCalled();
});
it('finishes a streaming reply while another tab is visible without aborting or resending', async () => {
  let signal!: AbortSignal, finish!: (value: Awaited<ReturnType<typeof sendChat>>) => void;
  vi.mocked(sendChat).mockImplementation((_id, _text, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); });
  const view = render(<Companion id={1} />); const field = await screen.findByLabelText('想对伙伴说的话');
  fireEvent.change(field, { target: { value: '你好' } }); fireEvent.click(screen.getByLabelText('发送消息'));
  fireEvent.click(screen.getByRole('tab', { name: '资料' })); view.rerender(<Companion id={1} />);
  expect(signal.aborted).toBe(false);
  const saved = { id: 8, role: 'assistant' as const, content: '分区切换后的真实存档', created_at: '2026-09-22T02:00:00Z' };
  vi.mocked(api.messages).mockResolvedValue([saved]);
  await act(async () => finish({ message: saved, proposal: null }));
  fireEvent.click(screen.getByRole('tab', { name: '聊天' })); view.rerender(<Companion id={1} />);
  expect(screen.getByText(saved.content)).toBeVisible(); expect(signal.aborted).toBe(false); expect(sendChat).toHaveBeenCalledTimes(1);
});
it.each([['?tab=life', '生活'], ['?tab=profile', '资料'], ['?tab=invalid', '聊天'], ['#chat', '聊天']])('opens %s in the right section', async (query, label) => {
  window.history.replaceState(null, '', '/companions/1' + query); render(<Companion id={1} />);
  expect(await screen.findByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: label })).toBeVisible();
});

it('unlocks after done and sends a second message without waiting for history or scene reload', async () => {
  vi.mocked(sendChat).mockResolvedValueOnce({ message: { id: 101, role: 'assistant', content: '第一条回复', created_at: '' }, proposal: null })
    .mockResolvedValueOnce({ message: { id: 103, role: 'assistant', content: '第二条回复', created_at: '' }, proposal: null });
  render(<Companion id={1} />);
  const field = await screen.findByLabelText('想对伙伴说的话');
  // Reads after the initial page load would stall; completed chat must not depend on them.
  vi.mocked(api.messages).mockImplementation(() => new Promise(() => {}));
  vi.mocked(api.scene).mockImplementation(() => new Promise(() => {}));
  for (const text of ['第一条', '第二条']) {
    fireEvent.change(field, { target: { value: text } }); fireEvent.click(screen.getByLabelText('发送消息'));
    await waitFor(() => expect(field).toHaveValue(''));
    expect(field).toBeEnabled();
  }
  expect(sendChat).toHaveBeenCalledTimes(2);
  expect(screen.getByText('第一条回复')).toBeVisible(); expect(screen.getByText('第二条回复')).toBeVisible();
  expect(screen.queryByText('伙伴正在回复，请稍等…')).not.toBeInTheDocument();
  expect(api.messages).toHaveBeenCalledTimes(1); expect(api.scene).toHaveBeenCalledTimes(1);
});

it('syncs a life draft into the mounted companion and ignores other companions', async () => {
  render(<Companion id={1} />); const field = await screen.findByLabelText('想对伙伴说的话');
  act(() => writeChatDraft(1, '生活记录带来的草稿')); expect(field).toHaveValue('生活记录带来的草稿');
  act(() => writeChatDraft(2, '另一个伙伴')); expect(field).toHaveValue('生活记录带来的草稿');
  expect(sendChat).not.toHaveBeenCalled();
});
it('does not clear a newly appended life draft when an earlier reply finishes', async () => {
  let finish!: (value: Awaited<ReturnType<typeof sendChat>>) => void;
  vi.mocked(sendChat).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<Companion id={1} />); const field = await screen.findByLabelText('想对伙伴说的话');
  fireEvent.change(field, { target: { value: '之前的话' } }); fireEvent.click(screen.getByLabelText('发送消息'));
  act(() => writeChatDraft(1, '之前的话\n\n生活记录'));
  await act(async () => finish({ message: { id: 107, role: 'assistant', content: '收到啦', created_at: '' }, proposal: null }));
  expect(field).toHaveValue('之前的话\n\n生活记录'); expect(sendChat).toHaveBeenCalledOnce();
});


it('brings the transferred draft composer into view without sending', async () => {
  window.history.replaceState(null, '', '/companions/1?tab=chat#chat-draft');
  writeChatDraft(1, '生活小事'); render(<Companion id={1} />);
  expect(await screen.findByLabelText('想对伙伴说的话')).toHaveValue('生活小事');
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' }));
  expect(sendChat).not.toHaveBeenCalled();
});
