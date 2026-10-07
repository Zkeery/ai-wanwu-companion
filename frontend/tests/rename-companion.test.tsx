import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import RenameCompanion from '@/components/rename-companion';
import { api } from '@/lib/api';
vi.mock('@/components/common', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { character: vi.fn(), renameCharacter: vi.fn() } }));
const character = { id: 12, name: '小杯', persona: '温柔', opening_line: '你好', status: 'ready' as const, image_path: null, created_at: '' };
beforeEach(() => vi.clearAllMocks());
it('validates empty and 40-character names then saves without generation', async () => {
  const changed = vi.fn(), close = vi.fn();
  vi.mocked(api.renameCharacter).mockResolvedValue({ ...character, name: '新名字' });
  render(<RenameCompanion character={character} onChange={changed} close={close} />);
  const field = screen.getByLabelText('伙伴名字');
  for (const name of ['   ', '🌱'.repeat(41)]) {
    fireEvent.change(field, { target: { value: name } });
    expect(screen.getByRole('button', { name: '保存名字' })).toBeDisabled();
  }
  fireEvent.change(field, { target: { value: ' 新名字 ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存名字' }));
  await waitFor(() => expect(api.renameCharacter).toHaveBeenCalledExactlyOnceWith(12, '新名字'));
  expect(changed).toHaveBeenCalledWith({ ...character, name: '新名字' });
  expect(close).toHaveBeenCalledTimes(1);
});
it('keeps the typed name after a lost response and queries before saving again', async () => {
  vi.mocked(api.renameCharacter).mockRejectedValue(new Error('连接中断'));
  vi.mocked(api.character).mockResolvedValue(character);
  render(<RenameCompanion character={character} onChange={vi.fn()} close={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('伙伴名字'), { target: { value: '新名字' } });
  fireEvent.click(screen.getByRole('button', { name: '保存名字' }));
  fireEvent.click(await screen.findByRole('button', { name: '核对名字' }));
  await screen.findByRole('button', { name: '保存名字' });
  expect(screen.getByLabelText('伙伴名字')).toHaveValue('新名字');
  expect(api.character).toHaveBeenCalledExactlyOnceWith(12);
  expect(api.renameCharacter).toHaveBeenCalledTimes(1);
});
