"""Read-only live website verification and public evidence for accepted scope."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import shutil
import sqlite3

from scripts.run_real_web import PROJECT, ROOT, DATA, ENDPOINT, save
from scripts.real_web_budget import Budget
from scripts.real_web_recovery import selected

EVIDENCE=PROJECT/'docs/PRD/版本/V1.2/验收证据/阶段3/四项验收续跑'
BASE_EVIDENCE=EVIDENCE
CHECKPOINT=ROOT/'acceptance/checkpoint.json'
NEW_ID=7
PHOTO=PROJECT/'docs/PRD/版本/V1.2/验收证据/阶段3/C1.74质量与稳定性/公开照片/plant_pothos.jpg'


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,default=lambda x:x.hex()).encode()).hexdigest()


def connect():
    db=sqlite3.connect((DATA/'check.db').as_uri()+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    return db


def snapshot():
    tables={}
    with connect() as db:
        integrity=db.execute('PRAGMA integrity_check').fetchone()[0]
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            quoted='"'+name.replace('"','""')+'"'
            rows=[dict(r) for r in db.execute('SELECT * FROM '+quoted)]
            if name=='sessions':
                rows=[{k:v for k,v in r.items() if k not in ('last_seen_at','expires_at')} for r in rows]
            rows.sort(key=lambda row:json.dumps(row,sort_keys=True,default=lambda x:x.hex()))
            tables[name]=dict(rows=len(rows),sha256=digest(rows))
    files={}
    candidates=[*DATA.glob('*.json')]
    for directory in ('uploads','ledger'):
        candidates.extend((DATA/directory).rglob('*'))
    for file in candidates:
        if file.is_file():
            if file.is_symlink() or not file.resolve().is_relative_to(DATA.resolve()):
                raise ValueError('Unsafe acceptance asset path')
            files[str(file.relative_to(DATA))]=hashlib.sha256(file.read_bytes()).hexdigest()
    return dict(tables=tables,files=files,sqlite_integrity=integrity,
        original_budget=Budget(ROOT,ENDPOINT).status(),active_budget=selected(ROOT,ENDPOINT).status())


def contract():
    with connect() as db:
        rows=[dict(r) for r in db.execute('SELECT c.id,c.name,c.persona,c.opening_line,c.image_path,c.status,c.object_id,'
            'o.photo_id,o.visual_features FROM characters c JOIN objects o ON o.id=c.object_id WHERE c.id IN (?,?) ORDER BY c.id',(6,NEW_ID))]
        if len(rows)!=2 or any(r['status']!='ready' for r in rows):
            raise ValueError('Both genuine characters must be ready')
        recreation=db.execute('SELECT source_id,character_id FROM recreations WHERE source_id=6 AND character_id=?',(NEW_ID,)).fetchall()
        messages=[dict(r) for r in db.execute('SELECT role,content FROM messages WHERE character_id=6 ORDER BY id')]
        charges=[dict(r) for r in db.execute('SELECT character_id,status FROM generation_charges WHERE character_id IN(?,?) ORDER BY character_id',(6,NEW_ID))]
        motions=[dict(r) for r in db.execute("SELECT character_id,'walk' AS activity,state,approval_ref FROM motion_generation_requests WHERE character_id IN(?,?) "
            'UNION ALL SELECT character_id,activity,state,approval_ref FROM motion_generation_activity_requests WHERE character_id IN(?,?) ORDER BY character_id,activity',(6,NEW_ID,6,NEW_ID))]
        photo_requests=[dict(r) for r in db.execute("SELECT digest,status FROM photo_requests WHERE photo_id=?",(rows[0]['photo_id'],))]
    expected_photo_sha=hashlib.sha256(PHOTO.read_bytes()).hexdigest()
    same_photo=(rows[0]['photo_id']==rows[1]['photo_id'] and rows[0]['visual_features']==rows[1]['visual_features']
        and len(recreation)==1 and any(r['digest']==expected_photo_sha and r['status']=='ready' for r in photo_requests))
    checks=dict(same_photo_and_features=same_photo,independent_character_and_object=rows[0]['object_id']!=rows[1]['object_id'],
        original_chat_preserved=any(r['role']=='user' for r in messages) and any(r['role']=='assistant' for r in messages),
        no_mock_reply=all('mock' not in r['content'].lower() for r in messages),
        two_business_charges=len(charges)==2 and all(r['status']=='spent' for r in charges),
        six_unapproved_motion_requests=len(motions)==6 and all(r['state']=='waiting_authorization' and not r['approval_ref'] for r in motions))
    for row in rows:
        file=(DATA/'uploads'/row['image_path']).resolve()
        if not file.is_relative_to((DATA/'uploads').resolve()) or not file.is_file():
            raise ValueError('Character asset must belong to this website')
        row['image_sha256']=hashlib.sha256(file.read_bytes()).hexdigest()
    checks['new_image_bytes']=rows[0]['image_sha256']!=rows[1]['image_sha256']
    review_file=EVIDENCE/'两次创作人工审阅.json'
    review=json.loads(review_file.read_text()) if review_file.exists() else {}
    review_status=review.get('status','pending')
    if review_status not in ('pending','accepted','rejected') or (review and review.get('characters')!=[6,NEW_ID]):
        raise ValueError('Human review must identify these two candidates')
    return dict(checks=checks,characters=rows,source_photo_sha256=expected_photo_sha,
        chat_message_count=len(messages),chat_sha256=digest(messages),motions=motions,charges=charges,
        human_visual_acceptance=review_status,source_photo_storage='原照片不保存；通过请求摘要、photo_id与特征文字核对同图')


def export_comparison(result):
    from PIL import Image, ImageDraw, ImageFont, ImageOps
    EVIDENCE.mkdir(parents=True,exist_ok=True)
    if EVIDENCE!=BASE_EVIDENCE:
        shutil.copyfile(BASE_EVIDENCE/'源照片许可.json',EVIDENCE/'源照片许可.json')
    credit=json.loads((EVIDENCE/'源照片许可.json').read_text())
    if credit['sha256']!=result['source_photo_sha256']:
        raise ValueError('Photo attribution must match the actual source')
    entries=[('源照片','同一张公开绿萝照片',PHOTO)]
    for row in result['characters']:
        target=EVIDENCE/f'真实伙伴-{row["id"]}.png'
        shutil.copyfile(DATA/'uploads'/row['image_path'],target)
        entries.append((row['name'],row['persona'],target))
    canvas=Image.new('RGB',(1500,650),'#fffaf1');draw=ImageDraw.Draw(canvas)
    font_path='/System/Library/Fonts/STHeiti Medium.ttc'
    font=ImageFont.truetype(font_path,28)
    small=ImageFont.truetype(font_path,20)
    cards=[]
    for i,(name,persona,file) in enumerate(entries):
        image=Image.open(file).convert('RGBA');image=ImageOps.contain(image,(460,460))
        canvas.paste(image,(i*500+(500-image.width)//2,60+(460-image.height)//2),image)
        draw.text((i*500+20,15),name,font=font,fill='#392a35')
        for line in range(3):draw.text((i*500+20,540+line*28),persona[line*22:(line+1)*22],font=small,fill='#392a35')
        cards.append(f'<article><h2>{html.escape(name)}</h2><img src="{html.escape(file.name)}" alt="{html.escape(name)}"><p>{html.escape(persona)}</p></article>')
    shutil.copyfile(PHOTO,EVIDENCE/PHOTO.name)
    draw.text((20,630),'Source: LucaLuca / Efeutute18.jpg (Wikimedia Commons), CC BY-SA 3.0. Resized and arranged; comparison CC BY-SA 3.0.',
        font=ImageFont.truetype(font_path,16),fill='#392a35')
    canvas.save(EVIDENCE/'同图两次真实创作对照.png')
    verdict={'pending':'待人工审阅','accepted':'人工已采用','rejected':'人工审阅未通过 · 待调整'}[result['human_visual_acceptance']]
    (EVIDENCE/'同图两次真实创作对照.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>同图两次真实创作</title><style>body{font:18px system-ui;background:#fffaf1;color:#392a35;margin:24px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}img{width:100%;object-fit:contain}article{background:white;padding:16px;border-radius:16px}@media(max-width:700px){main{grid-template-columns:1fr}}</style>'
        '<h1>同图两次真实创作 · '+verdict+'</h1><p>同一张绿萝照片，新名字、性格和形象；原伙伴及聊天保留。新动作未收费生成。哈希和工程核对不代替审图。</p><main>'+''.join(cards)
        +'</main><footer><p>源照片：LucaLuca，<a href="'+html.escape(credit['source_page'])+'">Efeutute18.jpg / Wikimedia Commons</a>，'
        '<a href="'+html.escape(credit['license_url'])+'">CC BY-SA 3.0</a>。原照片未修改，对照图缩放排版，按同一许可分享。</p></footer></html>',encoding='utf-8')


def main():
    global NEW_ID,EVIDENCE,CHECKPOINT
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['capture','verify','export','publish'])
    parser.add_argument('--new-id',type=int,default=7);args=parser.parse_args()
    NEW_ID=args.new_id
    if NEW_ID!=7:
        if NEW_ID<8:raise ValueError('Revision must identify a new candidate')
        EVIDENCE=BASE_EVIDENCE/f'造型差异修订-{NEW_ID}'
        CHECKPOINT=ROOT/f'acceptance/shape-{NEW_ID}-checkpoint.json'
    if args.mode=='capture':
        if CHECKPOINT.exists():raise FileExistsError('Never overwrite the pre-restart checkpoint')
        value=snapshot();save(CHECKPOINT,value)
        print(json.dumps(dict(status='captured',tables=len(value['tables']),files=len(value['files']))))
    elif args.mode=='verify':
        before=json.loads(CHECKPOINT.read_text());after=snapshot()
        checks={k:before[k]==after[k] for k in ('tables','files','original_budget','active_budget')}
        result=dict(status='verified' if all(checks.values()) and after['sqlite_integrity']=='ok' else 'failed',
            checks=checks,tables=len(after['tables']),files=len(after['files']),sqlite_integrity=after['sqlite_integrity'],
            excluded_session_fields=['last_seen_at','expires_at'],active_budget=after['active_budget'])
        save(EVIDENCE/'网页实际重启恢复.json',result);print(json.dumps(result))
    elif args.mode=='publish':
        target=ROOT/'frontend/public/acceptance-real-web'
        if NEW_ID!=7:target=target/f'shape-{NEW_ID}'
        target.mkdir(parents=True,exist_ok=True)
        for name in ('同图两次真实创作对照.html','同图两次真实创作对照.png','真实伙伴-6.png',f'真实伙伴-{NEW_ID}.png','plant_pothos.jpg','源照片许可.json'):
            shutil.copyfile(EVIDENCE/name,target/name)
        print(json.dumps(dict(url='http://127.0.0.1:3059/acceptance-real-web/'+(f'shape-{NEW_ID}/' if NEW_ID!=7 else '')+'同图两次真实创作对照.html'),ensure_ascii=False))
    else:
        result=contract()
        if not all(result['checks'].values()):raise ValueError('Live acceptance contract failed')
        with sqlite3.connect((ROOT/'recovery-1/model-budget.db').as_uri()+'?mode=ro',uri=True) as db:
            db.row_factory=sqlite3.Row
            result['model_calls']=[dict(r) for r in db.execute('SELECT kind,model,outcome,http_status,elapsed_ms FROM calls ORDER BY started_at')]
        result['budgets']=dict(original=Budget(ROOT,ENDPOINT).status(),recovery=selected(ROOT,ENDPOINT).status())
        export_comparison(result);save(EVIDENCE/'网页真实复验结构结果.json',result)
        print(json.dumps(dict(status='exported',checks=result['checks'],model_calls=len(result['model_calls'])),ensure_ascii=False))


if __name__=='__main__':main()
