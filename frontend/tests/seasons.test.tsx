import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import SeasonSettingsPanel from '@/components/season-settings';
import { parseSeason, seasonApi, seasonPalette, type SeasonSnapshot } from '@/lib/seasons';

vi.mock('@/lib/seasons', async original => ({ ...await original<typeof import('@/lib/seasons')>(), seasonApi: { read: vi.fn(), preview: vi.fn(), save: vi.fn() } }));
const empty: SeasonSnapshot = { settings: null, current_season: null, revision: 0, started_at: null, next_change_at: null, observed_at: 100, timezone: 'Asia/Shanghai' };
const autumn: SeasonSnapshot = { ...empty, settings: { mode: 'virtual', weeks: 2, start_season: 'autumn' }, current_season: 'autumn', started_at: 100, next_change_at: 1209700 };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(seasonApi.read).mockResolvedValue(empty); vi.mocked(seasonApi.preview).mockResolvedValue(autumn); vi.mocked(seasonApi.save).mockResolvedValue({ ...autumn, revision: 1 }); });
async function open() {
  await waitFor(() => expect(screen.getByRole('button', { name: '设置四季' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '设置四季' }));
}
function choose() {
  fireEvent.click(screen.getByLabelText('虚拟四季'));
  fireEvent.change(screen.getByLabelText('每季多久'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('从哪个季节开始'), { target: { value: 'autumn' } });
}
it('does not preselect, and postponing does not persist anything', async () => {
  render(<SeasonSettingsPanel spaceId="one" onSeason={vi.fn()} />);
  await open();
  for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  expect(screen.getByRole('button', { name: '预览效果' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('虚拟四季'));
  expect(screen.getByLabelText('每季多久')).toHaveValue('');
  expect(screen.getByLabelText('从哪个季节开始')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '稍后选择' }));
  expect(seasonApi.preview).not.toHaveBeenCalled(); expect(seasonApi.save).not.toHaveBeenCalled();
});
it('applies only the confirmed result and invalidates a preview when choices change', async () => {
  const changed = vi.fn(); render(<SeasonSettingsPanel spaceId="one" onSeason={changed} />);
  await open(); choose();
  fireEvent.click(screen.getByRole('button', { name: '预览效果' }));
  await screen.findByRole('button', { name: '确认设置' });
  expect(changed).toHaveBeenLastCalledWith(null);
  fireEvent.change(screen.getByLabelText('每季多久'), { target: { value: '1' } });
  expect(screen.queryByRole('button', { name: '确认设置' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('每季多久'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: '预览效果' }));
  fireEvent.click(await screen.findByRole('button', { name: '确认设置' }));
  await screen.findByText('四季已保存，场景现在生效。');
  expect(changed).toHaveBeenLastCalledWith('autumn'); expect(seasonApi.save).toHaveBeenCalledTimes(1);
});
it('reconciles an uncertain write instead of silently resending it', async () => {
  vi.mocked(seasonApi.save).mockRejectedValueOnce(new Error('timeout'));
  vi.mocked(seasonApi.read).mockResolvedValueOnce(empty).mockResolvedValue({ ...autumn, revision: 1 });
  render(<SeasonSettingsPanel spaceId="one" onSeason={vi.fn()} />);
  await open(); choose(); fireEvent.click(screen.getByRole('button', { name: '预览效果' }));
  fireEvent.click(await screen.findByRole('button', { name: '确认设置' }));
  await screen.findByText('已核对：四季设置已保存。');
  expect(seasonApi.save).toHaveBeenCalledTimes(1); expect(seasonApi.read).toHaveBeenCalledTimes(2);
});
it('keeps an active preview when the user switches away and returns', async () => {
  render(<SeasonSettingsPanel spaceId="one" onSeason={vi.fn()} />);
  await open(); choose();
  fireEvent.click(screen.getByRole('button', { name: '预览效果' }));
  await screen.findByRole('button', { name: '确认设置' });
  fireEvent.focus(window);
  fireEvent(document, new Event('visibilitychange'));
  expect(seasonApi.read).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '确认设置' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '确认设置' }));
  await screen.findByText('四季已保存，场景现在生效。');
  expect(seasonApi.save).toHaveBeenCalledTimes(1);
});
it('offers read retry after both save and reconciliation fail', async () => {
  vi.mocked(seasonApi.save).mockRejectedValueOnce(new Error('timeout'));
  vi.mocked(seasonApi.read).mockResolvedValueOnce(empty).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ...autumn, revision: 1 });
  render(<SeasonSettingsPanel spaceId="one" onSeason={vi.fn()} />);
  await open(); choose(); fireEvent.click(screen.getByRole('button', { name: '预览效果' }));
  fireEvent.click(await screen.findByRole('button', { name: '确认设置' }));
  await screen.findByText(/暂时无法确认保存结果/);
  expect(screen.getByRole('button', { name: '预览效果' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '核对设置' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(seasonApi.save).toHaveBeenCalledTimes(1);
});
it('aborts a pending read when leaving and ignores its late result', async () => {
  let resolve!: (s: SeasonSnapshot) => void;
  vi.mocked(seasonApi.read).mockImplementation(() => new Promise(r => { resolve = r; }));
  const changed = vi.fn(); const view = render(<SeasonSettingsPanel spaceId="one" onSeason={changed} />);
  await waitFor(() => expect(seasonApi.read).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(seasonApi.read).mock.calls[0][1]!;
  view.unmount(); expect(signal.aborted).toBe(true);
  resolve(autumn); await Promise.resolve(); expect(changed).not.toHaveBeenCalled();
});
it('rejects broken contracts and keeps the desert distinct in winter', () => {
  expect(() => parseSeason({ ...empty, current_season: 'spring' })).toThrow();
  expect(() => parseSeason({ ...autumn, settings: { mode: 'virtual', weeks: '2', start_season: 'autumn' } })).toThrow();
  expect(seasonPalette('desert', 'winter')).not.toEqual(seasonPalette('home', 'winter'));
  expect(seasonPalette('home', null)).toBeNull();
});
