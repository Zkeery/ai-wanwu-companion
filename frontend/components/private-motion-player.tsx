'use client';
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { loadPrivateMotion } from '@/lib/private-motion';
import { loadPreparedActivityMotion } from '@/lib/motion-preparation';
import MotionPlayer from './motion-player';
import type { Activity } from '@/lib/life-simulation';

const subscribe = (change: () => void) => {
  window.addEventListener(AUTH_CHANGED, change); window.addEventListener('storage', change);
  return () => { window.removeEventListener(AUTH_CHANGED, change); window.removeEventListener('storage', change); };
};

export default function PrivateMotionPlayer({ id, src, name, compact, scene, href, overlay, onStaticLoad, onStaticError, onSceneStill, activity }: {
  id: number; src: string; name: string; compact?: boolean; scene?: boolean; href?: string; overlay?: ReactNode;
  onStaticLoad?: (image: HTMLImageElement) => void; onStaticError?: () => void; onSceneStill?: (png: string) => void;
  activity?: Activity;
}) {
  const token = useSyncExternalStore(subscribe, getToken, () => null);
  const loadAsset = useCallback((signal: AbortSignal) => activity
    ? loadPreparedActivityMotion(id, token!, signal, activity)
    : loadPrivateMotion(id, token!, signal), [id, token, activity]);
  if (!token) return <p>登录后查看伙伴形象</p>;
  return <MotionPlayer key={JSON.stringify([id, src, token, activity, scene])} staticSrc={src} name={name} activity={activity}
    privateStatic loadAsset={loadAsset} compact={compact} scene={scene} href={href} overlay={overlay}
    onStaticLoad={onStaticLoad} onStaticError={onStaticError} onSceneStill={onSceneStill} />;
}
