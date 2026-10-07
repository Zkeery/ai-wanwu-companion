import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MotionPlayer, { type MotionAsset } from '@/components/motion-player';

const asset: MotionAsset = { spriteUrl: '/motion-preview-assets/sprite.png', backgroundUrl: '/motion-preview-assets/background.png', frameWidth: 320, frameHeight: 320, frameCount: 12, fps: 12 };
let requests: MockImage[], frames: Map<number, FrameRequestCallback>, serial: number, reduced: boolean, mediaChange: () => void;
const draw = vi.fn(), clear = vi.fn();
class MockImage {
  src = ''; naturalWidth = 0; naturalHeight = 0;
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor() { requests.push(this); }
}
function tick() { const current = [...frames.values()]; frames.clear(); act(() => current.forEach(f => f(performance.now()))); }
function loadStatic() { fireEvent.load(screen.getByRole('img')); tick(); }
function loadSceneStatic() { fireEvent.load(screen.getByRole('img', { hidden: true })); tick(); }
function loadAssets() { act(() => requests.forEach(i => { i.naturalWidth = i.src.includes('sprite') ? 3840 : 320; i.naturalHeight = 320; i.onload?.(); })); }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  requests = []; frames = new Map(); serial = 0; reduced = false; mediaChange = () => {};
  draw.mockReset(); clear.mockReset();
  vi.stubGlobal('Image', MockImage);
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.set(++serial, f); return serial; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: (_: string, callback: () => void) => { mediaChange = callback; }, removeEventListener: vi.fn() }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw, clearRect: clear } as unknown as CanvasRenderingContext2D);
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const mount = () => render(<MotionPlayer name="示意" staticSrc="/motion-preview-assets/static.png" asset={asset} />);

async function mountVideo(scene = false) {
  const decoders: HTMLVideoElement[]=[];
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(function(this: HTMLVideoElement) { if(this.src) decoders.push(this); });
  const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();
  const pause=vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  const dispose=vi.fn();
  const videoAsset={...asset,spriteUrl:'',backgroundUrl:'',videoUrl:'blob:video',frameWidth:960,frameHeight:720,durationMs:6000,fps:24};
  const view=render(<MotionPlayer name="视频伙伴" staticSrc="/motion-preview-assets/static.png"
    activity={scene ? 'walk' : undefined} scene={scene} loadAsset={async()=>({asset:videoAsset,dispose})}/>);
  if (scene) loadSceneStatic(); else loadStatic();
  await act(async()=>{});
  const decode=()=>act(()=>{
    const d=decoders[0]; Object.defineProperties(d,{videoWidth:{value:960},videoHeight:{value:720},duration:{value:6}});
    d.dispatchEvent(new Event('loadeddata'));
  });
  return {view,play,pause,dispose,decode};
}

it('lets missing private motion be checked again without reloading the page', async () => {
  const dispose = vi.fn();
  const loader = vi.fn().mockResolvedValueOnce({ asset: null, dispose })
    .mockResolvedValueOnce({ asset, dispose: vi.fn() });
  render(<MotionPlayer name="等待素材" staticSrc="/motion-preview-assets/static.png" loadAsset={loader} />);
  loadStatic(); await act(async () => {});
  expect(screen.getByRole('status')).toHaveTextContent('还没准备好');
  fireEvent.click(screen.getByRole('button', { name: '检查动作是否就绪' }));
  loadStatic(); await act(async () => {}); loadAssets();
  expect(loader).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '跳个舞' })).toBeInTheDocument();
});

it('does not restart the ten-second preparation deadline when a queued asset arrives late', async () => {
  let complete!: (value: { asset: MotionAsset; dispose: () => void }) => void;
  const dispose = vi.fn();
  const loader = vi.fn(() => new Promise<{ asset: MotionAsset; dispose: () => void }>(resolve => { complete = resolve; }));
  render(<MotionPlayer name="等待队列" staticSrc="/motion-preview-assets/static.png" loadAsset={loader} />);
  loadStatic(); await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(9500); complete({ asset, dispose }); });
  act(() => vi.advanceTimersByTime(500)); loadAssets();
  expect(screen.getByRole('status')).toHaveTextContent('没加载好');
  expect(dispose).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '重新加载动作' })).toBeInTheDocument();
});

