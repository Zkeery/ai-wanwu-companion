import copy
import json
import socket

import pytest

from app.core.config import Settings
from app.services.model_client import ModelClient
from app.services.parsers import ParseError
from scripts import acceptance_recreation as recreation


@pytest.fixture
def configured(monkeypatch):
    settings = Settings(_env_file=None, model_api_key='synthetic', character_bundle_enabled=True)
    monkeypatch.setattr(recreation, 'get_settings', lambda: settings)
    monkeypatch.setattr(socket.socket, 'connect', lambda *_: pytest.fail('No network in contrast tests'))
    return settings


def profile(**overrides):
    return json.dumps(dict(name='藤藤', persona='好奇', opening_line='你好呀',
        appearance_description='有脸的红棕盆身，横向藤蔓与不对称叶冠，侧身张臂', **overrides), ensure_ascii=False)


def test_contrast_uses_facts_and_reference_without_mutation(configured, monkeypatch):
    previous = dict(name='斑斑', persona='安静', generation_brief={'appearance_description':'旧轮廓'})
    original = copy.deepcopy(previous); calls = []
    monkeypatch.setattr(ModelClient, '_call_chat', lambda _, prompt, settings: calls.append((prompt, settings)) or profile())
    result = recreation.AcceptanceRecreationClient().generate_concept('绿萝', '奶白翠绿斑纹', previous_character=previous)
    assert previous == original and len(calls) == 1
    assert calls[0][1] is configured and result.appearance_description
    for expected in ('奶白翠绿斑纹', '旧轮廓', recreation.CONTRAST, recreation.POTHOS_CONTRAST):
        assert expected in calls[0][0]


def test_nonplant_has_structural_rule_without_plant_strategy(configured, monkeypatch):
    calls = []
    monkeypatch.setattr(ModelClient, '_call_chat', lambda _, p, s: calls.append(p) or profile())
    recreation.AcceptanceRecreationClient().generate_concept('杯子', '蓝色陶瓷', previous_character={'name':'小杯'})
    assert recreation.CONTRAST in calls[0] and recreation.POTHOS_CONTRAST not in calls[0]


def test_new_creation_delegates_original_logic(configured, monkeypatch):
    calls = []
    monkeypatch.setattr(ModelClient, 'generate_concept', lambda _, *a, **kw: calls.append((a, kw)) or 'original')
    assert recreation.AcceptanceRecreationClient().generate_concept('绿萝', '事实') == 'original'
    assert calls == [(('绿萝', '事实'), {'previous_character':None})]


@pytest.mark.parametrize('response', ['{bad', json.dumps({'name':'藤藤','persona':'好奇','opening_line':'你好'}),
    json.dumps({'name':'斑斑','persona':'好奇','opening_line':'你好','appearance_description':'横向盆身'})])
def test_invalid_or_duplicate_output_fails_once(configured, monkeypatch, response):
    calls = []
    monkeypatch.setattr(ModelClient, '_call_chat', lambda *_: calls.append(1) or response)
    with pytest.raises(ParseError):
        recreation.AcceptanceRecreationClient().generate_concept('绿萝', '事实', previous_character={'name':'斑斑'})
    assert calls == [1]
