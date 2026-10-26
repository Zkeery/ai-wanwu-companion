"""Opt-in bounded adapters. Empty operator paths leave production unchanged.

This module neither creates approvals nor starts a scheduler. It may be wired
only to an existing private approval ledger and the same production daily quota.
"""
from contextvars import ContextVar
import hashlib
import json
from pathlib import Path

import httpx
from sqlalchemy import select

from app.living.gatherings import fail
from app.living.life_provider import BASE_URL, MODEL, MaaSLifePlannerAdapter
from app.living.gathering_dialogue import MaaSDialogueAdapter
from app.services import cloud_speech, voice_sessions
from app.services.daily_model_quota import trial_dispatch_counts_once
from app.services.qwen_tts_candidate import FLASH_MODEL, _validated_audio_url
from app.services.trial_gate import TrialGate, TrialBlocked
from app.services.trial_transport import Envelope, TrialTransport, AsyncTrialTransport, TEXT_URL
from app.services.voice import VoiceService, rounds
from app.services.voice_reply import configured_reply


def private_json(path):
    path = Path(path)
    if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
        raise TrialBlocked('private_trial_file_required')
    try:
        if path.stat().st_size > 65536:
            raise ValueError()
        return json.loads(path.read_text())
    except Exception:
        raise TrialBlocked('trial_evidence_invalid') from None


def evidence_reader(path):
    def read(kind):
        try:
            return private_json(path)[kind]
        except (KeyError, TypeError):
            raise TrialBlocked('trial_evidence_missing') from None
    return read


def check_key(gate, vendor, key):
    if not isinstance(key, str) or not key or hashlib.sha256(key.encode()).hexdigest() != gate.policy['credentials'][vendor]:
        raise TrialBlocked('trial_credential_mismatch')


def preflight(gate, reader):
    try:
        gate.preflight_evidence(reader)
    except TrialBlocked:
        gate.stop('trial_preflight_blocked')


class SpeechClient:
    """The only POST is gated; asset GETs retain the original URL validation."""
    def __init__(self, gate, envelope, delegate_factory):
        self.gate, self.envelope = gate, envelope
        self.delegate_factory = delegate_factory
        self.post_client = None
        self.download = httpx.Client(transport=delegate_factory('download'), follow_redirects=False, trust_env=False)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        if self.post_client:
            self.post_client.close()
        self.download.close()

    def post(self, *args, **kwargs):
        if self.envelope is None:
            raise TrialBlocked('voice_request_context_missing')
        self.post_client = httpx.Client(transport=TrialTransport(self.envelope, self.delegate_factory('voice_tts')),
                                       follow_redirects=False, trust_env=False)
        with trial_dispatch_counts_once(self.gate.daily):
            return self.post_client.post(*args, **kwargs)

    def stream(self, method, url, **kwargs):
        if method != 'GET' or str(url) != _validated_audio_url(str(url)):
            raise TrialBlocked('asset_request_invalid')
        return self.download.stream(method, url, **kwargs)


