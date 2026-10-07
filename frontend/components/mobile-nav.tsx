'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { Heart, Camera, Compass } from 'lucide-react';
import { AUTH_CHANGED, getToken } from '@/lib/auth';

function subscribe(listener: () => void) {
  window.addEventListener(AUTH_CHANGED, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(AUTH_CHANGED, listener); window.removeEventListener('storage', listener); };
}
export default function MobileNav() {
  const token = useSyncExternalStore(subscribe, getToken, () => null);
  const path = usePathname();
  if (!token) return null;
  const entries = [
    { href: '/', label: '伙伴', Icon: Heart, current: path === '/' || /^\/companions\/\d+(?:\/|$)/.test(path) },
    { href: '/companions/new', label: '创作', Icon: Camera, current: path === '/companions/new' },
    { href: '/discover', label: '发现', Icon: Compass, current: /^\/(discover|themes|teams)(?:\/|$)/.test(path) },
  ];
  return <><div className="global-nav-spacer" aria-hidden="true" /><nav className="global-nav" aria-label="全局导航"><span className="global-nav-caption" aria-hidden="true">LITTLE<br />COMPANIONS ✦</span>{entries.map(({ href, label, Icon, current }) => <Link key={href} href={href} aria-current={current ? 'page' : undefined}><Icon size={23} aria-hidden="true" /><span>{label}</span></Link>)}</nav></>;
}
