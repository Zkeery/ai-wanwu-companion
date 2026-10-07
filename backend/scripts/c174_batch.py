"""Shared durable C1.74 cost/count guard. No paid calls at import time."""
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

import httpx

from scripts.check_quality_evidence import source_plan, fingerprint

PROJECT = Path(__file__).resolve().parents[2]
WORK = PROJECT/'.runtime/c174-real-quality-life'
EVIDENCE = PROJECT/'docs/PRD/版本/V1.2/验收证据/阶段3/C1.74质量与稳定性'
AUTH = EVIDENCE/'本次授权.json'
BASE = 'https://maas-api.antdigital.com/v1'
CATALOG = 'https://maas.antdigital.com/api/v1/model-service/public/page-list'
LIMITS = {'vision': (6, 200000, 0), 'image': (6, 16000, 0),
          'text': (6, 1145600, 0), 'private': (4, 1145600, 0),
          'shared': (4, 1145600, 0), 'motion': (18, 0, 111111)}
CHAINS = {'vision': 'static', 'image': 'static', 'text': 'static',
          'private': 'life', 'shared': 'life', 'motion': 'motion'}


def save(path, value):
    temp = path.with_name(path.name+'.'+uuid4().hex+'.tmp')
    with temp.open('w', encoding='utf-8') as file:
        os.chmod(temp, 0o600)
        json.dump(value, file, ensure_ascii=False, allow_nan=False, indent=2)
        file.flush(); os.fsync(file.fileno())
    temp.replace(path)


def authorization():
    value = json.loads(AUTH.read_text(encoding='utf-8'))
    if (value['authorization_ref'] != 'c174-20261001-user-approved-20cny-2usd'
        or value['user_reply'] != '可以' or value['budget_cny'] != 20 or value['budget_usd'] != 2
        or value['automatic_retries'] != 0 or value['plan_sha256'] != fingerprint(source_plan())
        or value['static_generations'] != 6 or value['motion_requests_max'] != 18
        or value['life_requests_max'] != 8 or value['real_life_duration_seconds'] != 86400):
        raise ValueError('C1.74 authorization or frozen plan changed')
    return value


def initialize():
    auth = authorization()
    WORK.mkdir(parents=True, exist_ok=False)
    with sqlite3.connect(WORK/'guard.db') as db:
        db.execute('CREATE TABLE approval (digest TEXT NOT NULL, ref TEXT NOT NULL)')
        db.execute('INSERT INTO approval VALUES (?,?)', (fingerprint(auth), auth['authorization_ref']))
        db.execute('''CREATE TABLE calls (id TEXT PRIMARY KEY, kind TEXT NOT NULL,
            operation TEXT UNIQUE NOT NULL, cny_micro INTEGER NOT NULL,
            usd_micro INTEGER NOT NULL, started_at INTEGER NOT NULL,
            outcome TEXT NOT NULL, detail TEXT NOT NULL)''')
    save(WORK/'batch.json', dict(status='prepared', approved_on=auth['approved_on'],
        authorization_ref=auth['authorization_ref'], plan_sha256=auth['plan_sha256'],
        evidence_origin='real_provider', automatic_retries=0))
    return status()


def connect():
    if not (WORK/'guard.db').is_file():
        raise ValueError('Initialize a fresh approved batch first; never recreate a missing ledger')
    db = sqlite3.connect(WORK/'guard.db', timeout=30)
    db.row_factory = sqlite3.Row
    if db.execute('SELECT digest FROM approval').fetchone()[0] != fingerprint(authorization()):
        db.close()
        raise ValueError('Durable approval does not match')
    return db


MANUAL_REF = 'c174-20261002-recreation-manual-1'
MANUAL_PREFIX = 'repeat_pothos:manual-1'


def manual_recreation_authorization():
    """The original unknown remains reserved; a new explicit grant is required."""
    original = authorization()
    value = json.loads((EVIDENCE/'同图再创作手动续跑确认.json').read_text(encoding='utf-8'))
    proof_path = EVIDENCE/'再创作中断平台回执.json'
    proof = json.loads(proof_path.read_text(encoding='utf-8'))
    if (value.get('authorization_ref') != MANUAL_REF
        or value.get('original_authorization_ref') != original['authorization_ref']
        or value.get('plan_sha256') != original['plan_sha256']
        or not isinstance(value.get('user_reply'), str) or not value['user_reply'].strip()
        or value.get('manual_attempt_confirmed') is not True
        or value.get('retain_unknown_reservation') is not True
        or value.get('text_requests_max') != 1 or value.get('image_requests_max') != 1
        or value.get('automatic_retries') != 0
        or value.get('budget_cny') != 20 or value.get('budget_usd') != 2
        or value.get('receipt_sha256') != hashlib.sha256(proof_path.read_bytes()).hexdigest()
        or value.get('unknown_call_id') != proof.get('ledger_call_id')
        or proof.get('operation') != 'repeat_pothos:text:1'
        or proof.get('response_code_source') != 'downstream_remote_disconnect'
        or proof.get('actual_bill_verified') is not False):
        raise ValueError('Manual recreation confirmation or platform receipt changed')
    return value


