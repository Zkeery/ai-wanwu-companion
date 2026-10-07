import { sceneNames, type LivingSpace } from './contracts';
import { kindMeta } from './living-ui';
import type { RuntimeSnapshot, RuntimeTask } from './life-runtime';

export function activityChatDraft(space: LivingSpace, origin: RuntimeSnapshot['origin'], task: RuntimeTask): string | null {
  if (task.state !== 'done' || !task.activity) return null;
  const target = task.activity === 'observe' ? space.items.find(item => item.id === task.target_id && !item.stored) : undefined;
  const title = task.activity === 'rest' ? '歇了一会儿' : task.activity === 'walk' ? '散了会儿步'
    : target ? `看了看${kindMeta[target.kind]?.name ?? '场景物件'}` : '观察了一会儿';
  return `想和你聊聊这条${origin === 'offline_fixture' ? '离线体验记录' : 'AI活动记录'}：\n本轮安排于 ${new Date(task.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（上海时间） · ${sceneNames[space.scene_type]}\n${origin === 'offline_fixture' ? '预设活动（离线样例）' : '已保存的AI活动'}：${title}。${task.activity === 'observe' && !target ? '\n原来观察的物件已收纳或移走。' : ''}`;
}
