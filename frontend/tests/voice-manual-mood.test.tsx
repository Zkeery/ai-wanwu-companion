import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import VoiceCompanion from '@/components/voice-companion';
import { api } from '@/lib/api';
import { setToken, TOKEN_KEY } from '@/lib/auth';
import { inspectMoodText, moods, parseVoiceSettings, voiceApi } from '@/lib/voice';
import { startWavCapture } from '@/lib/pcm-recorder';

vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { character: vi.fn(), messages: vi.fn(), scene: vi.fn() } }));
vi.mock('@/lib/voice', async original => {
  const actual = await original<typeof import('@/lib/voice')>();
  return { ...actual, voiceApi: { ...actual.voiceApi, history: vi.fn(), receipts: vi.fn() } };
});
vi.mock('@/lib/pcm-recorder', async original => ({ ...await original<typeof import('@/lib/pcm-recorder')>(), startWavCapture: vi.fn() }));

type Settings = ReturnType<typeof parseVoiceSettings>;
const original = { voice: 'qwen:Cherry', mood: null, mood_text: null, automatic: true, mood_source: 'none', voices: [{ id: 'qwen:Cherry', label: 'Cherry' }], reply_origin: 'disabled' };
let stored: Map<string, Settings>;
let calls: { method: string; path: string; account: string; body: Record<string, unknown> | null }[];
let failSave = false;
let deferredSave: ((response: Response) => void) | null = null;
let deferSave = false;
function reply(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function selectMood(value: string) { fireEvent.change(screen.getByRole('combobox', { name: '我现在的心情' }), { target: { value } }); }
async function open() { const view = render(<VoiceCompanion id={1} />); await screen.findByRole('combobox', { name: '我现在的心情' }); return view; }
function save() { fireEvent.click(screen.getByRole('button', { name: '保存设置' })); }
function assertNoPaidRoutes() {
  expect(calls.every(c => c.path === '/api/v1/characters/1/voice/settings' && ['GET', 'PUT'].includes(c.method))).toBe(true);
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(startWavCapture).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear(); setToken('synthetic-A');
  vi.stubGlobal('crypto', webcrypto);
  stored = new Map(['synthetic-A', 'synthetic-B'].map(account => [account, parseVoiceSettings(original)]));
  calls = []; failSave = false; deferSave = false; deferredSave = null;
  vi.mocked(api.character).mockResolvedValue({ id: 1, name: '合成伙伴' } as Awaited<ReturnType<typeof api.character>>);
  vi.mocked(api.messages).mockResolvedValue([{ id: 1, role: 'assistant', content: '原来的已保存回复', created_at: '' }]);
  vi.mocked(api.scene).mockResolvedValue({ scene_name: '家庭庭院', elements: { rain: 0, tree: 0, cloud: 0, sound: 1 }, can_undo: false, proposal: null, feedback: null });
  vi.mocked(voiceApi.history).mockResolvedValue([]); vi.mocked(voiceApi.receipts).mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input), method = init.method ?? 'GET';
    const account = new Headers(init.headers).get('Authorization')?.replace('Bearer ', '') ?? '';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ method, path, account, body });
    if (path !== '/api/v1/characters/1/voice/settings' || !['GET', 'PUT'].includes(method)) throw new Error('Unexpected network route is forbidden');
    if (method === 'PUT') {
      if (failSave) { failSave = false; return reply({ error: { message: '设置保存失败', code: 'request_failed' } }, 503); }
      const saved = parseVoiceSettings({ ...stored.get(account), ...body, mood_source: body?.mood ? 'user' : 'none' });
      stored.set(account, saved);
      if (deferSave) return new Promise<Response>(resolve => { deferredSave = resolve; });
    }
    return reply(stored.get(account));
  }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

it('accepts old settings without mood_text and retains all old mood values', () => {
  const { mood_text: omitted, ...legacy } = original;
  expect(omitted).toBeNull();
  expect(parseVoiceSettings(legacy).mood_text).toBeNull();
  expect(['happy', 'calm', 'sad', 'tired', 'anxious', 'unsure'].every(value => value in moods)).toBe(true);
  expect(moods.irritated).toBe('有点烦'); expect(moods.custom).toBe('我想自己说');
});

it.each([0, false, {}, []])('rejects a malformed new mood_text field: %j', moodText => {
  expect(() => parseVoiceSettings({ ...original, mood_text: moodText })).toThrow('主动心情暂时无法读取');
});

it('counts trimmed Unicode characters without cutting a pasted draft or counting emoji twice', () => {
  expect(inspectMoodText(' \n' + '😀'.repeat(200) + '\t ')).toMatchObject({ length: 200, issue: null });
  expect(inspectMoodText('😀'.repeat(201)).length).toBe(201);
  expect(inspectMoodText('😀'.repeat(201)).issue).toContain('当前 201');
  expect(inspectMoodText(' \n\t ').issue).toContain('请写下');
  expect(inspectMoodText('\uFEFF感受\uFEFF').text).toBe('感受');
  expect(inspectMoodText('\u0085感受\u0085').text).toBe('\u0085感受\u0085');
});

