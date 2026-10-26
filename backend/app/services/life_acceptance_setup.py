"""Prepare isolated business data. Live preparation requires a new explicit approval.

Nothing here sends a model request, enables an application service or changes
the production living spaces. The live entry is not used by free simulations.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import os
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

from sqlalchemy import create_engine, insert, update

from app.core.database import Base
from app.models.models import User, Photo, Object, Character
from app.living.store import metadata
from app.living.life_runtime import LifeRuntime
from app.living.life_provider import RESERVE_MICRO
from app.living.gathering_automatic import AutomaticDialogueStore
from app.services.daily_model_quota import DailyModelQuota
from app.services.trial_gate import TrialBlocked, TrialGate
from app.services.trial_wiring import private_json


def create_business(directory, owner, characters, private_id, shared_ids, ref, now):
    directory = Path(directory)
    seeds = {int(x['id']): x for x in characters}
    if (len(seeds) != 2 or len(set(shared_ids)) != 2 or set(shared_ids) != set(seeds)
            or private_id not in seeds or not owner):
        raise TrialBlocked('two_owned_character_seeds_required')
    # Shared commands query Mahjong and floor state even when both are empty.
    # Register their additive tables before creating either isolated database.
    from app.living import gathering_mahjong, villa_floor  # noqa: F401
    for name in ('private.db', 'shared.db'):
        with (directory / name).open('xb'):
            pass
        (directory / name).chmod(0o600)
    engines = [create_engine('sqlite:///' + str(directory / name))
               for name in ('private.db', 'shared.db')]
    scope = {'owner': owner, 'private_subject': str(uuid4()), 'shared_subject': None,
             'private_character_id': private_id, 'shared_character_ids': shared_ids}
    try:
        for engine, ids in zip(engines, [[private_id], shared_ids]):
            Base.metadata.create_all(engine)
            metadata.create_all(engine)
            with engine.begin() as db:
                # Required relational stub only; no production phone/photo is copied.
                db.execute(insert(User).values(id=owner, phone='13900000981'))
                db.execute(insert(Photo).values(id=1, filename='isolated-acceptance-only.png', status='done', owner_id=owner))
                db.execute(insert(Object).values(id=1, photo_id=1, label='隔离验收对象'))
                for cid in ids:
                    seed = seeds[cid]
                    db.execute(insert(Character).values(id=cid, object_id=1, owner_id=owner,
                        name=seed['name'], persona=seed['persona'], opening_line=seed.get('opening_line', ''),
                        status='ready', location_epoch=1))
        runtime = LifeRuntime(engines[0], lambda: int(now), origin='real_provider')
        runtime.initialize()
        sid = scope['private_subject']
        runtime.store.create_space(owner, sid, 'home', 'private', str(private_id))
        with engines[0].begin() as db:
            db.execute(update(Character).where(Character.id == private_id).values(current_space_id=sid))
        runtime.save_permission(owner, sid, str(uuid4()), 0, True, ('rest', 'walk'))
        runtime.set_limit('project', 3 * RESERVE_MICRO, ref)
        runtime.set_limit('space:' + sid, 3 * RESERVE_MICRO, ref)
        runtime.save_automatic(owner, sid, str(uuid4()), 0, True)
        runtime.save_viewing(owner, sid, str(uuid4()), 1, True)
        store = AutomaticDialogueStore(engines[1], lambda: int(now))
        group = store.create(owner, str(uuid4()), '隔离验收共享场景', '验收', 'home')
        for cid in shared_ids:
            for action, values in [('visit', {'character_id': cid}),
                                   ('dialogue_consent', {'character_id': cid, 'enabled': True})]:
                group = store.command(owner, group['id'], str(uuid4()), group['revision'], dict(action=action, **values))
        group = store.command(owner, group['id'], str(uuid4()), group['revision'], dict(action='dialogue_space', enabled=True))
        scope['shared_subject'] = group['id']
        grant = store.authorize_session(owner, group['id'], shared_ids, 3, ref,
                                        project_cap_micro=3 * RESERVE_MICRO, space_cap_micro=3 * RESERVE_MICRO)
        store.configure(owner, group['id'], str(uuid4()), 0, True, grant)
        store.viewing(owner, group['id'], str(uuid4()), True)
    finally:
        for engine in engines:
            engine.dispose()
    return scope


def prepare_approved(directory, approval_file, evidence_file):
    """Future paid phase only. No production call is made even on success."""
    from app.services.life_acceptance_worker import save_json, source_manifest
    approval = private_json(approval_file)
    required = {'approved_for_real_model_calls': True, 'phase': 'life_24h',
                'budget_micro': 7000000, 'max_requests': 6, 'per_group': 3, 'seconds': 86400}
    if any(approval.get(k) != v or type(approval.get(k)) is not type(v) for k, v in required.items()):
        raise TrialBlocked('explicit_live_authorization_required')
    ref = approval.get('authorization_ref')
    if not isinstance(ref, str) or not 8 <= len(ref) <= 120 or ref.startswith(('synthetic', 'simulation')):
        raise TrialBlocked('new_live_authorization_ref_required')
    private_id, shared_ids = approval.get('private_character_id'), approval.get('shared_character_ids')
    if (private_id != 6 or not isinstance(shared_ids, list) or len(shared_ids) != 2
            or any(type(cid) is not int for cid in shared_ids) or len(set(shared_ids)) != 2 or 6 not in shared_ids):
        raise TrialBlocked('approved_character_scope_required')
    now = int(time.time())
    if (approval.get('first_observed_pair_confirmed') is not True
            or type(approval.get('observer_confirmed_at')) is not int
            or not 0 <= now - approval['observer_confirmed_at'] <= 60):
        raise TrialBlocked('fresh_owner_observation_required')
    key = os.environ.get('PARTNER_ACCEPTANCE_MAAS_KEY', '')
    if not key or hashlib.sha256(key.encode()).hexdigest() != approval.get('credential_sha256'):
        raise TrialBlocked('approved_project_credential_required')
    from app.services.accounting_proof_refresh import read_published
    evidence = read_published(evidence_file, ref)
    check_admission(approval, evidence, now=now)
    source = Path('/opt/wanwu-partner/data/app.db')
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute('SELECT id,owner_id,name,persona,opening_line,status FROM characters WHERE id IN (?,?)', shared_ids).fetchall()
    if (len(rows) != 2 or len({r['owner_id'] for r in rows}) != 1 or any(r['status'] != 'ready' for r in rows)
            or hashlib.sha256(str(rows[0]['owner_id']).encode()).hexdigest() != approval.get('owner_sha256')):
        raise TrialBlocked('approved_owner_or_character_changed')
    owner = rows[0]['owner_id']
    seeds = [{k: r[k] for k in ('id', 'name', 'persona', 'opening_line')} for r in rows]
    directory = Path(directory)
    if directory.parent.resolve() != Path('/opt/wanwu-partner/acceptance-private').resolve():
        raise TrialBlocked('isolated_live_parent_required')
    directory.mkdir(mode=0o700, exist_ok=False)
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
        with closing(sqlite3.connect(directory / 'production-source.before.db')) as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise TrialBlocked('source_backup_invalid')
    (directory / 'production-source.before.db').chmod(0o600)
    # Preserve the original account-wide quota before adding this approval.
    daily_path = Path('/opt/wanwu-partner/data/daily-model-requests.db')
    with closing(sqlite3.connect(daily_path.as_uri() + '?mode=ro', uri=True)) as src:
        with closing(sqlite3.connect(directory / 'daily.db')) as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise TrialBlocked('quota_backup_invalid')
    (directory / 'daily.db').chmod(0o600)
    scope = create_business(directory, owner, seeds, private_id, shared_ids, ref, now)
    policy = {'approved': True, 'authorization_ref': ref, 'mode': 'life', 'starts_at': now,
        'ends_at': now + 86400, 'budget_micro': 7000000,
        'scopes': {'private_life': {'owner': owner, 'subject': scope['private_subject']},
                   'shared_life': {'owner': owner, 'subject': scope['shared_subject']}},
        'accounts': {'maas': evidence['private_life']['wallet']['account']},
        'credentials': {'maas': approval['credential_sha256']}}
    gate = TrialGate.create(directory / 'trial.db', DailyModelQuota(daily_path, 30), policy)
    save_json(directory / 'evidence.json', evidence, exclusive=True)
    try:
        gate.preflight_evidence(lambda kind: evidence[kind])
    except BaseException:
        try:
            gate.stop('live_preparation_not_admitted')
        except TrialBlocked:
            pass
        raise
    manifest = {'schema_version': 1, 'origin': 'real_wall_clock', 'starts_at': now,
        'authorization_ref': ref, 'scope': scope, 'live_daily_quota_path': str(daily_path),
        'limits': {'seconds': 86400, 'per_group': 3, 'total': 6, 'budget_micro': 7000000,
                   'max_gap': 120, 'interval': 30, 'auto_retry': 0}}
    save_json(directory / 'manifest.json', manifest, exclusive=True)
    save_json(directory / 'live-authorization.json', approval, exclusive=True)
    save_json(directory / 'manifest-binding.json',
              {'sha256': hashlib.sha256((directory / 'manifest.json').read_bytes()).hexdigest()}, exclusive=True)
    save_json(directory / 'source-manifest.json', source_manifest(), exclusive=True)
    return {'status': 'prepared', 'evidence_origin': 'real_wall_clock', 'model_requests': 0,
            'automatic_worker_started': False, 'real_acceptance_passed': False}


def check_admission(approval, evidence, *, now=None):
    """Read-only financial/scope readiness, not permission to start a worker."""
    from app.services.trial_admission import validate_evidence
    now = int(time.time()) if now is None else int(now)
    expected = {'approved_for_real_model_calls': True, 'phase': 'life_24h',
                'budget_micro': 7000000, 'max_requests': 6, 'per_group': 3, 'seconds': 86400}
    if any(type(approval.get(k)) is not type(v) or approval.get(k) != v for k, v in expected.items()):
        raise TrialBlocked('explicit_live_authorization_required')
    ref = approval.get('authorization_ref')
    ids = approval.get('shared_character_ids')
    if (not isinstance(ref, str) or not 8 <= len(ref) <= 120
            or ref.startswith(('synthetic', 'simulation'))
            or type(approval.get('private_character_id')) is not int
            or approval['private_character_id'] != 6
            or not isinstance(ids, list) or len(ids) != 2
            or any(type(x) is not int or x <= 0 for x in ids)
            or len(set(ids)) != 2 or 6 not in ids):
        raise TrialBlocked('approved_character_scope_required')
    checked = validate_evidence(evidence, ref, ('private_life', 'shared_life'), now, {'maas': 6873600})
    return {'status': 'ready_for_preparation', 'funds_and_price_expires_at': checked['expires_at'],
            'budget_micro': 7000000, 'max_requests': 6, 'seconds': 86400,
            'automatic_retries': 0, 'worker_started': False, 'new_model_posts': 0,
            'remaining_checks': ['fresh_owner_observation', 'project_credential_binding',
                                 'owned_ready_characters', 'isolated_backups_and_source_freeze']}
