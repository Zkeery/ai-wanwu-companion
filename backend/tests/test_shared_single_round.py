"""Independent shared dialogue acceptance using synthetic approvals and no network."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import insert

from app.core.config import Settings
from app.core.database import engine
from app.living.gathering_automatic import links
from app.living.gathering_dialogue import DialogueStore, grants, run_exchange
from app.services import accounting_proof_refresh as funding, trial_wiring as wiring
from app.services.daily_model_quota import DailyModelQuota
from app.services.trial_admission import bounded_shared_dialogue_grant, shared_dialogue_evidence_reader
from app.services.trial_gate import TrialGate, TrialBlocked, PRICE_CAPS, validate_policy
from app.services.trial_transport import Envelope, TrialTransport, TEXT_URL
from scripts import prepare_shared_dialogue_trial as preparation
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_gathering_activity_areas import area_world, dialogue_pair
from tests.test_gatherings import command
from tests.test_trial_guards import payload, text_result

KEY = 'synthetic-shared-one-key'
RESERVE = 1_145_600


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def deny(*_a, **_kw):
        raise AssertionError('NETWORK_FORBIDDEN')
    monkeypatch.setattr('socket.socket.connect', deny)
    monkeypatch.setattr('socket.socket.connect_ex', deny)


def policy(now, *, owner='owner', subject='space', pair=None):
    return dict(approved=True, authorization_ref='shared-dialogue-synthetic-0001', mode='shared_dialogue',
                starts_at=now, ends_at=now + 300, budget_micro=1_200_000,
                scopes={'shared_life': {'owner': owner, 'subject': subject}}, character_ids=pair or [1, 2],
                max_requests=1, accounts={'maas': 'synthetic-account'},
                credentials={'maas': hashlib.sha256(KEY.encode()).hexdigest()})


def proof(p, now):
    base = dict(verified=True, vendor='maas', currency='CNY', checked_at=now,
                authorization_ref=p['authorization_ref'])
    return {'shared_life': dict(
        wallet=dict(base, account=p['accounts']['maas'], available_micro=RESERVE, pending_micro=0,
                    pending_complete=True, source_type='official_console'),
        price=dict(base, model='qwen3.8-flash', rates=PRICE_CAPS['maas'].copy(), on_sale=True))}


def write(path, value):
    path.write_text(json.dumps(value)); path.chmod(0o600)


@pytest.fixture
def single(tmp_path):
    now = [1_800_000_000]
    p = policy(now[0])
    daily = DailyModelQuota(tmp_path / 'daily.db', 30, clock=lambda: now[0])
    gate = TrialGate.create(tmp_path / 'single.db', daily, p, clock=lambda: now[0])
    return gate, now, proof(p, now[0])


def send(gate, data, *, operation='synthetic-call-0001', owner='owner', subject='space', pair=None, handler=None):
    body = payload('shared_life')
    body['messages'][-1]['content'] = json.dumps({'participants': [{'character_id': cid} for cid in pair or [1, 2]]})
    envelope = Envelope(gate, 'shared_life', owner, subject, operation, lambda: data['shared_life'])
    result = dict(lines=[dict(character_id=cid, text='合成共同交流。', item_ids=[]) for cid in pair or [1, 2]])
    transport = TrialTransport(envelope, httpx.MockTransport(handler or (
        lambda _r: httpx.Response(200, json=text_result(json.dumps(result))))))
    with httpx.Client(transport=transport) as client:
        return client.post(TEXT_URL, headers={'Authorization': 'Bearer ' + KEY}, json=body)


@pytest.mark.parametrize('field,value', [
    ('mode', 'life'), ('max_requests', 2), ('max_requests', True),
    ('budget_micro', 1_200_001), ('budget_micro', RESERVE - 1),
    ('character_ids', [1, 1]), ('character_ids', [True, 2]),
    ('authorization_ref', 'old-seven-yuan-approval'), ('ends_at', 1_800_000_901),
])
def test_invalid_or_reused_shape_is_rejected_without_a_file(tmp_path, field, value):
    p = policy(1_800_000_000); p[field] = value
    with pytest.raises(TrialBlocked):
        validate_policy(p)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize('mutation', ['pending-unknown', 'unsettled-shortfall', 'stale', 'not-sale', 'old-ref', 'extra-life-scope', 'deadline'])
def test_complete_funds_and_deadline_are_checked_before_quota_or_ledger_writes(tmp_path, monkeypatch, mutation):
    now = 1_800_000_000
    p, data = policy(now), proof(policy(now), now)
    if mutation == 'pending-unknown':
        data['shared_life']['wallet']['pending_complete'] = False
    elif mutation == 'unsettled-shortfall':
        data['shared_life']['wallet']['pending_micro'] = 1
    elif mutation == 'stale':
        data['shared_life']['wallet']['checked_at'] -= 901
    elif mutation == 'not-sale':
        data['shared_life']['price']['on_sale'] = False
    elif mutation == 'old-ref':
        data['shared_life']['wallet']['authorization_ref'] = 'old-seven-yuan-approval'
    elif mutation == 'extra-life-scope':
        data['private_life'] = copy.deepcopy(data['shared_life'])
    else:
        data['shared_life']['wallet']['checked_at'] -= 700
    write(tmp_path / 'approval.json', p); write(tmp_path / 'evidence.json', data)
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    monkeypatch.setattr(preparation, 'DailyModelQuota', lambda *_a, **_kw: pytest.fail('quota must not be constructed'))
    with pytest.raises(TrialBlocked):
        preparation.prepare(tmp_path / 'approval.json', tmp_path / 'evidence.json',
                            tmp_path / 'new.db', tmp_path / 'absent-daily.db', create=True, clock=lambda: now)
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before


def test_default_check_is_read_only_and_explicit_create_never_creates_a_grant(tmp_path, monkeypatch):
    tmp_path.chmod(0o700)
    now = 1_800_000_000; p = policy(now)
    daily = DailyModelQuota(tmp_path / 'daily.db', 30, clock=lambda: now)
    write(tmp_path / 'approval.json', p); write(tmp_path / 'evidence.json', proof(p, now))
    # SQLite's read-only WAL reader uses existing SHM lock slots; those are
    # transient coordination bytes, not a business write or a new file.
    def snapshot():
        return {path.name: None if path.name.endswith('-shm') else path.read_bytes() for path in tmp_path.iterdir()}
    before = snapshot()
    with monkeypatch.context() as guard:
        guard.setattr(preparation, 'DailyModelQuota', lambda *_a, **_kw: pytest.fail('dry-run must not construct quota'))
        guard.setattr(sqlite3, 'connect', lambda *_a, **_kw: pytest.fail('dry-run must not open SQLite or sidecars'))
        result = preparation.prepare(tmp_path / 'approval.json', tmp_path / 'evidence.json',
                                     tmp_path / 'new.db', daily.path, clock=lambda: now)
    assert result['status'] == 'checked' and not result['ledger_created'] and not result['grant_created']
    assert snapshot() == before
    result = preparation.prepare(tmp_path / 'approval.json', tmp_path / 'evidence.json',
                                 tmp_path / 'new.db', daily.path, create=True, clock=lambda: now)
    assert result['status'] == 'prepared_not_started' and not result['worker_started']
    assert not result['grant_created'] and result['new_model_posts'] == 0
    before = snapshot()
    with pytest.raises(TrialBlocked, match='approval_already_used'):
        preparation.prepare(tmp_path / 'approval.json', tmp_path / 'evidence.json',
                            tmp_path / 'another.db', daily.path, create=True, clock=lambda: now)
    assert snapshot() == before


def test_one_post_is_terminal_across_restart_and_new_operation(single):
    gate, now, data = single
    assert send(gate, data).status_code == 200
    assert gate.summary() == dict(state='completed', attempts=1, reserved_micro=RESERVE,
                                  counts={'shared_life': 1}, unknown=0)
    reopened = TrialGate(gate.path, gate.daily, clock=lambda: now[0])
    with pytest.raises(TrialBlocked):
        send(reopened, data, operation='another-operation')
    assert reopened.summary()['attempts'] == 1 and gate.daily.status()['used'] == 1


def test_ledger_reopen_rejects_symlink_and_quota_hardlink_without_following(single, tmp_path):
    gate, now, _ = single
    original = tmp_path / 'preserved.db'
    gate.path.rename(original)
    gate.path.symlink_to(original)
    with pytest.raises(TrialBlocked):
        gate.summary()
    alias = tmp_path / 'quota-alias.db'
    os.link(gate.daily.path, alias)
    with pytest.raises(TrialBlocked, match='ledger_or_daily_guard_invalid'):
        TrialGate(alias, gate.daily, clock=lambda: now[0])
    assert gate.daily.status()['used'] == 0


@pytest.mark.parametrize('failure', ['http', 'timeout', 'bad-usage'])
def test_first_error_retains_unknown_and_never_retries(single, failure):
    gate, now, data = single; calls = []
    def handler(_request):
        calls.append(1)
        if failure == 'timeout':
            raise httpx.ReadTimeout('synthetic')
        if failure == 'http':
            return httpx.Response(503)
        result = text_result('{}'); result.pop('usage')
        return httpx.Response(200, json=result)
    with pytest.raises(TrialBlocked):
        send(gate, data, handler=handler)
    reopened = TrialGate(gate.path, gate.daily, clock=lambda: now[0])
    with pytest.raises(TrialBlocked):
        send(reopened, data, operation='another-operation', handler=handler)
    assert calls == [1] and reopened.summary()['state'] == 'stopped'
    assert reopened.summary()['unknown'] == 1 and reopened.summary()['reserved_micro'] == RESERVE


@pytest.mark.parametrize('owner,subject,pair', [('outsider', 'space', [1, 2]), ('owner', 'other-space', [1, 2]), ('owner', 'space', [2, 1])])
def test_owner_space_or_pair_change_never_reaches_a_provider(single, owner, subject, pair):
    gate, _, data = single; calls = []
    with pytest.raises(TrialBlocked):
        send(gate, data, owner=owner, subject=subject, pair=pair,
             handler=lambda _r: calls.append(1))
    assert calls == [] and gate.summary()['attempts'] == 0


def test_concurrent_operations_and_duplicate_approval_have_one_persistent_winner(single, tmp_path):
    gate, _, data = single; calls = []
    def execute(i):
        try:
            send(gate, data, operation='concurrent-operation-' + str(i),
                 handler=lambda _r: (calls.append(1) or httpx.Response(200, json=text_result(json.dumps(
                     dict(lines=[dict(character_id=cid, text='合成交流。', item_ids=[]) for cid in [1, 2]]))))))
            return True
        except TrialBlocked:
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(execute, [1, 2])) == 1
    assert calls == [1] and gate.summary()['attempts'] == 1
    with pytest.raises(TrialBlocked, match='approval_already_used'):
        TrialGate.create(tmp_path / 'duplicate.db', gate.daily, gate.policy)
    assert not (tmp_path / 'duplicate.db').exists()


def test_crash_reservation_is_unknown_and_expired_proof_never_reopens_it(single):
    gate, now, data = single
    gate.reserve('shared_life', 'owner', 'space', 'crashed-operation', b'{}', data['shared_life'])
    reopened = TrialGate(gate.path, gate.daily, clock=lambda: now[0])
    with pytest.raises(TrialBlocked):
        send(reopened, data, operation='replacement-operation')
    assert reopened.summary()['state'] == 'stopped' and reopened.summary()['unknown'] == 1
    assert reopened.summary()['reserved_micro'] == RESERVE and gate.daily.status()['used'] == 1


@pytest.mark.parametrize('old_path', ['PARTNER_LIFE_TRIAL_LEDGER', 'PARTNER_VOICE_TRIAL_LEDGER'])
def test_new_path_cannot_silently_override_an_old_trial(single, old_path):
    gate, _, _ = single
    with pytest.raises(TrialBlocked, match='one_trial_phase_at_a_time'):
        wiring.configure_trials(engine, None, gate.daily, {old_path: 'old', 'PARTNER_SHARED_DIALOGUE_TRIAL_LEDGER': 'new'})


def test_independent_published_proof_has_its_own_one_round_requirement(single, tmp_path):
    gate, now, data = single
    directory = tmp_path / 'proof'; directory.mkdir(mode=0o700)
    config = dict(schema_version=1, enabled=True, mode='shared_dialogue', vendor='maas',
                  account=gate.policy['accounts']['maas'], authorization_ref=gate.policy['authorization_ref'],
                  source_contract=dict(approved=True, transport='private_snapshot_v1', scope='balance_and_full_pending',
                                       query_fee_verified=True, query_fee_micro=0, permissions_approved=True,
                                       official_reference='https://example.invalid/synthetic-not-official'))
    source = dict(schema_version=1, source_type='official_console', observed_at=now[0], covers_through=now[0],
                  includes_unbilled=True, includes_unsettled=True, evidence=data)
    write(directory / funding.CONFIG, config); write(directory / 'funding-input.json', source)
    assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'ready'
    reader = shared_dialogue_evidence_reader(directory / 'evidence.json', gate, clock=lambda: now[0])
    assert reader('shared_life') == data['shared_life']
    now[0] += 901
    with pytest.raises(TrialBlocked):
        reader('shared_life')


@pytest.mark.parametrize('invalid_grant', ['old-ref', 'automatic-link'])
def test_factory_rejects_old_grant_or_automatic_link_before_any_post(area_world, tmp_path, invalid_grant):
    store, clock, group, ids = dialogue_pair(area_world)
    p = policy(clock[0], owner=UID, subject=group['id'], pair=ids)
    daily = DailyModelQuota(tmp_path / 'daily.db', 30, clock=lambda: clock[0])
    gate = TrialGate.create(tmp_path / 'single.db', daily, p, clock=lambda: clock[0])
    data = proof(p, clock[0]); calls = []
    grant = store.authorize(UID, group['id'], ids, 'old-life-approval' if invalid_grant == 'old-ref' else p['authorization_ref'], expires_at=p['ends_at'])
    task, _ = store.prepare(UID, group['id'], str(uuid4()), group['revision'], ids, grant)
    if invalid_grant == 'automatic-link':
        with store.transaction() as connection:
            connection.execute(insert(links).values(task_id=task['id'], session_id='synthetic', group_id=group['id'], revision=0))
    factory = wiring.TrialLifeFactories(gate, lambda kind: data[kind], KEY, engine=engine,
                                       delegate_factory=lambda _kind: httpx.MockTransport(lambda _r: calls.append(1)))
    with pytest.raises(TrialBlocked, match='manual_shared_task_required'):
        factory.adapter('shared_life', UID, group['id'], task['id'], presence='visible')
    assert calls == [] and gate.summary()['attempts'] == 0


def test_manual_business_route_uses_one_bound_post_and_publishes_synthetic_area_event(area_world, tmp_path, monkeypatch):
    store, clock, group, ids = dialogue_pair(area_world)
    group = command(store, group, 'activity', character_ids=ids, activity='rest')
    p = policy(clock[0], owner=UID, subject=group['id'], pair=ids)
    daily = DailyModelQuota(tmp_path / 'daily.db', 30, clock=lambda: clock[0])
    gate = TrialGate.create(tmp_path / 'single.db', daily, p, clock=lambda: clock[0])
    data = proof(p, clock[0]); file = tmp_path / 'proof.json'; write(file, data)
    settings = Settings(_env_file=None, model_base_url=wiring.BASE_URL, model_api_key=KEY)
    monkeypatch.setattr(wiring, 'TrialGate', lambda *_a: gate)
    configured = wiring.configure_trials(engine, settings, daily, {
        'PARTNER_SHARED_DIALOGUE_TRIAL_LEDGER': str(gate.path),
        'PARTNER_SHARED_DIALOGUE_TRIAL_EVIDENCE_FILE': str(file)})
    assert configured['voice'] is None and configured['life'] is None
    factory = configured['shared_dialogue']; calls = []
    def response(request):
        calls.append(request.method)
        return httpx.Response(200, json=text_result(json.dumps(dict(lines=[
            dict(character_id=cid, text='这是独立单轮合成台词。', item_ids=[]) for cid in ids]))))
    factory.delegate_factory = lambda _kind: httpx.MockTransport(response)
    grant = store.authorize(UID, group['id'], ids, p['authorization_ref'], expires_at=p['ends_at'])
    task, fresh = store.prepare(UID, group['id'], str(uuid4()), group['revision'], ids, grant)
    assert fresh
    async def catalog():
        return dict(verified=True)
    asyncio.run(run_exchange(store, task, lambda: factory.adapter('shared_life', UID, group['id'], task['id'], presence='visible'), catalog))
    event = store.read(UID, group['id'])['exchanges'][-1]
    assert calls == ['POST'] and event['area'] == 'indoor' and len(event['lines']) == 2
    assert gate.summary()['state'] == 'completed' and gate.summary()['attempts'] == 1
    assert daily.status()['used'] == 1 and gate.usage()['actual_bill_verified'] is False
    with pytest.raises(TrialBlocked):
        factory.adapter('private_life', UID, group['id'], 'private-operation', presence='visible')
    artifact = os.environ.get('SHARED_SINGLE_ARTIFACT_DIR')
    if artifact:
        Path(artifact, 'synthetic-single-round-event.json').write_text(json.dumps(dict(
            synthetic=True, real_provider_called=False, new_live_calls=0,
            area=event['area'], lines=event['lines'], one_mock_post=True), ensure_ascii=False))


def test_production_entry_and_actual_shared_route_install_only_the_new_factory(area_world, tmp_path, monkeypatch):
    from app.api import gatherings as api
    from app.services import daily_model_quota as daily_module, life_dispatch
    store, clock, group, ids = dialogue_pair(area_world)
    p = policy(clock[0], owner=UID, subject=group['id'], pair=ids)
    daily = DailyModelQuota(tmp_path / 'daily.db', 30, clock=lambda: clock[0])
    gate = TrialGate.create(tmp_path / 'single.db', daily, p, clock=lambda: clock[0])
    file = tmp_path / 'proof.json'; write(file, proof(p, clock[0]))
    settings = Settings(_env_file=None, app_env='production', auth_mode='invite',
                        model_base_url=wiring.BASE_URL, model_api_key=KEY, model_max_retries=0,
                        gathering_dialogue_enabled=True, gathering_dialogue_automatic_enabled=False)
    original_gate = TrialGate
    monkeypatch.setattr(wiring, 'TrialGate', lambda path, quota: original_gate(path, quota, clock=lambda: clock[0]))
    monkeypatch.setattr('app.core.config.get_settings', lambda: settings)
    monkeypatch.setattr(api, 'dialogue_store', store)
    for name in ['PARTNER_VOICE_TRIAL_LEDGER', 'PARTNER_LIFE_TRIAL_LEDGER', 'PARTNER_TRIAL_EVIDENCE_FILE',
                 'PARTNER_SHARED_DIALOGUE_TRIAL_LEDGER', 'PARTNER_SHARED_DIALOGUE_TRIAL_EVIDENCE_FILE']:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('PARTNER_SHARED_DIALOGUE_TRIAL_LEDGER', str(gate.path))
    monkeypatch.setenv('PARTNER_SHARED_DIALOGUE_TRIAL_EVIDENCE_FILE', str(file))
    monkeypatch.setenv('PARTNER_DAILY_QUOTA_DB', str(daily.path))
    monkeypatch.setenv('PARTNER_DAILY_REQUEST_LIMIT', '30')
    restores = []; original_install = daily_module.install_httpx_quota
    def install(*args, **kwargs):
        restore = original_install(*args, **kwargs); restores.append(restore); return restore
    monkeypatch.setattr(daily_module, 'install_httpx_quota', install)
    previous = life_dispatch._factories, life_dispatch._blocked, life_dispatch._on_stop
    original_run = api.run_exchange
    async def catalog():
        return dict(verified=True)
    async def run(store, task, factory):
        return await original_run(store, task, factory, catalog)
    monkeypatch.setattr(api, 'run_exchange', run)
    try:
        entry = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/ecs_partner_serve.py'))
        result = entry['deployment_check'](None)
        assert result['shared_dialogue_trial_ready'] and not result['life_trial_ready'] and not result['voice_trial_ready']
        assert api.dialogue_available() and not api.automatic_available()
        factory = life_dispatch._factories
        assert factory.gate.policy['mode'] == 'shared_dialogue'
        calls = []
        def respond(_request):
            calls.append('POST')
            return httpx.Response(200, json=text_result(json.dumps(dict(lines=[
                dict(character_id=cid, text='生产入口的合成台词。', item_ids=[]) for cid in ids]))))
        factory.delegate_factory = lambda _kind: httpx.MockTransport(respond)
        grant = store.authorize(UID, group['id'], ids, p['authorization_ref'], expires_at=p['ends_at'])
        request = api.DialogueRequest(request_id=uuid4(), expected_revision=group['revision'],
                                      character_ids=ids, grant_id=grant)
        response = asyncio.run(api.dialogue_start(group['id'], request, SimpleNamespace(id=UID)))
        assert len(response['exchanges']) == 1 and calls == ['POST']
        assert factory.gate.summary()['attempts'] == factory.gate.daily.status()['used'] == 1
        assert factory.gate.summary()['state'] == 'completed'
    finally:
        for restore in reversed(restores):
            restore()
        life_dispatch.install(previous[0], blocked=previous[1], on_stop=previous[2])


def test_bounded_grant_helper_checks_then_explicitly_creates_only_until_policy_deadline(area_world, tmp_path):
    from sqlalchemy import select
    store, clock, group, ids = dialogue_pair(area_world)
    p = policy(clock[0], owner=UID, subject=group['id'], pair=ids)
    daily = DailyModelQuota(tmp_path / 'daily.db', 30, clock=lambda: clock[0])
    gate = TrialGate.create(tmp_path / 'single.db', daily, p, clock=lambda: clock[0])
    file = tmp_path / 'proof.json'; write(file, proof(p, clock[0]))
    result = bounded_shared_dialogue_grant(gate, store, file)
    assert not result['grant_created'] and result['new_model_posts'] == 0
    with engine.connect() as conn:
        assert conn.execute(select(grants)).all() == []
    result = bounded_shared_dialogue_grant(gate, store, file, create=True)
    assert result['grant_created'] and not result['flags_changed']
    with engine.connect() as conn:
        row = conn.execute(select(grants).where(grants.c.id == result['grant_id'])).mappings().one()
    assert row['expires_at'] == p['ends_at'] < clock[0] + 3600
    assert row['owner_id'] == UID and json.loads(row['characters_json']) == ids
    assert gate.summary()['attempts'] == daily.status()['used'] == 0


def test_bounded_grant_helper_refuses_missing_permission_and_legacy_long_grant(area_world, tmp_path):
    from sqlalchemy import select
    from app.living.rules import LivingError
    store, clock, group, ids = dialogue_pair(area_world)
    p = policy(clock[0], owner=UID, subject=group['id'], pair=ids)
    daily = DailyModelQuota(tmp_path / 'daily.db', 30, clock=lambda: clock[0])
    gate = TrialGate.create(tmp_path / 'single.db', daily, p, clock=lambda: clock[0])
    data = proof(p, clock[0]); file = tmp_path / 'proof.json'; write(file, data)
    group = command(store, group, 'dialogue_consent', character_id=ids[0], enabled=False)
    with pytest.raises(LivingError):
        bounded_shared_dialogue_grant(gate, store, file, create=True)
    with engine.connect() as conn:
        assert conn.execute(select(grants)).all() == []
    group = command(store, group, 'dialogue_consent', character_id=ids[0], enabled=True)
    grant = store.authorize(UID, group['id'], ids, p['authorization_ref'])
    with engine.connect() as conn:
        assert conn.execute(select(grants.c.expires_at).where(grants.c.id == grant)).scalar_one() == clock[0] + 3600
    task, _ = store.prepare(UID, group['id'], str(uuid4()), group['revision'], ids, grant)
    factory = wiring.TrialLifeFactories(gate, lambda kind: data[kind], KEY, engine=engine)
    with pytest.raises(TrialBlocked, match='manual_shared_task_required'):
        factory.adapter('shared_life', UID, group['id'], task['id'], presence='visible')
    assert gate.summary()['attempts'] == 0
