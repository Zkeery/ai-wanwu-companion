import io
import shutil
import subprocess
import wave
from uuid import uuid4

import pytest
from sqlalchemy import select, update

from app.core.database import engine, SessionLocal
from app.living.gatherings import GatheringStore
from app.living.rules import LivingError
from app.models.models import Message, SceneProposal
from app.services.voice import VoiceService, RETENTION, MAX_BYTES, validate_audio, append_mood_context, rounds, audio
from tests.auth_helpers import TEST_USER_ID


def wav(seconds=1, *, silent=False):
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes((b'\0\0\0\0' if silent else b'\xe8\x03\x18\xfc') * (4000 * seconds))
    return stream.getvalue()


def test_duplicate_system_voices_keep_unique_choices_and_saved_selection(monkeypatch, ready_character_id):
    from app.services.voice import local_voices

    output = '\n'.join([
        'Meijia (中文（台湾）)     zh_TW # 你好',
        'Meijia (中文（台湾）)     zh_TW # 你好',
        'Eddy (中文（中国大陆）)   zh_CN # 你好',
        'Eddy (中文（台湾）)       zh_TW # 你好',
        'Tingting (中文（中国大陆）) zh_CN # 你好',
        'Tingting (中文（中国大陆）) zh_CN # 你好',
        'Samantha en_US # Hello',
    ])
    monkeypatch.setattr('app.services.voice.shutil.which', lambda _: '/usr/bin/say')
    monkeypatch.setattr('app.services.voice.subprocess.run', lambda *a, **kw:
                        subprocess.CompletedProcess(a, 0, stdout=output))
    local_voices.cache_clear()
    try:
        service = VoiceService(engine)
        settings = service.read_settings(TEST_USER_ID, ready_character_id)
        ids = [v['id'] for v in settings['voices']]
        assert ids == ['Meijia (中文（台湾）)', 'Eddy (中文（中国大陆）)',
                       'Eddy (中文（台湾）)', 'Tingting (中文（中国大陆）)']
        chosen = ids[-1]
        service.save_settings(TEST_USER_ID, ready_character_id, chosen, None, True)
        local_voices.cache_clear()
        restored = service.read_settings(TEST_USER_ID, ready_character_id)
        assert restored['voice'] == chosen
        assert sum(v['id'] == chosen for v in restored['voices']) == 1
    finally:
        local_voices.cache_clear()


class Speech:
    def synthesize(self, text, voice):
        return wav()


@pytest.fixture
def voice(monkeypatch):
    monkeypatch.setattr('app.services.voice.local_voices', lambda: [{'id': 'local-test', 'label': '测试音色'}])
    # Any accidental real-capable entry point is an immediate failure.
    monkeypatch.setattr('app.services.model_client.ModelClient.chat_stream', lambda *a: pytest.fail('network-capable chat forbidden'))
    clock = [1_800_000_000]
    return VoiceService(engine, lambda: clock[0], Speech()), clock


def test_voice_full_round_replay_and_expiration(voice, ready_character_id):
    s, clock = voice
    cid, rid = ready_character_id, str(uuid4())
    result = s.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True)
    assert result['state'] == 'completed'
    assert s.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True) == result
    entries = s.history(TEST_USER_ID, cid)
    assert len(entries) == 2
    with SessionLocal() as db:
        assert db.query(Message).filter_by(character_id=cid).count() == 2
    for entry in entries:
        assert s.read_audio(TEST_USER_ID, cid, entry['id'])[0] == wav()
    clock[0] += RETENTION
    with pytest.raises(LivingError):
        s.read_audio(TEST_USER_ID, cid, entries[0]['id'])
    assert all(a['state'] == 'expired' for a in s.history(TEST_USER_ID, cid))
    with SessionLocal() as db:
        assert db.query(Message).filter_by(character_id=cid).count() == 2