class TrialVoiceService(VoiceService):
    def __init__(self, engine, gate, reader, settings, tts_key, *, delegate_factory=lambda kind: None):
        if gate.policy['mode'] != 'voice' or settings.model_base_url != BASE_URL or settings.chat_model != MODEL:
            raise TrialBlocked('voice_trial_configuration_invalid')
        check_key(gate, 'maas', settings.model_api_key)
        check_key(gate, 'bailian', tts_key)
        preflight(gate, reader)
        scope = gate.policy['scopes']['voice_text']
        try:
            cid = int(scope['subject'])
            if cid <= 0 or str(cid) != scope['subject']:
                raise ValueError()
        except ValueError:
            raise TrialBlocked('voice_subject_invalid') from None
        self.gate, self.reader, self.trial_settings = gate, reader, settings
        self.context = ContextVar('voice_trial_request', default=None)
        self.delegate_factory = delegate_factory
        # Scene snapshots require integer Unix seconds; the gate uses time.time().
        super().__init__(engine, lambda: int(gate.clock()), live_reply=self._reply)
        with engine.connect() as conn:
            self.owned(conn, scope['owner'], cid)
            grant = voice_sessions.latest(conn, scope['owner'], cid)
            if (not grant or grant['authorization_ref'] != gate.policy['authorization_ref']
                    or voice_sessions.summary(grant, int(gate.clock()))['state'] != 'active'
                    or grant['in_flight'] or not 1 <= grant['max_rounds'] <= 2
                    or grant['used_rounds'] != gate.summary()['counts']['voice_text']):
                raise TrialBlocked('matching_voice_session_required')
        self.live_speech = cloud_speech.QwenSpeech(engine, gate.clock,
            key_loader=lambda: tts_key, model_loader=lambda: FLASH_MODEL, client_factory=self._speech_client)

    def _scope(self, uid, cid):
        return self.gate.policy['scopes']['voice_text'] == {'owner': uid, 'subject': str(cid)}

    def settings(self, conn, uid, cid):
        value = super().settings(conn, uid, cid)
        if not self._scope(uid, cid):
            value['reply_origin'] = 'disabled'
        return value

    def _envelope(self, kind):
        current = self.context.get()
        if current is None:
            raise TrialBlocked('voice_request_context_missing')
        uid, cid, rid = current
        return Envelope(self.gate, kind, uid, str(cid), rid, lambda: self.reader(kind))

    def _speech_client(self):
        envelope = self._envelope('voice_tts') if self.context.get() else None
        return SpeechClient(self.gate, envelope, self.delegate_factory)

    def _reply(self, messages):
        preflight(self.gate, self.reader)
        def post(payload, settings):
            envelope = self._envelope('voice_text')
            with httpx.Client(transport=TrialTransport(envelope, self.delegate_factory('voice_text')),
                              follow_redirects=False, trust_env=False) as client:
                with trial_dispatch_counts_once(self.gate.daily):
                    response = client.post(TEXT_URL, json=payload,
                        headers={'Authorization': 'Bearer ' + settings.model_api_key}, timeout=30)
            return response.json()['choices'][0]['message']['content']
        settings = self.trial_settings.model_copy(update={'voice_live_reply_enabled': True,
            'model_max_retries': 0, 'model_enable_thinking': False})
        return configured_reply(messages, settings=settings, max_payload_bytes=32768, post=post)

    def send(self, uid, cid, rid, text, data, *, offline):
        with self.engine.connect() as conn:
            self.owned(conn, uid, cid)
        if not self._scope(uid, cid):
            fail('这个伙伴未取得本次语音试跑授权', 'voice_session_unavailable')
        # Existing receipts may be read/replayed after a stop without new calls.
        with self.engine.connect() as conn:
            existing = conn.execute(select(rounds.c.id).where(rounds.c.id == rid)).first()
        if existing:
            return super().send(uid, cid, rid, text, data, offline=offline)
        try:
            preflight(self.gate, self.reader)
            with self.engine.connect() as conn:
                if self.settings(conn, uid, cid)['voice'] != 'qwen:Cherry':
                    raise TrialBlocked('trial_requires_selected_cherry')
        except TrialBlocked:
            try:
                self.gate.stop('voice_trial_preflight_blocked')
            except TrialBlocked:
                fail('语音试跑条件未核清，本轮没有发送', 'voice_session_unavailable')
        token = self.context.set((uid, cid, rid))
        try:
            result = super().send(uid, cid, rid, text, data, offline=False)
            if result['state'] == 'failed' or result.get('error'):
                try:
                    self.gate.stop('voice_delivery_failed')
                except TrialBlocked:
                    pass
            return result
        finally:
            self.context.reset(token)


