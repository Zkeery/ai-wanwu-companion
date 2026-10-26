import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GuestEntry } from '@/components/auth-modal';

it('offers a large guest start and a smaller invite login', () => {
  vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'invite');
  const onGuest = vi.fn(), onLogin = vi.fn();
  render(<GuestEntry onGuest={onGuest} onLogin={onLogin} />);
  fireEvent.click(screen.getByRole('button', { name: '立即体验' }));
  fireEvent.click(screen.getByRole('button', { name: '已有账号？用邀请码登录' }));
  expect(onGuest).toHaveBeenCalledOnce();
  expect(onLogin).toHaveBeenCalledOnce();
  vi.unstubAllEnvs();
});
