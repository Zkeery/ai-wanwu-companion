import type { HomeLeisureActivity } from './living-home-leisure';

/** All angles are radians. The caller supplies a frozen local elapsed clock and owns the real cup mesh. */
export type HomeLeisurePose = Readonly<{
  leftArmX: number; leftArmZ: number; rightArmX: number; rightArmZ: number;
  cupLift: number; lookYaw: number; sway: number;
}>;
const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
function pulse(phase: number, up: number, hold: number, down: number) {
  return phase < up ? smooth(phase / up) : phase < hold ? 1 : phase < down ? 1 - smooth((phase - hold) / (down - hold)) : 0;
}
function actorSeed(actorId: number) {
  const id = Number.isSafeInteger(actorId) && actorId > 0 ? actorId >>> 0 : 0;
  return Math.imul(id ^ 0x85ebca6b, 0x45d9f3b) >>> 0;
}

/** Pure bounded poses: no simulation state, random source, wall clock, timer or model. */
export function sampleHomeLeisurePose(activity: HomeLeisureActivity, elapsed: number, actorId: number): HomeLeisurePose {
  const time = Number.isFinite(elapsed) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed)) : 0;
  const seed = actorSeed(actorId), phase = (seed % 997) / 997 * Math.PI * 2;
  const base = { leftArmX: -.35, leftArmZ: .12, rightArmX: -.35, rightArmZ: -.12, cupLift: 0, lookYaw: 0, sway: 0 };
  if (activity === 'tea') {
    const duration = 11.5 + seed % 9 * .125;
    const lift = pulse(time % duration / duration, .23, .40, .68);
    return Object.freeze({
      leftArmX: -.4 + Math.sin(time * .5 + phase) * .014, leftArmZ: .14,
      rightArmX: -.55 - lift * .72, rightArmZ: -.22 - lift * .58,
      cupLift: lift, lookYaw: Math.sin(time * .28 + phase) * .022,
      sway: Math.sin(time * .42 + phase) * .008,
    });
  }
  if (activity === 'television') {
    const smallMove = pulse((time + seed % 5) % 17 / 17, .08, .12, .19);
    return Object.freeze({ leftArmX: -.48, leftArmZ: .16, rightArmX: -.48 - smallMove * .07,
      rightArmZ: -.16 - smallMove * .025, cupLift: 0,
      lookYaw: Math.sin(time * .21 + phase) * .018, sway: Math.sin(time * .31 + phase) * .006 });
  }
  if (activity === 'mahjong') {
    const duration = 5.8 + seed % 5 * .1, turn = Math.floor(time / duration);
    const reach = pulse(time % duration / duration, .27, .40, .72);
    const right = (turn + seed % 2) % 2 === 0;
    return Object.freeze({
      leftArmX: -.42 - (!right ? reach * .65 : 0), leftArmZ: .18 + (!right ? reach * .29 : 0),
      rightArmX: -.42 - (right ? reach * .65 : 0), rightArmZ: -.18 - (right ? reach * .29 : 0),
      cupLift: 0, lookYaw: Math.sin(time * .35 + phase) * .035,
      sway: Math.sin(time * .47 + phase) * .009,
    });
  }
  if (activity === 'bench') return Object.freeze({ ...base, lookYaw: Math.sin(time * .2 + phase) * .035, sway: Math.sin(time * .38 + phase) * .007 });
  return Object.freeze(base);
}