def test_voice_reply_during_gathering_does_not_propose_old_home_action(voice, ready_character_id):
    s, clock = voice
    gatherings = GatheringStore(engine, lambda: clock[0])
    group = gatherings.create(TEST_USER_ID, str(uuid4()), '朋友的小院', '我', 'home')
    gatherings.command(TEST_USER_ID, group['id'], str(uuid4()), group['revision'],
                       {'action': 'visit', 'character_id': ready_character_id})
    result = s.send(TEST_USER_ID, ready_character_id, str(uuid4()),
                    '帮我种一棵树', wav(), offline=True)
    assert result['state'] == 'completed'
    with SessionLocal() as db:
        assert db.query(SceneProposal).filter_by(character_id=ready_character_id).count() == 0


def test_individual_delete_and_no_cross_account(voice, ready_character_id):
    s, _ = voice
    s.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    aid = s.history(TEST_USER_ID, ready_character_id)[0]['id']
    with pytest.raises(LivingError):
        s.read_audio('outsider', ready_character_id, aid)
    with pytest.raises(LivingError):
        s.delete_audio('outsider', ready_character_id, aid)
    s.delete_audio(TEST_USER_ID, ready_character_id, aid)
    s.delete_audio(TEST_USER_ID, ready_character_id, aid)
    with pytest.raises(LivingError):
        s.read_audio(TEST_USER_ID, ready_character_id, aid)
    assert sum(a['state'] == 'ready' for a in s.history(TEST_USER_ID, ready_character_id)) == 1


@pytest.mark.parametrize('content', [b'', b'fake audio', b'RIFF1234WAVEbroken', b'x' * (MAX_BYTES + 1), wav(61), wav(silent=True)])
def test_audio_validation(content):
    with pytest.raises(LivingError):
        validate_audio(content)


def test_silent_recording_is_not_persisted(voice, ready_character_id):
    service, _ = voice
    with pytest.raises(LivingError, match='重录或改用文字'):
        service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '手填文字', wav(silent=True), offline=True)
    assert service.history(TEST_USER_ID, ready_character_id) == []
    with SessionLocal() as db:
        assert db.query(Message).filter_by(character_id=ready_character_id).count() == 0


@pytest.mark.parametrize('silent', [False, True])
def test_webm_audio_signal_validation(tmp_path, silent):
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        pytest.skip('ffmpeg is required for compressed audio validation')
    source = tmp_path / 'recording.wav'
    target = tmp_path / 'recording.webm'
    source.write_bytes(wav(silent=silent))
    subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', str(source),
        '-c:a', 'libopus', str(target)], check=True, timeout=8)
    if silent:
        with pytest.raises(LivingError, match='重录或改用文字'):
            validate_audio(target.read_bytes())
    else:
        assert validate_audio(target.read_bytes()) == 'audio/webm'


def test_tts_failure_keeps_text_and_original(voice, ready_character_id):
    s, _ = voice
    s.speech.synthesize = lambda *a: (_ for _ in ()).throw(RuntimeError())
    result = s.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    assert result['state'] == 'completed' and result['error'] == 'audio_unavailable'
    assert {a['state'] for a in s.history(TEST_USER_ID, ready_character_id)} == {'ready', 'unavailable'}


def test_voice_scene_proposal_waits_for_one_confirmation(voice, ready_character_id, client, anon):
    service, _ = voice
    cid, rid = ready_character_id, str(uuid4())
    path = f'/api/v1/characters/{cid}/scene'
    before = client.get(path).json()['elements']['tree']
    result = service.send(TEST_USER_ID, cid, rid, '种一棵树', wav(), offline=True)
    assert result['state'] == 'completed'
    with SessionLocal() as db:
        assert db.query(SceneProposal).filter_by(character_id=cid).count() == 1
    scene = client.get(path).json()
    assert scene['elements']['tree'] == before
    proposal = scene['proposal']
    assert proposal and proposal['action'] == 'plant_tree'
    assert service.send(TEST_USER_ID, cid, rid, '种一棵树', wav(), offline=True) == result
    assert client.get(path).json()['proposal'] == proposal
    assert anon.post(f"{path}/proposals/{proposal['id']}/confirm").status_code == 401
    assert client.post(f"{path}/proposals/{proposal['id']}/confirm").json()['elements']['tree'] == before + 1
    assert client.post(f"{path}/proposals/{proposal['id']}/confirm").status_code == 409
    assert client.get(path).json()['elements']['tree'] == before + 1


