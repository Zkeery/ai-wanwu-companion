import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginGenerationMeasurement, GENERATION_PERFORMANCE_KEY } from '@/lib/generation-performance';
let now=0;
const batch=()=>JSON.parse(sessionStorage.getItem(GENERATION_PERFORMANCE_KEY)!);
beforeEach(()=>{sessionStorage.clear();vi.stubEnv('NEXT_PUBLIC_GENERATION_DIAGNOSTICS','true');now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('does nothing when disabled',()=>{vi.stubEnv('NEXT_PUBLIC_GENERATION_DIAGNOSTICS','false');expect(beginGenerationMeasurement(0)).toBeNull();expect(sessionStorage.getItem(GENERATION_PERFORMANCE_KEY)).toBeNull();});
it('captures complete nonrounded segments and ends only at final display',()=>{
  const m=beginGenerationMeasurement(0)!;
  for(const [name,value] of [['upload_started',10],['recognized',600],['generation_started',650],['ready',4700]] as const){now=value;m.mark(name);}
  expect(batch().samples[0].status).toBe('running');expect(batch().samples[0].marks.displayed).toBeUndefined();
  now=5000.1;m.finish('succeeded');m.finish('failed');m.mark('ready');
  expect(batch().samples[0]).toMatchObject({status:'succeeded',marks:{click:0,upload_started:10,recognized:600,generation_started:650,ready:4700,displayed:5000.1,ended:5000.1}});
});
it('retains failed/interrupted samples and cannot turn late results into success',()=>{
  const a=beginGenerationMeasurement(0)!;now=50;a.finish('failed');a.finish('succeeded');
  const b=beginGenerationMeasurement(50)!;now=90;b.finish('interrupted');
  expect(batch().samples.map((s:{status:string})=>s.status)).toEqual(['failed','interrupted']);
  expect(batch().samples[0].marks.displayed).toBeUndefined();
});
it('preserves running samples across a new measurement and uses different anonymous IDs',()=>{
  beginGenerationMeasurement(0);now=100;beginGenerationMeasurement(100);
  expect(batch().samples).toHaveLength(2);expect(batch().samples[0].status).toBe('running');
  expect(batch().samples[0].sample_id).not.toBe(batch().samples[1].sample_id);
});
it('marks overflow and retains all earlier samples rather than evicting failures',()=>{
  for(let i=0;i<100;i++)beginGenerationMeasurement(0)!.finish('failed');
  const ids=batch().samples.map((s:{sample_id:string})=>s.sample_id);
  expect(beginGenerationMeasurement(0)).toBeNull();expect(batch().overflowed).toBe(true);
  expect(batch().samples.map((s:{sample_id:string})=>s.sample_id)).toEqual(ids);
});
it('does not block creation or overwrite evidence when storage is corrupt or unavailable',()=>{
  sessionStorage.setItem(GENERATION_PERFORMANCE_KEY,'corrupt');expect(beginGenerationMeasurement(0)).toBeNull();expect(sessionStorage.getItem(GENERATION_PERFORMANCE_KEY)).toBe('corrupt');
  sessionStorage.clear();vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('storage blocked');});expect(beginGenerationMeasurement(0)).toBeNull();
});
it('does not resurrect a deliberately cleared batch',()=>{const m=beginGenerationMeasurement(0)!;sessionStorage.removeItem(GENERATION_PERFORMANCE_KEY);m.finish('succeeded');expect(sessionStorage.getItem(GENERATION_PERFORMANCE_KEY)).toBeNull();});
