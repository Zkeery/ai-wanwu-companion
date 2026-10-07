import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AuthModal from '@/components/auth-modal';
import { api } from '@/lib/api';
import { getToken } from '@/lib/auth';

vi.mock('@/components/common', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { auth: { login: vi.fn(), sendCode: vi.fn() } } }));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_DEV_SMS_CODE', '');
  vi.mocked(api.auth.login).mockResolvedValue({ token: 'synthetic-session', user: { id: 'test', phone: '13900000001' } });
  vi.mocked(api.auth.sendCode).mockResolvedValue({ sent: true });
});
afterEach(() => vi.unstubAllEnvs());
function fillLogin() {
  fireEvent.change(screen.getByPlaceholderText('11 位手机号'), { target: { value: '13900000001' } });
  fireEvent.change(screen.getByPlaceholderText('6 位验证码'), { target: { value: '123456' } });
}
it('submits an entered code directly without requesting another SMS first', async () => {
  const loggedIn = vi.fn(); render(<AuthModal onClose={vi.fn()} onLoggedIn={loggedIn} />); fillLogin();
  fireEvent.submit(screen.getByPlaceholderText('6 位验证码').closest('form')!);
  await waitFor(() => expect(api.auth.login).toHaveBeenCalledWith('13900000001', '123456'));
  expect(api.auth.sendCode).not.toHaveBeenCalled();
  expect(loggedIn).toHaveBeenCalledTimes(1);
  expect(getToken()).toBe('synthetic-session');
});
it('does not report login success when the browser cannot save the session', async () => {
  const loggedIn = vi.fn(); render(<AuthModal onClose={vi.fn()} onLoggedIn={loggedIn} />); fillLogin();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  fireEvent.submit(screen.getByPlaceholderText('6 位验证码').closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('浏览器无法保存登录状态');
  expect(loggedIn).not.toHaveBeenCalled();
});
it('offers an explicit local test code without pretending to send a message', async () => {
  vi.stubEnv('NEXT_PUBLIC_DEV_SMS_CODE', '123456');
  render(<AuthModal onClose={vi.fn()} onLoggedIn={vi.fn()} />);
  expect(screen.getByRole('note')).toHaveTextContent('不会发送真实短信');
  fireEvent.click(screen.getByRole('button', { name: '填入测试信息' }));
  expect(screen.getByPlaceholderText('11 位手机号')).toHaveValue('13900000001');
  expect(screen.getByPlaceholderText('6 位验证码')).toHaveValue('123456');
  expect(api.auth.sendCode).not.toHaveBeenCalled();
});
it('explains the invalid phone from the reported screenshot instead of silently disabling login', () => {
  render(<AuthModal onClose={vi.fn()} onLoggedIn={vi.fn()} />);
  fireEvent.change(screen.getByPlaceholderText('11 位手机号'), { target: { value: '12345678910' } });
  fireEvent.change(screen.getByPlaceholderText('6 位验证码'), { target: { value: '123456' } });
  expect(screen.getByRole('alert')).toHaveTextContent('手机号格式不正确');
  expect(screen.getByRole('button', { name: '登录' })).toBeDisabled();
  expect(api.auth.login).not.toHaveBeenCalled();
});
it('keeps a per-phone cooldown across closing and reopening while allowing login', async () => {
  const { act } = await import('@testing-library/react');
  vi.useFakeTimers();
  try {
    const view = render(<AuthModal onClose={vi.fn()} onLoggedIn={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('11 位手机号'), { target: { value: '13900000129' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送验证码' })); });
    expect(screen.getByRole('button', { name: '60 秒后重发' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('6 位验证码'), { target: { value: '123456' } });
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
    fireEvent.change(screen.getByPlaceholderText('11 位手机号'), { target: { value: '13900000130' } });
    expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled();
    view.unmount(); render(<AuthModal onClose={vi.fn()} onLoggedIn={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('11 位手机号'), { target: { value: '13900000129' } });
    expect(screen.getByRole('button', { name: '60 秒后重发' })).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled();
    expect(api.auth.sendCode).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
it('shows a cooldown after server throttling instead of allowing repeated clicks', async () => {
  const { ApiError } = await import('@/lib/api');
  vi.mocked(api.auth.sendCode).mockRejectedValueOnce(new ApiError('发送太频繁', 429, 'rate_limited'));
  render(<AuthModal onClose={vi.fn()} onLoggedIn={vi.fn()} />);
  fireEvent.change(screen.getByPlaceholderText('11 位手机号'), { target: { value: '13900000131' } });
  fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
  expect(await screen.findByRole('button', { name: '60 秒后重发' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('发送太频繁');
});

it('keeps an uncertain SMS on cooldown but allows the received code to log in', async () => {
  const { ApiError } = await import('@/lib/api');
  vi.mocked(api.auth.sendCode).mockRejectedValueOnce(new ApiError('发送结果暂未确认，若已收到短信可直接登录', 503, 'sms_unknown'));
  const loggedIn = vi.fn();
  render(<AuthModal onClose={vi.fn()} onLoggedIn={loggedIn} />);
  fireEvent.change(screen.getByPlaceholderText('11 位手机号'), { target: { value: '13900000132' } });
  fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
  expect(await screen.findByRole('button', { name: '60 秒后重发' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('发送结果暂未确认');
  fireEvent.change(screen.getByPlaceholderText('6 位验证码'), { target: { value: '654321' } });
  fireEvent.submit(screen.getByPlaceholderText('6 位验证码').closest('form')!);
  await waitFor(() => expect(loggedIn).toHaveBeenCalledTimes(1));
  expect(api.auth.login).toHaveBeenCalledWith('13900000132', '654321');
  expect(api.auth.sendCode).toHaveBeenCalledTimes(1);
});
