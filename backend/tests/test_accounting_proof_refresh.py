"""Synthetic financial snapshots only; external connects are forbidden."""
import copy
import fcntl
import json
import subprocess
import sys

import httpx
import pytest

from app.services import accounting_proof_refresh as funding
from app.services.trial_admission import live_evidence_reader
from app.services.trial_gate import TrialBlocked
from app.services.trial_transport import Envelope, TrialTransport, TEXT_URL
from tests.test_trial_guards import setup, evidence, payload, KEY


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def deny(*_a, **_kw):
        raise AssertionError('NETWORK_FORBIDDEN')
    monkeypatch.setattr('socket.socket.connect', deny)
    monkeypatch.setattr('socket.socket.connect_ex', deny)


def write(path, value):
    path.write_text(json.dumps(value)); path.chmod(0o600)


@pytest.fixture
def fixture(tmp_path):
    gate, now = setup(tmp_path, 'life')
    directory = tmp_path / 'proof'
    directory.mkdir(mode=0o700)
    data = {kind: evidence(gate, kind) for kind in funding.KINDS}
    for value in data.values():
        value['wallet'].update(pending_complete=True, source_type='official_api')
        value['price']['on_sale'] = True
    config = {'schema_version': 1, 'enabled': True, 'vendor': 'maas',
              'account': gate.policy['accounts']['maas'],
              'authorization_ref': gate.policy['authorization_ref'],
              'source_contract': {'approved': True, 'transport': 'private_snapshot_v1',
                  'scope': 'balance_and_full_pending', 'query_fee_verified': True,
                  'query_fee_micro': 0, 'permissions_approved': True,
                  'official_reference': 'https://example.invalid/synthetic-contract-not-official'}}
    source = {'schema_version': 1, 'source_type': 'official_api',
              'observed_at': now[0], 'covers_through': now[0],
              'includes_unbilled': True, 'includes_unsettled': True, 'evidence': data}
    write(directory / funding.CONFIG, config)
    write(directory / 'funding-input.json', source)
    return directory, gate, now, config, source


def test_default_check_is_read_only_and_disabled_has_no_side_effect(fixture, capsys):
    directory, _, now, config, _ = fixture
    before = {p.name: p.read_bytes() for p in directory.iterdir()}
    assert funding.check(directory, clock=lambda: now[0])['status'] == 'ready_for_publication'
    assert {p.name: p.read_bytes() for p in directory.iterdir()} == before
    config['enabled'] = False
    write(directory / funding.CONFIG, config)
    from scripts.accounting_proof_refresh import main
    assert main(['--directory', str(directory)]) == 0
    assert json.loads(capsys.readouterr().out)['status'] == 'disabled'
    assert set(p.name for p in directory.iterdir()) == set(before)


@pytest.mark.parametrize('after_publish', [False, True])
def test_missing_state_cannot_fall_back_to_legacy_proof_after_opt_in(fixture, after_publish):
    directory, gate, now, _, source = fixture
    write(directory / 'evidence.json', source['evidence'])
    if after_publish:
        assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'ready'
        (directory / funding.STATE).unlink()
    with pytest.raises(TrialBlocked, match='financial_refresh_not_ready'):
        live_evidence_reader(directory / 'evidence.json', gate, clock=lambda: now[0])('private_life')
    if after_publish:
        before = (directory / 'evidence.json').read_bytes()
        assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'stopped'
        assert (directory / 'evidence.json').read_bytes() == before


def test_refresh_preserves_source_time_previous_proof_and_private_receipts(fixture):
    directory, gate, now, _, source = fixture
    old = copy.deepcopy(source['evidence'])
    for value in old.values():
        value['wallet']['checked_at'] -= 901
    write(directory / 'evidence.json', old)
    previous = (directory / 'evidence.json').read_bytes()
    result = funding.refresh(directory, clock=lambda: now[0])
    assert result['status'] == 'ready' and not result['worker_started']
    reader = live_evidence_reader(directory / 'evidence.json', gate, clock=lambda: now[0])
    assert reader('private_life') == source['evidence']['private_life']
    receipt = next(directory.glob('funding-record-*'))
    assert (receipt / 'previous-evidence.json').read_bytes() == previous
    assert json.loads((receipt / 'source.json').read_bytes()) == source
    for path in directory.rglob('*'):
        assert path.stat().st_mode & 0o077 == 0
    original_at = reader('shared_life')['wallet']['checked_at']
    now[0] += 10
    assert funding.refresh(directory, clock=lambda: now[0])['expires_at'] == original_at + 900
    assert reader('shared_life')['wallet']['checked_at'] == original_at
    assert len(list(directory.glob('funding-record-*'))) == 2
    assert gate.summary()['counts'] == {'private_life': 0, 'shared_life': 0}


