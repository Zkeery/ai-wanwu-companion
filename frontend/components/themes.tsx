'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Apple, ArrowLeft, ArrowRight, Camera, Heart, Sparkles } from 'lucide-react';
import { api, errorText } from '@/lib/api';
import type { Theme } from '@/lib/themes';
import { Brand, Loading, Notice } from './common';

export default function Themes() {
  const [themes, setThemes] = useState<Theme[] | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.themes(controller.signal).then(setThemes).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [revision]);
  return <div className="shell"><header className="site-header"><Brand /><Link className="back-link" href="/discover"><ArrowLeft size={16} />发现</Link></header>
    <main className="themes-page"><div className="eyebrow">SAME LITTLE THEME, YOUR OWN LITTLE FRIEND</div><h1>同一个主题，<br />不同的小小奇遇。</h1><p className="create-intro">不必拍一样的东西。<br />从共同的灵感出发，遇见只属于你的伙伴。</p>
      {error ? <Notice retry={() => { setError(''); setRevision(n => n + 1); }}>{error}</Notice> : themes === null ? <Loading /> : themes.length === 0 ? <div className="empty"><h2>新的灵感还在路上</h2><Link href="/companions/new">先去自由创作</Link></div> : <div className="theme-grid">{themes.map(theme => <section className="theme-card" key={theme.id}>
        <div className="theme-art" role="img" aria-label="水果主题示意插画"><div className="theme-orbit" /><Apple className="theme-apple" strokeWidth={1.15} /><Sparkles className="theme-sparkle" /><span>一点甜甜的灵感</span></div>
        <div className="theme-copy"><span className="create-kicker">本次创作主题</span><h2>{theme.title}</h2><p>{theme.description}</p><Link className="button primary" href={`/companions/new?theme=${encodeURIComponent(theme.id)}`}><Camera size={18} />拍一份水果<ArrowRight size={18} /></Link><Link className="button wall-entry" href={`/themes/${encodeURIComponent(theme.id)}`}>看看作品墙</Link><p className="privacy-note"><Heart size={14} />完成后只加入你的私人收藏</p></div>
      </section>)}</div>}
      <ol className="theme-how"><li><span>01</span><strong>选你喜欢的水果</strong><p>一颗苹果、一只橘子，都可以。</p></li><li><span>02</span><strong>让想象发芽</strong><p>保留它的特点，创造形象、名字与性格。</p></li><li><span>03</span><strong>开始你们的故事</strong><p>改个喜欢的名字，一起聊天和生活。</p></li></ol>
      <div className="theme-free"><Link className="button primary" href="/teams">和好友一起玩主题小队</Link></div>
      <div className="theme-free"><p>今天想拍点别的？杯子、植物也藏着故事。</p><Link className="back-link" href="/companions/new">去自由创作<ArrowRight size={16} /></Link></div>
    </main></div>;
}
