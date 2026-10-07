import React from 'react';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Collection from '@/components/collection';
import { api } from '@/lib/api';
import { readCollectionPosition, rememberCollectionPosition } from '@/lib/collection-position';
import { setToken } from '@/lib/auth';
import { parseCharacterOverview } from '@/lib/contracts';

const character = { id: 1, name: '小叶', persona: '安静', opening_line: '你好', image_path: null, status: 'ready', created_at: '2026-09-22T00:00:00Z' };
const overview = { character, residence: { space_id: 'home-1', scene_type: 'home', mode: 'private' }, last_interaction_at: '2026-09-22T02:30:00Z' };
const facts = [3, 2, 1].map(revision => ({ revision, occurred_at: '2026-09-22T02:30:00Z', source: 'user', text: ['放置了小树', '开启了小雨', '撤销了上一步布置'][revision - 1] }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); setToken('test-session');
  vi.spyOn(api.auth, 'me').mockResolvedValue({ id: 'test', phone: '13900000001' });
});
it('shows saved residence and chat time with distinct chat and life links', async () => {
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview(overview)]);
  const legacy = vi.spyOn(api, 'characters');
  render(<Collection />);
  const card = await screen.findByRole('article', { name: '小叶' });
  expect(within(card).getByText('家庭庭院 · 独自生活')).toBeVisible();
  expect(card.querySelector('time')).toHaveAttribute('dateTime', overview.last_interaction_at);
  expect(within(card).getByRole('link', { name: '聊聊天' })).toHaveAttribute('href', '/companions/1?tab=chat');
  expect(within(card).getByRole('link', { name: '去住处' })).toHaveAttribute('href', '/companions/1?tab=life');
  expect(api.characterOverview).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
});
it('does not fabricate activity or residence for a new companion', async () => {
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview({ ...overview, residence: null, last_interaction_at: null })]);
  render(<Collection />);
  expect(await screen.findByText('还没有聊天记录，来打个招呼吧。')).toBeVisible();
  expect(screen.getByRole('link', { name: '选择住处' })).toHaveAttribute('href', '/companions/1?tab=life');
});
it('shows retry instead of empty collection after failure, and recovers', async () => {
  vi.spyOn(api, 'characterOverview').mockRejectedValueOnce(new Error('暂时无法读取伙伴')).mockResolvedValueOnce([]);
  render(<Collection />);
  const alert = await screen.findByRole('alert');
  expect(screen.queryByText('第一位朋友，会是谁呢？')).not.toBeInTheDocument();
  fireEvent.click(within(alert).getByRole('button'));
  expect(await screen.findByRole('link', { name: /创建第一个伙伴/ })).toBeVisible();
});
it.each([
  { ...overview, residence: undefined },
  { ...overview, residence: { ...overview.residence, scene_type: 'unknown' } },
  { ...overview, residence: { ...overview.residence, mode: 'public' } },
  { ...overview, last_interaction_at: 'not-a-date' },
])('rejects malformed overview data', value => {
  expect(() => parseCharacterOverview(value)).toThrow();
});

it('shows three saved user actions and links to this companion journal', async () => {
  vi.stubEnv('NEXT_PUBLIC_LIFE_JOURNAL', 'true');
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview({ ...overview, recent_activity: facts })]);
  render(<Collection />);
  const region = await screen.findByRole('region', { name: '小叶的生活近况' });
  expect(within(region).getAllByRole('listitem')).toHaveLength(3);
  expect(within(region).getAllByText(/用户操作/)).toHaveLength(3);
  expect(within(region).getAllByText(/上海时间/)).toHaveLength(3);
  expect(within(region).getByRole('link', { name: '查看生活记录' })).toHaveAttribute('href', '/companions/1?tab=life#life-journal');
  expect(api.characterOverview).toHaveBeenCalledTimes(1);
});

it('shows honest empty history and supports old overview responses', async () => {
  vi.stubEnv('NEXT_PUBLIC_LIFE_JOURNAL', 'true');
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview(overview)]);
  render(<Collection />);
  expect(await screen.findByText('还没有手动生活记录')).toBeVisible();
});

