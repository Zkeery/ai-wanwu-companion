import type { SceneType } from './contracts';

export const sceneMeta: Record<SceneType, { name: string; emoji: string; desc: string }> = {
  home: { name: '家庭庭院', emoji: '🏡', desc: '在家布置一个舒适的小空间，种花种树、摆上长椅。' },
  desert: { name: '沙漠绿洲', emoji: '🏜️', desc: '和伙伴把一片沙地慢慢变成绿洲。' },
  forest: { name: '林间营地', emoji: '🏕️', desc: '亲近自然，观察林间，安静陪伴。' },
};

export const kindMeta: Record<string, { name: string; emoji: string }> = {
  palm: { name: '棕榈树', emoji: '🌴' }, cactus: { name: '仙人掌', emoji: '🌵' }, rock: { name: '石头', emoji: '🪨' }, tea_table: { name: '茶桌', emoji: '🫖' }, tent: { name: '帐篷', emoji: '⛺' }, string_lights: { name: '串灯', emoji: '💡' }, sign: { name: '路牌', emoji: '🪧' }, flowerpot: { name: '花盆', emoji: '🪴' },
  tree: { name: '小树', emoji: '🌱' },
  bench: { name: '长椅', emoji: '🪑' },
  shade: { name: '遮阴处', emoji: '⛱️' },
  cushion: { name: '坐垫', emoji: '🧺' },
  flower: { name: '花丛', emoji: '🌸' },
  mushroom: { name: '蘑菇', emoji: '🍄' },
  pond: { name: '水池', emoji: '💧' },
  campfire: { name: '营火', emoji: '🔥' },
  fireflies: { name: '萤火虫', emoji: '✨' },
};

export const sceneKinds: Record<SceneType, string[]> = {
  home: ['tree', 'bench', 'flower', 'mushroom', 'pond', 'campfire', 'fireflies'],
  desert: ['palm', 'cactus', 'rock', 'pond', 'shade', 'cushion', 'tea_table', 'tent', 'string_lights', 'sign', 'bench', 'flowerpot', 'tree'],
  forest: ['tree', 'cushion'],
};

export function careLabel(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds <= 0) return '等待照料';
  const h = Math.max(1, Math.ceil(seconds / 3600));
  return `照料有效 · 剩约 ${h} 小时`;
}
