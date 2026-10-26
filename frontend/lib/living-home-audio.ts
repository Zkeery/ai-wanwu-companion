import { sampleHomeAmbience, sampleHomeExtraAudio, sampleHomeOutdoorAudio, type HomeAmbientAudioEvent, type HomeAmbientSound } from './living-home-ambience';

/** UI must identify these as local synthesized effects, never a recording. */
export const HOME_AUDIO_ORIGIN = 'local_synthesized_effects' as const;
export type HomeAudioArea = 'outdoor' | 'indoor' | 'bedroom';
export type HomeAudioActor = Readonly<{ actorId: number; activity: string; audible?: boolean; moving?: boolean; startedAtElapsed?: number }>;
export type HomeAudioContextFactory = () => AudioContext;
type Voice = { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; released: boolean; kind: HomeAmbientSound };
export const HOME_AUDIO_PROFILES: Readonly<Record<HomeAmbientSound, Readonly<{ duration: number; cutoff: number; gain: number }>>> = Object.freeze({
  snore: Object.freeze({ duration: 1.35, cutoff: 650, gain: .055 }),
  laugh: Object.freeze({ duration: .72, cutoff: 1600, gain: .030 }),
  crunch: Object.freeze({ duration: .20, cutoff: 2300, gain: .023 }),
  tile: Object.freeze({ duration: .14, cutoff: 3800, gain: .070 }),
  wind: Object.freeze({ duration: 8, cutoff: 1200, gain: .025 }),
  bird: Object.freeze({ duration: .65, cutoff: 6800, gain: .065 }),
  pour: Object.freeze({ duration: .85, cutoff: 3500, gain: .11 }),
  cup: Object.freeze({ duration: .22, cutoff: 6500, gain: .10 }),
  step: Object.freeze({ duration: .18, cutoff: 1300, gain: .13 }),
  'door-open': Object.freeze({ duration: .42, cutoff: 2100, gain: .12 }),
  'door-close': Object.freeze({ duration: .38, cutoff: 2300, gain: .12 }),
});
function noiseSource(seed: number) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0xffffffff * 2 - 1; };
}
/** Pure offline synthesis. Envelopes are in the samples, not timer callbacks.
 * No speech, microphone, file, model or network input is used. */
