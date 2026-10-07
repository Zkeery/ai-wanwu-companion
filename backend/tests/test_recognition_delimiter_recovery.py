"""Regression for a real provider's closing-delimiter order failure."""
import json

import pytest

from app.services.parsers import ParseError, parse_recognize


def payload():
    return [{'label': '杯子', 'visual_features': '米白色，右侧把手', 'category': 'object',
        'concept': {'name': '暖暖', 'persona': '温暖的小伙伴', 'opening_line': '你好呀',
            'appearance_description': '圆润的米白色陶瓷身体，短小手臂。'}}]


def test_reorders_only_existing_final_delimiters_without_changing_values():
    text = json.dumps(payload(), ensure_ascii=False)
    assert text.endswith('}}]')
    malformed = text[:-3] + '}]}'
    assert parse_recognize(malformed) == parse_recognize(text)
    assert parse_recognize('```json\n' + malformed + '\n```') == parse_recognize(text)


def test_quotes_and_brackets_inside_values_are_preserved():
    data = payload()
    data[0]['visual_features'] = '印有"图案"和符号 } ] \\ 的杯子'
    text = json.dumps(data, ensure_ascii=False)
    assert parse_recognize(text[:-3] + '}]}')[0].visual_features == data[0]['visual_features']


@pytest.mark.parametrize('tail', ['}]', '}}]}}', '}}]]', '}]} trailing', '}],{}', '}'])
def test_does_not_insert_delete_or_discard_unexpected_content(tail):
    text = json.dumps(payload(), ensure_ascii=False)
    with pytest.raises(ParseError):
        parse_recognize(text[:-3] + tail)


def test_internal_missing_brace_is_not_repaired():
    with pytest.raises(ParseError):
        parse_recognize('[{"label":"杯子","concept":{"name":"暖暖"},{"label":"桌子"}]')


def test_schema_rejection_still_applies_after_delimiter_normalization():
    data = payload()
    data[0]['category'] = 'invalid'
    text = json.dumps(data, ensure_ascii=False)
    with pytest.raises(ParseError, match='识别类别无效'):
        parse_recognize(text[:-3] + '}]}')


def test_complete_multi_candidate_array_with_one_stray_object_closer():
    data = payload() + [
        {'label': '衣服', 'visual_features': '绿色布料', 'category': 'object'},
        {'label': '装饰', 'visual_features': '黄色圆点', 'category': 'object'},
    ]
    text = json.dumps(data, ensure_ascii=False)
    assert parse_recognize(text + '}') == parse_recognize(text)
    assert parse_recognize('```json\n' + text + '}\n```') == parse_recognize(text)


@pytest.mark.parametrize('suffix', [',{}', '{}', ' trailing', '}}', ']', ','])
def test_complete_array_does_not_allow_other_trailing_content(suffix):
    with pytest.raises(ParseError):
        parse_recognize(json.dumps(payload()) + suffix)


def test_stray_closer_recovery_still_validates_every_candidate():
    data = payload() + [{'label': '装饰', 'category': 'invalid'}]
    with pytest.raises(ParseError, match='识别类别无效'):
        parse_recognize(json.dumps(data) + '}')
    with pytest.raises(ParseError):
        parse_recognize('[]}')


def test_non_recognition_profile_remains_strict():
    from app.services.parsers import parse_character_profile
    with pytest.raises(ParseError):
        parse_character_profile(json.dumps(payload()[0]['concept']) + '}')


def test_recovered_response_passes_real_upload_and_persists_concept(client, png_header, monkeypatch):
    from types import SimpleNamespace
    from app.services import model_client
    from app.core.database import SessionLocal
    from app.models.models import Object
    monkeypatch.setattr(model_client, 'get_settings', lambda: SimpleNamespace(use_mock=False))
    calls = []
    def vision(self, image, settings):
        calls.append(True)
        return json.dumps(payload()) + '}'
    monkeypatch.setattr(model_client.ModelClient, '_call_vision', vision)
    reply = client.post('/api/v1/photos', files={'file': ('synthetic.png', png_header, 'image/png')})
    assert reply.status_code == 201
    assert len(calls) == 1
    obj = reply.json()['objects'][0]
    assert obj['label'] == payload()[0]['label']
    assert obj['visual_features'] == payload()[0]['visual_features']
    with SessionLocal() as db:
        assert db.get(Object, obj['id']).character_concept_json is not None
