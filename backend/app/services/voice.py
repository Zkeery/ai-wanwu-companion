"""Private audio lifecycle; real replies require explicit configuration or a scoped allowance."""
from __future__ import annotations

import hashlib
import io
import json
from array import array
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from functools import lru_cache
from pathlib import Path
from uuid import uuid4

from sqlalchemy import Column, Integer, LargeBinary, String, Table, Text, delete, insert, select, text as sql_text, update

from app.living.gatherings import GatheringStore, fail
from app.living.store import metadata, _uuid
from app.services.life_context import append_life_context
from app.services.voice_reply import configured_reply, reply_mode
from app.services.transcription_config import transcription_status
from app.services import voice_sessions
from app.services import cloud_speech

RETENTION = 7 * 86400
MAX_BYTES = 8 * 1024 * 1024
MOODS = ('happy', 'calm', 'sad', 'tired', 'anxious', 'unsure')
MOOD_LABELS = dict(happy='开心', calm='平静', sad='低落', tired='疲惫', anxious='紧张', unsure='说不清')

preferences = Table('companion_voice_preferences', metadata,
    Column('character_id', Integer, primary_key=True), Column('owner_id', String(128), nullable=False),
    Column('voice', String(100), nullable=False), Column('mood', String(16)),
    Column('automatic', Integer, nullable=False), Column('mood_source', String(16), nullable=False))
rounds = Table('companion_voice_rounds', metadata,
    Column('id', String(36), primary_key=True), Column('owner_id', String(128), nullable=False),
    Column('character_id', Integer, nullable=False), Column('digest', String(64), nullable=False),
    Column('state', String(16), nullable=False), Column('created_at', Integer, nullable=False),
    Column('origin', String(32), nullable=False, server_default='offline_fixture'),
    Column('user_message_id', Integer), Column('reply_message_id', Integer), Column('error', String(80)))
audio = Table('companion_audio', metadata,
    Column('id', String(36), primary_key=True), Column('round_id', String(36), nullable=False),
    Column('owner_id', String(128), nullable=False), Column('character_id', Integer, nullable=False),
    Column('message_id', Integer), Column('role', String(16), nullable=False),
    Column('mime', String(80), nullable=False), Column('voice', String(100)),
    Column('created_at', Integer, nullable=False), Column('expires_at', Integer, nullable=False),
    Column('state', String(16), nullable=False), Column('data', LargeBinary))


def _has_signal(frames: bytes, width: int) -> bool:
    """Reject only obviously silent PCM; speech recognition remains the worker's job."""
    if width == 1:
        return any(abs(sample - 128) > 1 for sample in frames)
    if width in (2, 4):
        samples = array('h' if width == 2 else 'i')
        samples.frombytes(frames)
        if sys.byteorder != 'little':
            samples.byteswap()
        threshold = 32 if width == 2 else 32 * 65536
        return any(abs(sample) > threshold for sample in samples)
    return any(abs(int.from_bytes(frames[i:i + 3], 'little', signed=True)) > 32 * 256
        for i in range(0, len(frames), 3))


def _decoded_has_signal(data: bytes) -> bool:
    executable = shutil.which('ffmpeg')
    if not executable:
        fail('本机尚未安装录音解码工具，请使用文字交流')
    with tempfile.NamedTemporaryFile(suffix='.audio') as source:
        source.write(data)
        source.flush()
        result = subprocess.run([executable, '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-i', source.name, '-t', '61', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '8000',
            '-f', 's16le', 'pipe:1'], capture_output=True, timeout=8, check=True)
    return bool(result.stdout) and _has_signal(result.stdout, 2)


