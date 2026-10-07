import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Collection from '@/components/collection';
import { api, checkResponse } from '@/lib/api';
import { getToken, setToken } from '@/lib/auth';
import SessionRecovery from '@/components/session-recovery';
vi.mock('@/components/auth-modal', () => ({ default: ({ onLoggedIn }: { onLoggedIn: () => void }) => <button onClick={onLoggedIn}>完成重新登录</button> }));

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); setToken('test-session'); });
it('revokes the server session when signing out', async () => {
  vi.spyOn(api.auth, 'me').mockResolvedValue({ id: 'test', phone: '13900000001' });
  vi.spyOn(api, 'characterOverview').mockResolvedValue([]);
  const logout = vi.spyOn(api.auth, 'logout').mockResolvedValue(null);
  render(<Collection />);
  fireEvent.click(await screen.findByRole('button', { name: '退出' }));
  await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  expect(getToken()).toBeNull();
  expect(await screen.findByRole('button', { name: /注册 \/ 登录/ })).toBeInTheDocument();
});
it('keeps a valid session when the identity service has a temporary network failure', async () => {
  vi.spyOn(api.auth, 'me').mockRejectedValue(new Error('连接失败'));
  render(<Collection />);
  expect(await screen.findByRole('alert')).toHaveTextContent('连接失败');
  expect(getToken()).toBe('test-session');
});
it('does not let an old failed request erase a newer login', async () => {
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const request = api.characters().catch(e => e);
  setToken('new-session');
  finish(new Response('', { status: 401 }));
  await request;
  expect(getToken()).toBe('new-session');
});
it('announces expiration so protected pages can offer login again', async () => {
  const expired = vi.fn(); window.addEventListener('companion-session-expired', expired);
  try {
    await expect(checkResponse(new Response('', { status: 401 }))).rejects.toThrow('请先登录');
    expect(expired).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
  } finally { window.removeEventListener('companion-session-expired', expired); }
});
it('hides the old page on expiration and restores it only after a new login', async () => {
  render(<SessionRecovery><div>已认证页面</div></SessionRecovery>);
  await expect(checkResponse(new Response('', { status: 401 }))).rejects.toThrow();
  expect(await screen.findByRole('button', { name: '完成重新登录' })).toBeInTheDocument();
  expect(screen.queryByText('已认证页面')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '完成重新登录' }));
  expect(await screen.findByText('已认证页面')).toBeInTheDocument();
});