@pytest.mark.parametrize('mutation', ['unknown', 'pending_null', 'low', 'bool_amount', 'stale',
    'future', 'tokens_only', 'unbilled_missing', 'unsettled_missing', 'coverage_gap',
    'account', 'ref', 'price', 'off_sale', 'different_wallet', 'fee', 'permissions', 'contract'])
def test_uncertainty_stops_actual_dispatch_and_never_automatically_reopens(fixture, mutation):
    directory, gate, now, config, source = fixture
    good_config, good_source = copy.deepcopy(config), copy.deepcopy(source)
    assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'ready'
    w = source['evidence']['private_life']['wallet']
    p = source['evidence']['private_life']['price']
    if mutation == 'unknown': w['pending_complete'] = False
    elif mutation == 'pending_null': w['pending_micro'] = None
    elif mutation == 'low': w['available_micro'] = 1
    elif mutation == 'bool_amount': w['available_micro'] = True
    elif mutation == 'stale': w['checked_at'] -= 901
    elif mutation == 'future': w['checked_at'] += 1
    elif mutation == 'tokens_only': source['source_type'] = 'usage_query'
    elif mutation == 'unbilled_missing': source['includes_unbilled'] = False
    elif mutation == 'unsettled_missing': source['includes_unsettled'] = False
    elif mutation == 'coverage_gap': source['covers_through'] -= 1
    elif mutation == 'account': w['account'] = 'other'
    elif mutation == 'ref': w['authorization_ref'] = 'other-ref'
    elif mutation == 'price': p['rates']['input_per_million'] += 1
    elif mutation == 'off_sale': p['on_sale'] = False
    elif mutation == 'different_wallet': source['evidence']['shared_life']['wallet']['pending_micro'] = 1
    elif mutation == 'fee': config['source_contract']['query_fee_micro'] = 1
    elif mutation == 'permissions': config['source_contract']['permissions_approved'] = False
    else: config['source_contract']['approved'] = False
    write(directory / funding.CONFIG, config)
    write(directory / 'funding-input.json', source)
    assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'stopped'
    reader = live_evidence_reader(directory / 'evidence.json', gate, clock=lambda: now[0])
    calls = []
    envelope = Envelope(gate, 'private_life', 'owner', 'private_life', 'funding-no-post',
                        lambda: reader('private_life'))
    with httpx.Client(transport=TrialTransport(envelope, httpx.MockTransport(lambda r: calls.append(r)))) as client:
        with pytest.raises(TrialBlocked):
            client.post(TEXT_URL, headers={'Authorization': 'Bearer ' + KEY}, json=payload('private_life'))
    assert not calls and gate.daily.status()['used'] == 0
    assert gate.summary()['state'] == 'stopped'
    count = len(list(directory.glob('funding-record-*')))
    write(directory / funding.CONFIG, good_config)
    write(directory / 'funding-input.json', good_source)
    assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'stopped'
    assert len(list(directory.glob('funding-record-*'))) == count
    assert gate.summary()['state'] == 'stopped'


def test_fresh_financial_proof_cannot_reopen_an_already_stopped_model_gate(fixture):
    directory, gate, now, _, _ = fixture
    with pytest.raises(TrialBlocked, match='earlier_unknown_preserved'):
        gate.stop('earlier_unknown_preserved')
    assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'ready'
    assert gate.summary()['state'] == 'stopped'