it('keeps the main homepage unchanged when the journal flag is off', async () => {
  vi.stubEnv('NEXT_PUBLIC_LIFE_JOURNAL', 'false');
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview({ ...overview, recent_activity: facts })]);
  render(<Collection />);
  await screen.findByRole('article', { name: '小叶' });
  expect(screen.queryByText('最近生活记录')).not.toBeInTheDocument();
});

it.each([
  { recent_activity: null },
  { recent_activity: [...facts, facts[0]] },
  { recent_activity: [...facts].reverse() },
  { recent_activity: [{ ...facts[0], source: 'simulation' }] },
  { recent_activity: [{ ...facts[0], occurred_at: '2026-09-22T02:30:00' }] },
  { recent_activity: [{ ...facts[0], text: '' }] },
  { residence: null, recent_activity: facts },
  { residence: { ...overview.residence, mode: 'shared' }, recent_activity: facts },
])('rejects untrustworthy recent activity', changes => {
  expect(() => parseCharacterOverview({ ...overview, ...changes })).toThrow();
});


it('remembers the actual card only for ordinary navigation, not modified clicks or buttons', async () => {
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview(overview)]);
  render(<Collection />); const card = await screen.findByRole('article', { name: '小叶' });
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: -80 } as DOMRect);
  const link = within(card).getByRole('link', { name: '聊聊天' }); link.addEventListener('click', e => e.preventDefault());
  fireEvent.click(link, { ctrlKey: true }); expect(readCollectionPosition('test')).toBeNull();
  fireEvent.click(card); expect(readCollectionPosition('test')).toBeNull();
  fireEvent.click(link); expect(readCollectionPosition('test')).toMatchObject({ companionId: 1, offset: -80 });
});
it('restores the same companion after reordering and consumes the anchor only once', async () => {
  rememberCollectionPosition('test', 1, 80);
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 900 } as DOMRect);
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview({ ...overview, character: { ...character, id: 2, name: '先出现的伙伴' } }), parseCharacterOverview(overview)]);
  const view = render(<Collection />); const card = await screen.findByRole('article', { name: '小叶' });
  await waitFor(() => expect(card).toHaveFocus());
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 820, behavior: 'instant' }); expect(readCollectionPosition('test')).toBeNull();
  view.rerender(<Collection />); expect(scroll).toHaveBeenCalledOnce();
});
it('keeps the anchor through a failed list read and restores after retry succeeds', async () => {
  rememberCollectionPosition('test', 1, 80); vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'characterOverview').mockRejectedValueOnce(new Error('读取失败')).mockResolvedValueOnce([parseCharacterOverview(overview)]);
  render(<Collection />); const alert = await screen.findByRole('alert'); expect(readCollectionPosition('test')).not.toBeNull();
  fireEvent.click(within(alert).getByRole('button'));
  await waitFor(() => expect(screen.getByRole('article', { name: '小叶' })).toHaveFocus());
  expect(readCollectionPosition('test')).toBeNull();
});
it('falls back to the list heading if the saved companion no longer exists', async () => {
  rememberCollectionPosition('test', 999, 80); const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview(overview)]);
  render(<Collection />); await screen.findByRole('article', { name: '小叶' });
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start' }));
  expect(scroll).not.toHaveBeenCalled(); expect(readCollectionPosition('test')).toBeNull();
});
it('does not apply an anchor from another account to this list', async () => {
  rememberCollectionPosition('someone-else', 1, 80); const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview(overview)]);
  render(<Collection />); await screen.findByRole('article', { name: '小叶' });
  expect(scroll).not.toHaveBeenCalled(); expect(readCollectionPosition('test')).toBeNull();
});


it('uses a visible card offset when returning at a different viewport width', async () => {
  rememberCollectionPosition('test', 1, -200); vi.stubGlobal('innerWidth', 390);
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 900 } as DOMRect);
  vi.spyOn(api, 'characterOverview').mockResolvedValue([parseCharacterOverview(overview)]);
  render(<Collection />); await screen.findByRole('article', { name: '小叶' });
  await waitFor(() => expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 876, behavior: 'instant' }));
});
