import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PublicationDialog from '@/components/publication-dialog';
import ThemeWall from '@/components/theme-wall';
import { parseWorkPage, parsePreview, wallApi } from '@/lib/wall';

const preview = { name: '小苹果', introduction: '温柔的小伙伴', author_name: '小小创作者', theme_id: 'fruit', image_url: '/uploads/apple.png', publication_id: null };
const pid = '11111111-1111-4111-8111-111111111111';
const work = { name: '小苹果', introduction: '温柔的小伙伴', author_name: '小桃', theme_id: 'fruit', image_url: `/api/v1/themes/fruit/works/${pid}/image`, id: pid, published_at: '2026-09-21T00:00:00' };
beforeEach(() => {
  vi.restoreAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});

it('preview is read-only; cancel never publishes', async () => {
  vi.spyOn(wallApi, 'preview').mockResolvedValue(preview);
  const publish = vi.spyOn(wallApi, 'publish'), close = vi.fn();
  render(<PublicationDialog characterId={1} close={close} />);
  await screen.findByText('当前状态：仅自己可见');
  expect(publish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(close).toHaveBeenCalledOnce();
  expect(publish).not.toHaveBeenCalled();
});
it('requires explicit confirmation and locks double clicks', async () => {
  vi.spyOn(wallApi, 'preview').mockResolvedValue(preview);
  const publish = vi.spyOn(wallApi, 'publish').mockResolvedValue({ ...preview, publication_id: pid });
  render(<PublicationDialog characterId={1} close={vi.fn()} />);
  const button = await screen.findByRole('button', { name: '确认发布' });
  fireEvent.click(button); fireEvent.click(button);
  await screen.findByText('当前状态：已公开');
  expect(publish).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('link', { name: '查看公开作品' })).toHaveAttribute('href', `/themes/fruit?work=${pid}`);
});
it('unknown write outcome blocks retry until server status is checked', async () => {
  vi.spyOn(wallApi, 'preview').mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error('离线')).mockResolvedValueOnce({ ...preview, publication_id: pid });
  const publish = vi.spyOn(wallApi, 'publish').mockRejectedValue(new Error('连接中断'));
  render(<PublicationDialog characterId={1} close={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '确认发布' }));
  const check = await screen.findByRole('button', { name: '核对发布状态' });
  await waitFor(() => expect(check).not.toBeDisabled());
  expect(screen.queryByRole('button', { name: '确认发布' })).not.toBeInTheDocument();
  fireEvent.click(check);
  await screen.findByText('当前状态：已公开');
  expect(publish).toHaveBeenCalledTimes(1);
});
it('withdraw updates visibility without deleting the companion', async () => {
  vi.spyOn(wallApi, 'preview').mockResolvedValue({ ...preview, publication_id: pid });
  const withdraw = vi.spyOn(wallApi, 'withdraw').mockResolvedValue(null);
  render(<PublicationDialog characterId={1} close={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '撤下作品，保留伙伴' }));
  await screen.findByText('已撤下，伙伴仍在你的收藏里');
  expect(withdraw).toHaveBeenCalledWith(1);
  expect(screen.getByText('当前状态：仅自己可见')).toBeInTheDocument();
});
it('invalid display names cannot be confirmed', async () => {
  vi.spyOn(wallApi, 'preview').mockResolvedValue(preview);
  render(<PublicationDialog characterId={1} close={vi.fn()} />);
  const input = await screen.findByLabelText('作品墙上的展示名');
  for (const name of [' ', '13900000088', '长'.repeat(21)]) {
    fireEvent.change(input, { target: { value: name } });
    expect(screen.getByRole('button', { name: '确认发布' })).toBeDisabled();
  }
});
it('wall shows actual count and preserves list when a detail is revoked', async () => {
  vi.spyOn(wallApi, 'list').mockResolvedValue({ items: [work], total: 1, next_offset: null });
  vi.spyOn(wallApi, 'detail').mockRejectedValue(new Error('这份作品已撤下或暂不可见'));
  render(<ThemeWall theme="fruit" />);
  await screen.findByText('1 份公开作品');
  fireEvent.click(screen.getByRole('button', { name: '查看小苹果的作品' }));
  await screen.findByText('这份作品已撤下或暂不可见');
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(screen.getByRole('button', { name: '查看小苹果的作品' })).toBeInTheDocument();
});
it('wall retries errors and shows honest empty state', async () => {
  vi.spyOn(wallApi, 'list').mockRejectedValueOnce(new Error('暂不可用')).mockResolvedValueOnce({ items: [], total: 0, next_offset: null });
  render(<ThemeWall theme="fruit" />);
  await screen.findByText('暂不可用');
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
  await screen.findByText('0 份公开作品');
  expect(screen.getByText('第一份奇遇，等你分享')).toBeInTheDocument();
});
it('pagination deduplicates moving lists and missing images have a fallback', async () => {
  vi.spyOn(wallApi, 'list').mockResolvedValueOnce({ items: [work], total: 2, next_offset: 1 }).mockResolvedValueOnce({ items: [work, { ...work, id: 'second', name: '另一位' }], total: 2, next_offset: null });
  render(<ThemeWall theme="fruit" />);
  fireEvent.click(await screen.findByRole('button', { name: '再看看更多伙伴' }));
  await screen.findByRole('button', { name: '查看另一位的作品' });
  expect(screen.getAllByRole('button', { name: '查看小苹果的作品' })).toHaveLength(1);
  fireEvent.error(screen.getByRole('img', { name: '小苹果' }));
  expect(screen.getByText('形象暂时看不到')).toBeInTheDocument();
});
it('public response rejects private image paths, unsafe URLs and invalid counts', () => {
  expect(() => parseWorkPage({ items: [{ ...work, image_url: '/uploads/private.png' }], total: 1, next_offset: null })).toThrow();
  expect(() => parseWorkPage({ items: [], total: -1, next_offset: null })).toThrow();
  expect(() => parsePreview({ ...preview, image_url: 'https://elsewhere/image' })).toThrow();
  expect(() => parsePreview({ ...preview, publication_id: false })).toThrow();
});
it('restores loaded pages and list position before showing the returned private preview', async () => {
  const { setToken } = await import('@/lib/auth'); setToken('synthetic-return-session');
  window.history.replaceState(null, '', '/themes/fruit?resume=1&preview=10');
  sessionStorage.setItem('creation-position:/themes/fruit', JSON.stringify({ y: 480, offset: 24 }));
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const list = vi.spyOn(wallApi, 'list').mockResolvedValueOnce({ items: [work], total: 2, next_offset: 24 }).mockResolvedValueOnce({ items: [{ ...work, id: 'second', name: '小橘子' }], total: 2, next_offset: null });
  vi.spyOn(wallApi, 'preview').mockResolvedValue(preview); const publish = vi.spyOn(wallApi, 'publish');
  render(<ThemeWall theme="fruit" initialPreview={10} resume />);
  await screen.findByText('当前状态：仅自己可见');
  await waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: 480, behavior: 'instant' }));
  expect(list).toHaveBeenCalledTimes(2); expect(list).toHaveBeenLastCalledWith('fruit', 24, expect.any(AbortSignal));
  expect(screen.getByRole('button', { name: '查看小橘子的作品' })).toBeInTheDocument(); expect(publish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭' })); expect(window.location.search).not.toContain('preview=');
});
it('asks for login before private preview and keeps publication explicit', async () => {
  const { clearToken } = await import('@/lib/auth'); clearToken();
  vi.spyOn(wallApi, 'list').mockResolvedValue({ items: [], total: 0, next_offset: null });
  const read = vi.spyOn(wallApi, 'preview'), publish = vi.spyOn(wallApi, 'publish');
  render(<ThemeWall theme="fruit" initialPreview={10} />);
  expect(await screen.findByRole('button', { name: '注册 / 登录' })).toBeVisible();
  expect(read).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
});