it('normalizes custom settings at the HTTP boundary and clears mood_text for legacy four-argument saves', async () => {
  await voiceApi.save(1, 'qwen:Cherry', 'custom', false, '  今天想安静一会儿 😀  ');
  expect(calls.at(-1)?.body).toEqual({ voice: 'qwen:Cherry', mood: 'custom', automatic: false, mood_text: '今天想安静一会儿 😀' });
  await voiceApi.save(1, 'qwen:Cherry', 'calm', true);
  expect(calls.at(-1)?.body?.mood_text).toBeNull();
  await expect(voiceApi.save(1, 'qwen:Cherry', 'custom', true, ' \t ')).rejects.toThrow('请写下');
  expect(calls).toHaveLength(2); assertNoPaidRoutes();
});

it('saves, restores and edits a custom feeling without changing saved chat or requesting any audio', async () => {
  const view = await open(); selectMood('custom');
  const field = screen.getByRole('textbox', { name: '我想自己说' });
  fireEvent.change(field, { target: { value: '  忙完后有点空落落 😀  ' } });
  save(); await screen.findByText('当前心情和音色设定已保存。旧消息和已有音频保持原样。');
  expect(field).toHaveValue('忙完后有点空落落 😀');
  expect(stored.get('synthetic-A')?.mood_text).toBe('忙完后有点空落落 😀');
  expect(screen.getByText('原来的已保存回复')).toBeInTheDocument();
  view.unmount(); await open();
  expect(screen.getByRole('textbox', { name: '我想自己说' })).toHaveValue('忙完后有点空落落 😀');
  fireEvent.change(screen.getByRole('textbox', { name: '我想自己说' }), { target: { value: '现在好多了' } });
  save(); await waitFor(() => expect(stored.get('synthetic-A')?.mood_text).toBe('现在好多了'));
  expect([...Array(localStorage.length)].map((_, i) => localStorage.key(i))).toEqual([TOKEN_KEY]);
  expect([...Array(sessionStorage.length)].map((_, i) => sessionStorage.getItem(sessionStorage.key(i)!)).join('')).not.toContain('现在好多了');
  assertNoPaidRoutes();
});

it('blocks blank and oversized custom feelings, while 200 emoji remain valid', async () => {
  await open(); selectMood('custom');
  const field = screen.getByRole('textbox', { name: '我想自己说' });
  expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
  fireEvent.change(field, { target: { value: '😀'.repeat(201) } });
  expect(field).toHaveValue('😀'.repeat(201));
  expect(field).toHaveAttribute('aria-invalid', 'true');
  save(); expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0);
  fireEvent.change(field, { target: { value: '  ' + '😀'.repeat(200) + '  ' } });
  expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled();
  save(); await waitFor(() => expect(stored.get('synthetic-A')?.mood_text).toBe('😀'.repeat(200)));
  assertNoPaidRoutes();
});

it('keeps typed feelings after a save error and only commits a clear or different choice after success', async () => {
  stored.set('synthetic-A', parseVoiceSettings({ ...original, mood: 'custom', mood_text: '原设定', mood_source: 'user' }));
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: '我想自己说' }), { target: { value: '尚未保存的新感受' } });
  failSave = true; save(); await screen.findByText('设置保存失败');
  expect(screen.getByRole('textbox', { name: '我想自己说' })).toHaveValue('尚未保存的新感受');
  expect(stored.get('synthetic-A')?.mood_text).toBe('原设定');
  selectMood('irritated'); expect(screen.queryByRole('textbox', { name: '我想自己说' })).toBeNull();
  selectMood('custom'); expect(screen.getByRole('textbox', { name: '我想自己说' })).toHaveValue('');
  selectMood('irritated'); save(); await waitFor(() => expect(stored.get('synthetic-A')?.mood).toBe('irritated'));
  expect(stored.get('synthetic-A')?.mood_text).toBeNull();
  selectMood(''); save(); await waitFor(() => expect(stored.get('synthetic-A')?.mood).toBeNull());
  expect(calls.at(-1)?.body?.mood_text).toBeNull();
  assertNoPaidRoutes();
});

it('never brings an old account custom feeling into a new account after a late save response', async () => {
  await open(); selectMood('custom');
  fireEvent.change(screen.getByRole('textbox', { name: '我想自己说' }), { target: { value: 'A的私人感受' } });
  deferSave = true; save(); await waitFor(() => expect(deferredSave).toBeTypeOf('function'));
  act(() => setToken('synthetic-B'));
  await waitFor(() => expect(screen.getByRole('combobox', { name: '我现在的心情' })).toHaveValue(''));
  await act(async () => deferredSave!(reply(stored.get('synthetic-A'))));
  expect(screen.queryByDisplayValue('A的私人感受')).toBeNull();
  expect(screen.queryByText('当前心情和音色设定已保存。旧消息和已有音频保持原样。')).toBeNull();
  expect(stored.get('synthetic-B')?.mood_text).toBeNull();
  expect(calls.filter(c => c.account === 'synthetic-B' && c.method === 'PUT')).toHaveLength(0);
  assertNoPaidRoutes();
});
