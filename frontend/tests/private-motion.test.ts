import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearPrivateMotionCache, loadPrivateMotion, loadPrivateMotionShared, loadGatheringMotion } from '@/lib/private-motion';

const hash = async (data: string) => Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(data))), n => n.toString(16).padStart(2, '0')).join('');
let metadata: Record<string, unknown>, fetcher: ReturnType<typeof vi.fn>;
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

it('loads shared assets only through the current group and rejects private or other-group URLs', async () => {
  const group = '11111111-1111-4111-8111-111111111111';
  const base = `/api/v1/gatherings/${group}/companions/7/motion`;
  metadata.activity = 'rest'; metadata.slot = 'activity';
  metadata.sprite_url = `${base}/activity/rest/${metadata.pack_id}/sprite`;
  metadata.background_url = `${base}/activity/rest/${metadata.pack_id}/background`;
  fetcher.mockImplementation(async (url: string) => url.includes('?activity=') ? json(metadata)
    : new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } }));
  const loaded = await loadGatheringMotion(group, 7, 'member', new AbortController().signal, 'rest');
  expect(fetcher.mock.calls[0][0]).toBe(base + '?activity=rest');
  expect(loaded.asset?.activity).toBe('rest'); loaded.dispose();
  for (const invalid of ['/api/v1/characters/7/motion/activity/rest/', `/api/v1/gatherings/${'2'.repeat(36)}/companions/7/motion/activity/rest/`]) {
    metadata.sprite_url = invalid + metadata.pack_id + '/sprite';
    const before = fetcher.mock.calls.length;
    await expect(loadGatheringMotion(group, 7, 'member', new AbortController().signal, 'rest')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(before + 1);
  }
  await expect(loadGatheringMotion('../escape', 7, 'member', new AbortController().signal, 'rest')).rejects.toThrow();
});
beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('crypto', webcrypto);
  URL.createObjectURL = vi.fn().mockReturnValueOnce('blob:sprite').mockReturnValueOnce('blob:background');
  URL.revokeObjectURL = vi.fn();
  const pack = 'a'.repeat(32), base = '/api/v1/characters/7/motion/' + pack;
  metadata = { state: 'ready', pack_id: pack, source_sha256: 'b'.repeat(64),
    sprite_url: base + '/sprite', background_url: base + '/background',
    sprite_sha256: await hash('sprite'), background_sha256: await hash('background'),
    frame_width: 320, frame_height: 320, frame_count: 12, fps: 12 };
  fetcher = vi.fn(async (url: string) => url.endsWith('/motion') ? json(metadata)
    : new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { clearPrivateMotionCache(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('hands a verified activity asset from the scene to its detail without a second download', async () => {
  metadata.activity = 'rest';
  fetcher.mockImplementation(async (url: string) => url.includes('/motion?') ? json(metadata)
    : new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } }));
  const scene = await loadPrivateMotionShared(7, 'session', new AbortController().signal, 'rest');
  expect(fetcher).toHaveBeenCalledTimes(3);
  vi.useFakeTimers();
  scene.dispose();
  const detail = await loadPrivateMotionShared(7, 'session', new AbortController().signal, 'rest');
  expect(detail.asset).toBe(scene.asset);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  detail.dispose();
  vi.advanceTimersByTime(3000);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});

it('clears the short handoff cache when activity playback becomes invalid', async () => {
  metadata.activity = 'rest';
  fetcher.mockImplementation(async (url: string) => url.includes('/motion?') ? json(metadata)
    : new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } }));
  const loaded = await loadPrivateMotionShared(7, 'session', new AbortController().signal, 'rest');
  clearPrivateMotionCache();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  loaded.dispose();
  vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:new-sprite').mockReturnValueOnce('blob:new-background');
  const afterPause = await loadPrivateMotionShared(7, 'session', new AbortController().signal, 'rest');
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(afterPause.asset).not.toBe(loaded.asset);
  afterPause.dispose();
});

