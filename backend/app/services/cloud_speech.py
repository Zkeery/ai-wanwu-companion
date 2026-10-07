"""Owner-scoped Qwen speech: one synthesis per authorized round, download-only recovery."""
import hashlib
import json
from pathlib import Path
import time

from dotenv import dotenv_values
import httpx
from sqlalchemy import Column, Integer, String, Table, Text, func, insert, select, update

from app.living.gatherings import GatheringStore, fail
from app.living.store import metadata
from app.services import voice_sessions
from app.services.qwen_tts_candidate import (
    MAX_TEXT_LENGTH, PRICE_PER_10000_CHARS, VOICES, billed_characters,
    download_candidate, synthesize_text,
)

RETENTION = 7 * 86400
SPEECH_RESERVE_MICRO = 54_400
CATALOG = (
    {'id': 'qwen:Cherry', 'label': 'Cherry · 欢快亲切'},
    {'id': 'qwen:Serena', 'label': 'Serena · 温柔自然'},
)
requests = Table('companion_speech_requests', metadata,
    Column('round_id', String(36), primary_key=True),
    Column('owner_id', String(128), nullable=False), Column('character_id', Integer, nullable=False),
    Column('session_id', String(36), nullable=False), Column('voice', String(100), nullable=False),
    Column('text_digest', String(64), nullable=False), Column('state', String(16), nullable=False),
    Column('created_at', Integer, nullable=False), Column('expires_at', Integer, nullable=False),
    Column('reserve_micro', Integer, nullable=False), Column('response_json', Text),
    Column('billed_characters', Integer))


def is_cloud_voice(voice):
    return voice in {item['id'] for item in CATALOG}


def preview_audio(voice):
    if not is_cloud_voice(voice):
        fail('请选择有效音色', 'invalid_request')
    return (Path(__file__).resolve().parents[2] / 'assets/voice-previews' /
        f'{voice.split(":", 1)[1]}.wav').read_bytes()


def reserved_for_session(conn, session_id):
    return conn.execute(select(func.coalesce(func.sum(requests.c.reserve_micro), 0))
        .where(requests.c.session_id == session_id)).scalar_one()


def clear_responses(conn, cid, rid=None):
    query = update(requests).where(requests.c.character_id == cid)
    if rid is not None:
        query = query.where(requests.c.round_id == rid)
    conn.execute(query.values(response_json=None, state='deleted'))


def expire_responses(conn, now):
    conn.execute(update(requests).where(requests.c.expires_at <= now)
        .values(response_json=None, state='expired'))


def interrupt_pending(conn):
    conn.execute(update(requests).where(requests.c.state == 'started').values(state='interrupted'))


