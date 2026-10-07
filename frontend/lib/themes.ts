import { array, object } from './contracts';

export type Theme = { id: string; title: string; description: string; category: string };
export function parseThemes(value: unknown): Theme[] {
  return array(value, item => {
    const v = object(item);
    for (const field of ['id', 'title', 'description', 'category']) {
      if (typeof v[field] !== 'string' || !v[field]) throw new Error('主题信息暂时无法读取');
    }
    return { id: v.id as string, title: v.title as string, description: v.description as string, category: v.category as string };
  });
}
export function themeName(id: string | null | undefined): string {
  return id === 'fruit' ? '一份水果' : id ? '主题创作' : '自由创作';
}
export function parseThemeId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) throw new Error('主题信息格式不正确');
  return value;
}