it('keeps activity and login sessions separate even during the handoff window', async () => {
  let urlNumber = 0;
  vi.mocked(URL.createObjectURL).mockReset().mockImplementation(() => `blob:asset-${++urlNumber}`);
  fetcher.mockImplementation(async (url: string) => {
    if (url.includes('/motion?')) return json({ ...metadata, activity: url.endsWith('walk') ? 'walk' : 'rest' });
    return new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } });
  });
  const rest = await loadPrivateMotionShared(7, 'first-session', new AbortController().signal, 'rest');
  const walk = await loadPrivateMotionShared(7, 'first-session', new AbortController().signal, 'walk');
  const anotherAccount = await loadPrivateMotionShared(7, 'second-session', new AbortController().signal, 'rest');
  expect(fetcher).toHaveBeenCalledTimes(9);
  expect(new Set([rest.asset?.spriteUrl, walk.asset?.spriteUrl, anotherAccount.asset?.spriteUrl]).size).toBe(3);
  rest.dispose(); walk.dispose(); anotherAccount.dispose();
});

it('releases the redundant verified asset when two identical loads overlap', async () => {
  let release!: () => void;
  const metadataGate = new Promise<void>(resolve => { release = resolve; });
  let urlNumber = 0;
  vi.mocked(URL.createObjectURL).mockReset().mockImplementation(() => `blob:overlap-${++urlNumber}`);
  fetcher.mockImplementation(async (url: string) => {
    if (url.includes('/motion?')) { await metadataGate; return json({ ...metadata, activity: 'rest' }); }
    return new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } });
  });
  const first = loadPrivateMotionShared(7, 'session', new AbortController().signal, 'rest');
  const second = loadPrivateMotionShared(7, 'session', new AbortController().signal, 'rest');
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a.asset).toBe(b.asset);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  vi.useFakeTimers(); a.dispose(); b.dispose(); vi.advanceTimersByTime(3000);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4);
});

it('authenticates resources, verifies bytes and revokes owned URLs', async () => {
  const loaded = await loadPrivateMotion(7, 'synthetic-session', new AbortController().signal);
  expect(loaded.asset?.spriteUrl).toBe('blob:sprite');
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [url, options] of fetcher.mock.calls) {
    expect(url).not.toContain('synthetic-session');
    expect(options).toMatchObject({ headers: { Authorization: 'Bearer synthetic-session' }, cache: 'no-store', redirect: 'error' });
  }
  loaded.dispose(); loaded.dispose(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});
