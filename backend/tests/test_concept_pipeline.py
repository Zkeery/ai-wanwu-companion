"""Two model calls on fresh photos; no live provider calls in this suite."""
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from app.core.config import Settings
from app.core.database import SessionLocal
from app.models.models import Object
from app.services import model_client
from app.services.character_concept import matching_concept
from app.services.appearance_style import STYLE_GUIDANCE, STYLE_ID
from app.services.parsers import ParseError, parse_recognize

CONCEPT = {'name': '点点', 'persona': '安静害羞', 'opening_line': '你好，我是点点。', 'appearance_description': '粉色圆杯身体，白色圆点，弯把手当小耳朵，害羞地挥手。'}


def setup_provider(monkeypatch, tmp_path, png_header, *, missing=False, fail_image=False):
    settings = Settings(_env_file=None, model_api_key='synthetic-concept-key', model_base_url='https://local.invalid/v1', model_max_retries=0, upload_dir=str(tmp_path))
    calls = []
    pending_failure = [fail_image]
    def handle(request):
        payload = json.loads(request.content)
        if request.url.path.endswith('/images/generations'):
            calls.append(('image', payload))
            assert 'data:image' not in request.content.decode()
            if pending_failure[0]:
                pending_failure[0] = False
                return httpx.Response(503, json={'error': {'message': 'synthetic outage'}})
            return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png_header).decode()}]})
        if isinstance(payload['messages'][0]['content'], list):
            calls.append(('vision', payload))
            assert payload['messages'][0]['content'][1]['image_url']['url'].startswith('data:image/')
            obj = {'label': '杯子', 'visual_features': '粉色杯身与白色圆点'}
            if not missing: obj['concept'] = CONCEPT
            content = json.dumps([obj])
        elif payload['messages'][0]['content'].startswith('为角色写一句开场白'):
            calls.append(('opening', payload))
            content = '你好，我是点点。'
        else:
            calls.append(('concept', payload))
            content = json.dumps({**CONCEPT, 'name': '新构思', 'appearance_description': '根据用户纠正后的特征设计的小生物'})
        return httpx.Response(200, json={'choices': [{'message': {'content': content}}]})
    original = httpx.Client
    monkeypatch.setattr(model_client, 'get_settings', lambda: settings)
    monkeypatch.setattr(model_client.httpx, 'Client', lambda **kw: original(transport=httpx.MockTransport(handle), **kw))
    return calls


def upload(client, png_header):
    r = client.post('/api/v1/photos', files={'file': ('cup.png', png_header, 'image/png')})
    assert r.status_code == 201
    return r.json()['objects'][0]['id']


def generate(client, oid, parse_sse, **fields):
    events = parse_sse(client.post('/api/v1/characters', json={'object_id': oid, **fields}).text)
    return events[-1]


def test_unedited_photo_is_two_calls_with_text_only_image_input(client, png_header, monkeypatch, tmp_path, parse_sse):
    calls = setup_provider(monkeypatch, tmp_path, png_header)
    oid = upload(client, png_header)
    event, result = generate(client, oid, parse_sse, label='杯子', visual_features='粉色杯身与白色圆点')
    assert event == 'done' and result['name'] == CONCEPT['name']
    assert [c[0] for c in calls] == ['vision', 'image']
    assert STYLE_GUIDANCE in calls[0][1]['messages'][0]['content'][0]['text']
    assert STYLE_GUIDANCE in calls[-1][1]['prompt'].split('\n创作素材：')[0]
    brief = json.loads(calls[-1][1]['prompt'].split('\n创作素材：')[1])
    assert brief['appearance_description'] == CONCEPT['appearance_description']
    assert brief['visual_features'] == '粉色杯身与白色圆点' and brief['persona'] == CONCEPT['persona']
    assert brief['style_id'] == STYLE_ID
    with SessionLocal() as db:
        saved = db.get(Object, oid).character_concept_json
        assert matching_concept(saved, '杯子', '粉色杯身与白色圆点').name == '点点'
    renamed = client.patch(f"/api/v1/characters/{result['id']}", json={'name': '用户命名'}).json()
    assert renamed['image_path'] == result['image_path']
    assert len(calls) == 2


