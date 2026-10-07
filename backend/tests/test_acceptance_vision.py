import copy
import json
import socket

import pytest

from app.core.config import Settings
from app.services import model_client
from app.services.parsers import ParseError
from scripts.acceptance_vision import AcceptanceVisionClient, CONTRACT, EXAMPLE


@pytest.fixture
def configured(monkeypatch):
    settings=Settings(_env_file=None,model_api_key='synthetic',character_bundle_enabled=True)
    monkeypatch.setattr(model_client,'get_settings',lambda:settings)
    monkeypatch.setattr('app.core.config.get_settings',lambda:settings)
    monkeypatch.setattr(socket.socket,'connect',lambda *_:pytest.fail('No network in parser tests'))
    return settings


def test_complete_example_preserves_valid_multiple_candidates(configured,monkeypatch):
    monkeypatch.setattr(AcceptanceVisionClient,'_call_vision',lambda *_:json.dumps(EXAMPLE))
    objects=AcceptanceVisionClient().recognize(b'synthetic')
    assert len(objects)==2 and objects[0].concept and not objects[1].concept


@pytest.mark.parametrize('missing',['visual_features','concept'])
def test_primary_fields_cannot_be_silently_omitted(configured,monkeypatch,missing):
    value=copy.deepcopy(EXAMPLE);value[0].pop(missing)
    monkeypatch.setattr(AcceptanceVisionClient,'_call_vision',lambda *_:json.dumps(value))
    with pytest.raises(ParseError):AcceptanceVisionClient().recognize(b'synthetic')


def test_malformed_nested_response_is_rejected_once_without_repair(configured,monkeypatch):
    calls=[]
    def vision(*_):
        calls.append(1)
        return '[{"label":"绿萝","category":"plant","concept":{"name":"斑斑","persona":"安静","opening_line":"你好","appearance_description":"盆栽"}, {"label":"地板","category":"object"}]'
    monkeypatch.setattr(AcceptanceVisionClient,'_call_vision',vision)
    with pytest.raises(ParseError):AcceptanceVisionClient().recognize(b'synthetic')
    assert len(calls)==1


def test_contract_changes_only_vision_prompt_and_never_original_payload(configured,monkeypatch):
    seen=[]
    monkeypatch.setattr(model_client.ModelClient,'_post_chat_completions',lambda _,p,s:seen.append(p) or 'fixture')
    original={'model':configured.vision_model,'messages':[{'role':'user','content':[
        {'type':'text','text':'original rules'},
        {'type':'image_url','image_url':{'url':'synthetic-image'}},
    ]}],'temperature':.1}
    before=copy.deepcopy(original)
    assert AcceptanceVisionClient()._post_chat_completions(original,configured)=='fixture'
    assert original==before and seen[0]['messages'][0]['content'][0]['text']=='original rules'+CONTRACT
    assert seen[0]['messages'][0]['content'][1]==original['messages'][0]['content'][1]
    assert 'response_format' not in seen[0]
    chat={'model':configured.chat_model,'messages':[{'role':'user','content':'hello'}]}
    AcceptanceVisionClient()._post_chat_completions(chat,configured)
    assert seen[-1] is chat
