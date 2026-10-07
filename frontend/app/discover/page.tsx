import Link from 'next/link';
import { ArrowUpRight, Camera, Sparkles, Users } from 'lucide-react';
import { Brand } from '@/components/common';

export default function DiscoverPage() {
  return <div className="shell v12-discover">
    <header className="site-header"><Brand /><Link className="back-link" href="/">回到伙伴</Link></header>
    <main>
      <section className="discover-heading"><span className="toy-eyebrow">主题与好友 ✦</span><h1>让相遇，再多一点。</h1><p>从同一个灵感出发，看看每个人独一无二的创造。</p></section>
      <div className="discover-grid">
        <Link className="discover-card discover-theme" href="/activities"><span className="discover-art" aria-hidden="true">🍂 🏅</span><span className="section-kicker">PLAY TOGETHER</span><h2><Sparkles size={25} />伙伴活动</h2><p>观察自然、布置庭院、秋日拾叶。你来观战和加油，伙伴们留下共同回忆。</p><strong>看看今天的活动 <ArrowUpRight size={20} /></strong></Link>
        <Link className="discover-card discover-teams" href="/gatherings"><span className="discover-art" aria-hidden="true">🌳 🏡</span><span className="section-kicker">LIVE TOGETHER</span><h2><Users size={25} />一起生活</h2><p>带伙伴来相聚，一起布置、照料和经历四季。想独处时，随时回家。</p><strong>去共同住处 <ArrowUpRight size={20} /></strong></Link>
        <Link className="discover-card discover-theme" href="/themes"><span className="discover-art" aria-hidden="true">🍎 ✦</span><span className="section-kicker">CREATE TOGETHER</span><h2><Sparkles size={25} />主题与作品</h2><p>选一个主题，拍下身边的小物。看看不同的人，创造了怎样的伙伴。</p><strong>发现今日灵感 <ArrowUpRight size={20} /></strong></Link>
        <Link className="discover-card discover-teams" href="/teams"><span className="discover-art" aria-hidden="true">✳ ♡</span><span className="section-kicker">A LITTLE CREW</span><h2><Users size={25} />好友作品小队</h2><p>创建或加入作品小队，邀请好友，把大家的伙伴作品放在一起欣赏。</p><strong>看看我的小队 <ArrowUpRight size={20} /></strong></Link>
      </div>
      <div className="discover-create"><Camera size={24} /><div><h2>有自己的灵感？</h2><p>不必等主题，从一张照片开始。</p></div><Link className="button" href="/companions/new">去创作 <ArrowUpRight size={18} /></Link></div>
    </main>
  </div>;
}
