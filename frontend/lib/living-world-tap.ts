type WorldPointer = { pointerId?: number; clientX: number; clientY: number; button?: number };

/** A pinch or a drag returning to its starting point must never become a click. */
export function createWorldTapTracker(distance = 7) {
  const pointers = new Map<number, { x: number; y: number; moved: boolean }>();
  let multi = false;
  const key = (e: WorldPointer) => Number.isFinite(e.pointerId) ? e.pointerId! : 0;
  function move(e: WorldPointer) {
    const p = pointers.get(key(e));
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > distance) p.moved = true;
  }
  return {
    down(e: WorldPointer) {
      if (e.button !== undefined && e.button !== 0) return;
      pointers.set(key(e), { x: e.clientX, y: e.clientY, moved: false });
      if (pointers.size > 1) multi = true;
    },
    move,
    up(e: WorldPointer) {
      move(e);
      const p = pointers.get(key(e));
      const tapped = !!p && !p.moved && !multi && pointers.size === 1;
      pointers.delete(key(e));
      if (!pointers.size) multi = false;
      return tapped;
    },
    cancel(e: WorldPointer) {
      pointers.delete(key(e));
      if (!pointers.size) multi = false;
    },
  };
}