def test_voice_only_proposes_supported_explicit_action(voice, ready_character_id, client):
    service, _ = voice
    cid = ready_character_id
    path = f'/api/v1/characters/{cid}/scene'
    client.get(path)
    for phrase in ('今天天气不错', '请不要种树', '种一棵树再下雨'):
        service.send(TEST_USER_ID, cid, str(uuid4()), phrase, wav(), offline=True)
        assert client.get(path).json()['proposal'] is None
    desert = client.post('/api/v1/living/spaces', json={
        'scene_type': 'desert', 'mode': 'private', 'companion_id': str(cid)}).json()
    assert client.put(f'/api/v1/characters/{cid}/location', json={'space_id': desert['id']}).status_code == 200
    service.send(TEST_USER_ID, cid, str(uuid4()), '请下点小雨', wav(), offline=True)
    assert client.get(path).json()['proposal'] is None


def test_voice_proposal_binds_scene_and_survives_audio_failure(voice, ready_character_id, client, monkeypatch):
    service, _ = voice
    cid = ready_character_id
    path = f'/api/v1/characters/{cid}/scene'
    client.get(path)
    service.speech.synthesize = lambda *a: (_ for _ in ()).throw(RuntimeError())
    result = service.send(TEST_USER_ID, cid, str(uuid4()), '种一棵树', wav(), offline=True)
    assert result['error'] == 'audio_unavailable'
    proposal = client.get(path).json()['proposal']
    assert proposal and proposal['action'] == 'plant_tree'
    assert client.get(path).json()['proposal'] == proposal
    from app.services.model_client import ModelClient
    def reply_after_scene_changes(self, messages):
        assert client.post(f'{path}/actions/plant_tree').status_code == 200
        return '我们再看看。'
    monkeypatch.setattr(ModelClient, '_mock_chat', reply_after_scene_changes)
    service.send(TEST_USER_ID, cid, str(uuid4()), '种一棵树', wav(), offline=True)
    with SessionLocal() as db:
        assert db.query(SceneProposal).filter_by(character_id=cid).count() == 0


def test_voice_living_proposal_survives_restart_then_rejects_or_expires(voice, ready_character_id, client):
    service, _ = voice
    cid = ready_character_id
    path = f'/api/v1/characters/{cid}/scene'
    home = client.post('/api/v1/living/spaces', json={
        'scene_type': 'home', 'mode': 'private', 'companion_id': str(cid)})
    assert home.status_code == 201
    assert client.put(f'/api/v1/characters/{cid}/location', json={'space_id': home.json()['id']}).status_code == 200
    service.send(TEST_USER_ID, cid, str(uuid4()), '种一棵树', wav(), offline=True)
    proposal = client.get(path).json()['proposal']
    assert proposal and proposal['action'] == 'plant_tree'
    with SessionLocal() as db:
        saved = db.query(SceneProposal).filter_by(character_id=cid).one()
        assert saved.space_id == home.json()['id'] and saved.space_revision == home.json()['revision']
    assert VoiceService(engine).receipts(TEST_USER_ID, cid)[0]['state'] == 'completed'
    before = client.get(path).json()['elements']['tree']
    rejected = client.post(f"{path}/proposals/{proposal['id']}/reject")
    assert rejected.status_code == 200 and rejected.json()['elements']['tree'] == before
    service.send(TEST_USER_ID, cid, str(uuid4()), '种一棵树', wav(), offline=True)
    stale = client.get(path).json()['proposal']
    assert stale
    assert client.post(f'{path}/actions/plant_tree').status_code == 200
    assert client.post(f"{path}/proposals/{stale['id']}/confirm").status_code == 409
    assert client.get(path).json()['elements']['tree'] == before + 1


def test_unapproved_real_provider_stays_closed(voice, ready_character_id):
    s, _ = voice
    with pytest.raises(LivingError):
        s.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=False)
    assert not s.history(TEST_USER_ID, ready_character_id)