def test_published_proof_reaches_transport_then_expires_without_another_post(fixture):
    from tests.test_trial_guards import text_result
    directory, gate, now, _, _ = fixture
    assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'ready'
    reader = live_evidence_reader(directory / 'evidence.json', gate, clock=lambda: now[0])
    calls = []
    def respond(request):
        calls.append(request.method)
        return httpx.Response(200, json=text_result('{"activity":"rest","reason":"在住处休息"}'))
    def send(operation):
        envelope = Envelope(gate, 'private_life', 'owner', 'private_life', operation,
                            lambda: reader('private_life'))
        with httpx.Client(transport=TrialTransport(envelope, httpx.MockTransport(respond))) as client:
            return client.post(TEXT_URL, headers={'Authorization': 'Bearer ' + KEY}, json=payload('private_life'))
    assert send('funding-first-operation').status_code == 200
    assert calls == ['POST'] and gate.daily.status()['used'] == 1
    now[0] += 901
    with pytest.raises(TrialBlocked): send('funding-expired-operation')
    # The synthetic clock crosses Beijing midnight: today's counter can reset,
    # while the original batch must still contain exactly one actual attempt.
    assert calls == ['POST'] and gate.summary()['counts']['private_life'] == 1


@pytest.mark.parametrize('mode', ['interrupted', 'tampered', 'missing_proof', 'disabled', 'replayed', 'invalid_json', 'publish_error'])
def test_failure_paths_block_without_destroying_original_evidence(fixture, mode, monkeypatch):
    directory, gate, now, config, source = fixture
    assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'ready'
    original = (directory / 'evidence.json').read_bytes()
    if mode == 'interrupted':
        write(directory / funding.STATE, {'status': 'updating'})
    elif mode == 'tampered':
        write(directory / 'evidence.json', {})
    elif mode == 'missing_proof':
        (directory / 'evidence.json').unlink()
    elif mode == 'disabled':
        config['enabled'] = False; write(directory / funding.CONFIG, config)
    elif mode == 'replayed':
        source['observed_at'] -= 1
        source['covers_through'] -= 1
        for value in source['evidence'].values():
            for row in value.values(): row['checked_at'] -= 1
        write(directory / 'funding-input.json', source)
    elif mode == 'invalid_json':
        (directory / 'funding-input.json').write_text('{')
    else:
        atomic = funding._atomic
        def fail(path, value):
            if path.name == 'evidence.json': raise OSError('synthetic-publication-failure')
            return atomic(path, value)
        monkeypatch.setattr(funding, '_atomic', fail)
    if mode in ('replayed', 'invalid_json', 'publish_error'):
        assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'stopped'
        assert (directory / 'evidence.json').read_bytes() == original
    if mode in ('tampered', 'missing_proof'):
        # A good new input cannot silently repair or mask a changed publication.
        assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'stopped'
    with pytest.raises(TrialBlocked):
        live_evidence_reader(directory / 'evidence.json', gate, clock=lambda: now[0])('private_life')
    assert next(directory.glob('funding-record-*')).is_dir()
    if mode == 'invalid_json':
        assert any((p / 'source.json').read_bytes() == b'{' for p in directory.glob('funding-record-*'))


def test_exclusive_lock_leaves_proof_and_state_unchanged(fixture):
    directory, _, now, _, _ = fixture
    funding.refresh(directory, clock=lambda: now[0])
    before = (directory / funding.STATE).read_bytes()
    with (directory / 'funding-refresh.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(TrialBlocked, match='financial_refresh_busy'):
            funding.refresh(directory, clock=lambda: now[0])
    assert (directory / funding.STATE).read_bytes() == before


def test_new_process_observes_latched_stop_with_no_network(fixture):
    directory, _, now, _, _ = fixture
    funding.refresh(directory, clock=lambda: now[0])
    write(directory / funding.STATE, {'status': 'stopped', 'code': 'synthetic-unknown'})
    program = '''import socket,sys
from app.services.accounting_proof_refresh import refresh
def deny(*a,**k):raise RuntimeError('NETWORK_FORBIDDEN')
socket.socket.connect=deny;socket.socket.connect_ex=deny
assert refresh(sys.argv[1])['status']=='stopped'
print('stopped_preserved')
'''
    child = subprocess.run([sys.executable, '-c', program, str(directory)], capture_output=True, text=True, timeout=15)
    assert child.returncode == 0 and child.stdout.strip() == 'stopped_preserved'


@pytest.mark.parametrize('raw', [b'{"schema_version":1,"schema_version":1}', b'{"observed_at":NaN}'])
def test_ambiguous_source_json_is_retained_and_blocked(fixture, raw):
    directory, _, now, _, _ = fixture
    (directory / 'funding-input.json').write_bytes(raw)
    assert funding.refresh(directory, clock=lambda: now[0])['status'] == 'stopped'
    assert next(directory.glob('funding-record-*/source.json')).read_bytes() == raw
