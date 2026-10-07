"""Deterministic personality catalog and validation; never calls a provider."""
from __future__ import annotations

from app.core.errors import api_error

_GROUPS = [
    ('推荐', [('gentle', '温柔体贴'), ('cheerful', '活泼开朗'), ('quiet', '安静内敛'), ('curious', '好奇探索'), ('playful', '幽默俏皮'), ('reliable', '沉稳可靠')]),
    ('社交', [('outgoing', '外向热情'), ('introverted', '内向安静'), ('agreeable', '讨好型'), ('direct', '直球型')]),
    ('情绪', [('optimistic', '乐天乐观'), ('melancholic', '阴郁沉稳'), ('sensitive', '敏感细腻'), ('rational', '冷静理性'), ('fiery', '暴躁易怒'), ('easygoing', '佛系淡定')]),
    ('做事', [('perfectionist', '完美主义'), ('procrastinator', '拖延懒散'), ('action', '行动派'), ('cautious', '谨慎保守'), ('ambitious', '野心强'), ('laidback', '佛系躺平')]),
    ('立场', [('principled', '正直守矩'), ('pragmatic', '实用主义'), ('strategic', '腹黑算计'), ('innocent', '天真单纯'), ('cynical', '犬儒嘲讽')]),
    ('趣味反差', [('tough_soft', '外表凶、内心软'), ('sharp_soft', '嘴硬心软'), ('shy_capable', '社恐但工作很猛'), ('genius_clumsy', '天才但生活白痴'), ('gentle_firm', '温柔但底线极硬'), ('entertainer', '搞笑担当 / 气氛组')]),
    ('补充', [('sharp', '毒舌'), ('protective', '护短'), ('carefree', '大大咧咧'), ('lonely', '怕孤独'), ('slowwarm', '慢热')]),
]
OPTIONS = [{'id': key, 'label': label, 'group': group} for group, items in _GROUPS for key, label in items]
LABELS = {o['id']: o['label'] for o in OPTIONS}
# Only overt default-style contradictions; contextual contrasts remain valid.
CONFLICTS = [('outgoing', 'introverted'), ('outgoing', 'quiet'), ('rational', 'fiery'),
             ('easygoing', 'fiery'), ('action', 'procrastinator'), ('ambitious', 'laidback')]
ALIASES = {'热情外向': 'outgoing', '慢热内向': 'introverted', '安静内敛': 'quiet'}
MAX_CUSTOM = 300


def normalize(tags: list[str], custom: str, priority: str | None):
    if len(custom) > MAX_CUSTOM:
        raise api_error(422, 'invalid_personality', '自定义性格最多300字，请调整后保存')
    clean = list(dict.fromkeys(ALIASES.get(tag, tag) for tag in tags))
    if any(tag not in LABELS for tag in clean):
        raise api_error(422, 'invalid_personality', '性格选项已更新，请重新选择')
    # The overlapping preset labels share the same canonical value.
    if 'quiet' in clean and 'introverted' in clean:
        clean.remove('quiet')
    for a, b in CONFLICTS:
        if a in clean and b in clean:
            raise api_error(422, 'personality_options_conflict', f'「{LABELS[a]}」与「{LABELS[b]}」方向不同，请保留一个；需要情境反差时可在自定义中说明')
    if not clean and not custom.strip():
        raise api_error(422, 'empty_personality', '请选择性格或填写自定义描述，原性格尚未更改')
    if clean and custom.strip() and priority is None:
        raise api_error(422, 'personality_priority_required', '请选择预设为主或自定义为主')
    return clean, custom, priority if clean and custom.strip() else None


def describe(tags: list[str], custom: str, priority: str | None) -> str:
    labels = ' + '.join(LABELS[t] for t in tags)
    if labels and custom.strip():
        return f'以{"自定义" if priority == "custom" else "预设"}为主；另一项作为不冲突的补充。\n预设：{labels}\n自定义：{custom}'
    return custom if custom.strip() else labels
