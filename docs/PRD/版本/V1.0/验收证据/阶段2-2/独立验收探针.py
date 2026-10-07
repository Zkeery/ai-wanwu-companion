import os, json, tempfile, sys
from pathlib import Path
from unittest.mock import patch
with tempfile.TemporaryDirectory(prefix='aiwwb-stage2-') as temp:
    os.environ.update(DATABASE_URL='sqlite:///'+temp+'/audit.db', UPLOAD_DIR=temp+'/uploads', MODEL_API_KEY='', MODEL_BASE_URL='', IMAGE_BASE_URL='')
    sys.path.insert(0, str(Path(__file__).resolve().parents[6] / 'backend'))
    from fastapi.testclient import TestClient
    from app.main import app
    from app.core.database import SessionLocal
    from app.core.config import Settings
    from app.models.models import Photo, Object, Character, Message
    from app.services.model_client import ModelClient, ModelError
    from app.services import model_client
    import httpx
    results=[]
    def record(name, passed, detail):
        results.append(dict(check=name,passed=passed,detail=detail))
    def character():
        with SessionLocal() as s:
            p=Photo(filename='audit.png',status='done');s.add(p);s.flush()
            o=Object(photo_id=p.id,label='杯子');s.add(o);s.flush()
            c=Character(object_id=o.id,name='验收杯',persona='温暖的杯子伙伴',opening_line='你好',status='ready');s.add(c);s.commit();return c.id
    with TestClient(app) as client:
        cid=character();captured=[]
        def capture(self,messages):
            captured.append(messages);yield '验收回复'
        with patch.object(ModelClient,'chat_stream',capture):
            r=client.post(f'/api/v1/characters/{cid}/chat',json={'message':'唯一当前消息'})
        count=sum(m['role']=='user' and m['content']=='唯一当前消息' for m in captured[0])
        record('current_message_once',count==1,{'actual_copies':count,'last_roles':[m['role'] for m in captured[0][-2:]]})
        mem=client.post(f'/api/v1/characters/{cid}/memories',json={'content':'验收记忆A'}).json()
        with patch.object(ModelClient,'chat_stream',capture):client.post(f'/api/v1/characters/{cid}/chat',json={'message':'测试'})
        added='验收记忆A' in captured[-1][0]['content']
        client.put(f'/api/v1/memories/{mem["id"]}',json={'content':'验收记忆B'})
        with patch.object(ModelClient,'chat_stream',capture):client.post(f'/api/v1/characters/{cid}/chat',json={'message':'测试'})
        edited='验收记忆B' in captured[-1][0]['content'] and '验收记忆A' not in captured[-1][0]['content']
        client.delete(f'/api/v1/memories/{mem["id"]}')
        with patch.object(ModelClient,'chat_stream',capture):client.post(f'/api/v1/characters/{cid}/chat',json={'message':'测试'})
        removed='验收记忆B' not in captured[-1][0]['content']
        record('memory_changes_affect_next_system_context',added and edited and removed,{'added':added,'edited':edited,'removed':removed})
        cid2=character()
        def clearing(self,messages):
            yield '前半段'
            client.delete(f'/api/v1/characters/{cid2}/messages')
            yield '后半段'
        with patch.object(ModelClient,'chat_stream',clearing):r=client.post(f'/api/v1/characters/{cid2}/chat',json={'message':'清空测试'})
        remaining=client.get(f'/api/v1/characters/{cid2}/messages').json()
        record('cleared_history_stays_empty_during_stream',remaining==[],{'remaining_roles':[m['role'] for m in remaining],'sse_done':'event: done' in r.text})
        cid3=character()
        def deleting(self,messages):
            yield '前半段'
            client.delete(f'/api/v1/characters/{cid3}')
            yield '后半段'
        with patch.object(ModelClient,'chat_stream',deleting):r=client.post(f'/api/v1/characters/{cid3}/chat',json={'message':'删除角色测试'})
        with SessionLocal() as s:orphans=s.query(Message).filter(Message.character_id==cid3).count()
        record('character_delete_leaves_no_orphan_reply',orphans==0,{'orphan_rows':orphans,'sse_done':'event: done' in r.text})
        r=client.post(f'/api/v1/characters/{cid}/chat',json={})
        record('validation_error_contract','error' in r.json(),{'status':r.status_code,'top_level_keys':list(r.json())})
    import subprocess
    from app.models.models import Memory
    with SessionLocal() as s:
        s.add(Memory(character_id=cid,content='重启验收记忆'));s.commit()
        expected_messages=s.query(Message).filter(Message.character_id==cid).count()
    child_code="import sys,json;sys.path.insert(0,"+repr(str(Path(__file__).resolve().parents[6]/'backend'))+");from fastapi.testclient import TestClient;from app.main import app;\nwith TestClient(app) as c:\n print(json.dumps({'messages':len(c.get('/api/v1/characters/"+str(cid)+"/messages').json()),'memories':[m['content'] for m in c.get('/api/v1/characters/"+str(cid)+"/memories').json()]}))"
    child=subprocess.run([sys.executable,'-c',child_code],capture_output=True,text=True,check=True)
    restored=json.loads(child.stdout)
    record('history_and_memory_survive_new_process',restored['messages']==expected_messages and '重启验收记忆' in restored['memories'],{'expected_messages':expected_messages,'restored_messages':restored['messages'],'memory_restored':'重启验收记忆' in restored['memories']})
    settings=Settings(_env_file=None,model_api_key='test-key',model_base_url='https://example.invalid/v1',model_max_retries=1)
    class FakeResponse:
        def __init__(self,mode,attempt):self.mode,self.attempt=mode,attempt
        def __enter__(self):return self
        def __exit__(self,*args):return False
        def raise_for_status(self):pass
        def iter_lines(self):
            yield 'data: '+json.dumps({'choices':[{'delta':{'content':'前半'}}]})
            if self.mode=='timeout' and self.attempt==1:raise httpx.ReadTimeout('simulated')
            if self.mode=='timeout':yield 'data: [DONE]'
    class FakeClient:
        attempts=0;mode='eof'
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):return False
        def stream(self,*args,**kwargs):
            FakeClient.attempts+=1;return FakeResponse(self.mode,FakeClient.attempts)
    with patch.object(model_client,'get_settings',lambda:settings),patch.object(model_client.httpx,'Client',FakeClient):
        chunks=[];failed=False
        try:chunks=list(ModelClient().chat_stream([{'role':'user','content':'测试'}]))
        except ModelError:failed=True
        record('upstream_eof_without_done_is_failure',failed,{'raised_error':failed,'chunks':chunks})
        FakeClient.mode='timeout';FakeClient.attempts=0;chunks=[];failed=False
        try:
            for chunk in ModelClient().chat_stream([{'role':'user','content':'测试'}]):chunks.append(chunk)
        except ModelError:failed=True
        record('partial_stream_is_not_silently_retried',failed and FakeClient.attempts==1,{'raised_error':failed,'attempts':FakeClient.attempts,'joined_text':''.join(chunks)})
    output=Path(__file__).resolve().parents[6]/'docs/PRD/版本/V1.0/验收证据/阶段2-2/修复复验探针.json'
    output.write_text(json.dumps(results,ensure_ascii=False,indent=2))
    print(json.dumps(results,ensure_ascii=False))