def validate_audio(data: bytes) -> str:
    if not data or len(data) > MAX_BYTES:
        fail('录音为空或超过 8 MB', 'invalid_request')
    try:
        if data[:4] == b'RIFF' and data[8:12] == b'WAVE':
            with wave.open(io.BytesIO(data), 'rb') as w:
                duration = w.getnframes() / w.getframerate()
                if w.getnchannels() not in (1, 2) or w.getsampwidth() not in (1, 2, 3, 4):
                    raise ValueError()
                frames = w.readframes(w.getnframes())
                if len(frames) != w.getnframes() * w.getnchannels() * w.getsampwidth():
                    raise ValueError()
                signal = _has_signal(frames, w.getsampwidth())
            mime = 'audio/wav'
        else:
            if not (data.startswith(b'\x1aE\xdf\xa3') or data[4:8] == b'ftyp' or data.startswith(b'OggS')):
                raise ValueError()
            executable = shutil.which('ffprobe')
            if not executable:
                fail('本机尚未安装录音格式校验工具，请使用文字交流')
            with tempfile.NamedTemporaryFile(suffix='.audio') as f:
                f.write(data)
                f.flush()
                result = subprocess.run([executable, '-v', 'error', '-protocol_whitelist', 'file,pipe',
                    '-show_entries', 'format=duration,format_name:stream=codec_type,duration:packet=pts_time,duration_time',
                    '-of', 'json', f.name], capture_output=True, timeout=8, check=True)
            facts = json.loads(result.stdout)
            streams = facts.get('streams', [])
            if len(streams) != 1 or streams[0].get('codec_type') != 'audio':
                raise ValueError()
            duration = float(facts['format'].get('duration') or streams[0].get('duration') or 0)
            if duration == 0:
                duration = max((float(p.get('pts_time', 0)) + float(p.get('duration_time', 0))
                    for p in facts.get('packets', [])), default=0)
            fmt = facts['format'].get('format_name', '')
            mime = 'audio/webm' if 'webm' in fmt else 'audio/ogg' if 'ogg' in fmt else 'audio/mp4' if 'mp4' in fmt else ''
            if not mime:
                raise ValueError()
            signal = _decoded_has_signal(data) if 0 < duration <= 60.2 else False
        if not 0 < duration <= 60.2:
            fail('单段录音最长 60 秒', 'invalid_request')
        if not signal:
            fail('这段录音没有可辨的声音，请重录或改用文字', 'invalid_request')
        return mime
    except (ValueError, KeyError, wave.Error, EOFError, OSError, subprocess.SubprocessError):
        fail('无法读取这段录音，请重新录制或使用文字', 'invalid_request')


@lru_cache(maxsize=1)
def local_voices():
    executable = shutil.which('say')
    if not executable:
        return []
    try:
        result = subprocess.run([executable, '-v', '?'], capture_output=True, text=True, timeout=5, check=True)
        voices = []
        seen = set()
        for line in result.stdout.splitlines():
            before = line.split('#', 1)[0].strip()
            if 'zh_' in before:
                name, locale = before.rsplit(None, 1)
                name = name.strip()
                # macOS can list the same selectable name more than once.
                # Keep the existing ID used by saved settings and `say -v`.
                if name not in seen:
                    seen.add(name)
                    voices.append(dict(id=name, label=name + ' · 本机语音', locale=locale))
        return voices
    except (ValueError, OSError, subprocess.SubprocessError):
        return []


class LocalSpeech:
    def synthesize(self, text: str, voice: str) -> bytes:
        if voice not in {v['id'] for v in local_voices()} or not shutil.which('afconvert'):
            fail('本机音色暂不可用，文字回复已保留')
        with tempfile.TemporaryDirectory(prefix='companion-speech-') as folder:
            source, target = Path(folder) / 'source.aiff', Path(folder) / 'reply.wav'
            # Text goes through stdin, never shell interpolation or options.
            subprocess.run([shutil.which('say'), '-v', voice, '-o', str(source)],
                input=text[:1000], text=True, capture_output=True, timeout=20, check=True)
            subprocess.run([shutil.which('afconvert'), '-f', 'WAVE', '-d', 'LEI16', str(source), str(target)],
                capture_output=True, timeout=10, check=True)
            data = target.read_bytes()
            if not data or len(data) > MAX_BYTES:
                fail('回复音频过长，文字回复已保留')
            return data


