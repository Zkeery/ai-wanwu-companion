import { expect, it } from 'vitest';
import { encodeMonoWav, isVSCodeEmbeddedBrowser } from '@/lib/pcm-recorder';

it('uses PCM fallback only for the VS Code Electron browser', () => {
  expect(isVSCodeEmbeddedBrowser('Mozilla/5.0 Code/1.139.0 Chrome/150.0 Electron/43.6.0')).toBe(true);
  expect(isVSCodeEmbeddedBrowser('Mozilla/5.0 Chrome/150.0 Safari/537.36')).toBe(false);
});

it('makes a playable 16 kHz mono PCM WAV within the existing upload contract', async () => {
  const wav = encodeMonoWav([new Float32Array(48000).fill(0.5)], 48000);
  const bytes = Buffer.from(await wav.arrayBuffer());
  expect(wav.type).toBe('audio/wav');
  expect(wav.size).toBe(44 + 16000 * 2);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  expect(bytes.readUInt16LE(22)).toBe(1);
  expect(bytes.readUInt32LE(24)).toBe(16000);
  expect(bytes.readUInt16LE(34)).toBe(16);
  expect(bytes.readInt16LE(44)).toBeGreaterThan(16000);
  expect(encodeMonoWav([], 48000).size).toBe(44);
});
