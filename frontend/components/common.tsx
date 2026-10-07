'use client';
import Link from 'next/link';
import { ArrowUpRight, Leaf, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function Brand() { return <Link href="/" className="brand"><span className="brand-icon"><Leaf size={22} /></span>万物伙伴<span className="brand-en">LITTLE COMPANIONS</span></Link>; }
export function Notice({ children, retry }: { children: React.ReactNode; retry?: () => void }) { return <div className="notice" role="alert">{children}{retry && <button onClick={retry}>重新加载 <ArrowUpRight size={14} /></button>}</div>; }
export function Loading() { return <div className="loading" role="status"><span className="loading-leaf"><Leaf /></span>正在把小世界打开…</div>; }
export function Modal({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={ref} onCancel={e => { e.preventDefault(); close(); }} aria-label={title} className="modal"><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X /></button></div>{children}</dialog>;
}
export function timeLabel(value: string): string {
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : value + 'Z');
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