class VoiceService:
    def __init__(self, engine, clock=None, speech=None, live_reply=None, live_speech=None):
        self.engine, self.clock = engine, clock or (lambda: int(time.time()))
        self.storage = GatheringStore(engine, self.clock)
        self.speech = speech or LocalSpeech()
        self.live_reply = live_reply
        self.live_speech = live_speech

    def voices(self):
        return list(cloud_speech.CATALOG) + local_voices() if self.live_speech else local_voices()

    def preview(self, uid, cid, voice):
        self.read_settings(uid, cid)
        if cloud_speech.is_cloud_voice(voice):
            if not self.live_speech:
                fail('自然音色尚未开启', 'audio_unavailable')
            return cloud_speech.preview_audio(voice)
        return self.speech.synthesize('你好，我在这里。慢慢说，我听着呢。', voice)

    @staticmethod
    def owned(conn, uid, cid):
        from app.models.models import Character
        ch = conn.execute(select(Character.__table__).where(Character.id == cid,
            Character.owner_id == uid, Character.status == 'ready')).mappings().first()
        if not ch:
            fail('伙伴不存在或无权访问', 'not_found')
        return ch

    def settings(self, conn, uid, cid):
        from app.core.config import get_settings
        ch = self.owned(conn, uid, cid)
        row = conn.execute(select(preferences).where(preferences.c.character_id == cid,
            preferences.c.owner_id == uid)).mappings().first()
        if not row:
            voices = self.voices()
            # Match once; independent saved voice survives later persona edits.
            preferred = 'Tingting' if any(x in ch['persona'] for x in ('温柔', '安静')) else 'Meijia'
            voice = next((v['id'] for v in voices if preferred.lower() in v['id'].lower()), voices[0]['id'] if voices else '')
            if self.live_speech:
                voice = 'qwen:Serena' if preferred == 'Tingting' else 'qwen:Cherry'
            values = dict(character_id=cid, owner_id=uid, voice=voice, mood=None, automatic=1, mood_source='none')
            conn.execute(insert(preferences).values(**values))
            row = values
        grant = voice_sessions.latest(conn, uid, cid)
        live = voice_sessions.summary(grant, self.clock())
        if live:
            live['reserved_micro'] += cloud_speech.reserved_for_session(conn, grant['id'])
        origin = ('configured_model' if live['state'] == 'active' and self.live_reply else 'disabled') if live else reply_mode()
        if cloud_speech.is_cloud_voice(row['voice']) and not (live and live['state'] == 'active' and self.live_reply and self.live_speech):
            origin = 'disabled'
        return dict(voice=row['voice'], mood=row['mood'], automatic=bool(row['automatic']),
            mood_source=row['mood_source'], voices=self.voices(), transcription='local_optional', reply_origin=origin,
            live_session=live,
            transcription_status=transcription_status(get_settings().voice_local_model_path))

    def end_live_session(self, uid, cid):
        with self.storage.transaction() as conn:
            self.owned(conn, uid, cid)
            voice_sessions.revoke(conn, uid, cid)
            return self.settings(conn, uid, cid)

    def read_settings(self, uid, cid):
        with self.storage.transaction() as conn:
            return self.settings(conn, uid, cid)

    def save_settings(self, uid, cid, voice, mood, automatic):
        with self.storage.transaction() as conn:
            current = self.settings(conn, uid, cid)
            if voice != current['voice'] and voice not in {v['id'] for v in self.voices()}:
                fail('请选择可用音色', 'invalid_request')
            if mood is not None and mood not in MOODS:
                fail('请选择有效心情', 'invalid_request')
            conn.execute(update(preferences).where(preferences.c.character_id == cid).values(
                voice=voice, mood=mood, automatic=int(automatic), mood_source='user' if mood else 'none'))
            return self.settings(conn, uid, cid)

    def cleanup(self):
        with self.engine.begin() as conn:
            conn.execute(update(audio).where(audio.c.expires_at <= self.clock(), audio.c.state.in_(['ready', 'unavailable']))
                .values(data=None, state='expired'))
            cloud_speech.expire_responses(conn, self.clock())

    def history(self, uid, cid):
        self.cleanup()
        with self.engine.connect() as conn:
            self.owned(conn, uid, cid)
            return [dict(id=r['id'], round_id=r['round_id'], message_id=r['message_id'], role=r['role'],
                state=r['state'], voice=r['voice'], origin=r['origin'], created_at=r['created_at'], expires_at=r['expires_at'])
                for r in conn.execute(select(audio, rounds.c.origin).join(rounds, rounds.c.id == audio.c.round_id).where(audio.c.owner_id == uid,
                    audio.c.character_id == cid).order_by(audio.c.created_at, audio.c.role)).mappings()]

    def read_audio(self, uid, cid, aid):
        self.cleanup()
        with self.engine.connect() as conn:
            self.owned(conn, uid, cid)
            row = conn.execute(select(audio).where(audio.c.id == aid, audio.c.owner_id == uid,
                audio.c.character_id == cid, audio.c.state == 'ready')).mappings().first()
            if not row:
                fail('音频已到期、已删除或无权访问', 'not_found')
            return row['data'], row['mime']

    def receipts(self, uid, cid, request_id=None):
        with self.engine.connect() as conn:
            self.owned(conn, uid, cid)
            query = select(rounds.c.id, rounds.c.state, rounds.c.error, rounds.c.origin,
                           rounds.c.created_at, rounds.c.reply_message_id).where(rounds.c.owner_id == uid, rounds.c.character_id == cid)
            if request_id is not None:
                row = conn.execute(query.where(rounds.c.id == request_id)).mappings().first()
                if row is None:
                    fail('发送记录不存在或无权访问', 'not_found')
                return dict(row)
            return [dict(row) for row in conn.execute(query.order_by(
                rounds.c.created_at.desc(), rounds.c.id.desc()).limit(20)).mappings()]

    def delete_audio(self, uid, cid, aid):
        with self.storage.transaction() as conn:
            self.owned(conn, uid, cid)
            row = conn.execute(select(audio.c.id, audio.c.round_id, audio.c.role).where(audio.c.id == aid, audio.c.owner_id == uid,
                audio.c.character_id == cid)).first()
            if not row:
                fail('音频不存在', 'not_found')
            conn.execute(update(audio).where(audio.c.id == aid).values(data=None, state='deleted'))
            if row.role == 'assistant':
                cloud_speech.clear_responses(conn, cid, row.round_id)

    def retry_audio(self, uid, cid, aid):
        from app.models.models import Message
        self.cleanup()
        with self.storage.transaction() as conn:
            self.owned(conn, uid, cid)
            row = conn.execute(select(audio, rounds.c.state.label('round_state')).join(
                rounds, rounds.c.id == audio.c.round_id).where(audio.c.id == aid,
                audio.c.owner_id == uid, audio.c.character_id == cid)).mappings().first()
            if not row:
                fail('回复音频不存在或无权访问', 'not_found')
            if row['state'] == 'ready' and row['role'] == 'assistant':
                return dict(id=aid, state='ready', expires_at=row['expires_at'])
            if row['state'] == 'synthesizing':
                fail('回复音频正在准备，请刷新记录', 'conflict')
            if (row['role'] != 'assistant' or row['state'] != 'unavailable' or
                    row['expires_at'] <= self.clock() or row['round_state'] != 'completed' or
                    not row['voice'] or not row['message_id']):
                fail('这段回复音频不能重新生成', 'invalid_action')
            reply = conn.execute(select(Message.content).where(Message.id == row['message_id'],
                Message.character_id == cid, Message.role == 'assistant')).scalar_one_or_none()
            if not reply:
                fail('回复文字已不存在，不能重新生成音频', 'invalid_action')
            conn.execute(update(audio).where(audio.c.id == aid, audio.c.state == 'unavailable')
                .values(state='synthesizing'))
        try:
            if cloud_speech.is_cloud_voice(row['voice']):
                if not self.live_speech:
                    fail('自然音色尚未开启', 'audio_unavailable')
                output = self.live_speech.recover(uid, cid, row['round_id'])
            else:
                output = self.speech.synthesize(reply, row['voice'])
            if not output or len(output) > MAX_BYTES:
                raise ValueError('invalid synthesized audio')
        except Exception:
            with self.storage.transaction() as conn:
                conn.execute(update(audio).where(audio.c.id == aid, audio.c.owner_id == uid,
                    audio.c.character_id == cid, audio.c.state == 'synthesizing')
                    .values(state='unavailable'))
            fail('回复音频暂时无法生成，文字仍可阅读', 'audio_unavailable')
        with self.storage.transaction() as conn:
            self.owned(conn, uid, cid)
            current = conn.execute(select(audio.c.state, audio.c.expires_at, audio.c.round_id,
                audio.c.message_id).where(audio.c.id == aid, audio.c.owner_id == uid,
                audio.c.character_id == cid)).mappings().first()
            if (not current or current['state'] != 'synthesizing' or
                    not conn.execute(select(Message.id).where(Message.id == current['message_id'],
                        Message.character_id == cid, Message.role == 'assistant')).first()):
                fail('回复音频状态已变化，请刷新记录', 'conflict')
            now = self.clock()
            expires_at = now + RETENTION
            conn.execute(update(audio).where(audio.c.id == aid, audio.c.state == 'synthesizing')
                .values(state='ready', data=output, created_at=now, expires_at=expires_at))
            conn.execute(update(rounds).where(rounds.c.id == current['round_id'],
                rounds.c.state == 'completed', rounds.c.error == 'audio_unavailable').values(error=None))
            return dict(id=aid, state='ready', expires_at=expires_at)

    def send(self, uid, cid, rid, text, data, *, offline):
        from app.models.models import Message, Memory, Character, SceneProposal, SceneState
        from app.services.chat import build_messages, detect_scene_action
        from app.services.model_client import ModelClient
        from app.core.database import SessionLocal
        from app.services.input_limits import validate_text
        from app.services import scene_bridge as bridge
        from app.services import scene as scene_service
        from app.living.store import LivingStore
        from app.living.rules import CATALOG
        _uuid(rid)
        text = validate_text(text, 'message')
        digest = hashlib.sha256(data + b'\0' + text.encode()).hexdigest()
        mime = validate_audio(data)
        scoped = False
        with self.storage.transaction() as conn:
            self.owned(conn, uid, cid)
            existing = conn.execute(select(rounds).where(rounds.c.id == rid)).mappings().first()
            if existing:
                if existing['owner_id'] != uid or existing['character_id'] != cid:
                    fail('此发送记录不可访问', 'not_found')
                if existing['digest'] != digest:
                    fail('同一请求不能更换录音或文字', 'conflict')
                return dict(id=rid, state=existing['state'], error=existing['error'], origin=existing['origin'])
            grant = voice_sessions.latest(conn, uid, cid)
            if grant:
                if not self.live_reply:
                    fail('真实聊天服务尚未开启，录音未发送', 'voice_session_unavailable')
                voice_sessions.reserve(conn, grant, rid, self.clock())
                offline, scoped = False, True
            if not offline and not scoped and reply_mode() != 'configured_model':
                fail('语音正式回复尚未启用，请先使用文字交流')
            settings = self.settings(conn, uid, cid)
            if cloud_speech.is_cloud_voice(settings['voice']) and not (scoped and self.live_speech):
                fail('自然音色需要有效的真实聊天额度，录音未发送', 'voice_session_unavailable')
            conn.execute(delete(SceneProposal.__table__).where(SceneProposal.character_id == cid))
            message = conn.execute(insert(Message.__table__).values(character_id=cid, role='user', content=text).returning(Message.id)).scalar_one()
            now = self.clock()
            conn.execute(insert(rounds).values(id=rid, owner_id=uid, character_id=cid, digest=digest,
                state='running', created_at=now, user_message_id=message,
                origin='offline_fixture' if offline else 'configured_model'))
            conn.execute(insert(audio).values(id=str(uuid4()), round_id=rid, owner_id=uid, character_id=cid,
                message_id=message, role='user', mime=mime, created_at=now, expires_at=now + RETENTION,
                state='ready', data=data))
        reply_id = None
        try:
            living = LivingStore(self.engine, self.clock)
            with SessionLocal() as db:
                ch = db.get(Character, cid)
                history = db.query(Message).filter(Message.character_id == cid, Message.id < message).order_by(Message.id.desc()).limit(20).all()[::-1]
                saved = db.query(Memory).filter(Memory.character_id == cid).all()
                visiting = bridge.visiting_group(db, ch)
                row = bridge.current_space(db, living, ch)
                allowed = set(bridge.allowed_actions(row['scene_type'])) if row else None
                legacy_snapshot = None
                if row:
                    elements = bridge.elements_for(bridge.snapshot(living, row))
                else:
                    old_scene = db.query(SceneState).filter_by(character_id=cid).first()
                    legacy_snapshot = old_scene.state_json if old_scene else None
                    elements, _ = scene_service.deserialize(old_scene.state_json if old_scene else None)
                messages = build_messages(ch, saved, history, text, elements, allowed)
                append_mood_context(db, uid, cid, messages)
                append_life_context(db, uid, cid, messages)
                if row:
                    messages[0]['content'] += (f"\n伙伴当前生活场景：{CATALOG[row['scene_type']]['name']}。"
                        f"可提议的操作：{', '.join(bridge.allowed_actions(row['scene_type']))}。"
                        '不支持的操作请解释当前场景限制。')
                action = detect_scene_action(text)
                if visiting:
                    action = None
                if row and action not in allowed:
                    action = None
                binding = (row['id'] if row else None, row['revision'] if row else None, ch.location_epoch)
                db.commit()
            # The explicit offline path never touches a network-capable adapter.
            if scoped:
                with self.engine.connect() as conn:
                    current = voice_sessions.latest(conn, uid, cid)
                    if current['state'] != 'active' or current['in_flight'] != rid or current['expires_at'] <= self.clock():
                        fail('真实聊天已结束，本轮未调用模型')
                reply = self.live_reply(messages)
            else:
                reply = ModelClient()._mock_chat(messages).strip() if offline else configured_reply(messages)
            if not reply:
                raise ValueError('empty reply')
            with SessionLocal() as db:
                db.execute(sql_text('BEGIN IMMEDIATE'))
                self.owned(db, uid, cid)
                valid_round = db.execute(select(rounds.c.state).where(rounds.c.id == rid)).scalar_one()
                if valid_round != 'running' or not db.execute(select(Message.id).where(Message.id == message, Message.character_id == cid)).first():
                    fail('聊天已清空，本次回复取消')
                reply_id = db.execute(insert(Message.__table__).values(character_id=cid, role='assistant', content=reply).returning(Message.id)).scalar_one()
                db.execute(update(rounds).where(rounds.c.id == rid).values(reply_message_id=reply_id, state='text_ready'))
                if action and db.execute(select(Message.id).where(
                    Message.character_id == cid, Message.role == 'user').order_by(Message.id.desc()).limit(1)).scalar() == message:
                    current_ch = db.get(Character, cid)
                    current_row = bridge.current_space(db, living, current_ch)
                    current_legacy = db.query(SceneState).filter_by(character_id=cid).first() if not current_row else None
                    if (current_row is not None or
                            (current_legacy.state_json if current_legacy else None) == legacy_snapshot) and (
                            current_row['id'] if current_row else None,
                            current_row['revision'] if current_row else None,
                            current_ch.location_epoch) == binding:
                        db.add(SceneProposal(id=str(uuid4()), character_id=cid, message_id=reply_id,
                            action=action, space_id=binding[0], space_revision=binding[1],
                            location_epoch=binding[2]))
                db.commit()
            try:
                if cloud_speech.is_cloud_voice(settings['voice']):
                    output = self.live_speech.synthesize(reply, settings['voice'], uid=uid, cid=cid, rid=rid)
                else:
                    output = self.speech.synthesize(reply, settings['voice'])
            except Exception:
                output = None
            with self.storage.transaction() as conn:
                self.owned(conn, uid, cid)
                valid_round = conn.execute(select(rounds.c.state).where(rounds.c.id == rid)).scalar_one()
                if valid_round != 'text_ready' or not conn.execute(select(Message.id).where(Message.id == reply_id, Message.character_id == cid)).first():
                    fail('聊天已清空，本次音频取消')
                now = self.clock()
                conn.execute(insert(audio).values(id=str(uuid4()), round_id=rid, owner_id=uid, character_id=cid,
                    message_id=reply_id, role='assistant', mime='audio/wav', voice=settings['voice'],
                    created_at=now, expires_at=now + RETENTION, state='ready' if output else 'unavailable', data=output))
                conn.execute(update(rounds).where(rounds.c.id == rid).values(state='completed', error=None if output else 'audio_unavailable'))
                if scoped:
                    voice_sessions.finish(conn, rid, success=bool(output))
            return dict(id=rid, state='completed', error=None if output else 'audio_unavailable',
                origin='offline_fixture' if offline else 'configured_model')
        except Exception:
            with self.engine.begin() as conn:
                conn.execute(update(rounds).where(rounds.c.id == rid, rounds.c.state != 'cancelled').values(state='failed', error='reply_unavailable'))
                if scoped:
                    voice_sessions.finish(conn, rid, success=False)
            return dict(id=rid, state='failed', error='reply_unavailable',
                origin='offline_fixture' if offline else 'configured_model')

    def recover(self):
        # No hidden retry/re-synthesis after restart.
        with self.engine.begin() as conn:
            conn.execute(update(rounds).where(rounds.c.state.in_(['running', 'text_ready']))
                .values(state='failed', error='interrupted'))
            conn.execute(update(audio).where(audio.c.state == 'synthesizing').values(state='unavailable'))
            voice_sessions.recover(conn)
            cloud_speech.interrupt_pending(conn)
        self.cleanup()