it('missing state does not request resources or generate', async () => {
  metadata = { state: 'missing' };
  const loaded = await loadPrivateMotion(7, 'session', new AbortController().signal);
  expect(loaded.asset).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('loads a verified private MP4 and releases its Blob exactly once', async () => {
  metadata = {state:'ready',kind:'video',pack_id:'a'.repeat(32),source_sha256:'b'.repeat(64),
    width:960,height:720,fps:24,duration_ms:6042,video_sha256:await hash('video'),
    video_url:'/api/v1/characters/7/motion/'+ 'a'.repeat(32) + '/video'};
  fetcher.mockImplementation(async (url: string) => url.endsWith('/motion') ? json(metadata)
    : new Response('video',{headers:{'Content-Type':'video/mp4'}}));
  const result=await loadPrivateMotion(7,'session',new AbortController().signal);
  expect(result.asset).toMatchObject({videoUrl:'blob:sprite',frameWidth:960,durationMs:6042});
  expect(fetcher).toHaveBeenCalledTimes(2); result.dispose();result.dispose();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  metadata.video_url='https://outside/video';
  await expect(loadPrivateMotion(7,'session',new AbortController().signal)).rejects.toThrow();
});
it.each([
  { sprite_url: 'https://outside/sprite' }, { background_url: '/api/v1/characters/8/motion/a/background' },
  { frame_width: 99999 }, { frame_count: true }, { fps: 25 }, { source_sha256: 'invalid' },
  { pack_id: '../escape' }, { state: 'pending' },
])('rejects invalid metadata before reading private files: %j', async change => {
  Object.assign(metadata, change);
  await expect(loadPrivateMotion(7, 'session', new AbortController().signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('rejects altered PNG bytes before creating URLs', async () => {
  metadata.sprite_sha256 = '0'.repeat(64);
  await expect(loadPrivateMotion(7, 'session', new AbortController().signal)).rejects.toThrow('无法核对');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('rejects oversized streamed content and wrong content type', async () => {
  fetcher.mockImplementation(async (url: string) => url.endsWith('/motion') ? json(metadata)
    : new Response(new Uint8Array(10 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } }));
  await expect(loadPrivateMotion(7, 'session', new AbortController().signal)).rejects.toThrow('过大');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  fetcher.mockImplementation(async (url: string) => url.endsWith('/motion') ? json(metadata) : new Response('html'));
  await expect(loadPrivateMotion(7, 'session', new AbortController().signal)).rejects.toThrow('格式');
});
it('does not create URLs after abort and cleans partial URL failures', async () => {
  const controller = new AbortController();
  fetcher.mockImplementation(async (url: string) => {
    if (url.endsWith('/motion')) return json(metadata);
    controller.abort();
    return new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } });
  });
  await expect(loadPrivateMotion(7, 'session', controller.signal)).rejects.toThrow();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  fetcher.mockImplementation(async (url: string) => url.endsWith('/motion') ? json(metadata)
    : new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } }));
  vi.mocked(URL.createObjectURL).mockReset().mockReturnValueOnce('blob:partial').mockImplementationOnce(() => { throw new Error('synthetic failure'); });
  await expect(loadPrivateMotion(7, 'session', new AbortController().signal)).rejects.toThrow();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:partial');
});

it.each(['rest', 'walk', 'observe'] as const)('requests only the matching %s pack and authenticates media', async activity => {
  metadata.activity = activity;
  fetcher.mockImplementation(async (url: string) => url.includes('/motion?') ? json(metadata)
    : new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } }));
  const loaded = await loadPrivateMotion(7, 'session', new AbortController().signal, activity);
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/characters/7/motion?activity=' + activity);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(loaded.asset).not.toBeNull(); loaded.dispose();
});
it.each([undefined, 'walk', 'dance', null])('rejects mismatched current motion before media: %j', async activity => {
  metadata.activity = activity;
  fetcher.mockImplementation(async () => json(metadata));
  await expect(loadPrivateMotion(7, 'session', new AbortController().signal, 'rest')).rejects.toThrow('当前活动');
  expect(fetcher).toHaveBeenCalledTimes(1); expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('current activity missing never falls back to the unfiltered dance endpoint', async () => {
  fetcher.mockImplementation(async () => json({ state: 'missing' }));
  const loaded = await loadPrivateMotion(7, 'session', new AbortController().signal, 'rest');
  expect(loaded.asset).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toContain('?activity=rest');
});

it('loads the selected private activity slot without accepting a sibling or generic URL', async () => {
  metadata.activity = 'rest';
  metadata.slot = 'activity';
  const pack = 'a'.repeat(32), base = '/api/v1/characters/7/motion/activity/rest/' + pack;
  metadata.sprite_url = base + '/sprite'; metadata.background_url = base + '/background';
  fetcher.mockImplementation(async (url: string) => url.includes('?activity=rest') ? json(metadata)
    : new Response(url.endsWith('/sprite') ? 'sprite' : 'background', { headers: { 'Content-Type': 'image/png' } }));
  const loaded = await loadPrivateMotion(7, 'session', new AbortController().signal, 'rest');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/v1/characters/7/motion?activity=rest', base + '/sprite', base + '/background',
  ]);
  loaded.dispose();
  metadata.sprite_url = '/api/v1/characters/7/motion/activity/walk/' + pack + '/sprite';
  await expect(loadPrivateMotion(7, 'session', new AbortController().signal, 'rest')).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it.each(['activity', 'unexpected'])('rejects invalid activity-slot metadata without a current activity: %j', async slot => {
  metadata.activity = 'rest'; metadata.slot = slot;
  fetcher.mockImplementation(async () => json(metadata));
  await expect(loadPrivateMotion(7, 'session', new AbortController().signal)).rejects.toThrow('当前活动');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