def test_mood_correction_overrides_and_voice_stays(voice, ready_character_id):
    s, _ = voice
    cid = ready_character_id
    s.read_settings(TEST_USER_ID, cid)
    with SessionLocal() as db:
        messages = [{'role': 'system', 'content': '角色'}, {'role': 'user', 'content': '我很难过'}]
        append_mood_context(db, TEST_USER_ID, cid, messages)
        db.commit()
    assert s.read_settings(TEST_USER_ID, cid)['mood_source'] == 'suggested'
    s.save_settings(TEST_USER_ID, cid, 'local-test', 'happy', False)
    with SessionLocal() as db:
        messages = [{'role': 'system', 'content': '角色'}, {'role': 'user', 'content': '我很难过'}]
        append_mood_context(db, TEST_USER_ID, cid, messages)
        assert '开心' in messages[0]['content'] and '低落' not in messages[0]['content']
        from app.models.models import Character
        db.get(Character, cid).persona = '新的性格'
        db.commit()
    assert s.read_settings(TEST_USER_ID, cid)['voice'] == 'local-test'


def test_common_first_person_tired_phrase_stays_a_correctable_suggestion(voice, ready_character_id):
    s, _ = voice
    cid = ready_character_id
    original = s.read_settings(TEST_USER_ID, cid)
    for text, expected in [('你好，我今天有点累。', 'tired'), ('我有点累', 'tired'),
                           ('他今天有点累', None), ('我今天不累', None)]:
        s.save_settings(TEST_USER_ID, cid, original['voice'], None, True)
        messages = [{'role': 'system', 'content': '角色'}, {'role': 'user', 'content': text}]
        with SessionLocal() as db:
            append_mood_context(db, TEST_USER_ID, cid, messages)
            db.commit()
        current = s.read_settings(TEST_USER_ID, cid)
        assert current['mood'] == expected
        assert current['mood_source'] == ('suggested' if expected else 'none')
        assert ('可能表达的心情（待用户确认，不是事实）' in messages[0]['content']) == bool(expected)


def test_clear_history_revokes_audio_and_recovery_no_retry(voice, ready_character_id, client):
    s, _ = voice
    cid = ready_character_id
    s.send(TEST_USER_ID, cid, str(uuid4()), '你好', wav(), offline=True)
    aid = s.history(TEST_USER_ID, cid)[0]['id']
    assert client.delete(f'/api/v1/characters/{cid}/messages').status_code == 204
    assert not s.history(TEST_USER_ID, cid)
    with pytest.raises(LivingError):
        s.read_audio(TEST_USER_ID, cid, aid)
    s.recover()
    with engine.connect() as conn:
        assert conn.execute(select(rounds.c.state)).scalar_one() == 'cancelled'


def test_voice_api_input_and_owner(client, anon, ready_character_id, voice, monkeypatch):
    s, _ = voice
    monkeypatch.setattr('app.api.voice.service', s)
    base = f'/api/v1/characters/{ready_character_id}/voice'
    assert anon.get(base + '/settings').status_code == 401
    assert client.get(base + '/settings').status_code == 200
    result = client.post(base + '/send', data={'request_id': str(uuid4()), 'transcript': '你好'},
        files={'recording': ('unsafe.exe', wav(), 'application/octet-stream')})
    assert result.status_code == 200 and result.json()['state'] == 'completed'
    aid = client.get(base + '/audio').json()[0]['id']
    assert client.get(base + '/audio/' + aid).headers['cache-control'] == 'private, no-store'


