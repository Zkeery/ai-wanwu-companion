"""模型输出解析器测试（畸形输出、缺字段、格式不合规）。"""
from __future__ import annotations

import pytest

from app.services.parsers import (
    ParseError,
    parse_opening,
    parse_persona,
    parse_recognize,
)


def test_parse_recognize_array():
    objs = parse_recognize('[{"label": "杯子"}, {"label": "植物"}]')
    assert [o.label for o in objs] == ["杯子", "植物"]


def test_parse_recognize_wrapped_in_objects():
    objs = parse_recognize('{"objects": [{"label": "杯子"}]}')
    assert [o.label for o in objs] == ["杯子"]


def test_parse_recognize_markdown_fence():
    objs = parse_recognize('```json\n[{"label": "杯子"}]\n```')
    assert [o.label for o in objs] == ["杯子"]


def test_parse_recognize_malformed_json_raises():
    with pytest.raises(ParseError):
        parse_recognize("这不是 JSON")


def test_parse_recognize_missing_label_raises():
    with pytest.raises(ParseError):
        parse_recognize('[{"foo": "bar"}]')


def test_parse_recognize_empty_raises():
    with pytest.raises(ParseError):
        parse_recognize("[]")


def test_parse_persona_ok():
    p = parse_persona('{"name": "杯子小伴", "persona": "安静的伙伴"}')
    assert p.name == "杯子小伴"
    assert p.persona == "安静的伙伴"


def test_parse_persona_missing_name_raises():
    with pytest.raises(ParseError):
        parse_persona('{"persona": "x"}')


def test_parse_persona_not_object_raises():
    with pytest.raises(ParseError):
        parse_persona('["a"]')


def test_parse_opening_ok():
    assert parse_opening('"你好呀"') == "你好呀"


def test_parse_opening_strips_chinese_quotes():
    assert parse_opening("“嗨，我是杯子。”") == "嗨，我是杯子。"


def test_parse_opening_empty_raises():
    with pytest.raises(ParseError):
        parse_opening("   ")
