'use client';
import { Fragment, useEffect, useState } from 'react';
import { SESSION_EXPIRED, TOKEN_KEY } from '@/lib/auth';
import { Brand } from './common';
import AuthModal from './auth-modal';

export default function SessionRecovery({ children }: { children: React.ReactNode }) {
  const [expired, setExpired] = useState(false), [showLogin, setShowLogin] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const expire = () => { setExpired(true); setShowLogin(true); };
    const sync = (event: StorageEvent) => {
      if (event.key === TOKEN_KEY && event.oldValue !== event.newValue) expire();
    };
    window.addEventListener(SESSION_EXPIRED, expire);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(SESSION_EXPIRED, expire); window.removeEventListener('storage', sync); };
  }, []);
  if (!expired) return <Fragment key={generation}>{children}</Fragment>;
  return <div className="shell">
    <header className="site-header"><Brand /></header>
    <main className="collection auth-welcome">
      <h1>重新回到你的小世界</h1>
      <p role="status">登录状态已失效或已切换，请重新登录。已保存的伙伴和场景不会丢失。</p>
      <button className="button primary" onClick={() => setShowLogin(true)}>重新登录</button>
    </main>
    {showLogin && <AuthModal onClose={() => setShowLogin(false)} onLoggedIn={() => { setGeneration(n => n + 1); setExpired(false); setShowLogin(false); }} />}
  </div>;
}