def test_receipts_read_only_private_and_persisted(client, anon, ready_character_id, voice, monkeypatch):
    s, _ = voice
    cid, rid = ready_character_id, str(uuid4())
    monkeypatch.setattr('app.api.voice.service', s)
    s.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True)
    original = s.history(TEST_USER_ID, cid)
    base = f'/api/v1/characters/{cid}/voice/rounds'
    assert anon.get(base).status_code == 401
    assert anon.get(base + '/' + rid).status_code == 401
    assert client.get(base + '/invalid').status_code == 422
    assert client.get(base + '/' + str(uuid4())).status_code == 404
    assert client.get('/api/v1/characters/999999/voice/rounds/' + rid).status_code == 404
    with pytest.raises(LivingError):
        s.receipts('outsider', cid, rid)
    for _ in range(2):
        result = client.get(base + '/' + rid)
        assert result.status_code == 200 and result.json()['state'] == 'completed'
        assert result.headers['cache-control'] == 'private, no-store'
        assert set(result.json()) == {'id', 'state', 'error', 'origin', 'created_at', 'reply_message_id'}
        assert result.json()['reply_message_id'] == next(a['message_id'] for a in original if a['role'] == 'assistant')
        assert client.get(base).json() == [result.json()]
    reopened = VoiceService(engine)
    assert reopened.receipts(TEST_USER_ID, cid, rid)['state'] == 'completed'
    assert s.history(TEST_USER_ID, cid) == original
    with SessionLocal() as db:
        assert db.query(Message).filter_by(character_id=cid).count() == 2


def test_text_receipt_is_readable_before_speech_finishes(voice, ready_character_id):
    service, _ = voice
    rid = str(uuid4())
    observed = []
    class InspectSpeech:
        def synthesize(self, reply, selected_voice):
            receipt = service.receipts(TEST_USER_ID, ready_character_id, rid)
            assert receipt['state'] == 'text_ready'
            with SessionLocal() as db:
                message = db.get(Message, receipt['reply_message_id'])
                assert message.role == 'assistant' and message.content == reply
            assert not any(a['role'] == 'assistant' for a in service.history(TEST_USER_ID, ready_character_id))
            observed.append(receipt['reply_message_id'])
            return wav()
    service.speech = InspectSpeech()
    assert service.send(TEST_USER_ID, ready_character_id, rid, '你好', wav(), offline=True)['state'] == 'completed'
    assert len(observed) == 1
    assert service.receipts(TEST_USER_ID, ready_character_id, rid)['reply_message_id'] == observed[0]


@pytest.mark.parametrize('state', ['running', 'text_ready', 'failed', 'cancelled'])
def test_receipts_preserve_states_and_recovery_does_not_dispatch(voice, ready_character_id, state):
    s, _ = voice
    rid = str(uuid4())
    s.send(TEST_USER_ID, ready_character_id, rid, '你好', wav(), offline=True)
    with engine.begin() as conn:
        conn.execute(update(rounds).where(rounds.c.id == rid).values(state=state))
    assert s.receipts(TEST_USER_ID, ready_character_id, rid)['state'] == state
    s.recover()
    assert s.receipts(TEST_USER_ID, ready_character_id, rid)['state'] == ('failed' if state in ('running', 'text_ready') else state)
    with SessionLocal() as db:
        assert db.query(Message).filter_by(character_id=ready_character_id).count() == 2


def test_retry_failed_reply_audio_preserves_message_and_uses_original_voice(
        voice, ready_character_id, client, anon, monkeypatch):
    service, clock = voice
    cid, rid = ready_character_id, str(uuid4())
    calls = []

    def synthesize(text, selected_voice):
        calls.append((text, selected_voice))
        if len(calls) == 1:
            raise RuntimeError('synthetic failure')
        return wav()

    service.speech.synthesize = synthesize
    monkeypatch.setattr('app.api.voice.service', service)
    service.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True)
    reply_audio = next(a for a in service.history(TEST_USER_ID, cid) if a['role'] == 'assistant')
    assert reply_audio['state'] == 'unavailable'
    original_expiry = reply_audio['expires_at']
    original_count = len(service.history(TEST_USER_ID, cid))
    assert service.receipts(TEST_USER_ID, cid, rid)['error'] == 'audio_unavailable'
    clock[0] += 90
    path = f'/api/v1/characters/{cid}/voice/audio/{reply_audio["id"]}/retry'
    assert anon.post(path).status_code == 401
    assert client.post('/api/v1/characters/999999/voice/audio/' + reply_audio['id'] + '/retry').status_code == 404
    assert client.post(path.replace(reply_audio['id'], 'invalid')).status_code == 422
    first = client.post(path)
    assert first.status_code == 200
    assert first.json() == {'id': reply_audio['id'], 'state': 'ready', 'expires_at': clock[0] + RETENTION}
    assert first.headers['cache-control'] == 'private, no-store'
    assert first.json()['expires_at'] > original_expiry
    assert client.post(path).json() == first.json()
    assert len(calls) == 2 and calls[0][1] == calls[1][1] == 'local-test'
    assert len(service.history(TEST_USER_ID, cid)) == original_count
    assert service.read_audio(TEST_USER_ID, cid, reply_audio['id'])[0] == wav()
    assert service.receipts(TEST_USER_ID, cid, rid)['error'] is None
    with SessionLocal() as db:
        assert db.query(Message).filter_by(character_id=cid).count() == 2
        assert db.query(SceneProposal).filter_by(character_id=cid).count() == 0


