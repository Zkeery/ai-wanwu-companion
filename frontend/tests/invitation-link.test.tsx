import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import InvitationLink from '@/components/invitation-link';
const link = 'http://127.0.0.1:3020/teams/join#invite=synthetic-invitation';
afterEach(() => vi.unstubAllGlobals());
it('copies the same invitation and explains local-only access', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<InvitationLink link={link} />);
  expect(screen.getByLabelText('邀请链接')).toHaveAttribute('type', 'password');
  fireEvent.click(screen.getByRole('button', { name: '复制邀请链接' }));
  expect(await screen.findByRole('status')).toHaveTextContent('这台电脑'); expect(writeText).toHaveBeenCalledWith(link);
  fireEvent.click(screen.getByRole('button', { name: '复制邀请链接' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2)); expect(writeText).toHaveBeenLastCalledWith(link);
});
it('provides a selectable manual fallback if clipboard access fails', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  render(<InvitationLink link={link} />); fireEvent.click(screen.getByRole('button', { name: '复制邀请链接' }));
  expect(await screen.findByRole('status')).toHaveTextContent('手动复制');
  const input = screen.getByLabelText('邀请链接') as HTMLInputElement;
  await waitFor(() => { expect(input).toHaveFocus(); expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(link.length); }); expect(input).toHaveAttribute('type', 'text');
  fireEvent.click(screen.getByRole('button', { name: '隐藏邀请链接' })); expect(input).toHaveAttribute('type', 'password');
});
it('does not describe an externally hosted link as local-only', () => {
  render(<InvitationLink link="https://example.test/teams/join#invite=synthetic" />);
  expect(screen.queryByText(/其他设备暂时无法访问/)).not.toBeInTheDocument();
});
