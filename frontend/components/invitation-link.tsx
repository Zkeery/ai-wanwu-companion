'use client';
import { useRef, useState } from 'react';

export default function InvitationLink({ link }: { link: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false), [copying, setCopying] = useState(false), [notice, setNotice] = useState('');
  const lock = useRef(false);
  const localOnly = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(link).hostname);
  async function copy() {
    if (lock.current) return;
    lock.current = true; setCopying(true); setNotice('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(link);
      setNotice(localOnly ? '链接已复制，可在这台电脑的无痕窗口中测试。' : '链接已复制，可以发给好友。');
    } catch {
      setVisible(true); setNotice('自动复制未成功，已显示并选中链接，请手动复制。');
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    } finally { lock.current = false; setCopying(false); }
  }
  return <div className="invitation-link-controls">
    <div className="team-actions"><input ref={input} className="team-link" aria-label="邀请链接" type={visible ? 'text' : 'password'} value={link} readOnly autoComplete="off" /><button className="button primary" disabled={copying} onClick={() => void copy()}>{copying ? '正在复制…' : '复制邀请链接'}</button><button className="text-button" aria-pressed={visible} onClick={() => setVisible(v => !v)}>{visible ? '隐藏邀请链接' : '显示邀请链接'}</button></div>
    {notice && <p role="status" className="team-status">{notice}</p>}
    {localOnly && <p className="privacy-note">当前链接仅限这台电脑使用。可在无痕窗口或另一浏览器打开，用不同账号登录后确认加入；其他设备暂时无法访问。</p>}
  </div>;
}
