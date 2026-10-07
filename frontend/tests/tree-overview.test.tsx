import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import TreeOverview from '@/components/tree-overview';
import LivingScene from '@/components/living-scene';
import type { LivingItem, LivingSpace } from '@/lib/contracts';
vi.mock('@/components/season-settings', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/life-journal', () => ({ default: () => null }));
HTMLElement.prototype.scrollIntoView = vi.fn();
const tree: LivingItem = { id: 'tree', kind: 'tree', x: .5, y: .5, stored: false, stage: 'planted', growth_seconds: 0, growth_status: 'needs_care', care_remaining_seconds: 0 };
const space: LivingSpace = { id: 's', scene_type: 'home', mode: 'private', companion_id: '1', revision: 0, observed_at: 1790500000, can_undo: false, items: [tree, { ...tree, id: 'g', growth_status: 'growing', growth_seconds: 3600, care_remaining_seconds: 3600 }, { ...tree, id: 'm', stage: 'mature', growth_status: 'mature', growth_seconds: 259200 }, { ...tree, id: 's', stored: true, growth_status: 'stored' }, { ...tree, id: 'flower', kind: 'flower', growth_status: null }] };
it('counts only trees and locates an original ID without modifying a space', () => {
  const locate = vi.fn(), refresh = vi.fn();
  render(<TreeOverview space={space} onLocate={locate} onRefresh={refresh} />);
  expect(screen.getByRole('button', { name: '全部小树 · 4' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '需要照料 · 1' }));
  fireEvent.click(screen.getByRole('button', { name: '定位小树 1' }));
  expect(locate).toHaveBeenCalledWith('tree');
  fireEvent.click(screen.getByRole('button', { name: '更新植物状态' }));
  expect(refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '收纳中 · 1' }));
  expect(screen.getByText('进度保留着，摆回来后再看看。')).toBeVisible();
  expect(screen.queryByRole('button', { name: /定位/ })).not.toBeInTheDocument();
});
it('shows empty trees without inventing growth for decorations and disables uncertain positioning', () => {
  const view = render(<TreeOverview space={{ ...space, items: [{ ...tree, kind: 'cactus' }] }} />);
  expect(screen.getByText(/花丛和仙人掌是装饰/)).toBeVisible();
  view.rerender(<TreeOverview space={space} onLocate={vi.fn()} locatingDisabled />);
  expect(screen.getByRole('button', { name: '定位小树 1' })).toBeDisabled();
});
it.each(['home', 'forest', 'desert'] as const)('integrates the private %s panel and hides it with the scene', scene => {
  const selected = { ...space, scene_type: scene, items: [tree] };
  const view = render(<LivingScene space={selected} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '植物照料' }));
  fireEvent.click(screen.getByRole('button', { name: '定位小树 1' }));
  expect(screen.getByRole('button', { name: '布置场景' })).toBeVisible();
  expect(screen.getByRole('progressbar')).toBeVisible();
  view.rerender(<LivingScene space={selected} onChange={vi.fn()} visible={false} />);
  expect(screen.queryByRole('region', { name: '植物照料总览' })).not.toBeInTheDocument();
});
it.each(['home', 'forest', 'desert'] as const)('keeps %s read-only and does not offer item writes', scene => {
  render(<LivingScene space={{ ...space, scene_type: scene, items: [tree] }} onChange={vi.fn()} readOnly />);
  const overview = screen.getByRole('region', { name: '植物照料总览' });
  expect(within(overview).queryByRole('button', { name: /定位|照料小树/ })).not.toBeInTheDocument();
});