def test_retry_audio_failure_and_competing_delete_do_not_resend(voice, ready_character_id, client, monkeypatch):
    service, _ = voice
    cid, rid = ready_character_id, str(uuid4())
    monkeypatch.setattr(service.speech, 'synthesize', lambda *_: (_ for _ in ()).throw(RuntimeError('unavailable')))
    service.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True)
    reply_audio = next(a for a in service.history(TEST_USER_ID, cid) if a['role'] == 'assistant')
    aid = reply_audio['id']
    monkeypatch.setattr('app.api.voice.service', service)
    response = client.post(f'/api/v1/characters/{cid}/voice/audio/{aid}/retry')
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'audio_unavailable'
    assert next(a for a in service.history(TEST_USER_ID, cid) if a['id'] == aid)['state'] == 'unavailable'

    def interrupted(*_):
        with pytest.raises(LivingError) as conflict:
            service.retry_audio(TEST_USER_ID, cid, aid)
        assert conflict.value.code == 'conflict'
        service.delete_audio(TEST_USER_ID, cid, aid)
        return wav()

    monkeypatch.setattr(service.speech, 'synthesize', interrupted)
    with pytest.raises(LivingError, match='状态已变化'):
        service.retry_audio(TEST_USER_ID, cid, aid)
    assert next(a for a in service.history(TEST_USER_ID, cid) if a['id'] == aid)['state'] == 'deleted'
    with pytest.raises(LivingError):
        service.retry_audio(TEST_USER_ID, cid, aid)


def test_retry_audio_expiry_user_record_and_restart(voice, ready_character_id):
    service, clock = voice
    cid, rid = ready_character_id, str(uuid4())
    service.speech.synthesize = lambda *_: (_ for _ in ()).throw(RuntimeError('unavailable'))
    service.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True)
    entries = service.history(TEST_USER_ID, cid)
    user_audio = next(a for a in entries if a['role'] == 'user')
    reply_audio = next(a for a in entries if a['role'] == 'assistant')
    with pytest.raises(LivingError):
        service.retry_audio(TEST_USER_ID, cid, user_audio['id'])
    with pytest.raises(LivingError):
        service.retry_audio('outsider', cid, reply_audio['id'])
    with engine.begin() as conn:
        conn.execute(update(audio).where(audio.c.id == reply_audio['id']).values(state='synthesizing'))
    service.recover()
    assert next(a for a in service.history(TEST_USER_ID, cid) if a['id'] == reply_audio['id'])['state'] == 'unavailable'
    clock[0] += RETENTION
    assert next(a for a in service.history(TEST_USER_ID, cid) if a['id'] == reply_audio['id'])['state'] == 'expired'
    with pytest.raises(LivingError):
        service.retry_audio(TEST_USER_ID, cid, reply_audio['id'])


@pytest.mark.parametrize('fails', [False, True])
def test_periodic_audio_cleanup_stops_and_hides_internal_errors(monkeypatch, caplog, fails):
    import asyncio
    from app.main import cleanup_expired_audio
    async def run():
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        calls = []
        def cleanup():
            calls.append(True)
            loop.call_soon_threadsafe(stop.set)
            if fails:
                raise RuntimeError('sensitive-internal-error')
        monkeypatch.setattr('app.main.voice.service.cleanup', cleanup)
        await cleanup_expired_audio(stop)
        assert len(calls) == 1
    asyncio.run(run())
    assert 'sensitive-internal-error' not in caplog.text
