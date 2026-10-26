import { createHash, webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/lib/sha256';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each([0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 127, 128, 255, 1024, 262144, 1048576, 10 * 1024 * 1024])(
  'matches the independent platform SHA-256 for %i bytes without Web Crypto', async length => {
    vi.stubGlobal('crypto', {});
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 255;
    expect(await sha256Hex(bytes.buffer)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
it('uses the native digest when available and rejects its failures', async () => {
  const digest = vi.fn((algorithm: string, input: ArrayBuffer) => webcrypto.subtle.digest(algorithm, input));
  vi.stubGlobal('crypto', { subtle: { digest } });
  expect(await sha256Hex(new TextEncoder().encode('abc').buffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(digest).toHaveBeenCalledOnce();
  digest.mockRejectedValueOnce(new Error('native failure'));
  await expect(sha256Hex(new ArrayBuffer(1))).rejects.toThrow('native failure');
});
it('bounds work and aborts both before hashing and while yielding a large file', async () => {
  vi.stubGlobal('crypto', {});
  await expect(sha256Hex(new ArrayBuffer(10 * 1024 * 1024 + 1))).rejects.toThrow('校验文件过大');
  const stopped = new AbortController(); stopped.abort();
  await expect(sha256Hex(new ArrayBuffer(1), stopped.signal)).rejects.toThrow();
  const active = new AbortController();
  const pending = sha256Hex(new ArrayBuffer(1048576), active.signal);
  active.abort(); await expect(pending).rejects.toThrow();
});