class QwenSpeech:
    def __init__(self, engine, clock=None, client_factory=None, key_loader=None):
        self.engine = engine
        self.clock = clock or (lambda: int(time.time()))
        self.store = GatheringStore(engine, self.clock)
        self.client_factory = client_factory or (lambda: httpx.Client(follow_redirects=False))
        self.key_loader = key_loader or (lambda: dotenv_values(
            Path(__file__).resolve().parents[2] / '.env').get('QWEN_TTS_API_KEY') or '')

    @staticmethod
    def _round(conn, uid, cid, rid):
        from app.models.models import Character, Message
        from app.services.voice import rounds
        row = conn.execute(select(rounds).join(Character.__table__,
            Character.id == rounds.c.character_id).join(Message.__table__,
            Message.id == rounds.c.reply_message_id).where(rounds.c.id == rid,
            rounds.c.owner_id == uid, rounds.c.character_id == cid,
            Character.owner_id == uid, Character.status == 'ready',
            Message.character_id == cid, Message.role == 'assistant',
            rounds.c.state.in_(['text_ready', 'completed']))).mappings().first()
        if not row:
            fail('回复已取消或无权访问', 'audio_unavailable')
        return row

    def synthesize(self, text, voice, *, uid, cid, rid):
        if not is_cloud_voice(voice) or not isinstance(text, str) or not 0 < len(text) <= MAX_TEXT_LENGTH:
            fail('回复暂时无法朗读，文字已保留', 'audio_unavailable')
        provider_voice = voice.split(':', 1)[1]
        upper_micro = int(PRICE_PER_10000_CHARS * billed_characters(text + VOICES[provider_voice]) * 100)
        if (upper_micro > SPEECH_RESERVE_MICRO or
                voice_sessions.RESERVE_MICRO + SPEECH_RESERVE_MICRO > 1_200_000):
            fail('语音合成超出本轮费用上限', 'audio_unavailable')
        key = self.key_loader()
        if not key:
            fail('自然音色暂不可用，文字已保留', 'audio_unavailable')
        digest = hashlib.sha256(text.encode()).hexdigest()
        with self.store.transaction() as conn:
            self._round(conn, uid, cid, rid)
            existing = conn.execute(select(requests).where(requests.c.round_id == rid)).mappings().first()
            if existing:
                if (existing['owner_id'], existing['character_id'], existing['voice'], existing['text_digest']) != (uid, cid, voice, digest):
                    fail('语音请求不一致', 'conflict')
            else:
                grant = voice_sessions.latest(conn, uid, cid)
                if (not grant or grant['state'] != 'active' or grant['in_flight'] != rid
                        or grant['expires_at'] <= self.clock()):
                    fail('本轮语音尚未取得聊天额度', 'voice_session_unavailable')
                total = grant['used_rounds'] * voice_sessions.RESERVE_MICRO + reserved_for_session(conn, grant['id'])
                if total + SPEECH_RESERVE_MICRO > grant['max_rounds'] * 1_200_000:
                    fail('本次语音费用额度已用完', 'voice_session_unavailable')
                now = self.clock()
                conn.execute(insert(requests).values(round_id=rid, owner_id=uid, character_id=cid,
                    session_id=grant['id'], voice=voice, text_digest=digest, state='started',
                    created_at=now, expires_at=now + RETENTION, reserve_micro=SPEECH_RESERVE_MICRO))
        if existing:
            return self.recover(uid, cid, rid)

        def save_response(body):
            with self.store.transaction() as conn:
                self._round(conn, uid, cid, rid)
                conn.execute(update(requests).where(requests.c.round_id == rid,
                    requests.c.state == 'started').values(response_json=json.dumps(body, ensure_ascii=False)))

        try:
            with self.client_factory() as client:
                result = synthesize_text(key, text, provider_voice, client=client, on_response=save_response)
            with self.store.transaction() as conn:
                self._round(conn, uid, cid, rid)
                conn.execute(update(requests).where(requests.c.round_id == rid,
                    requests.c.state == 'started').values(state='ready', billed_characters=result.billed_characters))
            return result.wav
        except Exception:
            with self.engine.begin() as conn:
                conn.execute(update(requests).where(requests.c.round_id == rid,
                    requests.c.state == 'started').values(state='failed'))
            fail('自然音色暂时无法播放，文字已保留', 'audio_unavailable')

    def recover(self, uid, cid, rid):
        with self.engine.connect() as conn:
            self._round(conn, uid, cid, rid)
            row = conn.execute(select(requests).where(requests.c.round_id == rid,
                requests.c.owner_id == uid, requests.c.character_id == cid,
                requests.c.expires_at > self.clock(), requests.c.state.in_(['ready', 'failed', 'interrupted']))).mappings().first()
            if not row or not row['response_json']:
                fail('这段音频没有可恢复的合成结果，文字仍可阅读', 'audio_unavailable')
            body = json.loads(row['response_json'])
        try:
            with self.client_factory() as client:
                result = download_candidate(body, client=client)
            with self.store.transaction() as conn:
                self._round(conn, uid, cid, rid)
                conn.execute(update(requests).where(requests.c.round_id == rid,
                    requests.c.state.in_(['ready', 'failed', 'interrupted']))
                    .values(state='ready', billed_characters=result.billed_characters))
            return result.wav
        except Exception:
            fail('已生成的音频暂时无法下载，文字仍可阅读', 'audio_unavailable')
