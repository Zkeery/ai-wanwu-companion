/* eslint-disable @next/next/no-img-element -- This isolated preview uses authored local assets. */
'use client';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import styles from './motion-player.module.css';
import PrivateImage from './private-image';
import type { LoadedMotion } from '@/lib/private-motion';
import type { Activity } from '@/lib/life-simulation';

export type MotionAsset = { spriteUrl: string; backgroundUrl: string; frameWidth: number; frameHeight: number; frameCount: number; fps: number; videoUrl?: string; durationMs?: number; activity?: Activity };
type Props = { staticSrc: string; name: string; asset?: MotionAsset; privateStatic?: boolean;
  activity?: Activity;
  compact?: boolean; scene?: boolean; href?: string; overlay?: ReactNode;
  onStaticLoad?: (image: HTMLImageElement) => void; onStaticError?: () => void; onSceneStill?: (png: string) => void;
  loadAsset?: (signal: AbortSignal) => Promise<LoadedMotion> };

function valid(asset: MotionAsset, allowBlob = false) {
  if (asset.activity !== undefined && !['rest', 'walk', 'observe'].includes(asset.activity)) return false;
  if (asset.videoUrl) return allowBlob && asset.videoUrl.startsWith('blob:')
    && [asset.frameWidth, asset.frameHeight, asset.durationMs].every(Number.isInteger)
    && asset.frameWidth >= 64 && asset.frameWidth <= 1920 && asset.frameHeight >= 64 && asset.frameHeight <= 1920
    && asset.durationMs! >= 4000 && asset.durationMs! <= 15000 && asset.fps === 24;
  const local = (url: string) => typeof url === 'string' && (/^\/motion-preview-assets\/[a-z][a-z0-9_-]*\.png$/.test(url)
    || (allowBlob && url.startsWith('blob:')));
  return local(asset.spriteUrl) && local(asset.backgroundUrl)
    && [asset.frameWidth, asset.frameHeight, asset.frameCount, asset.fps].every(Number.isInteger)
    && asset.frameWidth >= 64 && asset.frameWidth <= 512 && asset.frameHeight >= 64 && asset.frameHeight <= 512
    && asset.frameCount >= 2 && asset.frameCount <= 24 && asset.fps >= 4 && asset.fps <= 24
    && asset.frameWidth * asset.frameHeight * asset.frameCount <= 7_000_000;
}
const subscribe = (change: () => void) => {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
};
const reducedSnapshot = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function MotionPlayer(props: Props) {
  const [revision, setRevision] = useState(0);
  return <Player key={JSON.stringify([props.staticSrc, props.asset, revision])} {...props} retry={() => setRevision(n => n + 1)} />;
}

