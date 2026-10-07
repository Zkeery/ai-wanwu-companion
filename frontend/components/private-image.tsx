/* eslint-disable @next/next/no-img-element -- Authenticated images use revocable blob URLs. */
'use client';
import { useEffect, useEffectEvent, useState, useSyncExternalStore, type ImgHTMLAttributes } from 'react';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { privateImageBlob } from '@/lib/private-images';

function subscribe(change: () => void) {
  window.addEventListener(AUTH_CHANGED, change); window.addEventListener('storage', change);
  return () => { window.removeEventListener(AUTH_CHANGED, change); window.removeEventListener('storage', change); };
}
type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet'> & { src: string; alt: string; retryable?: boolean; onUnavailable?: () => void };
type ImageState = { src: string; token: string; revision: number; url: string; failed: boolean };

export default function PrivateImage({ src, alt, retryable = true, onError, onUnavailable, ...props }: Props) {
  const token = useSyncExternalStore(subscribe, getToken, () => null);
  const [state, setState] = useState<ImageState | null>(null), [revision, setRevision] = useState(0);
  const unavailable = useEffectEvent(() => onUnavailable?.());
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController(); let url = '';
    privateImageBlob(src, token, controller.signal).then(blob => {
      if (controller.signal.aborted || getToken() !== token) return;
      url = URL.createObjectURL(blob);
      setState({ src, token, revision, url, failed: false });
    }).catch(() => {
      if (!controller.signal.aborted && getToken() === token) { setState({ src, token, revision, url: '', failed: true }); unavailable(); }
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [src, token, revision]);
  const current = state?.src === src && state?.token === token && state?.revision === revision ? state : null;
  if (current?.url && !current.failed) return <img {...props} src={current.url} alt={alt} onError={event => { setState({ ...current, failed: true }); onError?.(event); }} />;
  return <span className="private-image-placeholder" role="img" aria-label={alt}>
    {current?.failed ? <><span>形象暂时看不到</span>{retryable ? <button type="button" onClick={() => setRevision(n => n + 1)}>重新加载形象</button> : <small>进入详情或刷新重试</small>}</> : token ? '正在迎接伙伴…' : '登录后查看形象'}
  </span>;
}
