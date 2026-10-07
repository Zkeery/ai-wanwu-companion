/** Opt-in, local-only diagnostics. No identity, photo, request key or provider data. */
export const GENERATION_PERFORMANCE_KEY = 'companion-generation-performance-v1';
const MAX_SAMPLES = 100;
type Status = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'needs_review';
type Mark = 'click' | 'upload_started' | 'recognized' | 'generation_started' | 'ready' | 'displayed' | 'ended';
type Sample = { sample_id: string; status: Status; marks: Partial<Record<Mark, number>> };
type Batch = { schema_version: 1; overflowed: boolean; samples: Sample[] };
function readBatch(): Batch {
  const raw = sessionStorage.getItem(GENERATION_PERFORMANCE_KEY);
  if (!raw) return { schema_version: 1, overflowed: false, samples: [] };
  const value = JSON.parse(raw);
  if (value?.schema_version !== 1 || typeof value.overflowed !== 'boolean' || !Array.isArray(value.samples) || value.samples.length > MAX_SAMPLES) throw new Error('Invalid diagnostic batch');
  if (Object.keys(value).some(k => !['schema_version', 'overflowed', 'samples'].includes(k))) throw new Error('Invalid diagnostic fields');
  for (const sample of value.samples) {
    if (typeof sample?.sample_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sample.sample_id) || !['running', 'succeeded', 'failed', 'interrupted', 'needs_review'].includes(sample.status) || !sample.marks || typeof sample.marks !== 'object') throw new Error('Invalid diagnostic sample');
    if (Object.keys(sample).some(k => !['sample_id', 'status', 'marks'].includes(k))) throw new Error('Invalid diagnostic fields');
    for (const [key, n] of Object.entries(sample.marks)) if (!['click', 'upload_started', 'recognized', 'generation_started', 'ready', 'displayed', 'ended'].includes(key) || typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error('Invalid diagnostic mark');
  }
  return value;
}
export type GenerationMeasurement = {
  mark: (name: Exclude<Mark, 'click' | 'displayed' | 'ended'>) => void;
  finish: (status: Exclude<Status, 'running'>, at?: number) => void;
};
export function beginGenerationMeasurement(startedAt: number): GenerationMeasurement | null {
  if (process.env.NEXT_PUBLIC_GENERATION_DIAGNOSTICS !== 'true') return null;
  try {
    const batch = readBatch();
    if (batch.overflowed || batch.samples.length >= MAX_SAMPLES) {
      batch.overflowed = true; sessionStorage.setItem(GENERATION_PERFORMANCE_KEY, JSON.stringify(batch)); return null;
    }
    const sample: Sample = { sample_id: crypto.randomUUID(), status: 'running', marks: { click: 0 } };
    batch.samples.push(sample); sessionStorage.setItem(GENERATION_PERFORMANCE_KEY, JSON.stringify(batch));
    const save = () => {
      try {
        const current = readBatch(), index = current.samples.findIndex(s => s.sample_id === sample.sample_id);
        if (index < 0) return; // Never resurrect a batch deliberately cleared by the operator.
        current.samples[index] = sample; sessionStorage.setItem(GENERATION_PERFORMANCE_KEY, JSON.stringify(current));
      } catch { /* Diagnostics cannot interrupt the business request. Last running record remains non-passing. */ }
    };
    return {
      mark(name) { if (sample.status !== 'running' || sample.marks[name] !== undefined) return; sample.marks[name] = Math.max(0, performance.now() - startedAt); save(); },
      finish(status, at = performance.now()) {
        if (sample.status !== 'running') return;
        const elapsed = Math.max(0, at - startedAt);
        sample.status = status; sample.marks.ended = elapsed;
        if (status === 'succeeded') sample.marks.displayed = elapsed;
        save();
      },
    };
  } catch { return null; }
}
