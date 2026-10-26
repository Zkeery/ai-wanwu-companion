"""Bounded procedural geometry hints from saved object facts, never private dialogue."""
from __future__ import annotations

import hashlib
import re


SOURCE = 'procedural_existing_features'
_KINDS = (
    ('cup', ('杯', r'\bcups?\b', r'\bmugs?\b', r'\btumblers?\b')),
    ('bouquet', ('花束', '花卉', '鲜花', '玫瑰', '绣球', r'\bbouquet\b', r'\bflowers?\b')),
    ('garment', ('衬衫', '衣服', '衣物', '毛衣', '外套', '裙子', '围巾', r'\bshirts?\b', r'\bgarments?\b', r'\bsweaters?\b', r'\bdress\b', r'\bclothes\b')),
    ('fruit', ('水果', '苹果', '橘子', '橙子', '香蕉', '梨子', '柠檬', '桃子', '草莓', r'\bfruits?\b', r'\bapples?\b', r'\boranges?\b', r'\bbananas?\b', r'\bpears?\b', r'\blemons?\b')),
    ('plant', ('植物', '绿植', '盆栽', '多肉', '叶片', '树苗', '藤蔓', r'\bplants?\b', r'\bsucculents?\b', r'\btrees?\b', r'\bleaves\b')),
    ('creature', ('小猫', '猫咪', '小狗', '狗狗', '兔子', '小熊', '玩偶', '毛绒', r'\bcats?\b', r'\bdogs?\b', r'\brabbits?\b', r'\bbears?\b', r'\bplush\b')),
)
_COLORS = (
    (r'浅紫|淡紫|lavender', '#b69acf'),
    (r'薄荷绿|浅绿|淡绿|mint', '#9ddac0'),
    (r'浅蓝|淡蓝|sky blue', '#a9cde4'),
    (r'米白|奶白|乳白|cream|ivory', '#f2e7ce'),
    (r'粉红|粉色|pink', '#efa3b8'),
    (r'白色|白杯|白衬衫|\bwhite\b', '#eee9df'),
    (r'绿色|绿叶|翠绿|\bgreen\b', '#6ca572'),
    (r'紫色|\bpurple\b|\bviolet\b', '#9868af'),
    (r'红色|红苹果|\bred\b', '#d77d75'),
    (r'橙色|橘色|\borange\b', '#e2a15e'),
    (r'黄色|金黄|\byellow\b', '#e3c56a'),
    (r'蓝色|\bblue\b', '#779fc8'),
    (r'棕色|褐色|\bbrown\b', '#a88668'),
    (r'黑色|\bblack\b', '#45444e'),
    (r'灰色|\bgr[ae]y\b', '#a9a6a1'),
)
_PALETTES = {
    'cup': ('#e8ddca', '#80b6a0', '#4c4544'),
    'bouquet': ('#a5ba8c', '#c3a0cf', '#65516f'),
    'plant': ('#83b188', '#b7d290', '#426c4c'),
    'fruit': ('#d99378', '#86a66b', '#684b43'),
    'garment': ('#d7d6ca', '#a7bec9', '#5b5964'),
    'creature': ('#d5b08d', '#ead8bd', '#51463e'),
    'unavailable': ('#c8c7c3', '#deddd8', '#66645f'),
}


def _text(value, limit):
    return value[:limit].casefold() if isinstance(value, str) else ''


def _kind(value):
    for kind, patterns in _KINDS:
        if any(re.search(pattern, value) for pattern in patterns):
            return kind
    return None


def resolve_avatar3d(character_id: int, *, label: str, category: str = 'unknown',
                     visual_features: str = '') -> dict:
    """Pure resolver. Callers deliberately cannot pass names, persona or messages."""
    if type(character_id) is not int or character_id <= 0:
        raise ValueError('character_id must be a positive integer')
    seed = int.from_bytes(hashlib.sha256(f'avatar3d:1:{character_id}'.encode()).digest()[:4], 'big')
    label, features = _text(label, 255), _text(visual_features, 500)
    kind = _kind(label) or _kind(features)
    if kind is None:
        kind = category if category in ('fruit', 'plant') else 'unavailable'
    palette = _PALETTES[kind]
    colors = []
    if kind != 'unavailable':
        # Prefer explicit saved appearance colors. Unspecified shades use a stable palette.
        for pattern, color in _COLORS:
            match = re.search(pattern, features or label)
            if match:
                colors.append((match.start(), match.end(), color))
        spans, selected = [], []
        for start, end, color in sorted(colors, key=lambda item: (item[0], -item[1])):
            if not any(start < previous_end and end > previous_start for previous_start, previous_end in spans):
                spans.append((start, end))
                selected.append(color)
        colors = list(dict.fromkeys(selected))
    body = colors[0] if colors else palette[seed % 2]
    accent = colors[1] if len(colors) > 1 else palette[1 if body != palette[1] else 0]
    return dict(version=1, kind=kind, body=body, accent=accent, detail=palette[2],
                seed=seed, source=SOURCE)


def gathering_avatars(conn, g: dict, uid: str) -> dict[int, dict]:
    """Derive hints only after membership and exact current visit binding match."""
    if conn is None or g.get('closed') or uid not in g.get('members', {}):
        return {}
    from sqlalchemy import and_, select
    from app.living.gatherings import visits
    from app.models.models import Character, Object

    participants = {c['id']: c for c in g['companions'].values()
                    if type(c.get('id')) is int and c['id'] > 0
                    and c.get('owner_id') in g['members']}
    if not participants:
        return {}
    rows = conn.execute(select(Character.id, Character.owner_id, Object.label,
            Object.category, Object.visual_features)
        .join(Object, Object.id == Character.object_id)
        .join(visits, and_(visits.c.character_id == Character.id,
                          visits.c.owner_id == Character.owner_id,
                          visits.c.group_id == g['id']))
        .where(Character.id.in_(participants), Character.status == 'ready',
               Character.current_space_id == g['id'])).mappings()
    return {row['id']: resolve_avatar3d(row['id'], label=row['label'], category=row['category'],
                                      visual_features=row['visual_features'])
            for row in rows if row['owner_id'] == participants[row['id']]['owner_id']}
