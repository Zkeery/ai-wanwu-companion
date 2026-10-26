import { expect, it } from 'vitest';
import { createWorldTapTracker } from '@/lib/living-world-tap';
const at = (pointerId: number, x = 20, y = 20) => ({ pointerId, clientX: x, clientY: y, button: 0 });

it('accepts a single tap with small finger movement', () => {
  const t = createWorldTapTracker(); t.down(at(1)); expect(t.up(at(1, 22, 22))).toBe(true);
});
it('rejects a drag even after it returns to its starting point', () => {
  const t = createWorldTapTracker(); t.down(at(1)); t.move(at(1, 60)); expect(t.up(at(1))).toBe(false);
});
it('rejects both fingers of a pinch and accepts the next separate tap', () => {
  const t = createWorldTapTracker(); t.down(at(1)); t.down(at(2));
  expect(t.up(at(2))).toBe(false); expect(t.up(at(1))).toBe(false);
  t.down(at(3)); expect(t.up(at(3))).toBe(true);
});
it('rejects cancellation and an unmatched pointer release', () => {
  const t = createWorldTapTracker(); t.down(at(1)); expect(t.up(at(2))).toBe(false);
  t.cancel(at(1)); expect(t.up(at(1))).toBe(false);
});
it('does not turn a cancelled pinch into a tap by its remaining finger', () => {
  const t = createWorldTapTracker(); t.down(at(1)); t.down(at(2)); t.cancel(at(1)); expect(t.up(at(2))).toBe(false);
});
it('ignores secondary mouse buttons and retains legacy pointer-less events', () => {
  const t = createWorldTapTracker(); t.down({ ...at(1), button: 2 }); expect(t.up(at(1))).toBe(false);
  t.down({ clientX: 20, clientY: 20 }); expect(t.up({ clientX: 20, clientY: 20 })).toBe(true);
});