function Player({ staticSrc, name, asset: suppliedAsset, privateStatic, loadAsset, retry, compact, scene, href, overlay, onStaticLoad, onStaticError, onSceneStill, activity }: Props & { retry: () => void }) {
  const playerId = useId();
  const [activated, setActivated] = useState(!compact);
  const [inView, setInView] = useState(!compact);
  const [loadedAsset, setLoadedAsset] = useState<MotionAsset | null>(null);
  const asset = suppliedAsset ?? loadedAsset;
  const usable = !!asset && valid(asset, !!loadAsset);
  const [staticReady, setStaticReady] = useState(false);
  const [staticFailed, setStaticFailed] = useState(false);
  const [phase, setPhase] = useState<'waiting' | 'missing' | 'ready' | 'failed'>(loadAsset ? 'waiting' : !asset ? 'missing' : usable ? 'waiting' : 'failed');
  const [playing, setPlaying] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const portrait = useRef<HTMLDivElement>(null);
  const staticImage = useRef<HTMLImageElement>(null);
  const images = useRef<{ sprite: HTMLImageElement; background: HTMLImageElement } | null>(null);
  const staticFrame = useRef<number | null>(null);
  const stillCallback = useRef(onSceneStill);
  const stillSent = useRef(false);
  useEffect(() => { stillCallback.current = onSceneStill; }, [onSceneStill]);
  const reduced = useSyncExternalStore(subscribe, reducedSnapshot, () => true);
  const width = asset?.frameWidth, height = asset?.frameHeight, count = asset?.frameCount, fps = asset?.fps;

  const staticPainted = useCallback(() => {
    if (staticFrame.current !== null) cancelAnimationFrame(staticFrame.current);
    staticFrame.current = requestAnimationFrame(() => setStaticReady(true));
  }, []);
  const staticUnavailable = useCallback(() => { setStaticFailed(true); setPlaying(false); onStaticError?.(); }, [onStaticError]);
  const startPlaying = useCallback(() => {
    if (phase !== 'ready' || reduced || staticFailed || !inView || document.hidden) return;
    window.dispatchEvent(new CustomEvent('companion-motion-start', { detail: playerId }));
    setPlaying(true);
  }, [phase, reduced, staticFailed, inView, playerId]);
  useEffect(() => {
    if (!scene || !activity || phase !== 'ready' || !inView) return;
    const frame = requestAnimationFrame(startPlaying);
    return () => cancelAnimationFrame(frame);
  }, [scene, activity, phase, inView, startPlaying]);
  useEffect(() => {
    const otherStarted = (event: Event) => { if ((event as CustomEvent).detail !== playerId) setPlaying(false); };
    window.addEventListener('companion-motion-start', otherStarted);
    return () => window.removeEventListener('companion-motion-start', otherStarted);
  }, [playerId]);
  useEffect(() => {
    if (!compact || !portrait.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      const frame = requestAnimationFrame(() => { setActivated(true); setInView(true); });
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(entries => {
      const visible = entries.some(entry => entry.isIntersecting);
      setInView(visible);
      if (visible) setActivated(true); else setPlaying(false);
    });
    observer.observe(portrait.current);
    return () => observer.disconnect();
  }, [compact]);
  useEffect(() => {
    if (staticImage.current?.complete) {
      if (staticImage.current.naturalWidth > 0) staticPainted();
      else staticFrame.current = requestAnimationFrame(() => setStaticFailed(true));
    }
    return () => { if (staticFrame.current !== null) cancelAnimationFrame(staticFrame.current); };
  }, [staticPainted]);
  useEffect(() => {
    if (!activated || !staticReady || (!loadAsset && (!suppliedAsset || !valid(suppliedAsset)))) return;
    let active = true;
    const controller = new AbortController();
    let dispose = () => {};
    const start = performance.now();
    const sprite = new Image(), background = new Image();
    let loaded = 0;
    let prepared: MotionAsset | null = null;
    let decoder: HTMLVideoElement | null = null;
    const fail = () => { if (active) { active = false; controller.abort(); clearTimeout(timer); dispose(); images.current = null; setPhase('failed'); } };
    const timer = setTimeout(fail, 10_000);
    const load = () => {
      if (!active) return;
      if (performance.now() - start > 10_000) { fail(); return; }
      loaded++;
      if (loaded !== 2) return;
      clearTimeout(timer);
      if (!prepared || sprite.naturalWidth !== prepared.frameWidth * prepared.frameCount || sprite.naturalHeight !== prepared.frameHeight
          || background.naturalWidth !== prepared.frameWidth || background.naturalHeight !== prepared.frameHeight) { fail(); return; }
      images.current = { sprite, background }; setPhase('ready');
    };
    sprite.onload = load; background.onload = load;
    sprite.onerror = fail; background.onerror = fail;
    const prepare = (result: LoadedMotion) => {
      if (!active || performance.now() - start >= 10_000) { result.dispose(); fail(); return; }
      dispose = result.dispose;
      if (!result.asset) { clearTimeout(timer); setPhase('missing'); return; }
      if (!valid(result.asset, !!loadAsset)) { fail(); return; }
      prepared = result.asset;
      setLoadedAsset(prepared);
      if (prepared.videoUrl) {
        const clip = prepared;
        decoder = document.createElement('video');
        decoder.muted = true; decoder.playsInline = true; decoder.preload = 'auto';
        decoder.onloadeddata = () => {
          if (!active) return;
          if (performance.now() - start >= 10_000 || decoder!.videoWidth !== clip.frameWidth
              || decoder!.videoHeight !== clip.frameHeight || !Number.isFinite(decoder!.duration)
              || Math.abs(decoder!.duration * 1000 - clip.durationMs!) > 100) { fail(); return; }
          clearTimeout(timer); setPhase('ready');
        };
        decoder.onerror = fail; decoder.src = prepared.videoUrl; decoder.load();
        return;
      }
      sprite.src = prepared.spriteUrl; background.src = prepared.backgroundUrl;
    };
    if (loadAsset) {
      Promise.resolve().then(() => loadAsset(controller.signal)).then(prepare).catch(fail);
    } else prepare({ asset: suppliedAsset!, dispose: () => {} });
    return () => { active = false; controller.abort(); clearTimeout(timer);
      if (decoder) { decoder.onloadeddata = decoder.onerror = null; decoder.removeAttribute('src'); decoder.load(); }
      dispose(); sprite.onload = background.onload = null; sprite.onerror = background.onerror = null; images.current = null; };
  }, [activated, staticReady, suppliedAsset, loadAsset]);

  useEffect(() => {
    if (!asset?.videoUrl || !video.current) return;
    const element = video.current;
    let current = true;
    element.muted = true;
    if (playing && phase === 'ready' && !reduced && !staticFailed && !document.hidden) {
      try { element.play().catch(() => { if (current) { setPhase('failed'); setPlaying(false); } }); }
      catch { const failure = setTimeout(() => { if (current) { setPhase('failed'); setPlaying(false); } }, 0);
        return () => { current = false; clearTimeout(failure); element.pause(); }; }
    } else { element.pause(); element.currentTime = 0; }
    return () => { current = false; element.pause(); element.currentTime = 0; };
  }, [asset, playing, phase, reduced, staticFailed]);
  useEffect(() => {
    const stop = () => { if (document.hidden) setPlaying(false); };
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const preferenceChanged = () => setPlaying(false);
    document.addEventListener('visibilitychange', stop);
    media.addEventListener('change', preferenceChanged);
    return () => { document.removeEventListener('visibilitychange', stop); media.removeEventListener('change', preferenceChanged); };
  }, []);
  useEffect(() => {
    if (scene) return;
    const element = portrait.current;
    if (!element) return;
    const enter = startPlaying;
    const leave = () => setPlaying(false);
    element.addEventListener('mouseenter', enter); element.addEventListener('mouseleave', leave);
    return () => { element.removeEventListener('mouseenter', enter); element.removeEventListener('mouseleave', leave); };
  }, [startPlaying, scene]);
  useEffect(() => {
    if (!playing || phase !== 'ready' || reduced || document.hidden || !images.current || !asset) return;
    let ctx: CanvasRenderingContext2D | null | undefined;
    try { ctx = canvas.current?.getContext('2d'); } catch { /* Restore the static image below. */ }
    if (!ctx) {
      const failure = setTimeout(() => { setPhase('failed'); setPlaying(false); }, 0);
      return () => clearTimeout(failure);
    }
    const context = ctx;
    let frame = 0, active = true;
    const started = performance.now(), pack = images.current;
    const paint = (now: number) => {
      if (!active || document.hidden) return;
      const index = Math.floor((now - started) * fps! / 1000) % count!;
      try {
        context.clearRect(0, 0, width!, height!);
        if (!scene) context.drawImage(pack.background, 0, 0, width!, height!);
        context.drawImage(pack.sprite, index * width!, 0, width!, height!, 0, 0, width!, height!);
        if (scene && activity && !stillSent.current && canvas.current && stillCallback.current) {
          try {
            const png = canvas.current.toDataURL('image/png');
            if (png.startsWith('data:image/png;base64,') && png.length <= 600_000) {
              stillSent.current = true;
              stillCallback.current(png);
            }
          } catch { /* Keep the original static image as the fallback. */ }
        }
      } catch { setPhase('failed'); setPlaying(false); return; }
      frame = requestAnimationFrame(paint);
    };
    paint(started);
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [playing, phase, reduced, asset, width, height, count, fps, scene, activity]);

  const visible = playing && phase === 'ready' && !reduced;
  const canPlay = phase === 'ready' && !reduced && !staticFailed && inView;
  const classifiedActivity = activity ?? asset?.activity;
  const activityLabel = classifiedActivity ? { rest: '休息', walk: '散步', observe: '观察' }[classifiedActivity] : null;
  const status = staticFailed ? '静态形象暂时看不到' : phase === 'missing' ? activityLabel ? '这类动作还没准备好，先看看静态形象' : '动作还没准备好，先看看静态形象'
    : phase === 'failed' ? '动作没加载好，静态形象仍保留' : phase === 'waiting' ? '正在准备动作…'
    : reduced ? '已按系统偏好保持静态' : visible ? activityLabel ? `正在播放${activityLabel}动作` : '正在跳舞' : '动作已就绪，移入形象或点按钮';
  const staticPortrait = privateStatic
        ? <PrivateImage src={staticSrc} alt={name} retryable={false} onLoad={e => { staticPainted(); onStaticLoad?.(e.currentTarget); }} onUnavailable={staticUnavailable} onError={staticUnavailable} />
        : <img ref={staticImage} src={staticSrc} alt={name} onLoad={e => { staticPainted(); onStaticLoad?.(e.currentTarget); }} onError={staticUnavailable} />;
  return <section aria-label={`${name}的动作`} aria-hidden={scene || undefined}
    className={`${styles.player} ${privateStatic ? styles.private : ''} ${compact ? `${styles.compact} collection-motion` : ''} ${scene ? styles.scene : ''}`}>
    <div ref={portrait} className={`${styles.portrait} ${compact && !scene ? 'portrait' : ''} ${visible ? styles.playingPortrait : ''} ${scene && visible && !asset?.videoUrl ? styles.transparentScene : ''}`}>
      {href ? <Link className={styles.portraitLink} href={href} aria-label={`查看${name}`}>{staticPortrait}</Link> : staticPortrait}
      {asset?.videoUrl
        ? <video ref={video} src={asset.videoUrl} muted playsInline loop preload="auto" aria-hidden="true"
          className={visible ? styles.active : styles.hidden} onVolumeChange={e => { e.currentTarget.muted = true; }}
          onError={() => { setPhase('failed'); setPlaying(false); }} />
        : <canvas ref={canvas} width={usable ? width : 320} height={usable ? height : 320} className={visible ? styles.active : styles.hidden} aria-hidden="true" />}
      {overlay}
    </div>
    {!scene && <div className={styles.controls}>
    <p role="status" aria-live="polite">{status}</p>
    {canPlay && <button type="button" aria-pressed={visible} onClick={e => { e.preventDefault(); e.stopPropagation(); if (playing) setPlaying(false); else startPlaying(); }}>{visible ? '停止动作' : activityLabel ? `看看${activityLabel}动作` : '跳个舞'}</button>}
    {(phase === 'failed' || staticFailed) && <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); retry(); }}>重新加载动作</button>}
    {phase === 'missing' && !staticFailed && loadAsset && <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); retry(); }}>检查动作是否就绪</button>}
    </div>}
  </section>;
}
