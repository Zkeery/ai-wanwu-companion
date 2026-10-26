import { describe, expect, it } from 'vitest';
import { createLivingWorldFrameClock } from '../lib/living-world-frame-clock';

const interval = 1000 / 30;

describe('living world rendering clock', () => {
  it.each([60, 90, 120])('keeps 30 fps for ten seconds of rounded %i Hz RAF callbacks', refreshRate => {
    const clock = createLivingWorldFrameClock(), rendered: number[] = [];
    for (let frame = 0; frame <= refreshRate * 10; frame++) {
      const timestamp = Math.round(frame * 1000 / refreshRate * 1000) / 1000;
      if (clock.step(timestamp)) rendered.push(timestamp);
    }
    // The immediate initial frame is in addition to 300 scheduled frames.
    expect(rendered.length).toBeGreaterThanOrEqual(300);
    expect(rendered.length).toBeLessThanOrEqual(301);
    const gaps = rendered.slice(1).map((time, index) => time - rendered[index]);
    expect(Math.min(...gaps)).toBeGreaterThan(interval - 1000 / refreshRate - .001);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(interval + 1000 / refreshRate + .001);
    expect(rendered.at(-1)).toBeCloseTo(10000, 2);
  });

  it('renders the first valid callback immediately and ignores duplicate timestamps', () => {
    const clock = createLivingWorldFrameClock();
    expect(clock.step(122)).toBe(true);
    expect(clock.step(122)).toBe(false);
    expect(clock.step(122 + interval / 2)).toBe(false);
    expect(clock.step(122 + interval)).toBe(true);
    expect(clock.step(122 + interval)).toBe(false);
  });

  it('accepts a boundary within 0.05 ms without rendering an extra early frame', () => {
    const clock = createLivingWorldFrameClock();
    expect(clock.step(0)).toBe(true);
    expect(clock.step(interval - .051)).toBe(false);
    expect(clock.step(interval - .05)).toBe(true);
    expect(clock.step(interval)).toBe(false);
    expect(clock.step(interval * 2 - .051)).toBe(false);
    expect(clock.step(interval * 2 - .049)).toBe(true);
  });

  it('skips missed short-gap frames once while retaining the original phase', () => {
    const clock = createLivingWorldFrameClock();
    expect(clock.step(0)).toBe(true);
    expect(clock.step(102)).toBe(true);
    expect(clock.step(102)).toBe(false);
    expect(clock.step(102.001)).toBe(false);
    expect(clock.step(interval * 4)).toBe(true);
    expect(clock.step(interval * 4 + 1)).toBe(false);
  });

  it.each([251, 10000, 5 * 60 * 60 * 1000])('starts a new schedule after a %i ms suspension without catch-up', gap => {
    const clock = createLivingWorldFrameClock();
    clock.step(0); clock.step(interval);
    const resumed = interval + gap;
    expect(clock.step(resumed)).toBe(true);
    for (let callback = 0; callback < 20; callback++) expect(clock.step(resumed)).toBe(false);
    expect(clock.step(resumed + 1)).toBe(false);
    expect(clock.step(resumed + interval)).toBe(true);
  });

  it('resets when time moves backwards and starts from the new timestamp', () => {
    const clock = createLivingWorldFrameClock();
    clock.step(500); clock.step(520);
    expect(clock.step(200)).toBe(true);
    expect(clock.step(200)).toBe(false);
    expect(clock.step(201)).toBe(false);
    expect(clock.step(200 + interval)).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid timestamp %s and forgets the old schedule', invalid => {
    const clock = createLivingWorldFrameClock();
    clock.step(500); clock.step(520);
    expect(clock.step(invalid)).toBe(false);
    expect(clock.step(520)).toBe(true);
    expect(clock.step(520)).toBe(false);
    expect(clock.step(521)).toBe(false);
    expect(clock.step(520 + interval)).toBe(true);
  });

  it('allows pause/resume to explicitly reset even at the same RAF timestamp', () => {
    const clock = createLivingWorldFrameClock();
    expect(clock.step(500)).toBe(true);
    clock.reset();
    expect(clock.step(500)).toBe(true);
    expect(clock.step(500)).toBe(false);
    expect(clock.step(500 + interval)).toBe(true);
  });
});
