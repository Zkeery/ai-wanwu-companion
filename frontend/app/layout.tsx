import type { Metadata } from 'next';
import MobileNav from '@/components/mobile-nav';
import SessionRecovery from '@/components/session-recovery';
import './globals.css';
import './toy-theme.css';
import './warm-theme.css';
import './v12-theme.css';

export const metadata: Metadata = { title: '万物伙伴 · 把日常，过成有回应的日子', description: '和你珍藏的伙伴聊聊天，一起照顾小花园。' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Tabbit injects data-tabbit-tray-* on html; other extensions add mpa-* on body.
  // These two static host elements tolerate external attributes only at their
  // own level. React still reports mismatches in application descendants.
  return <html lang="zh-CN" suppressHydrationWarning><body suppressHydrationWarning>{process.env.NEXT_PUBLIC_REAL_AI_LOCAL === 'true' && <div className="offline-preview" role="note">真实 AI 本地体验 · 新生成与文字聊天连接真实模型，费用额度需先确认。短信为本地测试登录：示例手机号 13900000160，测试码 123456。</div>}{process.env.NEXT_PUBLIC_OFFLINE_PREVIEW === 'true' && <div className="offline-preview" role="note">{process.env.NEXT_PUBLIC_LIFE_LIVE_PLANNER_PREVIEW === 'true' ? '隔离试用页 · 仅标记“AI 活动试用”的生活活动可使用真实模型；含预设回复与示例图片。' : '离线体验页 · 生活安排与回复使用预设样例，仅用于体验流程。'}</div>}<SessionRecovery>{children}<MobileNav /></SessionRecovery></body></html>;
}
