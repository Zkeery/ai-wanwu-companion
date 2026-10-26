"""Free end-to-end wiring only. All network connects are forbidden."""
import copy
import hashlib
import json
import sqlite3
import subprocess
import time
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select

from app.core.config import Settings
from app.core.database import engine, SessionLocal
from app.models.models import MotionPreparationTask, CharacterActivityMotionAsset
from app.services import voice_sessions
from app.services.character_motion_video import prepare_character_videos, ACTIVITIES
from app.services.daily_model_quota import DailyModelQuota
from app.services.motion_bindings import MotionBindingError
from app.services.motion_preparation import process_one
from app.services.trial_admission import live_evidence_reader, validate_evidence
from app.services.trial_gate import TrialGate, TrialBlocked, PRICE_CAPS, PROFILES
from app.services.voice_acceptance_setup import plan, prepare, policy_for
from app.services.trial_wiring import TrialVoiceService, BASE_URL
from app.services.trial_transport import TEXT_URL
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_private_motion import pack  # noqa: F401
from tests.test_voice import wav
from tests.test_qwen_flash_speech import source_wav
from tests.test_trial_guards import text_result

KEY = 'synthetic-key-never-real'


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def deny(*_a, **_k):
        raise AssertionError('NETWORK_FORBIDDEN')
    monkeypatch.setattr('socket.socket.connect', deny)
    monkeypatch.setattr('socket.socket.connect_ex', deny)
    monkeypatch.setattr('app.services.voice.local_voices', lambda: [])
    monkeypatch.setattr('app.services.voice_acceptance_setup.transcription_status', lambda _p: 'configured')


def inputs(cid, mode='voice'):
    now = int(time.time())
    ref = 'free-fixture-' + uuid4().hex
    a = {'approved_for_real_model_calls': True, 'phase': 'voice_one_round',
         'max_rounds': 1, 'budget_micro': 1200000, 'automatic_retries': 0,
         'authorization_ref': ref, 'owner_id': UID, 'character_id': cid,
         'credentials_sha256': {v: hashlib.sha256(KEY.encode()).hexdigest() for v in ('maas', 'bailian')}}
    kinds = ('voice_text', 'voice_tts')
    if mode == 'life':
        a = {'approved_for_real_model_calls': True, 'phase': 'life_24h',
             'budget_micro': 7000000, 'max_requests': 6, 'per_group': 3, 'seconds': 86400,
             'authorization_ref': ref, 'private_character_id': 6, 'shared_character_ids': [6, 8]}
        kinds = ('private_life', 'shared_life')
    e = {}
    for kind in kinds:
        vendor, model, _ = PROFILES[kind]
        common = {'verified': True, 'authorization_ref': ref, 'vendor': vendor,
                  'currency': 'CNY', 'checked_at': now}
        e[kind] = {'wallet': {**common, 'account': 'fixture-' + vendor, 'available_micro': 7000000,
                              'pending_micro': 0, 'pending_complete': True, 'source_type': 'official_console'},
                   'price': {**common, 'model': model, 'on_sale': True, 'rates': PRICE_CAPS[vendor].copy()}}
    s = Settings(_env_file=None, app_env='development', model_api_key=KEY,
                 model_base_url=BASE_URL, chat_model='qwen3.8-flash',
                 model_max_retries=0, voice_live_reply_enabled=False)
    return a, e, s, now


def test_voice_plan_is_explicit_read_only(ready_character_id):
    before = []
    from sqlalchemy import event
    def observe(_c, _cur, statement, _p, _ctx, _many):
        before.append(statement.strip().split()[0])
    event.listen(engine, 'before_cursor_execute', observe)
    try:
        assert plan(engine, UID, ready_character_id)['max_rounds'] == 1
        assert before == ['SELECT']
        with pytest.raises(TrialBlocked):
            plan(engine, 'other', ready_character_id)
    finally:
        event.remove(engine, 'before_cursor_execute', observe)


@pytest.mark.parametrize('change', ['pending_unknown', 'pending_null', 'stale', 'future', 'balance',
    'price', 'off_sale', 'model', 'bool', 'wrong_ref', 'wallet_source', 'two_rounds', 'key', 'target'])
