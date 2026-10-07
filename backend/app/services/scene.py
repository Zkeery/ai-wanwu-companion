"""场景定义与受控操作（确定性代码执行）。

- 预置「小花园」场景，含天气、声音、树木与六类装饰。
- 九个受控操作；装饰数量受限，旧存档缺少的元素按零读取。
- 仅保留最近一次「操作前状态」，撤销后无第二次可撤销操作。
"""
from __future__ import annotations

import json
from app.services.input_limits import TREE_LIMIT

SCENE_NAME = "小花园"

DEFAULT_ELEMENTS: dict[str, int] = {
    "rain": 0,    # 0/1
    "tree": 0,    # new additions <= 7; historical counts remain intact
    "cloud": 0,   # 0/1
    "sound": 1,   # 0..1 氛围音量
    "flower": 0,
    "mushroom": 0,
    "pond": 0,
    "bench": 0,
    "campfire": 0,
    "fireflies": 0,
}

ACTIONS: dict[str, dict] = {
    "light_rain": {
        "label": "小雨",
        "feedback": "淅淅沥沥的小雨落下来了，空气都清新了。",
        "changes": {"rain": 1, "cloud": 1, "sound": 1},
    },
    "quiet": {
        "label": "安静",
        "feedback": "世界安静下来了，只剩轻轻的呼吸声。",
        "changes": {"sound": 0},
    },
    "plant_tree": {
        "label": "种树",
        "feedback": "又种下一棵小树，花园更绿了一点。",
        "increment": "tree",
        "limit": TREE_LIMIT,
    },
    "plant_flower": {"label": "种一簇花", "feedback": "一簇小花开了，花园多了一点颜色。", "increment": "flower", "limit": 6},
    "grow_mushroom": {"label": "添一丛蘑菇", "feedback": "圆滚滚的小蘑菇，悄悄冒出了头。", "increment": "mushroom", "limit": 4},
    "add_pond": {"label": "添个水池", "feedback": "一汪小水池安顿好了，水面泛起轻轻的涟漪。", "changes": {"pond": 1}},
    "place_bench": {"label": "放张长椅", "feedback": "长椅放好了，留个位置一起坐坐。", "changes": {"bench": 1}},
    "light_campfire": {"label": "点亮营火", "feedback": "一团暖暖的营火，照亮了这片小天地。", "changes": {"campfire": 1}},
    "release_fireflies": {"label": "迎来萤火虫", "feedback": "小小的萤火虫飞来了，像会呼吸的星星。", "changes": {"fireflies": 1}},
}

ACTION_LABELS: dict[str, str] = {code: spec["label"] for code, spec in ACTIONS.items()}


def default_elements() -> dict[str, int]:
    return dict(DEFAULT_ELEMENTS)


def apply_action(elements: dict, action: str) -> dict:
    """返回执行操作后的元素状态（不修改入参）。"""
    spec = ACTIONS[action]
    result = dict(elements)
    if "increment" in spec:
        key = spec["increment"]
        count = int(result.get(key, 0))
        if "limit" in spec and count >= spec["limit"]:
            return result
        result[key] = count + 1
    else:
        result.update(spec["changes"])
    return result


def feedback_for(action: str) -> str:
    return ACTIONS[action]["feedback"]


def unchanged_feedback(action: str, elements: dict) -> str:
    if action == "plant_tree":
        count = elements.get("tree", 0)
        if count > TREE_LIMIT:
            return f"已保存 {count} 棵，画面展示 {TREE_LIMIT} 棵，暂时不能再种树。"
        return f"树木已达 {TREE_LIMIT} 棵上限，试试其他小物吧。"
    return "这里已经布置好了，试试其他小物吧。"


def serialize(elements: dict, history: list) -> str:
    return json.dumps({"elements": elements, "history": history}, ensure_ascii=False)


def deserialize(state_json: str | None) -> tuple[dict, list]:
    """解析持久化 JSON，返回（元素状态, 历史栈）。损坏时回退默认值。"""
    if not state_json:
        return default_elements(), []
    try:
        data = json.loads(state_json)
    except (json.JSONDecodeError, TypeError):
        return default_elements(), []
    elements = data.get("elements") if isinstance(data, dict) else None
    history = data.get("history") if isinstance(data, dict) else None
    if not isinstance(elements, dict):
        elements = default_elements()
    if not isinstance(history, list):
        history = []
    return {**default_elements(), **elements}, [
        {**default_elements(), **entry} for entry in history[-1:] if isinstance(entry, dict)
    ]
