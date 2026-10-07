"""Single explicitly approved same-photo continuation; old unknown is never retried."""
import argparse
import fcntl
import hashlib
from html import escape
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import httpx
from PIL import Image

from scripts import c174_batch as batch

ROOT = batch.WORK/'recreation-manual-1'


def source_facts():
    state = json.loads((batch.WORK/'static/state.json').read_text())
    rows = {row['case_id']:row for row in state['cases']}
    old, failed = rows['plant_pothos'], rows['repeat_pothos']
    if (old['status'] != 'needs_review' or failed.get('error_type') != 'ExecutorInterrupted'
        or failed['source_sha256'] != old['source_sha256']):
        raise ValueError('Original same-photo state changed')
    from scripts.prepare_quality_samples import OUTPUT
    inputs = json.loads((OUTPUT/'manifest.json').read_text())['cases']
    sources = {row['case_id']:row for row in inputs}
    for case in ('plant_pothos','repeat_pothos'):
        source = sources[case]
        if hashlib.sha256((OUTPUT/source['filename']).read_bytes()).hexdigest() != old['source_sha256']:
            raise ValueError('Same photograph changed')
    if hashlib.sha256((batch.PROJECT/old['image_file']).read_bytes()).hexdigest() != old['image_sha256']:
        raise ValueError('Previously adopted character pixels changed')
    return old


def prepare():
    batch.authorization()
    old = source_facts()
    with batch.connect() as db:
        unknown = db.execute("SELECT id FROM calls WHERE operation='repeat_pothos:text:1' AND outcome='unknown'").fetchone()
        prior = db.execute('SELECT count(*) FROM calls WHERE operation LIKE ?', (batch.MANUAL_PREFIX+':%',)).fetchone()[0]
    if not unknown or prior: raise ValueError('Manual continuation already attempted or original changed')
    ROOT.mkdir(exist_ok=False)
    (ROOT/'uploads').mkdir()
    batch.save(ROOT/'source.json',old)
    state = {'status':'prepared','case_id':'repeat_pothos','origin':'real_provider',
             'recognition_origin':'reused_identical_photo_facts','source_sha256':old['source_sha256'],
             'unknown_call_id':unknown['id'],'source_snapshot_sha256':batch.fingerprint(old),
             'automatic_retries':0,'max_text_requests':1,'max_image_requests':1,'calls':[]}
    batch.save(ROOT/'state.json',state)
    return {'status':'prepared','additional_model_requests':0,'manual_confirmation_required':True}


