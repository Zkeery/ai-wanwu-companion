import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { setToken, clearToken } from '@/lib/auth';
import { readChatDraft, writeChatDraft } from '@/lib/chat-draft';
import LifeJournal from '@/components/life-journal';
import { parseJournal, readJournal, type JournalPage } from '@/lib/life-journal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/life-journal', async original => ({ ...await original<typeof import('@/lib/life-journal')>(), readJournal: vi.fn() }));
const page = (count = 4, start = count): JournalPage => ({ space_id: 's', events: Array.from({ length: count }, (_, i) => ({ revision: start-i, request_id: `id-${start-i}`, created_at: 100, source: 'user', action: 'place', target_kind: 'tree', weather: null })), next_before_revision: null });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(readJournal).mockResolvedValue(page()); });

it('shows only three facts initially and can expand or collapse', async () => {
  render(<LifeJournal spaceId="s" revision={4} />);
  await screen.findByText('查看生活记录');
  expect(screen.getAllByText('用户操作')).toHaveLength(3);
  fireEvent.click(screen.getByText('查看生活记录')); expect(screen.getAllByText('用户操作')).toHaveLength(4);
  fireEvent.click(screen.getByText('收起记录')); expect(screen.getAllByText('用户操作')).toHaveLength(3);
});
it('keeps loaded records on failure and reads again on confirmed scene revision', async () => {
  const view = render(<LifeJournal spaceId="s" revision={4} />); await screen.findByText('查看生活记录');
  vi.mocked(readJournal).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByText('刷新生活记录')); await screen.findByRole('alert');
  expect(screen.getAllByText('用户操作')).toHaveLength(3);
  vi.mocked(readJournal).mockResolvedValue(page(1)); view.rerender(<LifeJournal spaceId="s" revision={5} />);
  await waitFor(() => expect(screen.getAllByText('用户操作')).toHaveLength(1));
});
it('paginates without repeat writes or duplicate requests', async () => {
  vi.mocked(readJournal).mockResolvedValueOnce({ ...page(20, 24), next_before_revision: 5 });
  render(<LifeJournal spaceId="s" revision={24} />); await screen.findByText('查看生活记录');
  fireEvent.click(screen.getByText('查看生活记录'));
  let resolve!: (p: JournalPage) => void;
  vi.mocked(readJournal).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const button = screen.getByText('加载更早记录'); fireEvent.click(button); fireEvent.click(button);
  expect(readJournal).toHaveBeenCalledTimes(2);
  expect(readJournal).toHaveBeenLastCalledWith('s', 5, expect.any(AbortSignal), 'all');
  await act(async () => resolve(page(4)));
  expect(screen.getAllByText('用户操作')).toHaveLength(24);
});
it('ignores late results after newer revisions and cancels on unmount', async () => {
  let resolve!: (p: JournalPage) => void;
  vi.mocked(readJournal).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const view = render(<LifeJournal spaceId="s" revision={1} />);
  const signal = vi.mocked(readJournal).mock.calls[0][2]!;
  vi.mocked(readJournal).mockResolvedValue(page(0)); view.rerender(<LifeJournal spaceId="s" revision={2} />);
  await screen.findByText(/还没有生活记录/); expect(signal.aborted).toBe(true);
  await act(async () => resolve(page())); expect(screen.queryByText('用户操作')).not.toBeInTheDocument();
  const latest = vi.mocked(readJournal).mock.calls[1][2]!; view.unmount();
  // Completed requests need no cancellation; in-flight ones do.
  expect(latest).toBeInstanceOf(AbortSignal);
});
it('rejects wrong sources, targets, order and pagination boundaries', () => {
  expect(parseJournal(page(), 's')).toEqual(page());
  expect(() => parseJournal(page(), 'other')).toThrow();
  expect(() => parseJournal({ ...page(), events: [{ ...page().events[0], source: 'simulation' }] }, 's')).toThrow();
  expect(() => parseJournal({ ...page(), events: [{ ...page().events[0], target_kind: null }] }, 's')).toThrow();
  expect(() => parseJournal({ ...page(), events: [...page().events].reverse() }, 's')).toThrow();
  expect(() => parseJournal({ ...page(), next_before_revision: 1 }, 's')).toThrow();
});