@pytest.mark.parametrize('fields', [{'label': '茶壶'}, {'visual_features': '绿色方形'}, {'visual_features': ''}])
def test_corrections_rebuild_concept_using_confirmed_facts(client, png_header, monkeypatch, tmp_path, parse_sse, fields):
    calls = setup_provider(monkeypatch, tmp_path, png_header)
    oid = upload(client, png_header)
    event, result = generate(client, oid, parse_sse, **fields)
    assert event == 'done' and result['name'] == '新构思'
    assert [c[0] for c in calls] == ['vision', 'concept', 'image']
    prompt = calls[1][1]['messages'][0]['content']
    assert STYLE_GUIDANCE in prompt
    assert fields.get('label', '杯子') in prompt
    assert json.dumps({'visual_features': fields.get('visual_features', '粉色杯身与白色圆点')}, ensure_ascii=False) in prompt
    with SessionLocal() as db:
        obj = db.get(Object, oid)
        assert matching_concept(obj.character_concept_json, obj.label, obj.visual_features).name == '新构思'


@pytest.mark.parametrize('missing', [False, True])
def test_image_failure_retry_reuses_persisted_concept(client, png_header, monkeypatch, tmp_path, parse_sse, missing):
    calls = setup_provider(monkeypatch, tmp_path, png_header, missing=missing, fail_image=True)
    oid = upload(client, png_header)
    event, result = generate(client, oid, parse_sse)
    assert event == 'error' and result['status'] == 'failed'
    before = len(calls)
    event, result = generate(client, oid, parse_sse)
    assert event == 'done' and len(calls) == before + 1 and calls[-1][0] == 'image'
    assert len([c for c in calls if c[0] == 'concept']) == int(missing)


def test_missing_legacy_concept_is_built_once(client, png_header, monkeypatch, tmp_path, parse_sse):
    calls = setup_provider(monkeypatch, tmp_path, png_header, missing=True)
    event, result = generate(client, upload(client, png_header), parse_sse)
    assert event == 'done'
    assert [c[0] for c in calls] == ['vision', 'concept', 'image']
    assert STYLE_GUIDANCE in calls[1][1]['messages'][0]['content']


@pytest.mark.parametrize('field,value', [('name', ''), ('persona', 1), ('opening_line', None), ('appearance_description', ''), ('appearance_description', []), ('appearance_description', 'x' * 1001)])
def test_malformed_concept_is_rejected_before_persistence(field, value):
    obj = {'label': '杯子', 'concept': {**CONCEPT, field: value}}
    with pytest.raises(ParseError): parse_recognize(json.dumps([obj]))


def test_concepts_remain_bound_to_each_object(client, png_header, monkeypatch, tmp_path, parse_sse):
    calls = setup_provider(monkeypatch, tmp_path, png_header)
    results = [generate(client, upload(client, png_header), parse_sse)[1] for _ in range(2)]
    assert [c[0] for c in calls] == ['vision', 'image', 'vision', 'image']
    assert results[0]['id'] != results[1]['id'] and results[0]['image_path'] != results[1]['image_path']


def test_concept_recovers_after_new_process_without_original_photo(client, png_header, monkeypatch, tmp_path):
    setup_provider(monkeypatch, tmp_path, png_header)
    oid = upload(client, png_header)
    script = f'''from app.core.database import SessionLocal
from app.models.models import Object
from app.services.character_concept import matching_concept
with SessionLocal() as db:
    obj=db.get(Object,{oid})
    assert matching_concept(obj.character_concept_json,obj.label,obj.visual_features).name == '点点'
print('restored')
'''
    result = subprocess.run([sys.executable, '-c', script], cwd=Path(__file__).resolve().parents[1], env=os.environ.copy(), text=True, capture_output=True, check=True)
    assert result.stdout.strip() == 'restored'


def test_legacy_switch_ignores_a_previously_saved_combined_concept(client, png_header, monkeypatch, tmp_path, parse_sse):
    from app.api import characters
    calls = setup_provider(monkeypatch, tmp_path, png_header)
    oid = upload(client, png_header)
    settings = model_client.get_settings()
    settings.character_bundle_enabled = False
    monkeypatch.setattr(characters, 'get_settings', lambda: settings)
    event, result = generate(client, oid, parse_sse)
    assert event == 'done'
    assert sorted(c[0] for c in calls) == ['concept', 'image', 'opening', 'vision']
