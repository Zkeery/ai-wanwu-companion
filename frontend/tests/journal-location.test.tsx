import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LifeJournal from '@/components/life-journal';
import LivingScene from '@/components/living-scene';
import { api } from '@/lib/api';
import { clearToken, setToken } from '@/lib/auth';
import { parseJournal, readJournal, type JournalPage } from '@/lib/life-journal';
import type { LivingItem, LivingSpace } from '@/lib/contracts';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/season-settings', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/lib/life-journal', async original => ({ ...await original<typeof import('@/lib/life-journal')>(), readJournal: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
const firstId = '11111111-1111-4111-8111-111111111111', targetId = '22222222-2222-4222-8222-222222222222';
const tree: LivingItem = { id: targetId, kind: 'tree', x: .6, y: .5, stored: false, stage: 'planted', growth_seconds: 0, growth_status: 'needs_care', care_remaining_seconds: 0 };
const items = [{ ...tree, id: firstId, x: .2 }, tree];
const page: JournalPage = { space_id: 's', category: 'all', next_before_revision: null, events: [{ revision: 4, request_id: 'request', created_at: 100, source: 'user', action: 'care', target_kind: 'tree', target_item_id: targetId, weather: null }] };
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(readJournal).mockResolvedValue(page);
  vi.stubEnv('NEXT_PUBLIC_LIFE_JOURNAL', 'true');
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { vi.unstubAllEnvs(); });
async function openDetail() { fireEvent.click(await screen.findByRole('button', { name: '查看记录详情：照料了小树' })); }

it.each(['home', 'forest', 'desert'] as const)('locates the exact %s tree after closing detail without moving or entering edit mode', async scene_type => {
  const space: LivingSpace = { id: 's', scene_type, mode: 'private', companion_id: '6', revision: 4, observed_at: 100, can_undo: false, items };
  render(<LivingScene space={space} onChange={vi.fn()} />);
  await openDetail();
  fireEvent.click(screen.getByRole('button', { name: '去看看这个物件' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const selected = document.querySelector(`[data-living-item-id="${targetId}"]`)!;
  expect(selected).toHaveAttribute('aria-pressed', 'true'); expect(selected).toHaveFocus();
  expect(document.querySelector(`[data-living-item-id="${firstId}"]`)).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: '布置场景' })).toBeVisible();
  expect(screen.getByRole('region', { name: '小树成长详情' })).toBeVisible();
  expect(api.living.action).not.toHaveBeenCalled(); expect(api.living.space).not.toHaveBeenCalled();
  expect(readJournal).toHaveBeenCalledTimes(1);
});

it.each([
  [[{ ...tree, stored: true }], '原物件已收纳'],
  [[], '这个物件已不在当前场景中'],
  [[{ ...tree, kind: 'bench' }], '原物件的资料暂时无法核对'],
] as const)('does not locate a stored, missing or mismatched target', async (currentItems, message) => {
  const locate = vi.fn();
  render(<LifeJournal spaceId="s" revision={4} items={currentItems as unknown as LivingItem[]} onLocate={locate} />);
  await openDetail();
  expect(screen.getByText(new RegExp(message))).toBeVisible();
  expect(screen.queryByRole('button', { name: '去看看这个物件' })).not.toBeInTheDocument();
  expect(locate).not.toHaveBeenCalled();
});

it('preserves old records and never substitutes another same-kind tree', async () => {
  vi.mocked(readJournal).mockResolvedValue({ ...page, events: [{ ...page.events[0], target_item_id: undefined }] });
  render(<LifeJournal spaceId="s" revision={4} items={items} onLocate={vi.fn()} />);
  await openDetail();
  expect(screen.getByText(/这条记录没有保存具体物件编号/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '去看看这个物件' })).not.toBeInTheDocument();
});

it('disables location during reconciliation and offline, and accepts a newer verified snapshot', async () => {
  const locate = vi.fn();
  const view = render(<LifeJournal spaceId="s" revision={4} items={items} onLocate={locate} />);
  await openDetail();
  let finish!: (p: JournalPage) => void;
  vi.mocked(readJournal).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  view.rerender(<LifeJournal spaceId="s" revision={5} items={items} onLocate={locate} />);
  const button = screen.getByRole('button', { name: '去看看这个物件' }); expect(button).toBeDisabled();
  fireEvent.click(button); expect(locate).not.toHaveBeenCalled();
  await act(async () => finish(page)); expect(button).toBeEnabled();
  vi.mocked(readJournal).mockRejectedValueOnce(new Error('offline'));
  view.rerender(<LifeJournal spaceId="s" revision={6} items={items} onLocate={locate} />);
  await screen.findByRole('alert'); expect(screen.getByRole('button', { name: '去看看这个物件' })).toBeDisabled();
});

it('uses current item state even when a selected record remains present', async () => {
  const locate = vi.fn();
  const view = render(<LifeJournal spaceId="s" revision={4} items={items} onLocate={locate} />);
  await openDetail();
  view.rerender(<LifeJournal spaceId="s" revision={4} items={[{ ...tree, stored: true }]} onLocate={locate} />);
  expect(screen.getByText(/原物件已收纳/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '去看看这个物件' })).not.toBeInTheDocument();
  view.rerender(<LifeJournal spaceId="s" revision={4} items={items} onLocate={locate} locatingDisabled />);
  expect(screen.getByRole('button', { name: '去看看这个物件' })).toBeDisabled();
});

it.each(['home', 'forest', 'desert'] as const)('provides no location in read-only %s or a hidden scene', async scene_type => {
  const space: LivingSpace = { id: 's', scene_type, mode: 'private', companion_id: '6', revision: 4, observed_at: 100, can_undo: false, items };
  const view = render(<LivingScene space={space} onChange={vi.fn()} readOnly />);
  await openDetail(); expect(screen.getByText(/当前页面仅供查看/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '去看看这个物件' })).not.toBeInTheDocument();
  view.rerender(<LivingScene space={space} onChange={vi.fn()} visible={false} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(api.living.action).not.toHaveBeenCalled();
});

it('removes old details on account changes before a target can be located', async () => {
  act(() => setToken('location-account-one'));
  const locate = vi.fn();render(<LifeJournal spaceId="s" revision={4} items={items} onLocate={locate} />);
  await openDetail();
  vi.mocked(readJournal).mockResolvedValueOnce({ ...page, events: [] });
  act(() => setToken('location-account-two'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(locate).not.toHaveBeenCalled();act(() => clearToken());
});

it.each(['invalid-id', 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF', 123, '', false])('rejects a malformed target ID %s', id => {
  expect(() => parseJournal({ ...page, events: [{ ...page.events[0], target_item_id: id }] }, 's')).toThrow();
});
it('accepts omitted or null old IDs and rejects identity on whole-scene actions', () => {
  for (const id of [undefined, null]) expect(parseJournal({ ...page, events: [{ ...page.events[0], target_item_id: id }] }, 's')).toBeDefined();
  for (const action of ['layout', 'undo', 'atmosphere']) {
    const event = { ...page.events[0], action, target_kind: null, weather: action === 'atmosphere' ? 'rain' : null };
    expect(() => parseJournal({ ...page, events: [event] }, 's')).toThrow();
  }
});