it('plays video muted, resets on stop, and releases on unmount',async()=>{
  const {view,play,pause,dispose,decode}=await mountVideo();decode();
  const video=document.querySelector('video')!;
  fireEvent.click(screen.getByRole('button',{name:'跳个舞'}));
  expect(play).toHaveBeenCalledTimes(1);expect(video.muted).toBe(true);expect(video.loop).toBe(true);
  video.currentTime=3;fireEvent.click(screen.getByRole('button',{name:'停止动作'}));
  expect(pause).toHaveBeenCalled();expect(video.currentTime).toBe(0);
  view.unmount();expect(dispose).toHaveBeenCalledTimes(1);
});
it('falls back on video play rejection without an automatic retry',async()=>{
  const {play,decode}=await mountVideo();decode();play.mockRejectedValue(new Error('denied'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'跳个舞'})));
  expect(screen.getByRole('status')).toHaveTextContent('没加载好');expect(play).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('img')).toBeInTheDocument();
});
it('rejects a late video decoder and keeps the static fallback',async()=>{
  const {decode,dispose}=await mountVideo();act(()=>vi.advanceTimersByTime(10000));decode();
  expect(screen.getByRole('status')).toHaveTextContent('没加载好');expect(dispose).toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:'跳个舞'})).not.toBeInTheDocument();
});
it('stops video when the page hides or reduced motion is enabled',async()=>{
  const {decode}=await mountVideo();decode();fireEvent.click(screen.getByRole('button',{name:'跳个舞'}));
  Object.defineProperty(document,'hidden',{value:true,configurable:true});fireEvent(document,new Event('visibilitychange'));
  expect(screen.getByRole('button',{name:'跳个舞'})).toHaveAttribute('aria-pressed','false');
  act(()=>{reduced=true;mediaChange();});expect(screen.getByRole('status')).toHaveTextContent('系统偏好');
});

it('allows only one companion to play at a time',()=>{
  render(<><MotionPlayer name="甲" staticSrc="/motion-preview-assets/a.png" asset={asset}/>
    <MotionPlayer name="乙" staticSrc="/motion-preview-assets/b.png" asset={asset}/></>);
  screen.getAllByRole('img').forEach(img=>fireEvent.load(img));tick();loadAssets();
  const first=screen.getByRole('region',{name:'甲的动作'}),second=screen.getByRole('region',{name:'乙的动作'});
  fireEvent.click(within(first).getByRole('button',{name:'跳个舞'}));
  expect(within(first).getByRole('button',{name:'停止动作'})).toBeInTheDocument();
  fireEvent.click(within(second).getByRole('button',{name:'跳个舞'}));
  expect(within(first).getByRole('button',{name:'跳个舞'})).toHaveAttribute('aria-pressed','false');
  expect(within(second).getByRole('button',{name:'停止动作'})).toHaveAttribute('aria-pressed','true');
  expect(frames.size).toBe(1);
});
it('prepares a compact card only in view, stops on exit and reuses its resources',async()=>{
  let observeChange!: IntersectionObserverCallback;
  const disconnect=vi.fn();
  vi.stubGlobal('IntersectionObserver',class {constructor(cb:IntersectionObserverCallback){observeChange=cb;}observe(){}disconnect=disconnect;});
  const loadAsset=vi.fn(async()=>({asset:{...asset,spriteUrl:'blob:sprite',backgroundUrl:'blob:background'},dispose:vi.fn()}));
  const view=render(<MotionPlayer name="卡片" staticSrc="/motion-preview-assets/static.png" compact href="/companions/7?tab=chat" loadAsset={loadAsset}/>);
  loadStatic();await act(async()=>{});expect(loadAsset).not.toHaveBeenCalled();
  const visibility=(isIntersecting:boolean)=>observeChange([{isIntersecting}] as IntersectionObserverEntry[],{} as IntersectionObserver);
  await act(async()=>visibility(true));loadAssets();
  fireEvent.click(screen.getByRole('button',{name:'跳个舞'}));expect(frames.size).toBe(1);
  expect(screen.getByRole('link',{name:'查看卡片'})).toHaveAttribute('href','/companions/7?tab=chat');
  expect(document.querySelector('a button')).toBeNull();
  act(()=>visibility(false));expect(frames.size).toBe(0);
  await act(async()=>visibility(true));expect(loadAsset).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button',{name:'跳个舞'})).toHaveAttribute('aria-pressed','false');
  view.unmount();expect(disconnect).toHaveBeenCalledTimes(1);
});

