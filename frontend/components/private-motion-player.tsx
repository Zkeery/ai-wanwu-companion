'use client';
import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { loadPrivateMotion } from '@/lib/private-motion';
import { loadPreparedActivityMotion } from '@/lib/motion-preparation';
import MotionPlayer from './motion-player';
import type { Activity } from '@/lib/life-simulation';
import type { ImageLoadStage } from '@/lib/private-images';
import { createMotionPreviewCache } from '@/lib/motion-preview-cache';

const subscribe = (change: () => void) => {
  window.addEventListener(AUTH_CHANGED, change); window.addEventListener('storage', change);
  return () => { window.removeEventListener(AUTH_CHANGED, change); window.removeEventListener('storage', change); };
};

export default function PrivateMotionPlayer({ id, src, name, compact, scene, href, overlay, onStaticLoad, onStaticStage, onStaticError, onSceneStill, activity, resourceKey, playRequest, reuseLoadedActions = false, quietWhenUnavailable = false }: {
  id: number; src: string; name: string; compact?: boolean; scene?: boolean; href?: string; overlay?: ReactNode;
  onStaticStage?: (stage: ImageLoadStage) => void;
  onStaticLoad?: (image: HTMLImageElement) => void; onStaticError?: () => void; onSceneStill?: (png: string) => void;
  activity?: Activity;
  resourceKey?: string;
  playRequest?: number;
  reuseLoadedActions?: boolean;
  quietWhenUnavailable?: boolean;
}) {
  const token = useSyncExternalStore(subscribe, getToken, () => null);
  const previewCache = useMemo(() => reuseLoadedActions ? createMotionPreviewCache(JSON.stringify([id, src, token, resourceKey])) : null,
    [id, src, token, resourceKey, reuseLoadedActions]);
  useEffect(() => () => previewCache?.clear(), [previewCache]);
  const loadAsset = useCallback((signal: AbortSignal) => {
    const read = (requestSignal: AbortSignal) => activity
      ? loadPreparedActivityMotion(id, token!, requestSignal, activity)
      : loadPrivateMotion(id, token!, requestSignal);
    return previewCache ? previewCache.load(activity ?? 'default', signal, read) : read(signal);
  }, [id, token, activity, previewCache]);
  if (!token) return <p>登录后查看伙伴形象</p>;
  return <MotionPlayer key={JSON.stringify([id, src, token, scene])} staticSrc={src} name={name} activity={activity} resourceKey={resourceKey} playRequest={playRequest}
    privateStatic loadAsset={loadAsset} compact={compact} scene={scene} href={href} overlay={overlay} quietWhenUnavailable={quietWhenUnavailable}
    onStaticLoad={onStaticLoad} onStaticStage={onStaticStage} onStaticError={onStaticError} onSceneStill={onSceneStill} />;
}
