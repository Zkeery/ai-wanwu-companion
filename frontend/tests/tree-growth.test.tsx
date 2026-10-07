import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TreeGrowthCard from '@/components/tree-growth';
import LivingScene from '@/components/living-scene';
import type { LivingItem, LivingSpace } from '@/lib/contracts';
import { api } from '@/lib/api';

vi.mock('@/components/season-settings', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/life-journal', () => ({ default: () => null }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
const tree: LivingItem = { id: 'tree', kind: 'tree', x: .5, y: .5, stored: false, stage: 'planted', growth_seconds: 0, growth_status: 'needs_care', care_remaining_seconds: 0 };
const sample = (scene_type: LivingSpace['scene_type']): LivingSpace => ({ id: scene_type, scene_type, mode: 'private', companion_id: '1', revision: 2, observed_at: 1790500000, can_undo: true, items: [tree] });
const button = (name: string) => screen.getByRole('button', { name });
const selectTree = (scene: string) => fireEvent.click(within(screen.getByRole('group', { name: scene === 'desert' ? '绿洲沙地' : '场景' })).getByRole('button'));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([
  [0, '0%', '72 小时'], [36 * 3600, '50%', '36 小时'], [72 * 3600 - 1, '99%', '1 分钟'],
])('uses saved effective growth %s, never promises a calendar completion', (seconds, percent, remaining) => {
  render(<TreeGrowthCard item={{ ...tree, growth_seconds: Number(seconds) }} observedAt={1790500000} />);
  expect(screen.getByText(percent)).toBeVisible();
  expect(screen.getByText(`还需 ${remaining}有效成长。`)).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', String(seconds));
  expect(screen.getByText(/不会枯萎/)).toBeVisible();
});

it('keeps a snapshot stable when the browser clock advances, then accepts an updated server result', () => {
  vi.useFakeTimers();
  const item = { ...tree, growth_seconds: 3600, growth_status: 'growing' as const, care_remaining_seconds: 3600 };
  const view = render(<TreeGrowthCard item={item} observedAt={1790500000} />);
  act(() => { vi.advanceTimersByTime(72 * 3600 * 1000); });
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '3600');
  expect(screen.getByText('照料有效 · 剩约 1 小时')).toBeVisible();
  view.rerender(<TreeGrowthCard item={{ ...item, growth_seconds: 7200, care_remaining_seconds: 0, growth_status: 'needs_care' }} observedAt={1790503600} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '7200');
  expect(screen.getByText('等你来照料')).toBeVisible();
});

it.each([false, true])('mature trees do not request more care, including stored=%s', stored => {
  render(<TreeGrowthCard item={{ ...tree, stored, stage: 'mature', growth_seconds: 72 * 3600, growth_status: 'mature' }} observedAt={1790500000} onCare={vi.fn()} />);
  expect(screen.getByText('100%')).toBeVisible();
  expect(screen.getByText(/不用再浇水/)).toBeVisible();
  if (stored) expect(screen.queryByRole('button', { name: '照料' })).toBeNull();
  else expect(button('照料')).toBeDisabled();
});

it('stored growth remains readable without granting care or restore actions', () => {
  const care = vi.fn();
  render(<TreeGrowthCard item={{ ...tree, stored: true, growth_seconds: 3600, growth_status: 'stored' }} observedAt={1790500000} onCare={care} />);
  expect(screen.getByText('收纳中，成长暂停')).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '3600');
  expect(screen.queryByRole('button')).toBeNull();
  expect(care).not.toHaveBeenCalled();
});

it('decorative plants do not acquire invented growth or care controls', () => {
  render(<TreeGrowthCard item={{ ...tree, kind: 'cactus' }} observedAt={1790500000} onCare={vi.fn()} onRefresh={vi.fn()} />);
  expect(screen.queryByRole('region')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it.each(['home', 'forest', 'desert'] as const)('%s keeps selected growth after care, blocks double clicks and displays the saved result', async scene => {
  let finish!: (space: LivingSpace) => void;
  vi.mocked(api.living.action).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  function Harness() { const [space, setSpace] = useState(sample(scene)); return <LivingScene space={space} onChange={setSpace} />; }
  render(<Harness />); selectTree(scene);
  expect(screen.getByText('等你来照料')).toBeVisible();
  fireEvent.click(button('照料')); fireEvent.click(button('照料'));
  expect(api.living.action).toHaveBeenCalledExactlyOnceWith(scene, expect.any(String), 2, { action: 'care', item_id: 'tree' });
  expect(button('照料')).toBeDisabled();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0');
  await act(async () => finish({ ...sample(scene), revision: 3, items: [{ ...tree, care_remaining_seconds: 86400, growth_status: 'growing' }] }));
  expect(screen.getByText('照料已保存')).toBeVisible();
  expect(within(screen.getByRole('region', { name: '小树成长详情' })).getByText('照料有效 · 剩约 24 小时')).toBeVisible();
  expect(button('照料')).toBeDisabled();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0');
  vi.mocked(api.living.space).mockResolvedValue({ ...sample(scene), revision: 3, observed_at: 1790503600, items: [{ ...tree, stage: 'growing', growth_seconds: 3600, care_remaining_seconds: 82800, growth_status: 'growing' }] });
  fireEvent.click(button('更新成长状态'));
  await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('value', '3600'));
  expect(api.living.action).toHaveBeenCalledTimes(1);
});

it.each(['home', 'forest', 'desert'] as const)('%s failed care and failed reconciliation keep the snapshot and prevent another write until refreshed', async scene => {
  vi.mocked(api.living.action).mockRejectedValue(new Error('保存结果待核对'));
  vi.mocked(api.living.space).mockRejectedValue(new Error('暂时无法连接'));
  function Harness() { const [space, setSpace] = useState(sample(scene)); return <LivingScene space={space} onChange={setSpace} />; }
  render(<Harness />); selectTree(scene); fireEvent.click(button('照料'));
  await waitFor(() => expect(api.living.space).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(button('更新成长状态')).toBeEnabled());
  expect(button('照料')).toBeDisabled();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0');
  vi.mocked(api.living.space).mockResolvedValue(sample(scene));
  fireEvent.click(button('更新成长状态'));
  await waitFor(() => expect(button('照料')).toBeEnabled());
  expect(api.living.action).toHaveBeenCalledTimes(1);
});

it.each(['home', 'forest', 'desert'] as const)('%s hidden and read-only pages cannot keep a selected care control', scene => {
  const view = render(<LivingScene space={sample(scene)} onChange={vi.fn()} />); selectTree(scene);
  view.rerender(<LivingScene space={sample(scene)} onChange={vi.fn()} visible={false} />);
  expect(screen.queryByRole('button', { name: '照料' })).toBeNull();
  view.rerender(<LivingScene space={sample(scene)} onChange={vi.fn()} readOnly />);
  expect(screen.queryByRole('button', { name: '照料' })).toBeNull();
  expect(api.living.action).not.toHaveBeenCalled();
});