export function synthesizeHomeAudioSamples(kind: HomeAmbientSound, sampleRate: number, seed = 1): Float32Array {
  const rate = Number.isFinite(sampleRate) && sampleRate >= 1000 && sampleRate <= 192000 ? sampleRate : 44100;
  const duration = HOME_AUDIO_PROFILES[kind].duration, data = new Float32Array(Math.ceil(rate * duration));
  const random = noiseSource(seed); let breath = 0, brown = 0, chirpPhase = 0;
  for (let i = 0; i < data.length; i++) {
    const time = i / rate, phase = time / duration, noise = random();
    const envelope = Math.sin(Math.PI * phase) ** 2, tau = Math.PI * 2;
    brown = brown * .94 + noise * .06;
    let value = 0;
    if (kind === 'snore') {
      breath = breath * .91 + noise * .09;
      const flutter = .78 + .22 * Math.sin(time * tau * 24);
      value = envelope * flutter * (breath * 1.8 + Math.sin(time * tau * 82) * .12);
    } else if (kind === 'laugh') {
      const syllable = time * 4.8 % 1, voiced = Math.sin(Math.PI * syllable) ** 3;
      value = envelope * voiced * (Math.sin(time * tau * 145) * .32
        + Math.sin(time * tau * 580) * .14 + Math.sin(time * tau * 1120) * .07 + noise * .065);
    } else if (kind === 'crunch') {
      value = envelope * noise * (.25 + Math.sin(time * tau * 37) ** 8 * .65);
    } else if (kind === 'tile') {
      // Dry resin/ceramic contacts: short irregular impacts, no pitched drum-like 280/530 Hz oscillators.
      const attack = Math.min(1, time / .0018), contact = Math.exp(-time * 105), tail = Math.exp(-time * 35);
      value = attack * (noise * (.52 * contact + .16 * tail) + (noise - brown) * .16 * contact + brown * .5 * tail);
    } else if (kind === 'wind') {
      const edge = Math.min(1, time / .15, (duration - time) / .15);
      const gust = .55 + .22 * Math.sin(time * tau * .19) + .12 * Math.sin(time * tau * .43 + .7);
      value = Math.max(0, edge) * gust * (brown * 2.2 + noise * .055);
    } else if (kind === 'bird') {
      // Three breathy, irregularly spaced sweeps with harmonics, rather than a repeated electronic tone.
      const local = time < .19 ? time : time < .29 ? -1 : time < .45 ? time - .29 : time < .51 ? -1 : time - .51;
      if (local >= 0) {
        const length = time < .19 ? .19 : time < .45 ? .16 : .14;
        const chirp = Math.sin(Math.PI * Math.min(1, local / length)) ** 2;
        chirpPhase += tau * (2350 + 1300 * Math.sin(local / length * Math.PI * .8) + 110 * Math.sin(time * tau * 32)) / rate;
        value = chirp * (.42 * Math.sin(chirpPhase) + .11 * Math.sin(chirpPhase * 2.03) + noise * .045);
      }
    } else if (kind === 'pour') {
      const stream = .42 + .13 * Math.sin(time * tau * 21) + .08 * Math.sin(time * tau * 47 + .3);
      const gurgle = Math.sin(time * tau * (185 + phase * 65)) * .15 * (Math.sin(time * tau * 7) ** 2);
      value = envelope * ((noise - brown) * stream + brown * 1.4 + gurgle);
    } else if (kind === 'cup') {
      const attack = Math.min(1, time / .002);
      value = attack * (Math.exp(-time * 25) * (Math.sin(time * tau * 2730) * .34
        + Math.sin(time * tau * 4190) * .19 + Math.sin(time * tau * 5680) * .08) + noise * Math.exp(-time * 100) * .12);
    } else if (kind === 'step') {
      const attack = Math.min(1, time / .004), decay = Math.exp(-time * 24);
      value = attack * decay * (brown * 2.8 + noise * .18 + Math.sin(time * tau * (100 - phase * 40)) * .30);
    } else if (kind === 'door-open') {
      const rub = .62 + .24 * Math.sin(time * tau * 17) + .12 * Math.sin(time * tau * 39);
      value = envelope * (brown * 2.2 + noise * .12) * rub
        + Math.sin(time * tau * (150 + phase * 55)) * envelope * .08;
    } else if (kind === 'door-close') {
      const contact = Math.max(0, time - .16), knock = time < .16 ? 0 : Math.exp(-contact * 28) * Math.min(1, contact / .003);
      value = envelope * brown * .8 + knock * (brown * 2.1 + noise * .24 + Math.sin(contact * tau * 115) * .32);
    }
    data[i] = Math.max(-.96, Math.min(.96, value));
  }
  return data;
}

/** Only enable(), called directly from the user's click, constructs/resumes a
 * context. The optional area enables the new soundscape; old two-argument tick
 * calls retain the original sounds and three-voice cap. No catch-up or retries. */
