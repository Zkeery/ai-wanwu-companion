"""Synthetic transport only: preserve receipts before parsing and stop failed chains."""
import base64
from io import BytesIO
import json
import socket

import httpx
from PIL import Image
import pytest

from app.core.config import get_settings
from app.services.parsers import ParseError
from scripts import run_c174_recreation as runner
from tests.test_c174_batch import manual_grant, prepared  # noqa: F401


@pytest.mark.parametrize('valid_profile',[False,True])
def test_detached_driver_persists_response_before_parse_and_never_retries(
        prepared,tmp_path,monkeypatch,valid_profile):
    manual_grant(prepared,tmp_path,monkeypatch)
    monkeypatch.setattr(prepared,'PROJECT',tmp_path)
    monkeypatch.setattr(prepared,'current_prices',lambda:{})
    root=prepared.WORK/'recreation-manual-1';root.mkdir();(root/'uploads').mkdir()
    monkeypatch.setattr(runner,'ROOT',root)
    old={'name':'原绿萝','persona':'原来的安静性格','opening_line':'你好，老朋友',
         'appearance_description':'绿色叶片与陶盆','label':'绿萝','visual_features':'斑叶与陶盆',
         'image_file':'original.png','source_sha256':'synthetic-photo-sha'}
    image=BytesIO();Image.new('RGB',(1024,1024),'green').save(image,format='PNG')
    (tmp_path/'original.png').write_bytes(image.getvalue())
    monkeypatch.setattr(runner,'source_facts',lambda:old)
    grant=prepared.manual_recreation_authorization()
    prepared.save(root/'state.json',{'status':'prepared','calls':[],
        'source_snapshot_sha256':prepared.fingerprint(old),'unknown_call_id':grant['unknown_call_id']})
    settings=get_settings()
    monkeypatch.setattr(get_settings,'cache_clear',lambda:None)
    for name,value in {'model_api_key':'synthetic-test-only','model_base_url':prepared.BASE,
        'image_base_url':prepared.BASE,'chat_model':'qwen3.8-flash','image_model':'wan2.6-t2i',
        'model_max_retries':0,'upload_dir':str(root/'uploads')}.items():
        monkeypatch.setattr(settings,name,value)
    # The driver updates only its own child environment; restore these in this in-process test.
    monkeypatch.setenv('MODEL_MAX_RETRIES','0');monkeypatch.setenv('UPLOAD_DIR',str(root/'uploads'))
    monkeypatch.setattr(socket.socket,'connect',lambda *a,**k:pytest.fail('No network in regression'))
    requests=[]
    def post(client,url,**kwargs):
        requests.append(kwargs['json']['model'])
        if kwargs['json']['model']=='qwen3.8-flash':
            profile=json.dumps({'name':'新绿萝','persona':'新伙伴活泼而好奇的性格',
                'opening_line':'你好，今天一起看看叶子吧','appearance_description':'陶盆中的斑叶绿萝'}) if valid_profile else 'invalid model JSON'
            data={'choices':[{'message':{'content':profile}}],
                  'usage':{'prompt_tokens':20,'completion_tokens':30}}
        else: data={'data':[{'b64_json':base64.b64encode(image.getvalue()).decode()}]}
        return httpx.Response(200,json=data,headers={'x-request-id':'synthetic-provider-'+str(len(requests))},
                              request=httpx.Request('POST',url))
    monkeypatch.setattr(httpx.Client,'post',post)
    if valid_profile:
        result=runner.run()
        assert result['status']=='needs_review' and result['additional_model_requests']==2
        assert requests==['qwen3.8-flash','wan2.6-t2i']
        assert (prepared.EVIDENCE/'同图再创作候选/index.html').exists()
    else:
        with pytest.raises(ParseError):runner.run()
        assert requests==['qwen3.8-flash']
        assert not (root/'image-response.json').exists()
        assert json.loads((root/'state.json').read_text())['status']=='paused_failure'
    receipt=json.loads((root/'text-response.json').read_text())
    assert 'choices' in receipt and 'headers' not in receipt
    assert prepared.status()['unknown_results']==1  # original retained, never rewritten
    before=len(requests)
    with pytest.raises(ValueError,match='Already attempted'):runner.run()
    assert len(requests)==before
