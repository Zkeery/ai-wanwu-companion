"""A reproducible appearance brief, separate from an editable display name."""
import random

from app.core.config import get_settings
from app.services.appearance_style import STYLE_ID

BRIEF_VERSION = "photo-features-concept-v3"
# The image model does not choose the species. Code picks one so the same object can be reborn differently.
CREATURE_ARCHETYPES = ("小龙宝宝", "小兽", "小精灵", "元素小怪")
CREATURE_ACTIONS = ("向前跑", "跳起来", "挥手", "轻轻飞起")


def generation_brief(label: str, name: str, persona: str, visual_features: str, appearance_description: str = "",
                     creature_archetype: str = "") -> dict:
    brief = {"version": BRIEF_VERSION, "style_id": STYLE_ID, "object_label": label, "visual_features": visual_features,
             "persona": persona, "original_name": name, "appearance_description": appearance_description}
    if creature_archetype:
        brief["creature_archetype"] = creature_archetype
    return brief


def _pick(options: tuple[str, ...], exclude: str | None = None) -> str:
    banned = (exclude or "").strip()
    pool = [item for item in options if item != banned]
    return random.choice(pool or options)


def pick_creature_archetype(exclude: str | None = None) -> str:
    return _pick(CREATURE_ARCHETYPES, exclude)


def pick_creature_action(exclude: str | None = None) -> str:
    return _pick(CREATURE_ACTIONS, exclude)


def image_prompt(label: str, name: str, persona: str = "", visual_features: str = "", appearance_description: str = "",
                 salient_features: str = "", body_parts: str = "", pose: str = "", archetype: str = "", action: str = "") -> str:
    del name, persona, appearance_description, body_parts, pose
    features = salient_features.strip() or visual_features.strip() or label
    body = archetype.strip() or pick_creature_archetype()
    motion = action.strip() or pick_creature_action()
    style = get_settings().image_style_prompt.strip()
    return (
        f"从「{label}」里诞生一只可爱、亲近、能站立的小生物。"
        f"身体必须是一只{body}，有四肢，全身入镜，四分之三侧面，正在{motion}。"
        "不要静态坐着、躺着或趴着，不要只画半身。"
        f"原物带来的特征：{features}。"
        f"「{label}」必须拆开，长成这只生物身体的一部分，和身体连在一起。"
        "可以是身体、头、衣服、脚掌、耳朵或翅膀，例如花盆变成身体下半截的陶土甲壳，耳机变成圆圆的耳朵，书页变成翅膀，拖鞋变成脚掌。"
        f"不能把「{label}」当成帽子、耳机、手里的东西或鞋子，不能拿着、戴着、背着，也不能坐在里面。不要给物件加五官。"
        f"性格可爱、亲近，不要凶猛。{style}"
        "反向要求：不要写实照片感，不要白底，不要文字，不要尖牙，不要攻击姿态。"
    )
