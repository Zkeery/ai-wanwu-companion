import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import Themes from '@/components/themes';
import { api } from '@/lib/api';
import { parseThemes } from '@/lib/themes';
import { creationApi, generateCompanion, readDraft, DRAFT_KEY } from '@/lib/creation';

const themes = [{ id: 'fruit', title: '一份水果，一位新朋友', description: '苹果和橘子都可以', category: 'fruit' }];
it('shows topic, privacy and working links with no fake public wall', async () => {
  vi.spyOn(api, 'themes').mockResolvedValue(themes);
  render(<Themes />);
  expect(await screen.findByText('一份水果，一位新朋友')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '拍一份水果' })).toHaveAttribute('href', '/companions/new?theme=fruit');
  expect(screen.getByText('完成后只加入你的私人收藏')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '去自由创作' })).toHaveAttribute('href', '/companions/new');
});
it('offers retry on directory failure and an honest empty state', async () => {
  vi.spyOn(api, 'themes').mockRejectedValueOnce(new Error('目录暂时不可用')).mockResolvedValueOnce([]);
  render(<Themes />); await screen.findByText('目录暂时不可用');
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
  await screen.findByText('新的灵感还在路上');
});
it('validates theme directory and saved free-creation intent', () => {
  expect(() => parseThemes([{ ...themes[0], id: 12 }])).toThrow();
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ requestId: '11111111-1111-4111-8111-111111111111', themeId: 'fruit', freeCreation: 'true' }));
  expect(() => readDraft()).toThrow('保存的创作方式无法恢复');
  sessionStorage.clear();
});
it('sends the selected theme in multipart and explicit free mode in the generation request', async () => {
  const mock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, status: 'done', theme_id: 'fruit', objects: [{ id: 2, label: '苹果', category: 'fruit' }] })))
    .mockResolvedValueOnce(new Response('event: done\ndata: {"id":3,"name":"苹果","persona":"温柔","opening_line":"你好","image_path":null,"status":"ready","created_at":"","theme_id":null}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', mock);
  try {
    const signal = new AbortController().signal;
    await creationApi.upload(new File(['x'], 'apple.png'), 'key', signal, 'fruit');
    expect(mock.mock.calls[0][1].body.get('theme_id')).toBe('fruit');
    await generateCompanion(2, '苹果', signal, vi.fn(), '', true);
    expect(JSON.parse(mock.mock.calls[1][1].body)).toMatchObject({ object_id: 2, free_creation: true });
  } finally { vi.unstubAllGlobals(); }
});
