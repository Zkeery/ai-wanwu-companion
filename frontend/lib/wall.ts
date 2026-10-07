import { request } from './api';
import { array, object } from './contracts';

export type PublicationPreview = { name: string; introduction: string; theme_id: string; image_url: string; author_name: string; publication_id: string | null };
export type PublicWork = Omit<PublicationPreview, 'publication_id'> & { id: string; published_at: string };
export type WorkPage = { items: PublicWork[]; total: number; next_offset: number | null };
function text(v: unknown): string { if (typeof v !== 'string') throw new Error('作品信息暂时无法核对'); return v; }
function fields(value: unknown) {
  const v = object(value), url = text(v.image_url);
  if ((!url.startsWith('/uploads/') && !/^\/api\/v1\/themes\/[a-z0-9_-]+\/works\/[a-f0-9-]+\/image$/.test(url)) || url.includes('..') || url.includes('\\')) throw new Error('作品图片地址无法核对');
  const theme = text(v.theme_id);
  if (!/^[a-z0-9_-]+$/.test(theme)) throw new Error('作品主题无法核对');
  return { name: text(v.name), introduction: text(v.introduction), theme_id: theme, image_url: url, author_name: text(v.author_name) };
}
export function parsePreview(value: unknown): PublicationPreview {
  const v = object(value);
  return { ...fields(v), publication_id: v.publication_id === null ? null : text(v.publication_id) };
}
export function parseWork(value: unknown): PublicWork {
  const v = object(value), f = fields(v);
  if (!f.image_url.startsWith('/api/v1/themes/')) throw new Error('公开作品图片地址无法核对');
  return { ...f, id: text(v.id), published_at: text(v.published_at) };
}
export function parseWorkPage(value: unknown): WorkPage {
  const v = object(value);
  if (!Number.isInteger(v.total) || Number(v.total) < 0 || (v.next_offset !== null && (!Number.isInteger(v.next_offset) || Number(v.next_offset) <= 0))) throw new Error('作品数量暂时无法核对');
  return { items: array(v.items, parseWork), total: Number(v.total), next_offset: v.next_offset === null ? null : Number(v.next_offset) };
}
export const wallApi = {
  list: async (theme: string, offset = 0, signal?: AbortSignal) => parseWorkPage(await request(`/themes/${encodeURIComponent(theme)}/works?offset=${offset}`, { signal })),
  detail: async (theme: string, id: string, signal?: AbortSignal) => parseWork(await request(`/themes/${encodeURIComponent(theme)}/works/${encodeURIComponent(id)}`, { signal })),
  preview: async (id: number, signal?: AbortSignal) => parsePreview(await request(`/wall/characters/${id}`, { signal })),
  publish: async (id: number, author: string) => parsePreview(await request(`/wall/characters/${id}`, { method: 'PUT', body: JSON.stringify({ author_name: author }) })),
  withdraw: async (id: number) => request(`/wall/characters/${id}`, { method: 'DELETE' }),
};
