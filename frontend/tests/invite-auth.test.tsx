import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AuthModal from '@/components/auth-modal';
import { api } from '@/lib/api';
import { getToken } from '@/lib/auth';

vi.mock('@/components/common', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { auth: { inviteLogin: vi.fn(), sendCode: vi.fn() } } }));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'invite');
  vi.mocked(api.auth.inviteLogin).mockResolvedValue({ token: 'synthetic-invite-session', user: { id: 'invite-user', phone: '' } });
});
afterEach(() => vi.unstubAllEnvs());

it('logs in with a concealed invite and never requests SMS', async () => {
  const done = vi.fn(); render(<AuthModal onClose={vi.fn()} onLoggedIn={done} />);
  const input = screen.getByLabelText('账号登录码');
  expect(input).toHaveAttribute('type', 'password');
  expect(input).toHaveAttribute('placeholder', '粘贴账号登录码');
  expect(input).toHaveAttribute('autocapitalize', 'none');
  expect(input).toHaveAttribute('autocorrect', 'off');
  expect(input).toHaveAttribute('spellcheck', 'false');
  expect(screen.queryByPlaceholderText('11 位手机号')).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: '  synthetic-invite  ' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(api.auth.inviteLogin).toHaveBeenCalledWith('synthetic-invite');
  expect(api.auth.sendCode).not.toHaveBeenCalled();
  expect(getToken()).toBe('synthetic-invite-session');
});

it('does not persist a rejected invitation or claim successful login', async () => {
  const { ApiError } = await import('@/lib/api');
  vi.mocked(api.auth.inviteLogin).mockRejectedValueOnce(new ApiError('邀请码无效或已过期，请联系邀请人', 401, 'invite_invalid'));
  const done = vi.fn(); render(<AuthModal onClose={vi.fn()} onLoggedIn={done} />);
  const input = screen.getByPlaceholderText('粘贴账号登录码');
  fireEvent.change(input, { target: { value: 'expired-invite' } });
  fireEvent.submit(input.closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('账号登录码无效或已过期');
  expect(done).not.toHaveBeenCalled(); expect(getToken()).toBeNull();
});

it('preserves the original login code characters and only trims its surrounding whitespace', async () => {
  render(<AuthModal onClose={vi.fn()} onLoggedIn={vi.fn()} />);
  const input = screen.getByLabelText('账号登录码');
  fireEvent.change(input, { target: { value: '  Synthetic_Login-Code-XyZ  ' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(api.auth.inviteLogin).toHaveBeenCalledExactlyOnceWith('Synthetic_Login-Code-XyZ'));
  expect(api.auth.sendCode).not.toHaveBeenCalled();
});

it('explains a rejected HTTP 401 login without treating it as a home invitation or persisting a session', async () => {
  const { ApiError } = await import('@/lib/api');
  vi.mocked(api.auth.inviteLogin).mockRejectedValueOnce(new ApiError('请先登录', 401, 'unauthorized'));
  const done = vi.fn(); render(<AuthModal onClose={vi.fn()} onLoggedIn={done} />);
  const input = screen.getByLabelText('账号登录码');
  fireEvent.change(input, { target: { value: 'SyntheticRejected_LoginCode' } });
  fireEvent.submit(input.closest('form')!);
  const error = await screen.findByRole('alert');
  expect(error).toHaveTextContent('账号登录码无效或已过期');
  expect(error).not.toHaveTextContent('SyntheticRejected_LoginCode');
  expect(done).not.toHaveBeenCalled(); expect(getToken()).toBeNull();
});
