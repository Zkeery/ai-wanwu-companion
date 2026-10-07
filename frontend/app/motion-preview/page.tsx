import { notFound } from 'next/navigation';
import MotionPlayer, { type MotionAsset } from '@/components/motion-player';
import styles from './preview.module.css';

export const dynamic = 'force-dynamic';
const asset: MotionAsset = { spriteUrl: '/motion-preview-assets/sprite.png', backgroundUrl: '/motion-preview-assets/background.png', frameWidth: 320, frameHeight: 320, frameCount: 12, fps: 12 };
export default function MotionPreview() {
  if (process.env.MOTION_PREVIEW_ENABLED !== 'true') notFound();
  return <main className={styles.page}>
    <p className={styles.note}>动作示意 · 手绘测试素材，未使用你的伙伴照片，未调用模型</p>
    <h1>让身体和手脚动起来</h1>
    <p>移入第一张形象，或点“跳个舞”。移开／点停止后回到静态。背景位置保持稳定。</p>
    <div className={styles.grid}>
      <article><h2>素材已备好</h2><MotionPlayer name="手绘杯子动作示意" staticSrc="/motion-preview-assets/static.png" asset={asset} /></article>
      <article><h2>尚无动作素材</h2><MotionPlayer name="尚无动作素材的示意" staticSrc="/motion-preview-assets/static.png" /></article>
      <article><h2>加载失败示例</h2><MotionPlayer name="失败时保留静态的示意" staticSrc="/motion-preview-assets/static.png" asset={{ ...asset, spriteUrl: '/motion-preview-assets/unavailable.png' }} /></article>
    </div>
    <p className={styles.note}>这页只验资源加载、播放、停止与失败恢复。真实生成图的主体分离、动作制作、旧伙伴绑定仍待后续开发；生成8秒和动画10秒未获真实验收。</p>
  </main>;
}
