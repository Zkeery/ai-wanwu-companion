/**
 * A 30 fps rendering gate for RAF timestamps, in milliseconds.
 *
 * The first valid step renders immediately. Normal frames keep their fractional
 * schedule rather than restarting it at each RAF callback. A delayed callback
 * can render once, never replay the frames that were missed.
 */
export function createLivingWorldFrameClock() {
  const interval = 1000 / 30, boundaryTolerance = .05, interruption = 250;
  let previous: number | null = null, next: number | null = null;

  function reset() { previous = null; next = null; }

  function step(timestamp: number): boolean {
    // RAF time is non-negative and finite. Invalid input discards the old
    // schedule; the next valid timestamp starts a fresh one.
    if (!Number.isFinite(timestamp) || timestamp < 0) { reset(); return false; }
    if (previous === timestamp) return false;
    const discontinuity = previous === null || timestamp < previous || timestamp - previous > interruption;
    previous = timestamp;
    // A new time domain or a long suspension has no accumulated rendering debt.
    if (discontinuity || next === null) { next = timestamp + interval; return true; }
    if (timestamp + boundaryTolerance < next) return false;
    const intervals = Math.max(1, Math.floor((timestamp - next + boundaryTolerance) / interval) + 1);
    next += intervals * interval;
    return true;
  }

  return { step, reset };
}