def claim(kind, operation, *, continuation=None):
    if kind not in LIMITS:
        raise ValueError('Unknown paid call type')
    maximum, cny, usd = LIMITS[kind]
    grant = None
    if continuation is not None:
        grant = manual_recreation_authorization()
        if (continuation != MANUAL_REF or kind not in ('text', 'image')
            or operation != f'{MANUAL_PREFIX}:{kind}:1'):
            raise ValueError('Manual grant is restricted to one text and one image')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        unresolved = db.execute("SELECT id,kind,operation FROM calls WHERE outcome='unknown'").fetchall()
        chain_unknowns = [row for row in unresolved if CHAINS[row['kind']] == CHAINS[kind]]
        if grant:
            if (len(chain_unknowns) != 1 or chain_unknowns[0]['id'] != grant['unknown_call_id']
                or chain_unknowns[0]['operation'] != 'repeat_pothos:text:1'):
                raise ValueError('Manual continuation has an additional unresolved result')
            db.execute('CREATE TABLE IF NOT EXISTS manual_continuations (ref TEXT PRIMARY KEY, digest TEXT NOT NULL)')
            digest = fingerprint(grant)
            existing = db.execute('SELECT digest FROM manual_continuations WHERE ref=?',(continuation,)).fetchone()
            if existing and existing['digest'] != digest:
                raise ValueError('Durable manual confirmation changed')
            db.execute('INSERT OR IGNORE INTO manual_continuations VALUES (?,?)',(continuation,digest))
            if kind == 'image':
                previous = db.execute('SELECT outcome FROM calls WHERE operation=?',
                    (f'{MANUAL_PREFIX}:text:1',)).fetchone()
                if not previous or previous['outcome'] != 'succeeded':
                    raise ValueError('Manual text must finish before the image')
        elif chain_unknowns:
            raise ValueError('An earlier paid result is unresolved; this chain is paused')
        count = db.execute('SELECT count(*) FROM calls WHERE kind=?', (kind,)).fetchone()[0]
        used = db.execute('SELECT coalesce(sum(cny_micro),0),coalesce(sum(usd_micro),0) FROM calls').fetchone()
        if count >= maximum or used[0]+cny > 20000000 or used[1]+usd > 2000000:
            raise ValueError('Frozen call count or budget reached')
        call_id = str(uuid4())
        db.execute('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)',
                   (call_id, kind, operation, cny, usd, int(time.time()), 'started', '{}'))
    return call_id


def settle(call_id, outcome, detail):
    if outcome not in ('succeeded', 'unknown'):
        raise ValueError('Invalid settlement state')
    # Callers pass only allowlisted summaries, never request bodies or headers.
    with connect() as db:
        if db.execute('UPDATE calls SET outcome=?,detail=? WHERE id=? AND outcome=?',
            (outcome, json.dumps(detail, ensure_ascii=False, allow_nan=False), call_id, 'started')).rowcount != 1:
            raise ValueError('Paid call was already settled or is missing')


def status():
    if not (WORK/'guard.db').is_file():
        return dict(status='not_prepared', provider_requests=0)
    with connect() as db:
        rows = db.execute('SELECT * FROM calls ORDER BY started_at,id').fetchall()
    return dict(status='paused_unknown' if any(r['outcome'] == 'unknown' for r in rows) else 'busy' if any(r['outcome']=='started' for r in rows) else 'ready',
        provider_requests=len(rows), counts={k: sum(r['kind']==k for r in rows) for k in LIMITS},
        reserved_cny=sum(r['cny_micro'] for r in rows)/1000000,
        reserved_usd=sum(r['usd_micro'] for r in rows)/1000000,
        unknown_results=sum(r['outcome'] == 'unknown' for r in rows),
        in_flight=sum(r['outcome'] == 'started' for r in rows))


def current_prices():
    with httpx.Client(timeout=15, trust_env=False, follow_redirects=False) as client:
        response = client.get(CATALOG)
        response.raise_for_status()
        data = response.json()
    if data.get('success') is not True:
        raise ValueError('Pricing unavailable')
    expected = {'ling-3.0-flash-vl': {'INPUT': '.14', 'OUTPUT': '.42'},
                'qwen3.8-flash': {'INPUT': '.8', 'OUTPUT': '2.7'},
                'wan2.6-t2i': {'GENERATED_COUNT': '.016'}}
    result = {}
    for name, ceiling in expected.items():
        models = [m for m in data['data']['items'] if m['name'] == name]
        if len(models) != 1 or models[0]['status'] != 'RELEASED' or models[0]['offShelfFlag'] != 0:
            raise ValueError('Frozen model is unavailable')
        model = models[0]
        for tier in model['priceInfo']['prices']:
            if tier['priceCurrency'] != 'CNY': raise ValueError('Unexpected currency')
            for code, cap in ceiling.items():
                prices = [x for x in tier['price'] if x['priceCode'] == code]
                if len(prices) != 1 or not Decimal('0') <= Decimal(prices[0]['priceValue']) <= Decimal(cap):
                    raise ValueError('Price exceeds approved reservation')
                if prices[0]['unitCode'] != ('PIECE' if code == 'GENERATED_COUNT' else 'M_TOKENS'):
                    raise ValueError('Price unit changed')
        result[name] = ceiling
    # Provider's official model card: 256K context, even separately charging
    # 256K input and 256K output costs .14680064 CNY, below the .20 reservation.
    assert (Decimal('.14')+Decimal('.42'))*262144/1000000 < Decimal('.20')
    result['vision_bound_reference'] = 'https://huggingface.co/inclusionAI/Ling-3.0-flash-VL'
    result['verified_at'] = datetime.now(timezone.utc).isoformat()
    save(WORK/'current-prices.json', result)
    return result