it('explains an empty history without inventing earlier activity', async () => {
  vi.mocked(readJournal).mockResolvedValue(page(0));
  render(<LifeJournal spaceId="s" revision={0} />);
  await screen.findByText(/之前的操作不会补写/);
  expect(screen.queryByText('用户操作')).not.toBeInTheDocument();
  expect(screen.queryByText('查看生活记录')).not.toBeInTheDocument();
  expect(screen.getByText('刷新生活记录')).toBeEnabled();
});

it('retains all loaded events and the cursor after a failed page, then retries once', async () => {
  vi.mocked(readJournal).mockResolvedValueOnce({ ...page(20, 24), next_before_revision: 5 });
  render(<LifeJournal spaceId="s" revision={24} />);
  await screen.findByText('查看生活记录');
  fireEvent.click(screen.getByText('查看生活记录'));
  vi.mocked(readJournal).mockRejectedValueOnce(new Error('timeout'));
  fireEvent.click(screen.getByText('加载更早记录'));
  await screen.findByRole('alert');
  expect(screen.getAllByText('用户操作')).toHaveLength(20);
  vi.mocked(readJournal).mockResolvedValueOnce(page(4));
  fireEvent.click(screen.getByText('加载更早记录'));
  await waitFor(() => expect(screen.getAllByText('用户操作')).toHaveLength(24));
  expect(readJournal).toHaveBeenLastCalledWith('s', 5, expect.any(AbortSignal), 'all');
  expect(readJournal).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('加载更早记录')).not.toBeInTheDocument();
});

it('aborts an in-flight read when leaving and ignores its later result', async () => {
  let resolve!: (p: JournalPage) => void;
  vi.mocked(readJournal).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const view = render(<LifeJournal spaceId="s" revision={1} />);
  const signal = vi.mocked(readJournal).mock.calls[0][2]!;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(page()));
  expect(screen.queryByText('用户操作')).not.toBeInTheDocument();
});

it('does not read while hidden and discards a late response when the life tab closes', async () => {
  const view = render(<LifeJournal spaceId="s" revision={1} visible={false} />);
  expect(readJournal).not.toHaveBeenCalled();
  let resolve!: (p: JournalPage) => void;
  vi.mocked(readJournal).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  view.rerender(<LifeJournal spaceId="s" revision={1} visible />);
  const signal = vi.mocked(readJournal).mock.calls[0][2]!;
  view.rerender(<LifeJournal spaceId="s" revision={1} visible={false} />);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(page()));
  expect(screen.queryByRole('region', { name: '私人生活记录' })).not.toBeInTheDocument();
  vi.mocked(readJournal).mockResolvedValue(page(1));
  view.rerender(<LifeJournal spaceId="s" revision={2} visible />);
  await screen.findByText('用户操作');
  expect(readJournal).toHaveBeenCalledTimes(2);
});

it('resets expansion, cursor and old records when switching to another space', async () => {
  const view = render(<LifeJournal spaceId="s" revision={4} />);
  await screen.findByText('查看生活记录'); fireEvent.click(screen.getByText('查看生活记录'));
  vi.mocked(readJournal).mockResolvedValue({ ...page(1), space_id: 'other' });
  view.rerender(<LifeJournal spaceId="other" revision={1} />);
  expect(screen.queryByText('收起记录')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByText('用户操作')).toHaveLength(1));
  expect(screen.getByText('最近三件小事')).toBeInTheDocument();
});

