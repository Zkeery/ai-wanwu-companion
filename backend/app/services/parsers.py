"""模型输出解析器（纯函数，离线可测）。

- 识别输出：JSON 数组，或 {"objects": [...]} / {"items": [...]}。
- 人设输出：{"name": ..., "persona": ...}。
- 开场白输出：纯文本一句话（可能被引号包裹）。
"""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from app.services.input_limits import MAX_CANDIDATES
from app.services.themes import CATEGORIES


class ParseError(ValueError):
    """模型输出不符合预期结构。"""


@dataclass
class RecognizedObject:
    label: str
    visual_features: str = ""
    concept: Persona | None = None
    category: str = "unknown"


@dataclass
class Persona:
    name: str
    persona: str
    opening_line: str | None = None
    appearance_description: str = ""


_FLAT_PROFILE = {
    "character_name": "name",
    "character_persona": "persona",
    "opening_line": "opening_line",
    "appearance_description": "appearance_description",
}


def _value_kind(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if isinstance(value, str):
        return "string"
    if isinstance(value, bool):
        return "boolean"
    return "number" if isinstance(value, (int, float)) else "unknown"


def _recognition_concept(item: dict, index: int) -> Persona | None:
    flat_present = any(key in item for key in ("character_name", "character_persona")) or (
        "concept" not in item and any(key in item for key in _FLAT_PROFILE)
    )
    use_flat = flat_present and (index == 0 or any(item.get(key) is not None for key in _FLAT_PROFILE))
    legacy_present = "concept" in item
    legacy = item.get("concept")
    source, kind = ("flat", "object") if use_flat else ("legacy", _value_kind(legacy))
    try:
        concept = None
        if use_flat:
            projected = {target: item.get(key) for key, target in _FLAT_PROFILE.items()}
            concept = parse_character_profile(json.dumps(projected, ensure_ascii=False))
        # A null legacy field is harmless when a complete canonical flat
        # profile exists, or when it is only a secondary optional placeholder.
        if legacy_present and not (legacy is None and (use_flat or index > 0)):
            source, kind = "legacy", _value_kind(legacy)
            value = _load_json(legacy) if isinstance(legacy, str) else legacy
            if isinstance(value, list):
                if len(value) > 1:
                    raise ParseError("角色资料包含多个对象")
                if len(value) == 1:
                    value = value[0]
            previous = parse_character_profile(json.dumps(value, ensure_ascii=False))
            if concept is not None and previous != concept:
                raise ParseError("角色资料存在冲突")
            concept = previous
        if concept is not None and not concept.appearance_description:
            raise ParseError("角色构思缺少形象设计描述")
        return concept
    except ParseError as error:
        error.candidate_index = index
        error.profile_contract = source
        error.profile_input_kind = kind
        raise


def parse_recognize(text: str) -> list[RecognizedObject]:
    """解析识别结果为对象列表；畸形输出、缺字段时抛 ParseError。"""
    data = _load_json(text, reorder_recognition_tail=True)
    if isinstance(data, dict):
        for key in ("objects", "items", "labels", "results"):
            if key in data:
                data = data[key]
                break
    if not isinstance(data, list):
        raise ParseError("识别结果应为对象数组")
    objects: list[RecognizedObject] = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            raise ParseError("识别数组元素应为对象")
        label = item.get("label") or item.get("name") or item.get("object") or item.get("item")
        if not isinstance(label, str) or not label.strip():
            raise ParseError("识别结果缺少有效的 label")
        features = item.get("visual_features", "")
        if not isinstance(features, str) or len(features.strip()) > 500:
            raise ParseError("照片特征应为不超过500字的文字")
        concept = _recognition_concept(item, index)
        category = item.get("category", "unknown")
        if not isinstance(category, str) or category not in CATEGORIES:
            raise ParseError("识别类别无效")
        objects.append(RecognizedObject(label=label.strip(), visual_features=features.strip(), concept=concept, category=category))
    if not objects:
        raise ParseError("识别结果为空")
    # Validate every item first, including those outside the display limit.
    return objects[:MAX_CANDIDATES]


def parse_persona(text: str) -> Persona:
    """解析人设输出；缺 name/persona 时抛 ParseError。"""
    data = _load_json(text)
    if not isinstance(data, dict):
        raise ParseError("人设输出应为对象")
    name = data.get("name")
    persona = data.get("persona") or data.get("description")
    if not isinstance(name, str) or not name.strip():
        raise ParseError("人设输出缺少有效的 name")
    if not isinstance(persona, str) or not persona.strip():
        raise ParseError("人设输出缺少有效的 persona")
    return Persona(name=name.strip(), persona=persona.strip())


def parse_opening(text: str) -> str:
    """解析开场白；空内容抛 ParseError。"""
    t = (text or "").strip()
    if not t:
        raise ParseError("开场白为空")
    # 去掉成对引号（含中文左右引号）
    for left, right in (('"', '"'), ("'", "'"), ("“", "”"), ("‘", "’")):
        if len(t) >= 2 and t.startswith(left) and t.endswith(right):
            t = t[1:-1].strip()
            break
    if not t:
        raise ParseError("开场白为空")
    return t


def parse_character_profile(text: str) -> Persona:
    """One response, with the same validated name/persona plus an opening line."""
    persona = parse_persona(text)
    data = _load_json(text)
    opening = data.get("opening_line")
    if not isinstance(opening, str):
        raise ParseError("角色输出缺少有效的 opening_line")
    persona.opening_line = parse_opening(opening)
    if len(persona.name) > 40 or len(persona.persona) > 300 or len(persona.opening_line) > 200:
        raise ParseError("角色输出超过长度限制")
    appearance = data.get("appearance_description", "")
    if not isinstance(appearance, str) or len(appearance.strip()) > 1000:
        raise ParseError("形象设计描述应为不超过1000字的文字")
    persona.appearance_description = appearance.strip()
    return persona


def _reorder_trailing_delimiters(text: str) -> str | None:
    """Reorder an existing closing-only suffix; never invent or drop content.

    The vision provider can emit `}]}` instead of `}}]` after a complete
    nested value. Only the uniquely determined stack order is allowed, with
    exactly the same delimiter counts. All other syntax/schema checks remain.
    """
    match = re.search(r'[}\]\s]+$', text)
    if not match:
        return None
    prefix, tail = text[:match.start()], text[match.start():]
    stack: list[str] = []
    in_string = escaped = False
    pairs = {'{': '}', '[': ']'}
    for char in prefix:
        if in_string:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in pairs:
            stack.append(char)
        elif char in '}]':
            if not stack or pairs[stack.pop()] != char:
                return None
    if in_string or not 1 <= len(stack) <= 8:
        return None
    expected = ''.join(pairs[char] for char in reversed(stack))
    actual = ''.join(tail.split())
    if actual == expected or Counter(actual) != Counter(expected):
        return None
    return prefix + expected


def _load_json(text: str, *, reorder_recognition_tail: bool = False):
    t = (text or "").strip()
    # 剥掉 markdown 代码围栏
    if t.startswith("```"):
        lines = t.splitlines()
        if lines and lines[0].strip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError as exc:
        if reorder_recognition_tail:
            # Observed provider output: a complete recognition array followed
            # by one stray `}`. Decode the entire array first; never complete
            # truncated content or ignore another value, field or explanation.
            try:
                complete, end = json.JSONDecoder().raw_decode(t)
                if isinstance(complete, list) and t[end:].strip() == '}':
                    return complete
            except json.JSONDecodeError:
                pass
            normalized = _reorder_trailing_delimiters(t)
            if normalized is not None:
                try:
                    return json.loads(normalized)
                except json.JSONDecodeError:
                    pass
        raise ParseError("输出不是合法 JSON") from exc