def run():
    grant = batch.manual_recreation_authorization()
    batch.current_prices()
    with (ROOT/'run.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state = json.loads((ROOT/'state.json').read_text())
        if state['status'] != 'prepared': raise ValueError('Already attempted; never automatically retry')
        old = source_facts()
        if (batch.fingerprint(old) != state['source_snapshot_sha256']
            or grant['unknown_call_id'] != state['unknown_call_id']):
            raise ValueError('Approved original character changed')
        os.environ.update(MODEL_MAX_RETRIES='0',UPLOAD_DIR=str(ROOT/'uploads'))
        from app.core.config import get_settings
        get_settings.cache_clear()
        settings = get_settings()
        if (settings.use_mock or settings.model_max_retries != 0
            or settings.model_base_url.rstrip('/') != batch.BASE
            or (settings.image_base_url or settings.model_base_url).rstrip('/') != batch.BASE
            or (settings.chat_model,settings.image_model) != ('qwen3.8-flash','wan2.6-t2i')):
            raise ValueError('Frozen production model configuration changed')
        from app.services.model_client import ModelClient
        from app.services.character_generation import finish_character
        before = batch.status()['provider_requests']
        state.update(status='running',started_at=int(time.time()),authorization_ref=grant['authorization_ref'])
        batch.save(ROOT/'state.json',state)
        original_post = httpx.Client.post
        counters = {}

        def guarded_post(client,url,**kwargs):
            payload=kwargs.get('json',{})
            model=payload.get('model')
            kind={'qwen3.8-flash':'text','wan2.6-t2i':'image'}.get(model)
            expected=batch.BASE+('/chat/completions' if kind=='text' else '/images/generations')
            if kind is None or str(url)!=expected: raise ValueError('Unexpected paid request blocked')
            if kind=='image' and (payload.get('n')!=1 or payload.get('size')!='1024x1024'):
                raise ValueError('Unexpected image count or size')
            if kind=='text' and len(json.dumps(payload.get('messages'),ensure_ascii=False).encode())>1000000:
                raise ValueError('Approved input envelope exceeded')
            counters[kind]=counters.get(kind,0)+1
            operation=f'{batch.MANUAL_PREFIX}:{kind}:{counters[kind]}'
            call=batch.claim(kind,operation,continuation=batch.MANUAL_REF)
            state['calls'].append(call);batch.save(ROOT/'state.json',state)
            settled=False
            try:
                response=original_post(client,url,**kwargs)
                response.raise_for_status()
                data=response.json()
                # Private durable output before parsing; never headers or request content.
                batch.save(ROOT/(kind+'-response.json'),{k:data[k] for k in
                    ('id','request_id','model','usage','choices','data') if k in data})
                usage={k:v for k,v in (data.get('usage') or {}).items()
                       if k in ('prompt_tokens','completion_tokens','total_tokens') and type(v) is int and v>=0}
                upstream=response.headers.get('x-request-id') or data.get('request_id') or data.get('id')
                if not isinstance(upstream,str) or len(upstream)>200: upstream=None
                detail={'model':model,'usage':usage,'provider_request_id':upstream,
                        'cost_status':'usage_estimate' if usage or kind=='image' else 'full_reservation_retained'}
                if usage: detail['estimated_cny']=(usage.get('prompt_tokens',0)*.8+usage.get('completion_tokens',0)*2.7)/1000000
                if kind=='image': detail['estimated_cny']=.016
                batch.settle(call,'succeeded',detail);settled=True
                state.setdefault('receipts',{})[kind]={'call_id':call,'provider_request_id':upstream,
                    'response_sha256':hashlib.sha256((ROOT/(kind+'-response.json')).read_bytes()).hexdigest()}
                batch.save(ROOT/'state.json',state)
                return response
            except Exception as exc:
                if not settled: batch.settle(call,'unknown',{'error_type':type(exc).__name__,'cost_status':'full_reservation_retained'})
                raise

        httpx.Client.post=guarded_post
        try:
            started=time.perf_counter()
            previous={k:old[k] for k in ('name','persona','appearance_description')}
            persona=ModelClient().generate_concept(old['label'],old['visual_features'],previous_character=previous)
            if persona.opening_line is None or persona.name==old['name'] or persona.persona==old['persona']:
                raise ValueError('Independent complete character profile required')
            batch.save(ROOT/'concept.json',{'name':persona.name,'persona':persona.persona,
                'opening_line':persona.opening_line,'appearance_description':persona.appearance_description})
            result,image_path=finish_character(ModelClient(),old['label'],persona,
                'c174:repeat_pothos:manual-1',old['visual_features'])
            file=Path(settings.upload_dir)/image_path
            raw=file.read_bytes()
            with Image.open(BytesIO(raw)) as image:
                if image.format not in ('PNG','JPEG') or image.size!=(1024,1024): raise ValueError('Static image structure failed')
                image.verify()
            state.update(status='needs_review',name=result.name,persona=result.persona,
                opening_line=result.opening_line,appearance_description=persona.appearance_description,
                image_file=str(file.relative_to(batch.PROJECT)),image_sha256=hashlib.sha256(raw).hexdigest(),
                elapsed_ms=round((time.perf_counter()-started)*1000,3),
                provider_requests_before=before,provider_requests_after=batch.status()['provider_requests'])
            batch.save(ROOT/'state.json',state)
            export(state,old)
        except Exception as exc:
            state.update(status='paused_failure',error_type=type(exc).__name__)
            batch.save(ROOT/'state.json',state)
            raise
        finally: httpx.Client.post=original_post
    return {'status':state['status'],'additional_model_requests':batch.status()['provider_requests']-before,
            'image_sha256':state.get('image_sha256')}


def export(state,old):
    target=batch.EVIDENCE/'同图再创作候选'
    target.mkdir(exist_ok=True)
    cards=[]
    for title,row,name in [('已采用的原伙伴',old,'original'),('待采用的新伙伴',state,'recreated')]:
        filename=name+Path(row['image_file']).suffix
        shutil.copyfile(batch.PROJECT/row['image_file'],target/filename)
        cards.append(f'<article><h2>{title} · {escape(row["name"])}</h2><img src="{filename}" alt="{escape(row["name"])}"><p>{escape(row["persona"])}</p><p>{escape(row["opening_line"])}</p></article>')
    html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>同图独立再创作</title><style>body{font:16px system-ui;margin:24px;background:#f6f7f3;color:#28392e}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}article{background:white;padding:20px;border-radius:16px}img{width:100%;max-height:520px;object-fit:contain}p{line-height:1.7}</style><h1>同一张绿萝照片，两位独立伙伴</h1><p>原伙伴保持。新伙伴待用户审图采用，尚未制作或绑定动作。未知原请求费用预留保持。</p><main>'+''.join(cards)+'</main></html>'
    (target/'index.html').write_text(html,encoding='utf-8')
    batch.save(target/'候选摘要.json',state)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['prepare','status','launch','run'],nargs='?',default='status')
    mode=parser.parse_args().mode
    if mode=='prepare': value=prepare()
    elif mode=='run': value=run()
    elif mode=='launch':
        batch.manual_recreation_authorization()
        with (ROOT/'run.lock').open('a') as lock: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if json.loads((ROOT/'state.json').read_text())['status']!='prepared': raise ValueError('Already attempted')
        with (ROOT/'launch.json').open('x') as marker: json.dump({'reserved':True},marker)
        with (ROOT/'process.log').open('a') as log:
            process=subprocess.Popen([sys.executable,'-m','scripts.run_c174_recreation','run'],
                cwd=batch.PROJECT/'backend',env=os.environ.copy(),stdin=subprocess.DEVNULL,
                stdout=log,stderr=log,start_new_session=True)
        value={'status':'launched','pid':process.pid};batch.save(ROOT/'process.json',value)
    else:
        value=json.loads((ROOT/'state.json').read_text()) if (ROOT/'state.json').exists() else {'status':'not_prepared'}
    print(json.dumps(value,ensure_ascii=False))


if __name__=='__main__':
    try: main()
    except Exception as exc:
        print(json.dumps({'status':'stopped','error_type':type(exc).__name__}));sys.exit(1)