export function createHomeAudio(contextFactory: HomeAudioContextFactory = () => new AudioContext()) {
  let context: AudioContext | null = null, master: GainNode | null = null;
  let enabled = false, disposed = false, desired = false, generation = 0, paused = false;
  let pending: Promise<boolean> | null = null, lastElapsed: number | null = null, lastContextTime: number | null = null;
  let pendingGeneration = 0, wind: Voice | null = null, outdoorSeen: string | null = null, currentArea: HomeAudioArea | null = null;
  const opening = new Set<AudioContext>(), closed = new WeakSet<AudioContext>();
  const voices = new Map<number, Voice>(), seen = new Map<number, { activity: string; event: string | null; clockStart: number | null }>();
  const origins = new Map<number, { activity: string; start: number }>(), doorStates = new Map<string, boolean>();
  const buffers = new Map<string, AudioBuffer>();
  const close = (value: AudioContext) => {
    if (closed.has(value)) return; closed.add(value);
    try { void value.close().catch(() => undefined); } catch { /* already closed */ }
  };
  function releaseVoice(voice: Voice, stop: boolean) {
    if (voice.released) return; voice.released = true; voice.source.onended = null;
    if (stop) try { voice.source.stop(); } catch { /* already ended */ }
    voice.source.disconnect(); voice.filter.disconnect(); voice.gain.disconnect();
  }
  function release(id: number) { const voice = voices.get(id); if (!voice) return; voices.delete(id); releaseVoice(voice, true); }
  function stopWind() { if (wind) releaseVoice(wind, true); wind = null; }
  function silence() {
    for (const id of [...voices.keys()]) release(id); stopWind();
    lastElapsed = lastContextTime = null; seen.clear(); outdoorSeen = null;
  }
  function off() {
    desired = enabled = false; paused = true; generation++; silence(); origins.clear(); doorStates.clear(); buffers.clear(); currentArea = null;
    master?.disconnect(); master = null; if (context) close(context); context = null;
    for (const value of opening) close(value); opening.clear();
  }
  async function enable(): Promise<boolean> {
    if (disposed) return false; desired = true;
    if (enabled && context?.state === 'running') return true;
    if (pending && pendingGeneration === generation) return pending;
    if (context) { silence(); buffers.clear(); master?.disconnect(); master = null; close(context); context = null; enabled = false; }
    const attempt = ++generation; pendingGeneration = attempt;
    const operation = (async () => {
      let created: AudioContext | null = null;
      try {
        created = contextFactory(); opening.add(created);
        if (created.state !== 'running') await created.resume(); opening.delete(created);
        if (disposed || !desired || attempt !== generation) { close(created); return false; }
        if (created.state !== 'running') { close(created); desired = false; return false; }
        context = created; master = context.createGain(); master.gain.value = .45; master.connect(context.destination);
        enabled = true; paused = false; lastElapsed = null; lastContextTime = context.currentTime; seen.clear(); origins.clear(); return true;
      } catch {
        if (created) { opening.delete(created); close(created); }
        if (attempt === generation) { enabled = desired = false; context = null; master = null; }
        return false;
      }
    })();
    pending = operation; const result = await operation; if (pending === operation) pending = null; return result;
  }
  function bufferFor(kind: HomeAmbientSound, seed: number) {
    const variant = kind === 'wind' ? 0 : seed >>> 0 & 3, key = kind + ':' + variant;
    let buffer = buffers.get(key); if (buffer || !context) return buffer;
    const samples = synthesizeHomeAudioSamples(kind, context.sampleRate, variant + 1);
    buffer = context.createBuffer(1, samples.length, context.sampleRate); buffer.getChannelData(0).set(samples);
    if (buffers.size >= 32) buffers.delete(buffers.keys().next().value!); buffers.set(key, buffer); return buffer;
  }
  function makeVoice(kind: HomeAmbientSound, seed: number, loop: boolean): Voice | null {
    if (!context || !master || !enabled) return null;
    let source: AudioBufferSourceNode | null = null, filter: BiquadFilterNode | null = null, gain: GainNode | null = null;
    try {
      const buffer = bufferFor(kind, seed); if (!buffer) return null;
      source = context.createBufferSource(); filter = context.createBiquadFilter(); gain = context.createGain();
      source.buffer = buffer; source.loop = loop; filter.type = 'lowpass'; filter.frequency.value = HOME_AUDIO_PROFILES[kind].cutoff; filter.Q.value = .45;
      gain.gain.value = HOME_AUDIO_PROFILES[kind].gain; source.connect(filter); filter.connect(gain); gain.connect(master);
      return { source, filter, gain, kind, released: false };
    } catch {
      try { source?.stop(); } catch { /* no started source */ } source?.disconnect(); filter?.disconnect(); gain?.disconnect(); return null;
    }
  }
  function play(id: number, cue: HomeAmbientAudioEvent, limit: number) {
    if (!context || voices.size >= limit) return false;
    const voice = makeVoice(cue.kind, Math.imul(id, 0x45d9f3b) ^ Math.imul(cue.episode, 0x85ebca6b), false); if (!voice) return false;
    voices.set(id, voice); voice.source.onended = () => { if (voices.get(id) === voice) voices.delete(id); releaseVoice(voice, false); };
    try { voice.source.start(context.currentTime); return true; } catch { release(id); return false; }
  }
  function startWind() {
    if (wind || !context) return;
    const voice = makeVoice('wind', 1, true); if (!voice) return; wind = voice;
    voice.source.onended = () => { if (wind === voice) wind = null; releaseVoice(voice, false); };
    try { voice.source.start(context.currentTime); } catch { stopWind(); }
  }
  function tick(elapsed: number, activities: readonly HomeAudioActor[], area?: HomeAudioArea | null) {
    if (!enabled || !desired || disposed || !context || context.state !== 'running') return;
    if (!Number.isFinite(elapsed) || elapsed < 0) { paused = true; silence(); return; }
    const nextArea = area === 'outdoor' || area === 'indoor' || area === 'bedroom' ? area : null, soundscape = nextArea !== null;
    const actors = new Map<number, HomeAudioActor>();
    for (const actor of activities) if (Number.isSafeInteger(actor.actorId) && actor.actorId > 0 && actor.audible !== false && !actors.has(actor.actorId) && actors.size < 32) actors.set(actor.actorId, actor);
    for (const id of [...voices.keys()]) if (id > 0 && (!actors.has(id) || seen.get(id)?.activity !== actors.get(id)?.activity
      || voices.get(id)?.kind === 'step' && actors.get(id)?.moving === false
      || !soundscape && ['step', 'pour', 'cup'].includes(voices.get(id)!.kind))) release(id);
    for (const id of [...seen.keys()]) if (!actors.has(id)) { seen.delete(id); origins.delete(id); }
    const rebase = lastElapsed === null || elapsed < lastElapsed || elapsed - lastElapsed > .75 || paused;
    if (rebase) { for (const id of [...voices.keys()]) release(id); stopWind(); outdoorSeen = null; }
    if (nextArea !== 'outdoor') { stopWind(); release(-1); outdoorSeen = null; }
    else startWind();
    for (const actor of actors.values()) {
      const rawStart = actor.startedAtElapsed;
      const clockStart = typeof rawStart === 'number' && Number.isFinite(rawStart) && rawStart >= 0 && rawStart <= Number.MAX_SAFE_INTEGER ? rawStart : null;
      const previous = seen.get(actor.actorId), clockChanged = !!previous && previous.clockStart !== clockStart;
      if (clockChanged) release(actor.actorId);
      let origin = origins.get(actor.actorId);
      if (clockStart !== null) origin = { activity: actor.activity, start: clockStart };
      else if (!origin || clockChanged || origin.activity !== actor.activity || elapsed < origin.start) origin = { activity: actor.activity, start: elapsed };
      origins.set(actor.actorId, origin);
      const extra = soundscape && !(actor.activity === 'walk' && actor.moving === false)
        ? sampleHomeExtraAudio(actor.activity, elapsed - origin.start, actor.actorId) : null;
      const baseStart = clockStart ?? 0;
      const base = elapsed < baseStart ? null : sampleHomeAmbience(actor.activity, elapsed - baseStart, actor.actorId).audio;
      const cue = extra ? { ...extra, startedAt: extra.startedAt + origin.start } : base ? { ...base, startedAt: base.startedAt + baseStart } : null;
      const key = cue ? cue.kind + ':' + cue.episode : null;
      if (!rebase && previous?.activity === actor.activity && previous.clockStart === clockStart && cue && key !== previous.event && elapsed - cue.startedAt <= .12) {
        release(actor.actorId); play(actor.actorId, cue, soundscape ? 4 : 3);
      }
      seen.set(actor.actorId, { activity: actor.activity, event: key, clockStart });
    }
    if (nextArea === 'outdoor') {
      const cue = sampleHomeOutdoorAudio(elapsed), key = cue ? cue.kind + ':' + cue.episode : null;
      if (!rebase && currentArea === 'outdoor' && cue && key !== outdoorSeen && elapsed - cue.startedAt <= .12) { release(-1); play(-1, cue, 4); }
      outdoorSeen = key;
    }
    currentArea = nextArea; paused = false; lastElapsed = elapsed; lastContextTime = context.currentTime;
  }
  function syncDoorState(id: string, open: boolean) {
    if (!enabled || !desired || disposed || typeof id !== 'string' || !id || id.length > 64 || typeof open !== 'boolean') return;
    if (doorStates.size >= 16 && !doorStates.has(id)) doorStates.delete(doorStates.keys().next().value!);
    doorStates.set(id, open);
  }
  function triggerDoor(id: string, open: boolean) {
    if (!enabled || !desired || disposed || paused || !context || context.state !== 'running' || lastContextTime === null
      || context.currentTime - lastContextTime > .75 || typeof id !== 'string' || !id || id.length > 64 || typeof open !== 'boolean') return false;
    if (doorStates.get(id) === open) return false;
    syncDoorState(id, open);
    let hash = 0; for (let i = 0; i < id.length; i++) hash = Math.imul(hash, 31) + id.charCodeAt(i) | 0;
    const key = -100 - (hash >>> 0) % 1024; release(key);
    return play(key, { kind: open ? 'door-open' : 'door-close', episode: open ? 1 : 0, startedAt: 0, progress: 0 }, 4);
  }
  return {
    enable,
    /** true records intent only; enable() still requires an explicit user click. */
    setEnabled(value: boolean) { if (!value) off(); else if (!disposed) desired = true; },
    tick, triggerDoor, syncDoorState,
    pause() { paused = true; silence(); },
    dispose() { if (disposed) return; disposed = true; off(); },
    getSnapshot: () => Object.freeze({ enabled, desired, disposed, activeVoices: voices.size, ambientActive: !!wind,
      cachedBuffers: buffers.size, origin: HOME_AUDIO_ORIGIN }),
  };
}
