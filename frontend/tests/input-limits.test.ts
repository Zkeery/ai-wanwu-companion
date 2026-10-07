import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectText } from '@/lib/input-limits';

// JSON.parse deliberately permits lone-surrogate fixtures, unlike Vite's JSON transformer.
const samples: { name: string; input: string; normalized: string; count: number; validUnicode: boolean }[] = JSON.parse(
  readFileSync(resolve(process.cwd(), '../tests/fixtures/input-limits.json'), 'utf8'),
);

it.each(samples)('uses the shared code-point/trim rule: $name', sample => {
  const result = inspectText(sample.input, 'memory');
  expect(result.text).toBe(sample.normalized);
  expect(result.count).toBe(sample.count);
  expect(result.validUnicode).toBe(sample.validUnicode);
  expect(result.valid).toBe(sample.validUnicode && sample.count > 0);
});

it.each(['message', 'memory'] as const)('retains %s input at and beyond its limit', kind => {
  const limit = kind === 'message' ? 4000 : 1000;
  for (const size of [limit - 1, limit, limit + 1]) {
    const result = inspectText(' \ufeff' + '🌱'.repeat(size) + '　', kind);
    expect(result.count).toBe(size);
    expect(result.text).toBe('🌱'.repeat(size));
    expect(result.valid).toBe(size <= limit);
  }
});
