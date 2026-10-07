import { expect, it, vi } from 'vitest';
import { RainAudio } from '@/lib/rain-audio';
it('creates one looping source, changes volume and closes all audio on leave', async () => {
  const volume = vi.fn(), stop = vi.fn(), close = vi.fn().mockResolvedValue(undefined), start = vi.fn();
  const gain = { gain: { value: 0, setTargetAtTime: volume }, connect: vi.fn() };
  const filter = { type: '', frequency: { value: 0 }, connect: vi.fn().mockReturnValue(gain) };
  const createSource = vi.fn().mockReturnValue({ buffer: null, loop: false, connect: vi.fn().mockReturnValue(filter), start, stop });
  class Context { state = 'running'; sampleRate = 10; currentTime = 0; destination = {}; resume = vi.fn().mockResolvedValue(undefined); close = close; createBuffer = () => ({ getChannelData: () => new Float32Array(30) }); createBufferSource = createSource; createBiquadFilter = () => filter; createGain = () => gain; }
  vi.stubGlobal('AudioContext', Context);
  try { const audio = new RainAudio(); await audio.enable(); await audio.enable(); audio.volume(true); audio.volume(false); audio.volume(true); expect(createSource).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1); expect(volume.mock.calls.map(c => c[0])).toEqual([0.3, 0, 0.3]); audio.close(); expect(stop).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1); } finally { vi.unstubAllGlobals(); }
});