it('renders saved layout and turn events, rejecting impossible targets', async () => {
  const events: JournalPage['events'] = [
    { ...page().events[0], action: 'layout', target_kind: null },
    { ...page().events[1], action: 'turn', target_kind: 'palm' },
  ];
  const result = { ...page(), events };
  expect(parseJournal(result, 's')).toEqual(result);
  expect(() => parseJournal({ ...result, events: [{ ...events[1], target_kind: null }] }, 's')).toThrow();
  expect(() => parseJournal({ ...result, events: [{ ...events[0], target_kind: 'palm' }] }, 's')).toThrow();
  vi.mocked(readJournal).mockResolvedValue(result);
  render(<LifeJournal spaceId="s" revision={4} />);
  await screen.findByText('换了一套绿洲布置');
  expect(screen.getByText('转向了棕榈树')).toBeInTheDocument();
});


it('exposes chat only with private companion context and discards a preview when hidden', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  writeChatDraft(6, '原草稿');
  const view = render(<LifeJournal spaceId="s" revision={4} />);
  await screen.findByText('查看生活记录');
  expect(screen.queryByRole('button', { name: /聊聊这件事/ })).not.toBeInTheDocument();
  view.rerender(<LifeJournal spaceId="s" revision={4} companionId={6} sceneType="desert" />);
  await screen.findByText('查看生活记录');
  fireEvent.click(screen.getAllByRole('button', { name: /聊聊这件事/ })[0]);
  expect(screen.getByRole('dialog')).toBeVisible();
  view.rerender(<LifeJournal spaceId="s" revision={4} companionId={6} sceneType="desert" visible={false} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(readChatDraft(6)).toBe('原草稿');
});


it('filters on the server, cancels late categories and collapses back to all', async () => {
  render(<LifeJournal spaceId="s" revision={4} />);
  fireEvent.click(await screen.findByText('查看生活记录'));
  let late!: (p: JournalPage) => void;
  vi.mocked(readJournal).mockImplementationOnce(() => new Promise(r => { late = r; }));
  fireEvent.click(screen.getByRole('button', { name: '照料' }));
  const signal = vi.mocked(readJournal).mock.calls.at(-1)![2]!;
  expect(screen.queryByText('放置了小树')).not.toBeInTheDocument();
  vi.mocked(readJournal).mockResolvedValueOnce({ ...page(0), category: 'atmosphere' });
  fireEvent.click(screen.getByRole('button', { name: '氛围' }));
  await screen.findByText('还没有“氛围”记录。');
  expect(signal.aborted).toBe(true);
  await act(async () => late({ ...page(1), category: 'care', events: [{ ...page(1).events[0], action: 'care' }] }));
  expect(screen.queryByText('照料了小树')).not.toBeInTheDocument();
  vi.mocked(readJournal).mockResolvedValueOnce(page());
  fireEvent.click(screen.getByText('收起记录'));
  await screen.findByText('查看生活记录');
  expect(readJournal).toHaveBeenLastCalledWith('s', undefined, expect.any(AbortSignal), 'all');
  expect(screen.queryByRole('group', { name: '生活记录分类' })).not.toBeInTheDocument();
});

it('keeps filtered history and its cursor after failure and deduplicates pagination', async () => {
  render(<LifeJournal spaceId="s" revision={4} />);
  fireEvent.click(await screen.findByText('查看生活记录'));
  const filtered = { ...page(20, 24), category: 'care' as const, next_before_revision: 5, events: page(20, 24).events.map(e => ({ ...e, action: 'care' as const })) };
  vi.mocked(readJournal).mockResolvedValueOnce(filtered);
  fireEvent.click(screen.getByRole('button', { name: '照料' }));
  await screen.findByText('加载更早记录');
  vi.mocked(readJournal).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByText('加载更早记录')); await screen.findByRole('alert');
  expect(screen.getAllByText('照料了小树')).toHaveLength(20);
  vi.mocked(readJournal).mockResolvedValueOnce({ ...filtered, next_before_revision: null, events: [filtered.events.at(-1)!, { ...page(1).events[0], action: 'care' }] });
  fireEvent.click(screen.getByText('加载更早记录'));
  await waitFor(() => expect(screen.getAllByText('照料了小树')).toHaveLength(21));
  expect(readJournal).toHaveBeenLastCalledWith('s', 5, expect.any(AbortSignal), 'care');
});