describe('offline motion resource lifecycle', () => {
  it('prepares a cached static image whose load event preceded hydration', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(320);
    mount(); tick(); expect(requests).toHaveLength(2); loadAssets();
    expect(screen.getByRole('status')).toHaveTextContent('已就绪');
  });
  it('starts preparation after static image paint and keeps missing assets honest', () => {
    render(<MotionPlayer name="示意" staticSrc="/motion-preview-assets/static.png" />);
    loadStatic(); expect(requests).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('动作还没准备好');
    expect(screen.queryByRole('button', { name: '跳个舞' })).not.toBeInTheDocument();
  });
  it('draws a fixed background and changing sprite frames then stops on exit', () => {
    const view = mount(); expect(requests).toHaveLength(0);
    loadStatic(); loadAssets();
    fireEvent.mouseEnter(screen.getByRole('img').parentElement!);
    expect(draw.mock.calls[0].slice(1)).toEqual([0, 0, 320, 320]);
    act(() => vi.advanceTimersByTime(100)); tick();
    expect(draw.mock.calls[2].slice(1)).toEqual([0, 0, 320, 320]);
    expect(draw.mock.calls[3][1]).toBe(320);
    fireEvent.mouseLeave(screen.getByRole('img').parentElement!);
    expect(screen.getByRole('button', { name: '跳个舞' })).toHaveAttribute('aria-pressed', 'false');
    expect(frames.size).toBe(0); view.unmount();
  });
  it('supports button start/stop without bubbling into a card', () => {
    const clicked = vi.fn(); render(<div onClick={clicked}><MotionPlayer name="示意" staticSrc="/motion-preview-assets/static.png" asset={asset} /></div>);
    loadStatic(); loadAssets(); fireEvent.click(screen.getByRole('button', { name: '跳个舞' }));
    expect(clicked).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '停止动作' })); expect(frames.size).toBe(0);
  });
  it('times out at ten seconds and ignores late callbacks', () => {
    mount(); loadStatic(); const late = requests.map(i => i.onload);
    act(() => vi.advanceTimersByTime(9999)); expect(screen.getByRole('status')).toHaveTextContent('正在准备');
    act(() => vi.advanceTimersByTime(1)); expect(screen.getByRole('status')).toHaveTextContent('没加载好');
    act(() => late.forEach(f => f?.())); expect(screen.queryByRole('button', { name: '跳个舞' })).not.toBeInTheDocument();
  });
  it('reloads the same pack only on manual retry', () => {
    mount(); loadStatic(); act(() => requests[0].onerror?.());
    expect(requests).toHaveLength(2); fireEvent.click(screen.getByRole('button', { name: '重新加载动作' }));
    requests = []; loadStatic(); loadAssets(); expect(screen.getByRole('status')).toHaveTextContent('已就绪');
  });
  it('does not allow a stale resource or hidden tab to continue playback', () => {
    const view = mount(); loadStatic(); loadAssets(); fireEvent.click(screen.getByRole('button', { name: '跳个舞' }));
    Object.defineProperty(document, 'hidden', { value: true, configurable: true }); fireEvent(document, new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    const stale = requests[0].onload; view.rerender(<MotionPlayer name="下一位" staticSrc="/motion-preview-assets/other.png" />);
    act(() => stale?.()); expect(screen.getByRole('status')).toHaveTextContent('还没准备好'); view.unmount(); expect(frames.size).toBe(0);
  });
  it('respects reduced motion changes and stops its frame loop', () => {
    mount(); loadStatic(); loadAssets(); fireEvent.click(screen.getByRole('button', { name: '跳个舞' }));
    act(() => { reduced = true; mediaChange(); }); expect(frames.size).toBe(0);
    expect(screen.getByRole('status')).toHaveTextContent('系统偏好');
    act(() => { reduced = false; mediaChange(); }); expect(frames.size).toBe(0);
  });
  it('rejects external sources and oversized canvas parameters before loading', () => {
    render(<MotionPlayer name="示意" staticSrc="/motion-preview-assets/static.png" asset={{ ...asset, spriteUrl: 'https://example.com/sprite.png', frameWidth: 100000 }} />);
    loadStatic(); expect(requests).toHaveLength(0); expect(document.querySelector('canvas')).toHaveAttribute('width', '320');
  });
  it('falls back to static when decoding dimensions or canvas playback fail', () => {
    mount(); loadStatic(); act(() => requests.forEach(i => { i.naturalWidth = 1; i.naturalHeight = 1; i.onload?.(); }));
    expect(screen.getByRole('status')).toHaveTextContent('没加载好');
  });
  it('keeps static content when canvas drawing fails', () => {
    mount(); loadStatic(); loadAssets(); draw.mockImplementation(() => { throw new Error('synthetic draw failure'); });
    fireEvent.click(screen.getByRole('button', { name: '跳个舞' }));
    expect(screen.getByRole('status')).toHaveTextContent('没加载好');
    expect(frames.size).toBe(0); expect(screen.getByRole('img')).toBeInTheDocument();
  });
  it('keeps static content when a canvas context is unavailable', () => {
    mount(); loadStatic(); loadAssets(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    fireEvent.click(screen.getByRole('button', { name: '跳个舞' })); act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole('status')).toHaveTextContent('没加载好'); expect(frames.size).toBe(0);
  });
  it('shares one 10-second deadline across metadata and PNG decoding', async () => {
    let resolve!: (value: {asset: MotionAsset; dispose: () => void}) => void;
    const dispose = vi.fn();
    const loadAsset = vi.fn(() => new Promise<{asset: MotionAsset; dispose: () => void}>(done => { resolve = done; }));
    render(<MotionPlayer name="私有伙伴" staticSrc="/motion-preview-assets/static.png" loadAsset={loadAsset} />);
    loadStatic(); await act(async () => {});
    act(() => vi.advanceTimersByTime(9500));
    await act(async () => resolve({asset: {...asset,spriteUrl:'blob:sprite',backgroundUrl:'blob:background'},dispose}));
    act(() => vi.advanceTimersByTime(500));
    loadAssets();
    expect(screen.getByRole('status')).toHaveTextContent('没加载好');
    expect(screen.queryByRole('button',{name:'跳个舞'})).not.toBeInTheDocument();
    expect(dispose).toHaveBeenCalled();
  });
  it('disposes late loader results after an account or character unmount', async () => {
    let resolve!: (value: {asset: MotionAsset; dispose: () => void}) => void;
    let signal!: AbortSignal; const dispose = vi.fn();
    const loadAsset = (s: AbortSignal) => { signal=s; return new Promise<{asset: MotionAsset; dispose: () => void}>(done => { resolve=done; }); };
    const view=render(<MotionPlayer name="私有伙伴" staticSrc="/motion-preview-assets/static.png" loadAsset={loadAsset} />);
    loadStatic(); await act(async () => {}); view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({asset:{...asset,spriteUrl:'blob:sprite',backgroundUrl:'blob:background'},dispose}));
    expect(dispose).toHaveBeenCalled(); expect(requests.every(i=>!i.src)).toBe(true);
  });

});

