import { sampleHomeLeisurePose } from './living-home-leisure-pose';

export type HomeAmbientSound = 'snore' | 'laugh' | 'crunch' | 'tile' | 'wind' | 'bird' | 'pour' | 'cup' | 'step' | 'door-open' | 'door-close';
export type HomeAmbientAudioEvent = Readonly<{
  kind: HomeAmbientSound; episode: number; startedAt: number; progress: number;
}>;
export type HomeAmbience = Readonly<{
  sleep: Readonly<{ phase: number; breath: number }>;
  television: Readonly<{ laugh: number; crunch: number; seedHandLift: number }>;
  mahjong: Readonly<{ reach: number; hold: boolean; hand: 'left' | 'right'; turn: number }>;
  tea: Readonly<{ steamTime: number; steamStrength: number }>;
  audio: HomeAmbientAudioEvent | null;
}>;
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
function pulse(phase: number, start: number, peak: number, end: number) {
  return phase < start || phase >= end ? 0 : phase < peak ? smooth((phase - start) / (peak - start)) : 1 - smooth((phase - peak) / (end - peak));
}
function seedOf(actorId: number) { return Math.imul((actorId >>> 0) ^ 0x85ebca6b, 0x45d9f3b) >>> 0; }
function event(kind: HomeAmbientSound, episode: number, start: number, duration: number, time: number): HomeAmbientAudioEvent | null {
  return time < start || time >= start + duration ? null : Object.freeze({ kind, episode, startedAt: start, progress: (time - start) / duration });
}

/** Deterministic presentation rhythm from the renderer's frozen elapsed clock.
 * These are local gestures/effect cues, never an AI plan or a business action.
 */
export function sampleHomeAmbience(activity: string, elapsed: number, actorId: number): HomeAmbience {
  const time = Number.isFinite(elapsed) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, elapsed)) : 0;
  const valid = Number.isSafeInteger(actorId) && actorId > 0;
  const seed = seedOf(valid ? actorId : 0), phase = (seed % 997) / 997;
  let sleep = { phase: 0, breath: 0 }, television = { laugh: 0, crunch: 0, seedHandLift: 0 };
  let mahjong: HomeAmbience['mahjong'] = { reach: 0, hold: false, hand: 'right', turn: 0 };
  let tea = { steamTime: 0, steamStrength: 0 }, audio: HomeAmbientAudioEvent | null = null;
  if (valid && activity === 'sleep') {
    const duration = 5.8 + seed % 7 * .16, offset = phase * duration;
    const episode = Math.floor((time + offset) / duration), cycle = (time + offset) / duration - episode;
    sleep = { phase: cycle, breath: .5 - .5 * Math.cos(cycle * Math.PI * 2) };
    audio = event('snore', episode, episode * duration - offset + duration * .36, 1.35, time);
  } else if (valid && activity === 'television') {
    const duration = 13 + seed % 7 * .2, offset = phase * duration;
    const episode = Math.floor((time + offset) / duration), start = episode * duration - offset;
    const cycle = (time - start) / duration;
    const laugh = pulse(cycle, .22, .255, .31);
    const crunch = pulse(cycle, .68, .686, .707);
    television = { laugh, crunch, seedHandLift: cycle < .66 ? smooth((cycle - .56) / .10)
      : cycle < .71 ? 1 : 1 - smooth((cycle - .71) / .13) };
    audio = event('laugh', episode, start + duration * .22, .72, time)
      ?? event('crunch', episode, start + duration * .68, .20, time);
  } else if (valid && activity === 'mahjong') {
    const duration = 5.8 + seed % 5 * .1, turn = Math.floor(time / duration), cycle = time % duration / duration;
    const pose = sampleHomeLeisurePose('mahjong', time, actorId), right = (turn + seed % 2) % 2 === 0;
    mahjong = { reach: Math.max(0, Math.min(1, (-Math.min(pose.leftArmX, pose.rightArmX) - .42) / .65)),
      hold: cycle >= .27 && cycle < .64, hand: right ? 'right' : 'left', turn };
    audio = event('tile', turn * 2, turn * duration + duration * .27, .14, time)
      ?? event('tile', turn * 2 + 1, turn * duration + duration * .64, .14, time);
  } else if (valid && activity === 'tea') {
    tea = { steamTime: time + phase * 7,
      steamStrength: .60 + Math.sin(time * .65 + phase * Math.PI * 2) * .08 };
  }
  return Object.freeze({ sleep: Object.freeze(sleep), television: Object.freeze(television),
    mahjong: Object.freeze(mahjong), tea: Object.freeze(tea), audio });
}


/** Optional new soundscape clock. Original sampleHomeAmbience/tea.audio stays silent for legacy callers. */
export function sampleHomeExtraAudio(activity: string, elapsed: number, actorId: number): HomeAmbientAudioEvent | null {
  if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isSafeInteger(actorId) || actorId <= 0) return null;
  const seed = seedOf(actorId), time = Math.min(Number.MAX_SAFE_INTEGER, elapsed);
  if (activity === 'tea') {
    const duration = 11.5 + seed % 9 * .125, episode = Math.floor(time / duration), start = episode * duration;
    return event('pour', episode * 2, start + duration * .04, .85, time)
      ?? event('cup', episode * 2 + 1, start + duration * .68, .22, time);
  }
  if (activity === 'walk') {
    const duration = .54 + seed % 5 * .02, offset = seed % 19 / 19 * duration;
    const episode = Math.floor((time + offset) / duration), start = episode * duration - offset;
    return event('step', episode, start, .18, time);
  }
  return null;
}

export function sampleHomeOutdoorAudio(elapsed: number): HomeAmbientAudioEvent | null {
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const period = 12.8, episode = Math.floor(elapsed / period);
  return event('bird', episode, episode * period + 2.4, .65, elapsed);
}
