import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomRequestId } from '@/lib/request-id';

afterEach(() => vi.unstubAllGlobals());

describe('request IDs on public HTTP origins', () => {
  it('uses secure random bytes when randomUUID is unavailable', () => {
    let counter = 0;
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) array[i] = (i * 17 + counter) % 256;
      counter++;
      return array;
    } });
    const first = randomRequestId(), second = randomRequestId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
    sessionStorage.setItem('http-request-receipt', first);
    expect(sessionStorage.getItem('http-request-receipt')).toBe(first);
    sessionStorage.removeItem('http-request-receipt');
  });

  it('retains the native secure-context behavior', () => {
    const id = 'bbd02b9c-c78b-491f-96b7-e019478557dd';
    vi.stubGlobal('crypto', { randomUUID: () => id });
    expect(randomRequestId()).toBe(id);
  });

  it('fails before submission when no cryptographic source exists', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => randomRequestId()).toThrow('无法生成请求标识');
  });
});
