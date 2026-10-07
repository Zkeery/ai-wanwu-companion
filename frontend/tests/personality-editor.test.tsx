import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PersonalityEditor from '@/components/personality-editor';
import { ApiError } from '@/lib/api';
import { normalizeDraft, parseCatalog, parsePersonality, personalityApi, personalityPreview, type Personality, type PersonalityCatalog } from '@/lib/personality';
vi.mock('@/components/common', () => ({ Modal: ({ children, close }: { children: React.ReactNode; close: () => void }) => <div><button onClick={close}>弹窗关闭</button>{children}</div> }));
vi.mock('@/lib/personality', async original => ({ ...await original<typeof import('@/lib/personality')>(), personalityApi: { read: vi.fn(), catalog: vi.fn(), save: vi.fn() } }));
const base: Personality = { character_id: 12, original_persona: '最初温柔', effective_persona: '最初温柔', revision: 0, mode: 'original', tags: [], custom_text: '', priority: null };
const catalog: PersonalityCatalog = { catalog_version: 1, max_custom_length: 300, options: [
  { id: 'gentle', label: '温柔体贴', group: '推荐' }, { id: 'rational', label: '冷静理性', group: '情绪' }, { id: 'fiery', label: '暴躁易怒', group: '情绪' }, { id: 'quiet', label: '安静内敛', group: '推荐' }, { id: 'introverted', label: '内向安静', group: '社交' },
], conflicts: [['rational', 'fiery']] };
const saved: Personality = { ...base, revision: 1, mode: 'custom', tags: ['gentle'], effective_persona: '温柔体贴' };
const saveButton = () => screen.getByRole('button', { name: /^(保存性格|已保存|待核对)$/ });
const choose = (value: string) => fireEvent.change(screen.getByLabelText(/添加性格/), { target: { value } });
const custom = (value: string) => fireEvent.change(screen.getByLabelText('也可以自己描述'), { target: { value } });
async function open() { const close = vi.fn(), onSaved = vi.fn(); render(<PersonalityEditor id={12} onSaved={onSaved} close={close} />); await screen.findByLabelText(/添加性格/); return { close, onSaved }; }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(personalityApi.read).mockResolvedValue(base); vi.mocked(personalityApi.catalog).mockResolvedValue(catalog); vi.mocked(personalityApi.save).mockResolvedValue(saved); });
it('previews and cancels without mutation', async () => {
  const { close } = await open(); choose('gentle'); expect(screen.getByText('温柔体贴', { selector: '.personality-preview p' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(close).toHaveBeenCalledOnce(); expect(personalityApi.save).not.toHaveBeenCalled();
});
it('saves with version and can edit again without redrawing', async () => {
  const { onSaved } = await open(); choose('gentle'); fireEvent.click(saveButton());
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('温柔体贴'));
  expect(personalityApi.save).toHaveBeenCalledExactlyOnceWith(12, { mode: 'custom', tags: ['gentle'], custom_text: '', priority: null, expected_revision: 0 });
  expect(saveButton()).toBeDisabled(); expect(saveButton()).toHaveTextContent('已保存'); expect(screen.getByRole('button', { name: '完成' })).toBeEnabled(); expect(screen.getByRole('status').closest('.personality-footer')).not.toBeNull(); choose('rational'); expect(saveButton()).toBeEnabled();
});
it('deduplicates and explains synonymous choices', async () => {
  await open(); choose('gentle'); choose('gentle'); expect(screen.getByRole('status')).toHaveTextContent('已经选过');
  choose('quiet'); choose('introverted'); expect(screen.getByRole('status')).toHaveTextContent('合并'); expect(screen.queryByRole('button', { name: '移除安静内敛' })).not.toBeInTheDocument();
});
it('blocks obvious conflicts but lets the user remove one', async () => {
  await open(); choose('rational'); choose('fiery'); expect(saveButton()).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('方向不同');
  fireEvent.click(screen.getByRole('button', { name: '移除暴躁易怒' })); expect(saveButton()).toBeEnabled();
});
it('validates custom Unicode length and requires explicit mixed priority', async () => {
  await open(); custom(' '); expect(saveButton()).toBeDisabled(); custom('🍎'.repeat(301)); expect(saveButton()).toBeDisabled();
  custom('🍎'.repeat(300)); expect(saveButton()).toBeEnabled(); choose('gentle'); expect(saveButton()).toBeDisabled();
  fireEvent.change(screen.getByLabelText('性格主次'), { target: { value: 'custom' } }); expect(saveButton()).toBeEnabled();
  expect(screen.getByText(/以自定义为主/, { selector: '.personality-preview p' })).toHaveTextContent('🍎'.repeat(300));
});
it('reset is previewed and only saved by explicit action', async () => {
  vi.mocked(personalityApi.read).mockResolvedValue(saved); await open();
  fireEvent.click(screen.getByRole('button', { name: '恢复最初性格（保存后生效）' })); expect(personalityApi.save).not.toHaveBeenCalled();
  expect(screen.getByText('最初温柔', { selector: '.personality-preview p' })).toBeVisible(); fireEvent.click(saveButton());
  await waitFor(() => expect(personalityApi.save).toHaveBeenCalledWith(12, { expected_revision: 1, mode: 'original', tags: [], custom_text: '', priority: null }));
});
it('recovers a lost success response by reading without retrying PATCH', async () => {
  const { onSaved } = await open(); vi.mocked(personalityApi.save).mockRejectedValue(new Error('断线')); choose('gentle'); fireEvent.click(saveButton());
  fireEvent.click(await screen.findByRole('button', { name: '核对保存结果' }));
  await screen.findByRole('button', { name: '使用服务器版本' }); expect(saveButton()).toBeDisabled();
  vi.mocked(personalityApi.read).mockResolvedValue(saved); fireEvent.click(screen.getByRole('button', { name: '核对保存结果' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('温柔体贴')); expect(personalityApi.save).toHaveBeenCalledTimes(1);
});
it('keeps local draft on conflict and uses latest version only after acknowledgement', async () => {
  await open(); choose('gentle'); vi.mocked(personalityApi.save).mockRejectedValue(new ApiError('其他页面更新', 409, 'personality_conflict')); fireEvent.click(saveButton());
  await screen.findByRole('button', { name: '核对保存结果' }); vi.mocked(personalityApi.read).mockResolvedValue({ ...base, revision: 3, effective_persona: '他处已改' });
  fireEvent.click(screen.getByRole('button', { name: '核对保存结果' })); fireEvent.click(await screen.findByRole('button', { name: '保留我的草稿，继续编辑' }));
  expect(saveButton()).toBeEnabled(); fireEvent.click(saveButton()); await waitFor(() => expect(personalityApi.save).toHaveBeenLastCalledWith(12, expect.objectContaining({ expected_revision: 3, tags: ['gentle'] })));
});
it('can discard local draft for the server state after conflict', async () => {
  const { onSaved } = await open(); choose('gentle'); vi.mocked(personalityApi.save).mockRejectedValue(new ApiError('冲突', 409, 'personality_conflict')); fireEvent.click(saveButton());
  fireEvent.click(await screen.findByRole('button', { name: '核对保存结果' })); fireEvent.click(await screen.findByRole('button', { name: '使用服务器版本' }));
  expect(saveButton()).toBeDisabled(); expect(screen.queryByRole('button', { name: '移除温柔体贴' })).not.toBeInTheDocument(); expect(onSaved).toHaveBeenCalledWith(base.effective_persona);
});
it('load failure retries instead of editing empty state', async () => {
  vi.mocked(personalityApi.read).mockRejectedValueOnce(new Error('读取失败'));
  render(<PersonalityEditor id={12} onSaved={vi.fn()} close={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '重新加载性格' })); await screen.findByLabelText(/添加性格/); expect(saveButton()).toBeDisabled();
});
it('blocks duplicate saves and close while response is pending', async () => {
  const { close } = await open(); vi.mocked(personalityApi.save).mockImplementation(() => new Promise(() => {})); choose('gentle'); fireEvent.click(saveButton());
  fireEvent.click(screen.getByRole('button', { name: '保存中…' })); fireEvent.click(screen.getByRole('button', { name: '弹窗关闭' }));
  expect(personalityApi.save).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
});
it('rejects malformed contracts and keeps effective text stable', () => {
  expect(parsePersonality(base)).toEqual(base); expect(() => parsePersonality({ ...base, revision: -1 })).toThrow();
  expect(() => parseCatalog({ ...catalog, options: [...catalog.options, catalog.options[0]] })).toThrow();
  expect(() => parseCatalog({ ...catalog, conflicts: [['nonexistent', 'gentle']] })).toThrow();
  const d = normalizeDraft({ ...saved, tags: ['quiet', 'introverted'], custom_text: ' 安静🍎 ', priority: 'custom' });
  expect(d.tags).toEqual(['introverted']); expect(personalityPreview(d, catalog, base.original_persona)).toBe('以自定义为主；另一项作为不冲突的补充。\n预设：内向安静\n自定义： 安静🍎 ');
});
