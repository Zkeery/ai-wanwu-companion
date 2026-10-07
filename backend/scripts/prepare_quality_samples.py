"""Freeze public photographic inputs for C1.74. No model calls or credentials."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from html import escape, unescape
from io import BytesIO
import json
from pathlib import Path
import re
from urllib.parse import urlsplit, quote

import httpx
from PIL import Image

PROJECT = Path(__file__).resolve().parents[2]
OUTPUT = PROJECT / 'docs/PRD/版本/V1.2/验收证据/阶段3/C1.74质量与稳定性/公开照片'
SAMPLES = (
    ('object_mug', '杯子', 'File:White-blue mug.jpg', '把手、杯口与主体轮廓'),
    ('object_clock', '闹钟', 'File:Alarm clock from IKEA store.jpg', '薄部件、刻度与文字'),
    ('object_apple', '苹果', 'File:Red Apple.jpg', '果柄、光滑主体与色彩'),
    ('plant_pothos', '绿萝', 'File:Efeutute18.jpg', '多叶、藤蔓与盆体'),
    ('plant_succulent', '多肉', 'File:Echeveria on white background.jpg', '密集叶片、遮挡与盆体'),
)
HEADERS = {'User-Agent': 'AIWanWuCompanionQuality/1.0 (local photographic evaluation; no model calls)'}


def plain(value):
    return unescape(re.sub(r'<[^>]*>', '', value or '')).strip()


def fetch_bytes(client, url, maximum, hosts):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.username or parsed.password:
        raise ValueError('Unexpected public media origin')
    with client.stream('GET', url) as response:
        response.raise_for_status()
        content = bytearray()
        for chunk in response.iter_bytes():
            content.extend(chunk)
            if len(content) > maximum:
                raise ValueError('Public media response exceeded its size limit')
        return bytes(content)


def download(sample, info):
    case_id, label, title, risk = sample
    with httpx.Client(timeout=30, trust_env=False, follow_redirects=False, headers=HEADERS) as client:
        data = fetch_bytes(client, info['thumburl'], 6*1024*1024,
                           {'upload.wikimedia.org', 'thumb.wikimedia.org'})
    with Image.open(BytesIO(data)) as image:
        if image.format not in {'JPEG', 'PNG'} or max(image.size) > 2048 or image.size != (info['thumbwidth'], info['thumbheight']):
            raise ValueError('Unexpected photo format or dimensions')
        image.verify()
        suffix = '.jpg' if image.format == 'JPEG' else '.png'
        dimensions = image.size
    metadata = info['extmetadata']
    license_name = plain(metadata['LicenseShortName']['value'])
    if license_name not in {'CC BY 2.0', 'CC BY-SA 3.0', 'CC BY-SA 4.0'}:
        raise ValueError('Public photo license changed; review before using it')
    row = dict(case_id=case_id, label=label, risk=risk, filename=case_id+suffix,
               source_title=title, source_page='https://commons.wikimedia.org/wiki/'+quote(title.replace(' ', '_')),
               downloaded_url=info['thumburl'], artist=plain(metadata['Artist']['value']),
               license=license_name, license_url=plain(metadata['LicenseUrl']['value']),
               transformation='Wikimedia 960px thumbnail; no local pixel edits',
               width=dimensions[0], height=dimensions[1], bytes=len(data),
               sha256=hashlib.sha256(data).hexdigest(), evidence_origin='public_photograph',
               review='NEED_REVIEW')
    return row, data


def prepare():
    # Never overwrite a frozen input set, even if a prior download failed.
    OUTPUT.mkdir(parents=True, exist_ok=False)
    api = 'https://commons.wikimedia.org/w/api.php'
    try:
        with httpx.Client(timeout=30, trust_env=False, follow_redirects=False, headers=HEADERS) as client:
            response = client.get(api, params=dict(action='query', format='json', prop='imageinfo',
                iiprop='url|extmetadata|size', iiurlwidth=960, titles='|'.join(x[2] for x in SAMPLES)))
            response.raise_for_status()
            if len(response.content) > 2*1024*1024:
                raise ValueError('Metadata too large')
            pages = response.json()['query']['pages'].values()
            lookup = {p['title']: p['imageinfo'][0] for p in pages}
        # Independent public downloads; credentials are never used.
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda sample: download(sample, lookup[sample[2]]), SAMPLES))
        rows = []
        for row, data in results:
            (OUTPUT/row['filename']).write_bytes(data)
            rows.append(row)
        repeat = dict(next(row for row in rows if row['case_id'] == 'plant_pothos'))
        repeat.update(case_id='repeat_pothos', repeat_of='plant_pothos',
                      risk='同一照片独立再创作；同操作恢复不重复生成')
        manifest = dict(schema_version=1, fetched_at=datetime.now(timezone.utc).isoformat(),
                        provider_requests=0, cost=0, cases=rows+[repeat])
        (OUTPUT/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        cards = ''.join(f'<article><h2>{escape(row["label"])}</h2><img src="{escape(row["filename"])}" alt="{escape(row["label"])}真实照片"><p>{escape(row["risk"])}</p><p>{escape(row["artist"])} · <a href="{escape(row["license_url"])}">{escape(row["license"])}</a> · <a href="{escape(row["source_page"])}">原始来源</a></p></article>' for row in rows)
        html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>C1.74真实输入照片</title><style>body{font:16px system-ui;background:#f6f7f3;margin:24px;color:#28392e}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px}article{background:white;padding:18px;border-radius:12px}img{width:100%;height:240px;object-fit:contain}p{line-height:1.6;font-size:14px}a{color:#316543}</style><h1>质量验证 · 五类真实照片</h1><p>3类物品＋2类植物；绿萝同图再创作，共6个case。当前只准备输入，未调用模型，未判定质量通过。</p><main>'+cards+'</main></html>'
        (OUTPUT/'index.html').write_text(html, encoding='utf-8')
        return dict(status='prepared', cases=6, photographs=5, provider_requests=0, output=str(OUTPUT))
    except Exception as exc:
        (OUTPUT/'failure.json').write_text(json.dumps({'status':'failed','error_type':type(exc).__name__}), encoding='utf-8')
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch-public-photos', action='store_true')
    args = parser.parse_args()
    value = prepare() if args.fetch_public_photos else dict(status='plan', photographs=5,
        cases=6, provider_requests=0, output=str(OUTPUT), sources=[s[2] for s in SAMPLES])
    print(json.dumps(value, ensure_ascii=False))


if __name__ == '__main__':
    main()
