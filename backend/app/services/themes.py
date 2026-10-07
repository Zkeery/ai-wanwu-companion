"""Fixed creative topics, separate from the model's observed object category."""
from app.core.errors import api_error

THEMES = {
    "fruit": {
        "id": "fruit", "title": "一份水果，一位新朋友",
        "description": "苹果、橘子、香蕉……拍下你喜欢的一份水果，创造属于你的独特伙伴。",
        "category": "fruit",
    },
}
CATEGORIES = {"fruit", "plant", "object", "other", "unknown"}


def validate_theme(theme_id: str | None) -> str | None:
    if theme_id is not None and theme_id not in THEMES:
        raise api_error(422, "invalid_theme", "这个主题暂不可用，请重新选择主题")
    return theme_id


def require_match(theme_id: str | None, category: str, label_changed: bool) -> None:
    if theme_id is None:
        return
    validate_theme(theme_id)
    if label_changed or category != THEMES[theme_id]["category"]:
        raise api_error(409, "theme_mismatch", "还不能确认这个对象符合水果主题。请选择识别到的水果、换张照片，或改为自由创作。")
