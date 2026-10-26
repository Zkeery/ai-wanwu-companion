'use client';
import { useEffect, useState } from 'react';
import { AUTH_CHANGED, getToken, TOKEN_KEY } from '@/lib/auth';
import { Modal } from './common';
import MotionCandidateReview from './motion-candidate-review';

export default function CompanionActionReview({ id, disabled = false }: { id: number; disabled?: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const changed = () => { if (getToken() !== token) setToken(null); };
    const storage = (event: StorageEvent) => { if (!event.key || event.key === TOKEN_KEY) changed(); };
    window.addEventListener(AUTH_CHANGED, changed);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener(AUTH_CHANGED, changed);
      window.removeEventListener('storage', storage);
    };
  }, [token]);
  return <section aria-label="伙伴的动作">
    <button className="button" disabled={disabled} onClick={() => {
      const current = getToken();
      if (!current) { setNotice('请先登录，再查看伙伴的动作。'); return; }
      setNotice(''); setToken(current);
    }}>伙伴的动作</button>
    {notice && <p role="status">{notice}</p>}
    {token && <Modal title="伙伴的动作" close={() => setToken(null)}>
      <p>你可以先看过动作，再决定是否采用。原来的形象会保留。</p>
      <MotionCandidateReview key={id + token} id={id} token={token}
        onChange={() => setNotice('动作选择已保存，准备好后会用于这个伙伴。')} />
    </Modal>}
  </section>;
}