def test_voice_invalid_inputs_create_no_files_or_session(tmp_path, ready_character_id, change):
    a, e, s, now = inputs(ready_character_id)
    w, p = e['voice_text']['wallet'], e['voice_text']['price']
    if change == 'pending_unknown': w['pending_complete'] = False
    elif change == 'pending_null': w['pending_micro'] = None
    elif change == 'stale': w['checked_at'] -= 901
    elif change == 'future': w['checked_at'] += 1
    elif change == 'balance': w['available_micro'] = 1
    elif change == 'price': p['rates']['input_per_million'] += 1
    elif change == 'off_sale': p['on_sale'] = False
    elif change == 'model': p['model'] = 'unapproved-model'
    elif change == 'bool': w['available_micro'] = True
    elif change == 'wrong_ref': w['authorization_ref'] = 'wrong-approval'
    elif change == 'wallet_source': w['source_type'] = 'token_counter'
    elif change == 'two_rounds': a['max_rounds'] = 2
    elif change == 'key': a['credentials_sha256']['maas'] = '0' * 64
    elif change == 'target': a['owner_id'] = 'other-owner'
    q = DailyModelQuota(tmp_path / 'daily.db', 30)
    target = tmp_path / 'attempt'
    with pytest.raises(TrialBlocked):
        prepare(engine, s, q, KEY, a, e, target, clock=lambda: now)
    assert not target.exists()
    with engine.connect() as c:
        assert c.execute(select(voice_sessions.sessions).where(
            voice_sessions.sessions.c.authorization_ref == a['authorization_ref'])).first() is None
    assert q.status()['used'] == 0


def test_voice_preparation_full_round_replay_and_exhaustion(tmp_path, ready_character_id):
    a, e, s, now = inputs(ready_character_id)
    q = DailyModelQuota(tmp_path / 'daily.db', 30)
    d = tmp_path / 'one-round'
    result = prepare(engine, s, q, KEY, a, e, d, clock=lambda: now)
    assert result['new_model_posts'] == 0 and result['service_enabled'] is False
    for name in ('business.before.db', 'daily.before.db'):
        with sqlite3.connect(d / name) as c:
            assert c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    g = TrialGate(d / 'trial.db', q, clock=lambda: now)
    assert g.policy['budget_micro'] == 1200000
    assert g.policy['ends_at'] <= min(v[r]['checked_at'] + 900 for v in e.values() for r in ('wallet', 'price'))
    calls = []
    def handler(r):
        calls.append(r.method)
        if r.method == 'GET': return httpx.Response(200, content=source_wav())
        if str(r.url) == TEXT_URL: return httpx.Response(200, json=text_result())
        return httpx.Response(200, json={'output': {'audio': {'url':
            'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?signature=fixture'}},
            'usage': {'characters': 20}})
    service = TrialVoiceService(engine, g, lambda k: e[k], s, KEY,
                               delegate_factory=lambda _k: httpx.MockTransport(handler))
    rid = str(uuid4())
    value = service.send(UID, ready_character_id, rid, '合成测试文本', wav(), offline=True)
    assert value['state'] == 'completed' and value['error'] is None
    service.send(UID, ready_character_id, rid, '合成测试文本', wav(), offline=True)
    audio = next(v for v in service.history(UID, ready_character_id) if v['role'] == 'assistant')
    assert service.read_audio(UID, ready_character_id, audio['id'])[0]
    assert calls == ['POST', 'POST', 'GET']
    assert g.summary()['counts'] == {'voice_text': 1, 'voice_tts': 1}
    from app.living.rules import LivingError
    with pytest.raises(LivingError):
        service.send(UID, ready_character_id, str(uuid4()), '第二轮应阻止', wav(), offline=True)
    assert calls == ['POST', 'POST', 'GET']
    assert q.status()['used'] == 2
    with pytest.raises(TrialBlocked):
        prepare(engine, s, q, KEY, a, e, d, clock=lambda: now)
    assert s.voice_live_reply_enabled is False


def test_voice_failed_preparation_keeps_backups_and_stops_grant(tmp_path, ready_character_id, monkeypatch):
    a, e, s, now = inputs(ready_character_id)
    q = DailyModelQuota(tmp_path / 'daily.db', 30)
    def bad(*_a, **_k): raise RuntimeError('synthetic validation failure')
    monkeypatch.setattr('app.services.trial_wiring.TrialVoiceService', bad)
    d = tmp_path / 'failed'
    with pytest.raises(RuntimeError):
        prepare(engine, s, q, KEY, a, e, d, clock=lambda: now)
    assert (d / 'business.before.db').exists()
    g = TrialGate(d / 'trial.db', q, clock=lambda: now)
    assert g.summary()['state'] == 'stopped' and q.status()['used'] == 0
    with engine.connect() as c:
        assert voice_sessions.latest(c, UID, ready_character_id)['state'] == 'failed'


@pytest.fixture
def clips(pack, tmp_path):
    cid, _, source = pack
    clip = tmp_path / 'fixture.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=96x96:r=24',
        '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(clip)],
        check=True, capture_output=True, timeout=15)
    return cid, source, {a: clip for a in ACTIVITIES}


def reviewed(value):
    return {k: value[k] for k in ('source_sha256', 'videos')} | {
        'confirmed': True, 'viewed_all_three': True, 'review_ref': 'free-fixture-review'}