it('opens factual detail then one editable chat preview, cancelling without writes', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  writeChatDraft(6, '保留的原草稿');
  render(<LifeJournal spaceId="s" revision={4} companionId={6} sceneType="home" />);
  await screen.findByText('查看生活记录');
  fireEvent.click(screen.getAllByRole('button', { name: /查看记录详情/ })[0]);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByText(/没有保存具体物件编号/)).toBeVisible();
  expect(screen.getByText('4 · id-4')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '聊聊这件事' }));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.queryByText('这条生活记录')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('想和伙伴聊的话'), { target: { value: '编辑后的话' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(readChatDraft(6)).toBe('保留的原草稿');
});

it('keeps edited chat during a normal same-scope refresh but blocks transfer while checking', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const view = render(<LifeJournal spaceId="s" revision={4} companionId={6} sceneType="home" />);
  await screen.findByText('查看生活记录');
  fireEvent.click(screen.getAllByRole('button', { name: /聊聊这件事：/ })[0]);
  fireEvent.change(screen.getByLabelText('想和伙伴聊的话'), { target: { value: '我的修改' } });
  let finish!: (p: JournalPage) => void;
  vi.mocked(readJournal).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  view.rerender(<LifeJournal spaceId="s" revision={5} companionId={6} sceneType="home" />);
  expect(screen.getByRole('button', { name: /接在原草稿后面|带到聊天/ })).toBeDisabled();
  await act(async () => finish(page()));
  expect(screen.getByLabelText('想和伙伴聊的话')).toHaveValue('我的修改');
  expect(screen.getByRole('button', { name: /接在原草稿后面|带到聊天/ })).toBeEnabled();
});

it('retains offline detail but blocks chat, and clears everything on lost access', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const view = render(<LifeJournal spaceId="s" revision={4} companionId={6} sceneType="home" />);
  await screen.findByText('查看生活记录');
  fireEvent.click(screen.getAllByRole('button', { name: /查看记录详情/ })[0]);
  vi.mocked(readJournal).mockRejectedValueOnce(new Error('offline'));
  view.rerender(<LifeJournal spaceId="s" revision={5} companionId={6} sceneType="home" />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: '聊聊这件事' })).toBeDisabled();
  expect(screen.getByText(/这是上次读取的记录/)).toBeVisible();
  vi.mocked(readJournal).mockRejectedValueOnce(new ApiError('forbidden', 403, 'forbidden'));
  view.rerender(<LifeJournal spaceId="s" revision={6} companionId={6} sceneType="home" />);
  await screen.findByText(/当前生活记录无法访问/);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText('用户操作')).not.toBeInTheDocument();
});

it('remounts on account changes, hiding records and cancelling old reads', async () => {
  act(() => setToken('test-account-one'));
  render(<LifeJournal spaceId="s" revision={4} />);
  await screen.findByText('查看生活记录');
  let late!: (p: JournalPage) => void;
  vi.mocked(readJournal).mockImplementationOnce(() => new Promise(r => { late = r; }));
  fireEvent.click(screen.getByText('刷新生活记录'));
  const signal = vi.mocked(readJournal).mock.calls.at(-1)![2]!;
  vi.mocked(readJournal).mockResolvedValueOnce(page(0));
  act(() => setToken('test-account-two'));
  await screen.findByText(/还没有生活记录/);
  expect(signal.aborted).toBe(true);
  await act(async () => late(page()));
  expect(screen.queryByText('用户操作')).not.toBeInTheDocument();
  act(() => clearToken());
});

it('validates category membership and old all responses', () => {
  expect(parseJournal(page(), 's', undefined, 'all')).toEqual(page());
  expect(() => parseJournal(page(), 's', undefined, 'care')).toThrow();
  expect(() => parseJournal({ ...page(), category: 'care' }, 's', undefined, 'care')).toThrow();
  const care = { ...page(1), category: 'care', events: [{ ...page(1).events[0], action: 'care' }] };
  expect(parseJournal(care, 's', undefined, 'care')).toEqual(care);
  expect(() => parseJournal(care, 's', undefined, 'layout')).toThrow();
});
