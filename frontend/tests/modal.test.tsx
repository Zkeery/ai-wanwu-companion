import React from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Modal } from '@/components/common';

it('returns keyboard focus to the opener after the dialog is removed', () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); this.querySelector('button')?.focus(); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const opener = document.createElement('button'); opener.textContent = '打开记忆'; document.body.append(opener); opener.focus();
  const view = render(<Modal title="记忆" close={vi.fn()}><p>记忆内容</p></Modal>);
  expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();
  view.unmount(); expect(opener).toHaveFocus(); opener.remove();
});
