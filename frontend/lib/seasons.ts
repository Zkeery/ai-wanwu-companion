import { request } from './api';
import { object } from './contracts';

export const seasonNames = { spring: '春天', summer: '夏天', autumn: '秋天', winter: '冬天' } as const;
export type Season = keyof typeof seasonNames;
export type SeasonSettings = { mode: 'real'; hemisphere: 'north' | 'south' } | { mode: 'virtual'; weeks: 1 | 2 | 4; start_season: Season };
export type SeasonSnapshot = { settings: SeasonSettings | null; current_season: Season | null; started_at: number | null; next_change_at: number | null; revision: number; observed_at: number; timezone: 'Asia/Shanghai' };
const isSeason = (v: unknown): v is Season => typeof v === 'string' && Object.hasOwn(seasonNames, v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function parseSeason(value: unknown): SeasonSnapshot {
  const r = object(value);
  if (!integer(r.revision) || !integer(r.observed_at) || r.timezone !== 'Asia/Shanghai') throw new Error('四季状态暂时无法核对');
  if (r.settings === null) {
    if (r.revision !== 0 || r.current_season !== null || r.started_at !== null || r.next_change_at !== null) throw new Error('四季状态暂时无法核对');
  } else {
    const s = object(r.settings);
    const valid = s.mode === 'real' ? (s.hemisphere === 'north' || s.hemisphere === 'south') : s.mode === 'virtual' && [1, 2, 4].includes(Number(s.weeks)) && typeof s.weeks === 'number' && isSeason(s.start_season);
    if (!valid || !isSeason(r.current_season) || !integer(r.started_at) || !integer(r.next_change_at)) throw new Error('四季状态暂时无法核对');
  }
  return r as SeasonSnapshot;
}

async function call(id: string, suffix = '', init: RequestInit = {}) {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
  return parseSeason(await request(`/living/spaces/${encodeURIComponent(id)}/season${suffix}`, { ...init, signal }));
}
export const seasonApi = {
  read: (id: string, signal?: AbortSignal) => call(id, '', { signal }),
  preview: (id: string, settings: SeasonSettings, signal?: AbortSignal) => call(id, '/preview', { method: 'POST', body: JSON.stringify({ settings }), signal }),
  save: (id: string, settings: SeasonSettings, revision: number, requestId: string, signal?: AbortSignal) => call(id, '', { method: 'PUT', body: JSON.stringify({ settings, expected_revision: revision, request_id: requestId }), signal }),
};

export function seasonPalette(scene: 'home' | 'desert' | 'forest', season: Season | null) {
  if (!season) return null;
  const palettes = {
    home: { spring: ['#d8f4ec', '#b2d59f', '#8fbf93'], summer: ['#b7e9ed', '#8dcb9b', '#60af91'], autumn: ['#f5e4c8', '#e7be82', '#cba06e'], winter: ['#dcebec', '#ccdedb', '#a2bebc'] },
    forest: { spring: ['#d7eee5', '#9ec6a7', '#7aaf95'], summer: ['#c2e7e4', '#76b39a', '#508f82'], autumn: ['#f1e0c9', '#ccaa79', '#a48e68'], winter: ['#d3e2e7', '#aabfbc', '#809e9a'] },
    desert: { spring: ['#e1eee6', '#eed7a5', '#dabc85'], summer: ['#c9e8ec', '#f4d195', '#e3b372'], autumn: ['#f4e2cc', '#ebc797', '#ce9f73'], winter: ['#d9e7eb', '#d9cfb4', '#bdb397'] },
  };
  const [sky, hill, ground] = palettes[scene][season];
  return { sky, hill, ground };
}
