"""场景意图识别（关键词映射）测试。"""
from __future__ import annotations

import pytest

from app.services.chat import detect_scene_action


def test_detect_light_rain():
    assert detect_scene_action("下点小雨吧") == "light_rain"
    assert detect_scene_action("我想下雨了") == "light_rain"


def test_detect_quiet():
    assert detect_scene_action("安静一点") == "quiet"
    assert detect_scene_action("太吵了，静音") == "quiet"


def test_detect_plant_tree():
    assert detect_scene_action("种棵树吧") == "plant_tree"
    assert detect_scene_action("帮我种一棵树") == "plant_tree"


def test_no_action_for_ordinary_message():
    assert detect_scene_action("今天好累啊") is None
    assert detect_scene_action("你好") is None


def test_empty_returns_none():
    assert detect_scene_action("") is None
    assert detect_scene_action("   ") is None


@pytest.mark.parametrize("text", [
    "不要下雨", "别下雨", "不要安静", "不要种树", "我不想下雨了",
    "我喜欢下雨天", "今天下雨了", "为什么会下雨", "种树有什么好处？",
    "他说下点雨吧", "下雨这个词是什么意思", "下雨并种树", "安静的杯子真可爱",
])
def test_negation_description_and_ambiguous_requests_do_not_propose(text):
    assert detect_scene_action(text) is None


@pytest.mark.parametrize("text,expected", [
    ("请下点小雨吧", "light_rain"), ("帮我种一棵树", "plant_tree"),
    ("安静一些好吗？", "quiet"), ("让花园下点雨", "light_rain"),
])
def test_explicit_requests(text, expected):
    assert detect_scene_action(text) == expected
