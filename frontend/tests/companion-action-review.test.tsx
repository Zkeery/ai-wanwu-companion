import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CompanionActionReview from '@/components/companion-action-review';
import { clearToken, setToken } from '@/lib/auth';

const candidate = vi.fn();
vi.mock('@/components/motion-candidate-review', () => ({ default: (props: object) => {
  candidate(props); return <p>已打开当前伙伴候选</p>;
} }));
const prototype = HTMLDialogElement.prototype;
const originalShow = Object.getOwnPropertyDescriptor(prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(prototype, 'close');
beforeEach(() => {
  Object.defineProperty(prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterEach(() => {
  cleanup(); clearToken(); vi.clearAllMocks();
  if (originalShow) Object.defineProperty(prototype, 'showModal', originalShow); else Reflect.deleteProperty(prototype, 'showModal');
  if (originalClose) Object.defineProperty(prototype, 'close', originalClose); else Reflect.deleteProperty(prototype, 'close');
});
it('loads candidates only from an explicit profile action and closes on account change', () => {
  setToken('owner-A');
  render(<CompanionActionReview id={6} />);
  expect(candidate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('伙伴的动作'));
  expect(screen.getByText('已打开当前伙伴候选')).toBeInTheDocument();
  expect(candidate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 6, token: 'owner-A' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(screen.queryByText('已打开当前伙伴候选')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('伙伴的动作'));
  fireEvent.click(document.body); // no decision is implied by background clicks
  act(() => setToken('owner-B'));
  expect(screen.queryByText('已打开当前伙伴候选')).not.toBeInTheDocument();
});
it('does not open private candidates without login or while disabled', () => {
  clearToken();
  const view = render(<CompanionActionReview id={6} disabled />);
  expect(screen.getByText('伙伴的动作')).toBeDisabled();
  view.rerender(<CompanionActionReview id={6} />);
  fireEvent.click(screen.getByText('伙伴的动作'));
  expect(candidate).not.toHaveBeenCalled();
  expect(screen.getByText('请先登录，再查看伙伴的动作。')).toBeInTheDocument();
});
