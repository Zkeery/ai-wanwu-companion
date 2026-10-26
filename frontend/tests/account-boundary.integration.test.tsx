import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import SessionRecovery from '@/components/session-recovery';
import CreateCompanion from '@/components/create-companion';
import Companion from '@/components/companion';
import { ApiError, api } from '@/lib/api';
import { creationApi, DRAFT_KEY, generateCompanion } from '@/lib/creation';
import { getToken, setToken, TOKEN_KEY } from '@/lib/auth';
import { sendChat } from '@/lib/stream';
import { reserveChat } from '@/lib/chat-recovery';
import { readChatDraft, writeChatDraft } from '@/lib/chat-draft';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock('@/components/auth-modal', () => ({ default: ({ onLoggedIn }: { onLoggedIn: () => void }) => <button onClick={onLoggedIn}>完成测试登录</button> }));
vi.mock('@/components/companion-motion-preview', () => ({ default: () => null }));
vi.mock('@/components/recreate-companion', () => ({ default: () => null }));
vi.mock('@/components/garden', () => ({ default: () => <div>合成场景</div> }));
vi.mock('@/lib/stream', () => ({ sendChat: vi.fn() }));
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { auth: { me: vi.fn() }, generationCredits: vi.fn(), character: vi.fn(), characterOverview: vi.fn(), messages: vi.fn(), scene: vi.fn(), chatRequest: vi.fn() } };
});
vi.mock('@/lib/creation', async original => ({ ...await original<typeof import('@/lib/creation')>(), creationApi: { upload: vi.fn(), photo: vi.fn(), byObject: vi.fn(), receipt: vi.fn(), rename: vi.fn(), correction: vi.fn() }, generateCompanion: vi.fn() }));
const photo = { id: 101, status: 'done', objects: [{ id: 201, label: '合成白杯' }] };
const character = { id: 301, name: '账号A私有杯子', persona: '合成性格', opening_line: '合成开场', image_path: null, status: 'ready' as const, created_at: '' };
const scene = { scene_name: '合成庭院', elements: { rain: 0, tree: 0, cloud: 0, sound: 1 }, can_undo: false, feedback: null, proposal: null };
function evidence(id: string, value: object) {
  const out = process.env.BOUNDARY_EVIDENCE_DIR;
  if (!out) throw new Error('Missing isolated evidence path');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, id + '.json'), JSON.stringify(value, null, 2));
}
async function switchAccount(token: string) {
  const before = getToken();
  act(() => {
    localStorage.setItem(TOKEN_KEY, token);
    window.dispatchEvent(new StorageEvent('storage', { key: TOKEN_KEY, oldValue: before, newValue: token }));
  });
  fireEvent.click(await screen.findByRole('button', { name: '完成测试登录' }));
}
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear(); setToken('synthetic-account-A');
  window.history.replaceState(null, '', '/companions/301');
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  URL.createObjectURL = vi.fn(() => 'blob:boundary-synthetic'); URL.revokeObjectURL = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked fetch forbidden in boundary verification'); }));
  vi.mocked(api.auth.me).mockImplementation(async () => ({ id: getToken() === 'synthetic-account-A' ? 'A' : 'B', phone: '' }));
  vi.mocked(api.generationCredits).mockResolvedValue({ enabled: true, available: 5 });
  vi.mocked(creationApi.upload).mockResolvedValue(photo);
  vi.mocked(creationApi.photo).mockImplementation(async () => { if (getToken() !== 'synthetic-account-A') throw new ApiError('照片不存在', 404, 'not_found'); return photo; });
  vi.mocked(creationApi.byObject).mockResolvedValue(character);
  vi.mocked(api.character).mockImplementation(async () => { if (getToken() !== 'synthetic-account-A') throw new ApiError('角色不存在', 404, 'not_found'); return character; });
  vi.mocked(api.characterOverview).mockResolvedValue([]);
  vi.mocked(api.messages).mockResolvedValue([]);
  vi.mocked(api.scene).mockResolvedValue(scene);
  vi.mocked(api.chatRequest).mockResolvedValue('running');
});
it('F1: cross-tab account switch aborts a pending generation, ignores late A completion, and restores A only by reads', async () => {
  let finish!: (value: typeof character) => void;
  vi.mocked(generateCompanion).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<SessionRecovery><CreateCompanion /></SessionRecovery>);
  fireEvent.change(await screen.findByLabelText('选择照片'), { target: { files: [new File(['synthetic'], 'cup.png', { type: 'image/png' })] } });
  fireEvent.click(screen.getByRole('button', { name: '上传并生成伙伴' }));
  await waitFor(() => expect(generateCompanion).toHaveBeenCalledOnce());
  const signal = vi.mocked(generateCompanion).mock.calls[0][2];
  const originalDraft = sessionStorage.getItem(DRAFT_KEY);
  expect(originalDraft).toBeTruthy();
  await switchAccount('synthetic-account-B');
  await screen.findByLabelText('选择照片');
  expect(signal.aborted).toBe(true);
  await act(async () => finish(character));
  expect(screen.queryByText(character.name)).not.toBeInTheDocument();
  expect(screen.queryByText('已加入我的伙伴')).not.toBeInTheDocument();
  expect(sessionStorage.getItem(DRAFT_KEY)).toBe(originalDraft);
  expect(creationApi.upload).toHaveBeenCalledOnce(); expect(generateCompanion).toHaveBeenCalledOnce();
  await switchAccount('synthetic-account-A');
  expect(await screen.findByText('已加入我的伙伴')).toBeInTheDocument();
  expect(screen.getByLabelText('给伙伴一个喜欢的名字')).toHaveValue(character.name);
  expect(creationApi.upload).toHaveBeenCalledOnce(); expect(generateCompanion).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  evidence('F1', { status: 'passed', oldSignalAborted: signal.aborted, oldResultHiddenFromB: true, originalDraftPreserved: true, uploadMockCalls: 1, generationMockCalls: 1, restoredByReadsOnly: true, providerRequests: 0 });
});
it('F2: a late old-account chat cannot enter B, while A recovers saved history and its newer unsent draft without a replay', async () => {
  let finish!: (value: Awaited<ReturnType<typeof sendChat>>) => void;
  vi.mocked(sendChat).mockImplementation((_id, text, _signal, _delta) => {
    reserveChat(301, text); return new Promise(resolve => { finish = resolve; });
  });
  render(<SessionRecovery><Companion id={301} /></SessionRecovery>);
  const input = await screen.findByLabelText('想对伙伴说的话');
  fireEvent.change(input, { target: { value: '账号A已发送的合成消息' } });
  fireEvent.click(screen.getByLabelText('发送消息'));
  await waitFor(() => expect(sendChat).toHaveBeenCalledOnce());
  const signal = vi.mocked(sendChat).mock.calls[0][2];
  act(() => writeChatDraft(301, '账号A尚未发送的新草稿'));
  await switchAccount('synthetic-account-B');
  await screen.findByRole('alert');
  expect(signal.aborted).toBe(true);
  const saved = { id: 401, role: 'assistant' as const, content: '账号A的私有合成回复', created_at: '' };
  await act(async () => finish({ message: saved, proposal: null }));
  expect(screen.queryByText(saved.content)).not.toBeInTheDocument();
  expect(screen.queryByText(character.name)).not.toBeInTheDocument();
  expect(readChatDraft(301)).toBe('账号A尚未发送的新草稿');
  vi.mocked(api.chatRequest).mockResolvedValue('completed'); vi.mocked(api.messages).mockResolvedValue([saved]);
  await switchAccount('synthetic-account-A');
  expect(await screen.findByText(saved.content)).toBeInTheDocument();
  expect(screen.getByLabelText('想对伙伴说的话')).toHaveValue('账号A尚未发送的新草稿');
  expect(sendChat).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  evidence('F2', { status: 'passed', oldSignalAborted: signal.aborted, lateReplyHiddenFromB: true, newerUnsentDraftPreserved: true, chatMockCalls: 1, returnedByReadOnlyRecovery: true, providerRequests: 0 });
});