it.each([['rest', '休息'], ['walk', '散步'], ['observe', '观察']] as const)('plays %s with its own label instead of dance', (activity, label) => {
  render(<MotionPlayer name="示意" staticSrc="/motion-preview-assets/static.png" asset={asset} activity={activity} />);
  loadStatic(); loadAssets();
  expect(screen.queryByRole('button', { name: '跳个舞' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '看看' + label + '动作' }));
  expect(screen.getByRole('status')).toHaveTextContent('正在播放' + label + '动作');
  tick(); expect(draw).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '停止动作' }));
  expect(screen.getByRole('button', { name: '看看' + label + '动作' })).toBeInTheDocument();
});

it('uses the bound classification in the ordinary motion entry instead of calling rest a dance', () => {
  render(<MotionPlayer name="示意" staticSrc="/motion-preview-assets/static.png" asset={{ ...asset, activity: 'rest' }} />);
  loadStatic(); loadAssets();
  expect(screen.getByRole('button', { name: '看看休息动作' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '跳个舞' })).not.toBeInTheDocument();
});

it('plays a matching sprite in the scene without extra controls and releases its frame loop', () => {
  const png = 'data:image/png;base64,c3RpbGw=';
  const capture = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(png);
  const onSceneStill = vi.fn();
  const view = render(<MotionPlayer name="场景伙伴" staticSrc="/motion-preview-assets/static.png" asset={asset} activity="rest" scene onSceneStill={onSceneStill} />);
  loadSceneStatic(); loadAssets();
  expect(screen.queryByRole('button', { name: /动作|跳个舞/ })).not.toBeInTheDocument();
  expect(frames.size).toBe(1);
  tick(); expect(draw).toHaveBeenCalled();
  expect(draw.mock.calls.every(([source]) => source === requests[0])).toBe(true);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(onSceneStill).toHaveBeenCalledExactlyOnceWith(png);
  view.unmount(); expect(frames.size).toBe(0);
  capture.mockRestore();
});

