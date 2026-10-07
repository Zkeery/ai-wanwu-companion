import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import MobileNav from '@/components/mobile-nav';
import { clearToken, setToken, TOKEN_KEY } from '@/lib/auth';
const route = vi.hoisted(() => ({ path: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.path }));
beforeEach(() => { localStorage.clear(); route.path = '/'; });
it('only appears after login and disappears immediately on logout in the same tab', () => {
  render(<MobileNav />);
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  act(() => setToken('test-session'));
  const nav = screen.getByRole('navigation', { name: '全局导航' });
  expect(within(nav).getAllByRole('link').map(a => a.textContent)).toEqual(['伙伴', '创作', '发现']);
  expect(within(nav).getByRole('link', { name: '伙伴' })).toHaveAttribute('aria-current', 'page');
  act(clearToken);
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
});
it('keeps the same destinations and highlights companions on a nested scene route', () => {
  setToken('test-session'); route.path = '/companions/7/scenes/desert/space';
  render(<MobileNav />);
  expect(screen.getByRole('link', { name: '伙伴' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: '发现' })).toHaveAttribute('href', '/discover');
  expect(screen.queryByText('小队')).not.toBeInTheDocument();
});
it.each(['/discover', '/themes/fruit', '/teams/abc'])('keeps discovery active on %s', path => {
  setToken('test-session'); route.path = path; render(<MobileNav />);
  expect(screen.getByRole('link', { name: '发现' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getAllByRole('link')).toHaveLength(3);
});
it('updates on route changes and cross-tab logout', () => {
  setToken('test-session'); const { rerender } = render(<MobileNav />);
  route.path = '/companions/new'; rerender(<MobileNav />);
  expect(screen.getByRole('link', { name: '创作' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('link', { name: '场景' })).not.toBeInTheDocument();
  act(() => { localStorage.removeItem(TOKEN_KEY); window.dispatchEvent(new StorageEvent('storage', { key: TOKEN_KEY })); });
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
});
