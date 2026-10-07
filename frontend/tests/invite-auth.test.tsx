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
  const input = screen.getByPlaceholderText('粘贴专属邀请码');
  expect(input).toHaveAttribute('type', 'password');
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
  const input = screen.getByPlaceholderText('粘贴专属邀请码');
  fireEvent.change(input, { target: { value: 'expired-invite' } });
  fireEvent.submit(input.closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('邀请码无效或已过期');
  expect(done).not.toHaveBeenCalled(); expect(getToken()).toBeNull();
});
