import { describe, expect, it } from 'vitest';
import { layoutLivingLabels, type LivingLabelAnchor } from '../lib/living-world-label-layout';

function assertReachable(labels: LivingLabelAnchor[], width: number, height: number) {
  const before = JSON.stringify(labels), positions = layoutLivingLabels(labels, width, height);
  const boxes = positions.map(p => { const size = labels.find(l => l.id === p.id)!; return { left: p.x - size.width / 2, right: p.x + size.width / 2, top: p.y - size.height, bottom: p.y }; });
  expect(JSON.stringify(labels)).toBe(before);
  for (const [i, box] of boxes.entries()) {
    expect(box.left).toBeGreaterThanOrEqual(8 - 1e-8); expect(box.right).toBeLessThanOrEqual(width - 8 + 1e-8);
    expect(box.top).toBeGreaterThanOrEqual(8 - 1e-8); expect(box.bottom).toBeLessThanOrEqual(height - 8 + 1e-8);
    for (const other of boxes.slice(i + 1)) expect(box.right + 5.9 <= other.left || other.right + 5.9 <= box.left || box.bottom + 5.9 <= other.top || other.bottom + 5.9 <= box.top).toBe(true);
  }
  expect(layoutLivingLabels([...labels].reverse(), width, height)).toEqual(positions);
}

describe('scene companion click targets', () => {
  it('separates the three overlapping 44px phone buttons from the observed tea scene', () => {
    assertReachable([{ id: 4, x: 172.5, y: 218.9, width: 77.2, height: 44 }, { id: 5, x: 184.3, y: 213.5, width: 77.2, height: 44 }, { id: 2, x: 170.7, y: 210, width: 77.2, height: 44 }], 348, 398);
  });
  it.each([280, 348, 900])('keeps nine crowded targets reachable inside a %ipx canvas', width => {
    assertReachable(Array.from({ length: 9 }, (_, id) => ({ id, x: width / 2, y: 200, width: 77.2, height: 44 })), width, 360);
  });
  it('keeps a caption and the other names inside the canvas without covering each other', () => {
    assertReachable([{ id: 2, x: -5, y: 15, width: 145, height: 130 }, { id: 4, x: 0, y: 20, width: 77.2, height: 44 }, { id: 5, x: 350, y: 450, width: 77.2, height: 44 }], 348, 398);
  });
});