class TrialLifeFactories:
    def __init__(self, gate, reader, key, *, delegate_factory=lambda kind: None, engine=None):
        if gate.policy['mode'] not in ('life', 'shared_dialogue'):
            raise TrialBlocked('life_trial_configuration_invalid')
        check_key(gate, 'maas', key)
        preflight(gate, reader)
        self.gate, self.reader, self.key, self.delegate_factory = gate, reader, key, delegate_factory
        self.engine = engine

    def _manual_shared_task(self, owner, subject, operation):
        """Bind the new approval to one persisted manual grant, never an auto task."""
        from app.living.gathering_dialogue import grants, tasks
        from app.living.gathering_automatic import links
        if self.engine is None:
            raise TrialBlocked('manual_shared_task_required')
        with self.engine.connect() as conn:
            row = conn.execute(select(grants.c.authorization_ref, grants.c.characters_json, grants.c.expires_at)
                .select_from(tasks.join(grants, tasks.c.grant_id == grants.c.id))
                .where(tasks.c.id == operation, tasks.c.owner_id == owner, tasks.c.group_id == subject,
                       tasks.c.state == 'running', grants.c.owner_id == owner, grants.c.group_id == subject,
                       grants.c.used == 1)).mappings().first()
            automatic = conn.execute(select(links.c.task_id).where(links.c.task_id == operation)).first()
        if (not row or automatic or row['authorization_ref'] != self.gate.policy['authorization_ref']
                or json.loads(row['characters_json']) != self.gate.policy['character_ids']
                or not self.gate.clock() < row['expires_at'] <= self.gate.policy['ends_at']):
            raise TrialBlocked('manual_shared_task_required')

    def adapter(self, kind, owner, subject, operation, *, presence):
        if kind not in ('private_life', 'shared_life') or self.gate.policy['scopes'].get(kind) != {'owner': owner, 'subject': subject}:
            raise TrialBlocked('scope_mismatch')
        if self.gate.policy['mode'] == 'shared_dialogue':
            self._manual_shared_task(owner, subject, operation)
        preflight(self.gate, self.reader)
        envelope = Envelope(self.gate, kind, owner, subject, operation, lambda: self.reader(kind), presence=presence)
        transport = AsyncTrialTransport(envelope, self.delegate_factory(kind))
        gate = self.gate
        class Planner(MaaSLifePlannerAdapter):
            async def plan(self, prompt):
                with trial_dispatch_counts_once(gate.daily):
                    return await super().plan(prompt)
        class Dialogue(MaaSDialogueAdapter):
            async def exchange(self, facts):
                with trial_dispatch_counts_once(gate.daily):
                    return await super().exchange(facts)
        return (Planner if kind == 'private_life' else Dialogue)(self.key, transport=transport)


def configure_trials(engine, settings, quota, environ):
    """Default off; no grant insertion, provider request or task creation here."""
    voice_path = environ.get('PARTNER_VOICE_TRIAL_LEDGER', '').strip()
    life_path = environ.get('PARTNER_LIFE_TRIAL_LEDGER', '').strip()
    evidence_path = environ.get('PARTNER_TRIAL_EVIDENCE_FILE', '').strip()
    shared_path = environ.get('PARTNER_SHARED_DIALOGUE_TRIAL_LEDGER', '').strip()
    shared_evidence = environ.get('PARTNER_SHARED_DIALOGUE_TRIAL_EVIDENCE_FILE', '').strip()
    if sum(bool(path) for path in (voice_path, life_path, shared_path)) > 1:
        raise TrialBlocked('one_trial_phase_at_a_time')
    if shared_path:
        if evidence_path or not shared_evidence:
            raise TrialBlocked('independent_shared_evidence_required')
        ledger = Path(shared_path)
        if ledger.is_symlink() or ledger.stat().st_mode & 0o077:
            raise TrialBlocked('private_trial_file_required')
        gate = TrialGate(shared_path, quota)
        if gate.policy['mode'] != 'shared_dialogue' or settings.model_base_url != BASE_URL:
            raise TrialBlocked('shared_dialogue_configuration_invalid')
        from app.services.trial_admission import shared_dialogue_evidence_reader
        reader = shared_dialogue_evidence_reader(shared_evidence, gate, clock=gate.clock)
        factory = TrialLifeFactories(gate, reader, settings.model_api_key, engine=engine)
        return {'voice': None, 'life': None, 'shared_dialogue': factory}
    if shared_evidence:
        raise TrialBlocked('trial_ledger_missing')
    if not voice_path and not life_path:
        if evidence_path:
            raise TrialBlocked('trial_ledger_missing')
        return {'voice': None, 'life': None}
    reader = evidence_reader(evidence_path)
    result = {'voice': None, 'life': None}
    for kind, path in [('voice', voice_path), ('life', life_path)]:
        if not path:
            continue
        private_json_policy = Path(path)
        if private_json_policy.is_symlink() or private_json_policy.stat().st_mode & 0o077:
            raise TrialBlocked('private_trial_file_required')
        gate = TrialGate(path, quota)
        if kind == 'voice':
            from app.services.transcription_config import transcription_status
            if transcription_status(settings.voice_local_model_path) != 'configured':
                raise TrialBlocked('offline_transcription_required')
            result[kind] = TrialVoiceService(engine, gate, reader, settings, cloud_speech.project_tts_key())
        else:
            if settings.model_base_url != BASE_URL:
                raise TrialBlocked('life_trial_configuration_invalid')
            if settings.app_env == 'production':
                from app.services.trial_admission import live_evidence_reader
                reader = live_evidence_reader(evidence_path, gate, clock=gate.clock)
            result[kind] = TrialLifeFactories(gate, reader, settings.model_api_key)
    return result
