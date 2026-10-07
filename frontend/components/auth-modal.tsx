'use client';
import { useEffect, useRef, useState } from 'react';
import { Lock, MessageSquareText, Phone } from 'lucide-react';
import { api, ApiError, errorText } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { Modal } from './common';

const PHONE_RE = /^1[3-9]\d{9}$/;
const cooldowns = new Map<string, number>();
function cooldown(phone: string): number {
  try { return Math.max(cooldowns.get(phone) ?? 0, Number(sessionStorage.getItem(`sms-cooldown:${phone}`)) || 0); }
  catch { return cooldowns.get(phone) ?? 0; }
}
function startCooldown(phone: string) {
  const until = Date.now() + 60000;
  cooldowns.set(phone, until);
  try { sessionStorage.setItem(`sms-cooldown:${phone}`, String(until)); } catch { /* In-page fallback remains. */ }
}

export default function AuthModal({ onClose, onLoggedIn }: { onClose: () => void; onLoggedIn: () => void }) {
  if (process.env.NEXT_PUBLIC_AUTH_MODE === 'invite') return <InviteAuthModal onClose={onClose} onLoggedIn={onLoggedIn} />;
  return <SmsAuthModal onClose={onClose} onLoggedIn={onLoggedIn} />;
}

function InviteAuthModal({ onClose, onLoggedIn }: { onClose: () => void; onLoggedIn: () => void }) {
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false);
  async function login() {
    if (!code.trim() || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const result = await api.auth.inviteLogin(code.trim());
      setToken(result.token); setCode(''); onLoggedIn();
    } catch (e) { setError(errorText(e)); }
    finally { locked.current = false; setBusy(false); }
  }
  return <Modal title="进入我的小世界" close={onClose}>
    <p className="modal-copy">输入你的专属邀请码，回到自己的伙伴、聊天和花园。</p>
    <form className="auth-form" onSubmit={e => { e.preventDefault(); void login(); }}>
      <label className="field">
        <span className="field-label"><Lock size={15} />邀请码</span>
        <input type="password" autoComplete="current-password" placeholder="粘贴专属邀请码" value={code} maxLength={128} disabled={busy} onChange={e => { setCode(e.target.value); setError(''); }} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="button primary auth-submit" disabled={busy || !code.trim()}><Lock size={17} />{busy ? '正在登录…' : '登录'}</button>
    </form>
    <p className="modal-footnote">邀请码可重复登录，请妥善保存，不要分享给他人。没有邀请码时，请联系邀请人。</p>
  </Modal>;
}

function SmsAuthModal({ onClose, onLoggedIn }: { onClose: () => void; onLoggedIn: () => void }) {
  const devCode = process.env.NEXT_PUBLIC_DEV_SMS_CODE;
  const locked = useRef(false);
  const [phone, setPhone] = useState(''), [code, setCode] = useState('');
  const [sent, setSent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const phoneOk = PHONE_RE.test(phone.trim());
  const phoneError = phone.length === 11 && !phoneOk ? '手机号格式不正确：请输入以 13–19 开头的 11 位手机号。' : '';
  const codeOk = /^\d{6}$/.test(code.trim());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const remaining = Math.max(0, Math.ceil((cooldown(phone.trim()) - now) / 1000));

  async function send() {
    if (!phoneOk || locked.current || cooldown(phone.trim()) > Date.now()) return;
    locked.current = true;
    setBusy(true); setError('');
    try { await api.auth.sendCode(phone.trim()); startCooldown(phone.trim()); setNow(Date.now()); setSent(true); }
    catch (e) {
      if (!(e instanceof ApiError) || e.status === 429 || ['sms_unknown', 'sms_rejected'].includes(e.code)) {
        startCooldown(phone.trim()); setNow(Date.now());
      }
      setError(e instanceof ApiError ? errorText(e) : '发送结果暂未确认，请等待一分钟；若已收到短信，可直接填写验证码登录');
    }
    finally { locked.current = false; setBusy(false); }
  }
  async function login() {
    if (!phoneOk || !codeOk || locked.current) return;
    locked.current = true;
    setBusy(true); setError('');
    try {
      const { token } = await api.auth.login(phone.trim(), code.trim());
      setToken(token);
      onLoggedIn();
    }
    catch (e) { setError(errorText(e)); }
    finally { locked.current = false; setBusy(false); }
  }

  return <Modal title="进入我的小世界" close={onClose}>
    <p className="modal-copy">用手机号登录，你的伙伴、聊天和花园都会安全地跟着你。</p>
    <form className="auth-form" onSubmit={e => { e.preventDefault(); void login(); }}>
      <label className="field">
        <span className="field-label"><Phone size={15} />手机号</span>
        <input inputMode="numeric" autoComplete="tel" placeholder="11 位手机号" value={phone} maxLength={11} disabled={busy} aria-invalid={!!phoneError} aria-describedby="auth-phone-hint" onChange={e => { setPhone(e.target.value.replace(/\D/g, '')); setSent(false); setError(''); }} />
      </label>
      <p id="auth-phone-hint" className={phoneError ? 'form-error' : 'modal-footnote'} role={phoneError ? 'alert' : undefined}>{phoneError || '请输入以 13–19 开头的 11 位手机号。'}</p>
      <label className="field">
        <span className="field-label"><MessageSquareText size={15} />验证码</span>
        <div className="code-row">
          <input inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" value={code} maxLength={6} disabled={busy} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
          <button type="button" className="text-button" disabled={busy || !phoneOk || remaining > 0} onClick={() => void send()}>{remaining > 0 ? `${remaining} 秒后重发` : sent ? '重新发送' : '发送验证码'}</button>
        </div>
      </label>
      {devCode && <p className="dev-hint" role="note">当前是本地测试，不会发送真实短信。可使用测试信息体验登录。<button type="button" className="text-button" disabled={busy} onClick={() => { if (!phoneOk) setPhone('13900000001'); setCode(devCode); setError(''); }}>填入测试信息</button></p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="button primary auth-submit" disabled={busy || !phoneOk || !codeOk}><Lock size={17} />{busy ? '正在处理…' : '登录'}</button>
    </form>
    <p className="modal-footnote">登录即表示你同意我们安全保存你的账号数据。</p>
  </Modal>;
}
