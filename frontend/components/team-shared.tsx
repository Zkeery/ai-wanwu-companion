'use client';
import PrivateImage from './private-image';
import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import { type TeamWork } from '@/lib/teams';
import { Brand } from './common';
function subscribe(change: () => void) { window.addEventListener(AUTH_CHANGED, change); window.addEventListener('storage', change); return () => { window.removeEventListener(AUTH_CHANGED, change); window.removeEventListener('storage', change); }; }
export function useTeamSession() { return useSyncExternalStore(subscribe, getToken, () => null); }
export function TeamShell({ children }: { children: React.ReactNode }) { return <div className="shell"><header className="site-header"><Brand /><Link className="back-link" href="/discover">发现</Link></header><main className="teams-page">{children}</main></div>; }
export function PrivateTeamImage({ work }: { work: TeamWork }) {
  return <div className="wall-image"><PrivateImage src={work.image_url} alt={work.name} /></div>;
}
export function validAlias(name: string) { return name.trim().length > 0 && name.trim().length <= 20 && !/1[3-9]\d{9}|\p{C}/u.test(name); }
