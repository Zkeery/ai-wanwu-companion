import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ScenePreviewPage from '@/app/scene-preview/page';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('opens and switches all scene artwork without requests or changing a session', () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  localStorage.setItem('aiwwb-token', 'existing-session');
  const { container } = render(<ScenePreviewPage />);
  for (const scene of ['家庭庭院', '森林营地']) {
    fireEvent.click(screen.getByRole('button', { name: scene }));
    for (const [name, id] of [['春天', 'spring'], ['夏天', 'summer'], ['秋天', 'autumn'], ['冬天', 'winter']]) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(container.querySelector('[data-season-art]')).toHaveAttribute('data-season-art', id);
      expect(container.querySelector('img')).toHaveAttribute('src', new URL(`/seasons/${scene === '家庭庭院' ? 'home' : 'forest'}-four-seasons-v1.png`, window.location.href).href);
    }
  }
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(localStorage.getItem('aiwwb-token')).toBe('existing-session');
  expect(screen.queryByText(/确认后换上/)).not.toBeInTheDocument();
});

it('can recover a failed public image without an API request', () => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const { container } = render(<ScenePreviewPage />);
  fireEvent.error(container.querySelector('img')!);
  fireEvent.click(screen.getByRole('button', { name: '重试季节画面' }));
  expect(container.querySelector('img')).toHaveAttribute('src', new URL('/seasons/home-four-seasons-v1.png?retry=1', window.location.href).href);
  expect(fetchSpy).not.toHaveBeenCalled();
});
