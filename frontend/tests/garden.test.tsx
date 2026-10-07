import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import Garden from '@/components/garden';
import { parseScene } from '@/lib/contracts';

const scene = { scene_name: '小花园', elements: { rain: 0, tree: 1, cloud: 0, sound: 1, flower: 2, mushroom: 1, pond: 1, bench: 1, campfire: 1, fireflies: 1 }, can_undo: true, feedback: null, proposal: null };
it.each([6, 7, 9])('shows saved tree count and identical expanded controls at %s', tree => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const act = vi.fn();
  render(<Garden scene={{ ...scene, elements: { ...scene.elements, tree } }} busy={false} act={act} undo={vi.fn()} />);
  const text = tree > 7 ? '已保存 9 棵，画面展示 7 棵' : `树木 ${tree}/7`;
  expect(screen.getByText(text)).toBeInTheDocument();
  const button = screen.getByRole('button', { name: /种一棵树/ });
  expect(button.hasAttribute('disabled')).toBe(tree >= 7);
  if (tree >= 7) { fireEvent.click(button); expect(act).not.toHaveBeenCalled(); }
  expect(screen.getByRole('img')).toHaveAccessibleName(new RegExp(`${tree}棵树`));
  if (tree > 7) expect(screen.getByRole('img')).toHaveAccessibleName(/画面展示7棵/);
  fireEvent.click(screen.getByRole('button', { name: '放大小花园' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText(text)).toBeInTheDocument();
  expect(dialog.getByRole('button', { name: /种一棵树/ }).hasAttribute('disabled')).toBe(tree >= 7);
  expect(dialog.getByRole('button', { name: '撤销' })).toBeEnabled();
});
it('shows saved objects and groups controls without triggering paid generation', () => {
  const act = vi.fn(), undo = vi.fn();
  render(<Garden scene={scene} busy={false} act={act} undo={undo} />);
  expect(screen.getByRole('img')).toHaveAccessibleName(/2簇花.*蘑菇.*水池.*长椅.*营火.*萤火虫/);
  fireEvent.click(screen.getByRole('button', { name: '种一簇花' }));
  expect(act).toHaveBeenCalledWith('plant_flower');
  fireEvent.click(screen.getByRole('button', { name: '景观' }));
  expect(screen.getByRole('button', { name: /添个水池/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '氛围' }));
  expect(screen.getByRole('button', { name: /迎来萤火虫/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(undo).toHaveBeenCalledTimes(1);
});
it('understands a saved garden from the previous version', () => {
  const parsed = parseScene({ ...scene, elements: { rain: 1, tree: 8, cloud: 1, sound: 0 } });
  expect(parsed.elements).toMatchObject({ tree: 8, sound: 0, flower: 0, pond: 0, fireflies: 0 });
});
it('only offers actions supported by the connected backend', () => {
  const parsed = parseScene({ ...scene, action_labels: { plant_tree: '种树', light_rain: '小雨', quiet: '安静' } });
  render(<Garden scene={parsed} busy={false} act={vi.fn()} undo={vi.fn()} />);
  expect(screen.getByRole('button', { name: '种一棵树' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '种一簇花' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '景观' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '氛围' }));
  expect(screen.getByRole('button', { name: '下点小雨' })).toBeEnabled();
});