def append_mood_context(db, uid, cid, messages, user_text=None):
    row = db.execute(select(preferences).where(preferences.c.character_id == cid,
        preferences.c.owner_id == uid)).mappings().first()
    if not row:
        return
    mood, source = row['mood'], row['mood_source']
    if row['automatic'] and source != 'user':
        current = user_text if user_text is not None else messages[-1]['content'] if messages[-1]['role'] == 'user' else ''
        mood = next((key for key, phrases in {
            'happy': ('我很开心', '我今天很开心'), 'sad': ('我很难过', '我今天有点难过'),
            'tired': ('我很累', '我今天很累', '我有点累', '我今天有点累'), 'anxious': ('我很紧张', '我有点紧张'),
            'calm': ('我很平静',)}.items() if any(p in current for p in phrases)), None)
        source = 'suggested' if mood else 'none'
        db.execute(update(preferences).where(preferences.c.character_id == cid).values(mood=mood, mood_source=source))
    if mood in MOODS:
        messages[0]['content'] += ('\n用户主动表达或纠正的当前心情：' if source == 'user' else '\n当前文字可能表达的心情（待用户确认，不是事实）：') + MOOD_LABELS[mood] + '。尊重用户纠正，保持原有性格；不作诊断，不要求用户安慰角色。'


def clear_audio(db, cid):
    cloud_speech.clear_responses(db, cid)
    from sqlalchemy import delete
    db.execute(delete(audio).where(audio.c.character_id == cid))
    db.execute(update(rounds).where(rounds.c.character_id == cid).values(state='cancelled', error='history_cleared'))
