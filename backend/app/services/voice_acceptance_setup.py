"""One-round voice preparation. Never sends, starts workers or enables the site."""
from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3
import time

from sqlalchemy import update

from app.services import voice_sessions
from app.services.trial_admission import validate_evidence
from app.services.trial_gate import TrialBlocked, TrialGate, validate_policy
from app.services.trial_wiring import BASE_URL, MODEL
from app.services.transcription_config import transcription_status


def plan(engine, owner, cid):
    if not owner or type(cid) is not int or cid <= 0:
        raise TrialBlocked('explicit_voice_target_required')
    # No metadata creation, session grant or preference mutation in this path.
    with engine.connect() as conn:
        row = conn.exec_driver_sql(
            'SELECT owner_id,status FROM characters WHERE id=?', (cid,)).fetchone()
    if not row or row[0] != owner or row[1] != 'ready':
        raise TrialBlocked('owned_ready_character_required')
    return {'status': 'planned', 'character_id': cid, 'max_rounds': 1,
            'budget_micro': 1200000, 'automatic_retries': 0, 'new_model_posts': 0,
            'service_enabled': False, 'owner_identity_disclosed': False}


def policy_for(engine, settings, tts_key, approval, evidence, now):
    owner, cid = approval.get('owner_id'), approval.get('character_id')
    plan(engine, owner, cid)
    expected = {'approved_for_real_model_calls': True, 'phase': 'voice_one_round',
                'max_rounds': 1, 'budget_micro': 1200000, 'automatic_retries': 0}
    if any(type(approval.get(k)) is not type(v) or approval.get(k) != v for k, v in expected.items()):
        raise TrialBlocked('explicit_one_round_authorization_required')
    ref = approval.get('authorization_ref')
    if not isinstance(ref, str) or not 8 <= len(ref) <= 120:
        raise TrialBlocked('new_voice_authorization_required')
    if (settings.voice_live_reply_enabled or settings.model_max_retries != 0
            or settings.model_base_url != BASE_URL or settings.chat_model != MODEL
            or transcription_status(settings.voice_local_model_path) != 'configured'):
        raise TrialBlocked('voice_configuration_not_ready')
    proof = validate_evidence(evidence, ref, ('voice_text', 'voice_tts'), now,
                              {'maas': 1145600, 'bailian': 54400})
    credentials = {'maas': settings.model_api_key, 'bailian': tts_key}
    if any(not isinstance(key, str) or not key for key in credentials.values()):
        raise TrialBlocked('project_credentials_required')
    hashes = {vendor: hashlib.sha256(key.encode()).hexdigest() for vendor, key in credentials.items()}
    if hashes != approval.get('credentials_sha256'):
        raise TrialBlocked('approved_project_credentials_required')
    ends = proof['expires_at'] - 60
    if ends - now < 300:
        raise TrialBlocked('voice_proof_window_too_short')
    with engine.connect() as conn:
        old = voice_sessions.latest(conn, owner, cid)
        if old and (old['in_flight'] or voice_sessions.summary(old, now)['state'] == 'active'):
            raise TrialBlocked('previous_voice_session_unresolved')
    policy = {'approved': True, 'authorization_ref': ref, 'mode': 'voice',
              'starts_at': now, 'ends_at': ends, 'budget_micro': 1200000,
              'scopes': {k: {'owner': owner, 'subject': str(cid)} for k in ('voice_text', 'voice_tts')},
              'accounts': proof['accounts'], 'credentials': hashes}
    return validate_policy(policy)


def _backup(source, target):
    source = Path(source)
    if source.is_symlink() or not source.is_file():
        raise TrialBlocked('source_database_invalid')
    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as src:
        with closing(sqlite3.connect(target)) as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise TrialBlocked('database_backup_invalid')
    target.chmod(0o600)


def prepare(engine, settings, quota, tts_key, approval, evidence, directory, *, clock=time.time):
    from app.services.life_acceptance_worker import save_json
    from app.services.trial_wiring import TrialVoiceService
    now = int(clock())
    policy = policy_for(engine, settings, tts_key, approval, evidence, now)
    directory = Path(directory)
    if directory.is_symlink() or directory.exists() or directory.parent.is_symlink():
        raise TrialBlocked('unique_voice_directory_required')
    directory.mkdir(mode=0o700)
    gate = None
    try:
        _backup(engine.url.database, directory / 'business.before.db')
        _backup(quota.path, directory / 'daily.before.db')
        save_json(directory / 'evidence.json', evidence, exclusive=True)
        gate = TrialGate.create(directory / 'trial.db', quota, policy, clock=clock)
        gate.preflight_evidence(lambda kind: evidence[kind])
        uid, cid = approval['owner_id'], approval['character_id']
        with engine.begin() as conn:
            # Recheck under the same write transaction as the session grant.
            row = conn.exec_driver_sql('SELECT owner_id,status FROM characters WHERE id=?', (cid,)).fetchone()
            if not row or row[0] != uid or row[1] != 'ready':
                raise TrialBlocked('voice_target_changed')
            voice_sessions.authorize(conn, uid, cid, policy['authorization_ref'], 1, now)
            conn.execute(update(voice_sessions.sessions).where(
                voice_sessions.sessions.c.authorization_ref == policy['authorization_ref']
            ).values(expires_at=policy['ends_at']))
        # Validate the same service installed by ecs_partner_serve; no send().
        service = TrialVoiceService(engine, gate, lambda k: evidence[k], settings, tts_key)
        service.read_settings(uid, cid)
        current = service.read_settings(uid, cid)
        service.save_settings(uid, cid, 'qwen:Cherry', current['mood'], current['automatic'])
        result = {'status': 'prepared', 'character_id': cid, 'max_rounds': 1,
                  'budget_micro': 1200000, 'ends_at': policy['ends_at'],
                  'new_model_posts': 0, 'service_enabled': False, 'automatic_retries': 0}
        save_json(directory / 'ready.json', result, exclusive=True)
        return result
    except BaseException:
        # Retain evidence and backups. A failed preparation cannot be resumed.
        if gate is not None:
            try:
                gate.stop('voice_preparation_failed')
            except TrialBlocked:
                pass
            with engine.begin() as conn:
                conn.execute(update(voice_sessions.sessions).where(
                    voice_sessions.sessions.c.authorization_ref == policy['authorization_ref']
                ).values(state='failed', in_flight=None))
        raise