def test_three_videos_reach_existing_private_activity_api(client, clips):
    cid, _source, videos = clips
    with SessionLocal() as db:
        probe = prepare_character_videos(db, cid, UID, videos)
        assert probe['written'] is False and db.query(MotionPreparationTask).count() == 0
        delivered = prepare_character_videos(db, cid, UID, videos, apply=True, review=reviewed(probe))
        assert delivered['written'] and delivered['new_model_requests'] == 0
        for _ in ACTIVITIES:
            assert process_one(db)
        assert db.query(CharacterActivityMotionAsset).count() == 3
    for a in ACTIVITIES:
        response = client.get(f'/api/v1/characters/{cid}/motion?activity={a}')
        assert response.status_code == 200
        data = response.json()
        assert data['kind'] == 'video'
        assert client.get(data['video_url']).status_code == 200


@pytest.mark.parametrize('change', ['missing', 'owner', 'source', 'video', 'unreviewed', 'bad_third', 'commit'])
def test_three_video_failure_publishes_no_partial_batch(clips, change, monkeypatch):
    cid, source, videos = clips
    with SessionLocal() as db:
        probe = prepare_character_videos(db, cid, UID, videos)
        review = reviewed(probe)
        if change == 'missing': videos.pop('observe')
        elif change == 'source': source.write_bytes(b'synthetic changed image')
        elif change == 'video': review['videos'] = dict(review['videos'], walk='0' * 64)
        elif change == 'unreviewed': review['viewed_all_three'] = False
        elif change == 'bad_third':
            bad = source.parent / 'invalid.mp4'; bad.write_bytes(b'not-a-video'); videos['observe'] = bad
            review['videos']['observe'] = hashlib.sha256(bad.read_bytes()).hexdigest()
        elif change == 'commit':
            def broken(): raise RuntimeError('synthetic commit failure')
            monkeypatch.setattr(db, 'commit', broken)
        with pytest.raises((MotionBindingError, subprocess.SubprocessError, ValueError)):
            prepare_character_videos(db, cid, 'other' if change == 'owner' else UID,
                                      videos, apply=True, review=review)
        assert db.query(MotionPreparationTask).count() == 0
        assert db.query(CharacterActivityMotionAsset).count() == 0


@pytest.mark.parametrize('change', ['none', 'unknown', 'stale', 'split_wallet', 'tokens_only', 'price'])
def test_life_readiness_no_start_and_live_refresh_does_not_restamp(tmp_path, change):
    from app.services.life_acceptance_setup import check_admission
    a, e, _s, now = inputs(6, 'life')
    if change == 'unknown': e['private_life']['wallet']['pending_complete'] = False
    elif change == 'stale': e['private_life']['price']['checked_at'] -= 901
    elif change == 'split_wallet': e['shared_life']['wallet']['account'] = 'another'
    elif change == 'tokens_only': e['private_life']['wallet']['source_type'] = 'usage_query'
    elif change == 'price': e['shared_life']['price']['rates']['output_per_million'] += 1
    if change != 'none':
        with pytest.raises(TrialBlocked):
            check_admission(a, e, now=now)
        assert list(tmp_path.iterdir()) == []
        return
    result = check_admission(a, e, now=now)
    assert result['worker_started'] is False and result['new_model_posts'] == 0
    assert result['status'] == 'ready_for_preparation'
    from types import SimpleNamespace
    path = tmp_path / 'evidence.json'
    path.write_text(json.dumps(e)); path.chmod(0o600)
    gate = SimpleNamespace(policy={'authorization_ref': a['authorization_ref']})
    read = live_evidence_reader(path, gate, clock=lambda: now)
    assert read('shared_life') == e['shared_life']
    before = path.read_bytes()
    with pytest.raises(TrialBlocked):
        live_evidence_reader(path, gate, clock=lambda: now + 901)('private_life')
    assert path.read_bytes() == before
    e['private_life']['wallet']['pending_complete'] = False
    path.write_text(json.dumps(e))
    with pytest.raises(TrialBlocked): read('private_life')


def test_operator_clis_are_read_only_by_default(tmp_path, ready_character_id, capsys):
    from scripts.voice_live_session import main as voice_main
    from scripts.life_acceptance import main as life_main
    assert voice_main(['--database', engine.url.database, '--owner-id', UID,
                       '--character-id', str(ready_character_id)]) == 0
    value = json.loads(capsys.readouterr().out)
    assert value['status'] == 'planned' and value['new_model_posts'] == 0
    assert UID not in json.dumps(value)
    a, e, _s, _now = inputs(6, 'life')
    paths = []
    for name, value in [('approval', a), ('evidence', e)]:
        p = tmp_path / (name + '.json'); p.write_text(json.dumps(value)); p.chmod(0o600); paths.append(p)
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    assert life_main(['readiness', '--approval-file', str(paths[0]), '--evidence-file', str(paths[1])]) == 0
    value = json.loads(capsys.readouterr().out)
    assert value['worker_started'] is False
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before