it('keeps the scene static when no matching asset exists or drawing fails', () => {
  const missing = render(<MotionPlayer name="场景伙伴" staticSrc="/motion-preview-assets/static.png" activity="rest" scene />);
  loadSceneStatic();
  expect(screen.getByRole('img', { hidden: true })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /动作|跳个舞/ })).not.toBeInTheDocument();
  expect(frames.size).toBe(0);
  missing.unmount();
  draw.mockImplementation(() => { throw new Error('synthetic canvas failure'); });
  render(<MotionPlayer name="场景伙伴" staticSrc="/motion-preview-assets/static.png" asset={asset} activity="rest" scene />);
  loadSceneStatic(); loadAssets(); tick();
  expect(screen.getByRole('img', { hidden: true })).toBeInTheDocument();
  expect(frames.size).toBe(0);
});

it('autoplays a muted scene video and stops it on unmount', async () => {
  const { view, play, pause, dispose, decode } = await mountVideo(true);
  decode(); tick();
  expect(play).toHaveBeenCalledTimes(1);
  expect(document.querySelector('video')?.muted).toBe(true);
  expect(screen.queryByRole('button', { name: /动作|跳个舞/ })).not.toBeInTheDocument();
  view.unmount(); expect(pause).toHaveBeenCalled(); expect(dispose).toHaveBeenCalledTimes(1);
});

it('waits for the scene portrait to enter view, stops offscreen and resumes without reloading', () => {
  let notify!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe() {} disconnect = disconnect;
  });
  const view = render(<MotionPlayer name="场景伙伴" staticSrc="/motion-preview-assets/static.png"
    asset={asset} activity="rest" scene compact />);
  loadSceneStatic(); expect(requests).toHaveLength(0);
  act(() => notify([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(requests).toHaveLength(2);
  loadAssets(); tick(); expect(draw).toHaveBeenCalled(); expect(frames.size).toBe(1);
  act(() => notify([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(frames.size).toBe(0);
  act(() => notify([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  tick(); expect(frames.size).toBe(1); expect(requests).toHaveLength(2);
  view.unmount(); expect(disconnect).toHaveBeenCalledTimes(1);
});
