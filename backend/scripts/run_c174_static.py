"""Six frozen real photographic cases; no automatic reruns or human scoring."""
import argparse
import fcntl
from html import escape
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Lock
import time

import httpx
from PIL import Image

from scripts import c174_batch as batch

ALIASES = {'object_mug': ('杯',), 'object_clock': ('钟',), 'object_apple': ('苹果',),
           'plant_pothos': ('绿萝', '盆栽', '植物'), 'repeat_pothos': ('绿萝', '盆栽', '植物'),
           'plant_succulent': ('多肉', '石莲', '盆栽', '植物')}


def run(continue_recreation=False):
    batch.authorization()
    batch.current_prices()
    root = batch.WORK/'static'
    root.mkdir(exist_ok=True)
    state_path = root/'state.json'
    with (root/'run.lock').open('a') as process_lock:
        fcntl.flock(process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(state_path.read_text()) if state_path.exists() else dict(
            status='running', origin='real_provider', cases=[], plan_sha256=batch.authorization()['plan_sha256'])
        reuse_facts = False
        if any(row['status'] != 'needs_review' for row in state['cases']):
            if not continue_recreation or len(state['cases']) != 6:
                raise ValueError('Earlier case is unresolved; no generation request is repeated')
            failed = state['cases'][-1]
            prior = state['cases'][3]
            with batch.connect() as db:
                attempts = db.execute('SELECT kind,outcome FROM calls WHERE operation LIKE ?',('repeat_pothos:%',)).fetchall()
            if (failed['case_id'] != 'repeat_pothos' or failed.get('error_type') != 'ParseError'
                or prior['case_id'] != 'plant_pothos' or prior['status'] != 'needs_review'
                or failed['source_sha256'] != prior['source_sha256']
                or len(attempts) != 1 or attempts[0]['kind'] != 'vision' or attempts[0]['outcome'] != 'succeeded'):
                raise ValueError('Same-photo continuation prerequisites are not met')
            state.setdefault('retained_failures',[]).append(dict(failed))
            state['cases'].pop(); reuse_facts = True
            state['status']='continuing_unstarted_recreation_steps';batch.save(state_path,state)
        if batch.status()['status'] != 'ready':
            raise ValueError('Batch has an unresolved paid result')
        os.environ['MODEL_MAX_RETRIES'] = '0'
        os.environ['UPLOAD_DIR'] = str(root/'uploads')
        from app.core.config import get_settings
        get_settings.cache_clear()
        settings = get_settings()
        if (settings.use_mock or settings.model_max_retries != 0 or settings.model_base_url.rstrip('/') != batch.BASE
            or (settings.image_base_url or settings.model_base_url).rstrip('/') != batch.BASE
            or (settings.vision_model, settings.chat_model, settings.image_model) !=
                ('ling-3.0-flash-vl','qwen3.8-flash','wan2.6-t2i')):
            raise ValueError('Production provider configuration differs from frozen batch')
        from app.services.model_client import ModelClient
        from app.services.photo_input import normalize_photo
        from app.services.character_generation import finish_character
        from scripts.prepare_quality_samples import OUTPUT
        inputs = json.loads((OUTPUT/'manifest.json').read_text())['cases']
        original_post = httpx.Client.post
        lock = Lock()
        active = {}

        def guarded_post(client, url, **kwargs):
            if str(url) not in (batch.BASE+'/chat/completions', batch.BASE+'/images/generations'):
                raise ValueError('Unexpected billable endpoint blocked')
            payload = kwargs.get('json', {})
            model = payload.get('model')
            kind = {'ling-3.0-flash-vl':'vision','qwen3.8-flash':'text','wan2.6-t2i':'image'}.get(model)
            if kind is None: raise ValueError('Unexpected model blocked')
            if kind == 'image':
                if payload.get('n') != 1 or payload.get('size') != '1024x1024':
                    raise ValueError('Image count or size changed')
            elif len(json.dumps(payload.get('messages'), ensure_ascii=False).encode()) > 1000000:
                raise ValueError('Input exceeds the approved conservative token envelope')
            with lock:
                active['kind_count'][kind] = active['kind_count'].get(kind, 0)+1
                operation = f"{active['case_id']}:{kind}:{active['kind_count'][kind]}"
                call_id = batch.claim(kind, operation)
                active['calls'].append(call_id)
            started = time.perf_counter()
            try:
                response = original_post(client, url, **kwargs)
                response.raise_for_status()
                data = response.json()
                usage = data.get('usage') or {}
                safe_usage = {k:int(v) for k,v in usage.items() if k in ('prompt_tokens','completion_tokens','total_tokens') and type(v) is int and v >= 0}
                upstream = response.headers.get('x-request-id') or data.get('request_id') or data.get('id')
                upstream = upstream if isinstance(upstream,str) and len(upstream)<200 else None
                detail = dict(model=model, case_id=active['case_id'], usage=safe_usage,
                    elapsed_ms=round((time.perf_counter()-started)*1000,3), provider_request_id=upstream,
                    cost_status='usage_estimate' if safe_usage else 'reserved_unreconciled')
                if safe_usage:
                    rates = (.14,.42) if kind=='vision' else (.8,2.7)
                    detail['estimated_cny'] = (safe_usage.get('prompt_tokens',0)*rates[0]+safe_usage.get('completion_tokens',0)*rates[1])/1000000
                if kind=='image': detail['estimated_cny'] = .016
                batch.settle(call_id, 'succeeded', detail)
                with lock:
                    active['receipts'][kind] = dict(call_id=call_id, provider_request_id=upstream,
                        request_id_source='upstream' if upstream else 'client_ledger', detail=detail)
                return response
            except Exception as exc:
                batch.settle(call_id, 'unknown', {'error_type': type(exc).__name__, 'model':model})
                raise

        httpx.Client.post = guarded_post
        try:
            for case in inputs[len(state['cases']):]:
                active.clear(); active.update(case_id=case['case_id'], calls=[], receipts={}, kind_count={})
                row = dict(case_id=case['case_id'], status='started', source_sha256=case['sha256'])
                state['cases'].append(row); batch.save(state_path,state)
                started = time.perf_counter()
                try:
                    raw = (OUTPUT/case['filename']).read_bytes()
                    if hashlib.sha256(raw).hexdigest() != case['sha256']:
                        raise ValueError('Photograph changed')
                    normalized = normalize_photo(raw)
                    if reuse_facts and case['case_id'] == 'repeat_pothos':
                        from app.services.parsers import RecognizedObject
                        previous_facts = state['cases'][3]
                        recognized = [RecognizedObject(label=previous_facts['label'],
                            visual_features=previous_facts['visual_features'],category='plant')]
                        row.update(recognition_origin='reused_identical_photo_facts',
                                   failed_vision_attempt_retained=True)
                    else:
                        recognized = ModelClient().recognize(normalized)
                    candidates = [obj for obj in recognized if any(word in obj.label for word in ALIASES[case['case_id']])]
                    if len(candidates) != 1:
                        row.update(recognized=[obj.label for obj in recognized])
                        raise ValueError('Target was missing or ambiguous; no label is forced')
                    obj = candidates[0]
                    persona = obj.concept
                    if case['case_id'] == 'repeat_pothos':
                        old = next(x for x in state['cases'] if x['case_id']=='plant_pothos')
                        previous = {'name':old['name'], 'persona':old['persona'], 'appearance_description':old['appearance_description']}
                        persona = ModelClient().generate_concept(obj.label,obj.visual_features,previous_character=previous)
                    elif persona is None:
                        persona = ModelClient().generate_concept(obj.label,obj.visual_features)
                    result, image_path = finish_character(ModelClient(),obj.label,persona,
                        'c174:'+case['case_id'],obj.visual_features)
                    image_file = Path(settings.upload_dir)/image_path
                    image_bytes = image_file.read_bytes()
                    with Image.open(BytesIO(image_bytes)) as image:
                        if image.format not in ('PNG','JPEG') or image.size != (1024,1024):
                            raise ValueError('Generated static image structure failed')
                        image.verify()
                    receipt = active['receipts']['image']
                    row.update(status='needs_review', label=obj.label, visual_features=obj.visual_features,
                        name=result.name, persona=result.persona, opening_line=result.opening_line,
                        appearance_description=persona.appearance_description,
                        normalized_source_sha256=hashlib.sha256(normalized).hexdigest(),
                        image_file=str(image_file.relative_to(batch.PROJECT)),
                        image_sha256=hashlib.sha256(image_bytes).hexdigest(),
                        elapsed_ms=round((time.perf_counter()-started)*1000,3),
                        image_call_id=receipt['call_id'],provider_request_id=receipt['provider_request_id'],
                        request_id_source=receipt['request_id_source'], calls=active['calls'])
                    batch.save(state_path,state)
                except Exception as exc:
                    row.update(status='failed',error_type=type(exc).__name__,calls=active['calls'])
                    state['status']='paused_failure'; batch.save(state_path,state)
                    raise
            state['status']='needs_review'; batch.save(state_path,state)
            export(state)
            return {**batch.status(), 'static_status':state['status'], 'cases':len(state['cases'])}
        finally:
            httpx.Client.post = original_post


def export(state):
    import shutil
    target = batch.EVIDENCE/'真实静态候选'
    target.mkdir(exist_ok=True)
    cards=[]
    for row in state['cases']:
        if row['status']!='needs_review': continue
        filename=row['case_id']+Path(row['image_file']).suffix
        shutil.copyfile(batch.PROJECT/row['image_file'],target/filename)
        cards.append(f'<article><h2>{escape(row["case_id"])} · {escape(row["name"])}</h2><img src="{escape(filename)}"><p>{escape(row["label"])}：{escape(row["visual_features"])}</p><p>{escape(row["persona"])}</p><p>{escape(row["opening_line"])}</p><p>耗时 {row["elapsed_ms"]/1000:.2f} 秒 · 待产品审图</p></article>')
    html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>C1.74真实静态候选</title><style>body{font:16px system-ui;margin:24px;background:#f6f7f3;color:#28392e}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}article{padding:18px;background:white;border-radius:12px}img{width:100%;height:280px;object-fit:contain}p{line-height:1.6}</style><h1>'+str(len(cards))+'个真实静态候选</h1><p>未判定质量通过，未制作动作或绑定。耗时不含浏览器；原8秒门槛单独待验。</p><main>'+''.join(cards)+'</main></html>'
    (target/'index.html').write_text(html,encoding='utf-8')
    batch.save(target/'候选摘要.json',state)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['status','prepare','execute','continue-recreation','launch','export','record-interrupted'],default='status',nargs='?')
    args=parser.parse_args()
    if args.mode=='prepare': value=batch.initialize()
    elif args.mode=='execute': value=run()
    elif args.mode=='continue-recreation': value=run(continue_recreation=True)
    elif args.mode=='launch':
        batch.authorization()
        root=batch.WORK/'static';root.mkdir(exist_ok=True)
        with (root/'run.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        temp=batch.WORK/'tmp';temp.mkdir(exist_ok=True)
        with (root/'process.log').open('a') as log:
            process=subprocess.Popen([sys.executable,'-m','scripts.run_c174_static','execute'],
                cwd=batch.PROJECT/'backend',env={**os.environ,'TMPDIR':str(temp)},
                stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        value={'status':'launched','pid':process.pid}
        batch.save(root/'process.json',value)
    elif args.mode=='record-interrupted':
        root=batch.WORK/'static'
        with (root/'run.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with batch.connect() as db:
                rows=db.execute("SELECT id,kind,operation FROM calls WHERE outcome='started'").fetchall()
            if len(rows)!=1 or rows[0]['operation']!='repeat_pothos:text:1':
                raise ValueError('Only the confirmed interrupted recreation may be recorded')
            batch.settle(rows[0]['id'],'unknown',{'error_type':'ExecutorInterrupted',
                'cost_status':'full_reservation_retained','automatic_retry':False})
            state=json.loads((root/'state.json').read_text())
            row=state['cases'][-1]
            if row['case_id']!='repeat_pothos' or row['status']!='started':
                raise ValueError('Interrupted case changed')
            row.update(status='failed',error_type='ExecutorInterrupted',calls=[rows[0]['id']])
            state['status']='paused_unknown';batch.save(root/'state.json',state);export(state)
        value=batch.status()
    elif args.mode=='export':
        state=json.loads((batch.WORK/'static/state.json').read_text());export(state);value={'status':state['status']}
    else: value=batch.status()
    print(json.dumps(value,ensure_ascii=False))


if __name__=='__main__':
    try: main()
    except Exception as exc:
        # Upstream errors are kept as safe types, never response bodies or keys.
        print(json.dumps({'status':'stopped','error_type':type(exc).__name__}));sys.exit(1)
