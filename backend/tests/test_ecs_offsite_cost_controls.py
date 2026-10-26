import hashlib
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

import pytest

from scripts import ecs_offsite_once as offsite
from scripts import ecs_offsite_costs as costs
from tests.test_ecs_offsite_notify import Client, Engine, NOW, RUN, config, source


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('real network forbidden in cost-control tests')
    for name in ('connect', 'connect_ex'):
        monkeypatch.setattr(socket.socket, name, forbidden)
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    monkeypatch.setattr(socket, 'getaddrinfo', forbidden)


def update_file(root, name, **changes):
    path = root / 'private' / name
    data = json.loads(path.read_text())
    data.update(changes)
    path.write_text(json.dumps(data))
    return path


def never_send(root):
    return offsite.copy_once(root, Engine(), config(), {}, now=NOW,
                             factory=lambda *_: pytest.fail('SDK must not initialize'))


@pytest.mark.parametrize('amount', ['-0.02', '0.00', '0.49', '0.63'])
def test_insufficient_balance_stops_before_reservation_and_sdk(tmp_path, amount):
    source(tmp_path)
    update_file(tmp_path, costs.BALANCE_FILE, available_balance_cny=amount)
    assert never_send(tmp_path)['reason'] == 'offsite_balance_insufficient'
    assert not list((tmp_path / 'private/offsite-backup').glob('run-*'))


def test_exact_post_reservation_floor_allows_metadata_only(tmp_path):
    archive = source(tmp_path)
    update_file(tmp_path, costs.BALANCE_FILE, available_balance_cny='0.64')
    client, engine = Client(), Engine()
    result = offsite.copy_once(tmp_path, engine, config(), {}, now=NOW,
                               factory=lambda *_: (client, 'private'))
    assert result['state'] == 'uploaded_metadata_verified'
    assert result['full_download_bytes'] == 0
    assert result['download_verified'] is result['remote_restore_verified'] is False
    assert client.calls == ['acl', 'policy', 'put', 'head']
    assert len(engine.restores) == 1
    assert not (tmp_path / 'private/offsite-backup' / RUN / 'download.tar').exists()
    assert archive.is_file()


@pytest.mark.parametrize('changes,reason', [
    ({'unbilled_reviewed': False}, 'offsite_balance_unknown'),
    ({'unbilled_cost_cny': None}, 'offsite_balance_unknown'),
    ({'unbilled_cost_cny': '-0.01'}, 'offsite_balance_unknown'),
    ({'unbilled_cost_cny': '0.37'}, 'offsite_balance_insufficient'),
    ({'available_balance_cny': None}, 'offsite_balance_unknown'),
    ({'available_balance_cny': True}, 'offsite_balance_unknown'),
    ({'available_balance_cny': 'NaN'}, 'offsite_balance_unknown'),
    ({'available_balance_cny': 'Infinity'}, 'offsite_balance_unknown'),
    ({'available_balance_cny': '1e3'}, 'offsite_balance_unknown'),
    ({'source': 'guessed'}, 'offsite_balance_unknown'),
    ({'approval_sha256': '0' * 64}, 'offsite_balance_unknown'),
    ({'evidence_ref': ''}, 'offsite_balance_unknown'),
    ({'checked_at': NOW + 1}, 'offsite_balance_stale'),
    ({'checked_at': NOW - 901, 'valid_until': NOW - 1}, 'offsite_balance_stale'),
    ({'valid_until': NOW}, 'offsite_balance_stale'),
    ({'valid_until': NOW + 901}, 'offsite_balance_stale'),
    ({'checked_at': True}, 'offsite_balance_stale'),
])
def test_unknown_or_stale_observation_never_spends(tmp_path, changes, reason):
    source(tmp_path)
    update_file(tmp_path, costs.BALANCE_FILE, **changes)
    assert never_send(tmp_path)['reason'] == reason
    assert not list((tmp_path / 'private/offsite-backup').glob('run-*'))


@pytest.mark.parametrize('fault', ['missing', 'malformed', 'symlink', 'public', 'duplicate', 'oversized'])
def test_invalid_balance_file_fails_closed(tmp_path, fault):
    source(tmp_path)
    path = tmp_path / 'private' / costs.BALANCE_FILE
    if fault == 'missing':
        path.unlink()
    elif fault == 'malformed':
        path.write_text('{')
    elif fault == 'symlink':
        target = tmp_path / 'saved.json'
        path.rename(target)
        path.symlink_to(target)
    elif fault == 'public':
        path.chmod(0o644)
    elif fault == 'duplicate':
        path.write_text('{"schema_version":1,"schema_version":1}')
    else:
        path.write_text(' ' * 16385)
    assert never_send(tmp_path)['reason'] == 'offsite_balance_unknown'


@pytest.mark.parametrize('changes', [
    {'enabled': False}, {'minimum_remaining_cny': '0.00'},
    {'max_balance_age_seconds': 86400}, {'allow_full_download': True},
    {'verification_mode': 'full'}, {'schema_version': True},
])
def test_policy_cannot_weaken_floor_freshness_or_enable_download(tmp_path, changes):
    source(tmp_path)
    update_file(tmp_path, costs.POLICY_FILE, **changes)
    assert never_send(tmp_path)['state'] == 'blocked'
    assert not (tmp_path / 'private/offsite-backup').exists()


def test_missing_cost_policy_blocks_old_authorization(tmp_path):
    source(tmp_path)
    (tmp_path / 'private' / costs.POLICY_FILE).unlink()
    assert never_send(tmp_path)['reason'] == 'offsite_cost_policy_missing'


def test_private_parent_is_required(tmp_path):
    source(tmp_path)
    (tmp_path / 'private').chmod(0o755)
    assert never_send(tmp_path)['reason'] == 'offsite_cost_policy_invalid'


def test_same_balance_observation_is_one_use_even_after_reformatting(tmp_path):
    source(tmp_path)
    client = Client()
    first = offsite.copy_once(tmp_path, Engine(), config(), {}, now=NOW,
                              factory=lambda *_: (client, 'private'))
    assert first['state'] == 'uploaded_metadata_verified'
    source(tmp_path, run='run-' + '2' * 32)
    path = tmp_path / 'backups/scheduled' / ('run-' + '2' * 32) / 'scheduled-result.json'
    os.utime(path, (NOW + 1, NOW + 1))
    evidence = tmp_path / 'private' / costs.BALANCE_FILE
    evidence.write_text(json.dumps(json.loads(evidence.read_text()), indent=4, sort_keys=True))
    result = offsite.copy_once(tmp_path, Engine(), config(), {}, now=NOW + 1,
                               factory=lambda *_: pytest.fail('old evidence reused'))
    assert result['reason'] == 'offsite_balance_evidence_used'
    assert len(list((tmp_path / 'private/offsite-backup').glob('run-*'))) == 1
    child = subprocess.run([sys.executable, '-c',
        'import json,sys;from pathlib import Path;from scripts.ecs_offsite_costs import check;'
        'print(json.dumps(check(Path(sys.argv[1]),json.loads(sys.argv[2]),int(sys.argv[3]))))',
        str(tmp_path), json.dumps(config()), str(NOW + 1)],
        capture_output=True, text=True, timeout=10, check=True)
    assert json.loads(child.stdout)['reason'] == 'offsite_balance_evidence_used'


@pytest.mark.parametrize('fault', ['length', 'etag', 'metadata', 'missing', 'timeout'])
def test_head_fault_preserves_failure_without_get_fallback(tmp_path, fault):
    source(tmp_path)
    client = Client()
    original_head = client.head_object
    def head(*args):
        response = original_head(*args)
        if fault == 'timeout':
            raise TimeoutError('synthetic-secret-never-print')
        if fault == 'length':
            response.content_length += 1
        elif fault == 'etag':
            response.etag = 'other'
        elif fault == 'metadata':
            response.meta = {'wanwu-archive-sha256': '0' * 64}
        else:
            response.meta = None
        return response
    client.head_object = head
    client.get_object = lambda *_: pytest.fail('full download forbidden')
    result = offsite.copy_once(tmp_path, Engine(), config(), {}, now=NOW,
                               factory=lambda *_: (client, 'private'))
    assert result['state'] == 'failed'
    assert 'synthetic-secret' not in json.dumps(result)
    assert client.calls == ['acl', 'policy', 'put', 'head']
    assert (tmp_path / 'private/offsite-backup/review-required.json').exists()
    assert never_send(tmp_path)['reason'] == 'previous_failure_requires_review'


def test_expired_during_local_restore_cannot_initialize_sdk(tmp_path, monkeypatch):
    source(tmp_path)
    clock = [NOW]
    engine = Engine()
    restore = engine.restore
    def slow_restore(*args):
        result = restore(*args)
        clock[0] += 901
        return result
    engine.restore = slow_restore
    monkeypatch.setattr(offsite.time, 'time', lambda: clock[0])
    result = offsite.copy_once(tmp_path, engine, config(), {},
                               factory=lambda *_: pytest.fail('expired before SDK'))
    assert result['state'] == 'failed'
    assert (tmp_path / 'private/offsite-backup' / RUN / 'intent.json').exists()


@pytest.mark.parametrize('fault', ['balance', 'archive', 'policy'])
def test_change_during_sdk_initialization_blocks_put(tmp_path, fault):
    archive = source(tmp_path)
    client = Client()
    def factory(*_):
        if fault == 'balance':
            update_file(tmp_path, costs.BALANCE_FILE, available_balance_cny='0.00')
        elif fault == 'archive':
            archive.write_bytes(b'changed')
        else:
            update_file(tmp_path, costs.POLICY_FILE, enabled=False)
        return client, 'private'
    result = offsite.copy_once(tmp_path, Engine(), config(), {}, now=NOW, factory=factory)
    assert result['state'] == 'failed'
    assert client.calls == ['acl', 'policy']


def test_process_interruption_cannot_continue_with_another_snapshot(tmp_path):
    source(tmp_path)
    def interrupted(*_):
        raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        offsite.copy_once(tmp_path, Engine(), config(), {}, now=NOW, factory=interrupted)
    source(tmp_path, run='run-' + '2' * 32)
    path = tmp_path / 'backups/scheduled' / ('run-' + '2' * 32) / 'scheduled-result.json'
    os.utime(path, (NOW + 1, NOW + 1))
    update_file(tmp_path, costs.BALANCE_FILE, evidence_ref='new-operator-check')
    result = offsite.copy_once(tmp_path, Engine(), config(), {}, now=NOW + 1,
                               factory=lambda *_: pytest.fail('unknown attempt replay'))
    assert result['reason'] == 'previous_attempt_unknown_requires_review'


@pytest.mark.parametrize('with_balance', [True, False])
def test_preflight_cli_needs_no_engine_credentials_or_network(tmp_path, with_balance):
    source(tmp_path)
    c = config()
    # The CLI runs against actual time; make only the synthetic test grant fresh.
    import time
    now = int(time.time())
    c['expires_at'] = now + 3600
    auth = tmp_path / 'private/authorization.json'
    auth.write_text(json.dumps(c))
    auth.chmod(0o600)
    update_file(tmp_path, costs.BALANCE_FILE, approval_sha256=costs.approval_sha(c),
                checked_at=now, valid_until=now + 900)
    if not with_balance:
        (tmp_path / 'private' / costs.BALANCE_FILE).unlink()
    result = subprocess.run([sys.executable, '-m', 'scripts.ecs_offsite_once',
        '--root', str(tmp_path), '--config', str(auth),
        '--credentials', str(tmp_path / 'must-not-read-credentials'),
        '--engine', str(tmp_path / 'must-not-load-engine'), '--preflight-only'],
        capture_output=True, text=True, timeout=10)
    data = json.loads(result.stdout)
    assert data['state'] == ('preflight_passed' if with_balance else 'blocked')
    assert result.returncode == (0 if with_balance else 2)
    assert data['network_requests'] == 0
    assert '1.00' not in result.stdout
    assert not (tmp_path / 'private/offsite-backup').exists()


def test_old_full_restore_receipt_is_preserved_and_not_rewritten(tmp_path):
    archive = source(tmp_path)
    area = tmp_path / 'private/offsite-backup' / RUN
    area.mkdir(mode=0o700, parents=True)
    area.parent.chmod(0o700)
    prior = {'state': 'verified', 'approval_sha256': costs.approval_sha(config()),
             'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
             'download_verified': True, 'independent_restore_verified': True}
    receipt = area / 'result.json'
    receipt.write_text(json.dumps(prior))
    original = receipt.read_bytes()
    assert never_send(tmp_path)['state'] == 'already_verified'
    assert receipt.read_bytes() == original


def test_concurrent_dispatch_cannot_consume_same_observation(tmp_path):
    source(tmp_path)
    area = tmp_path / 'private/offsite-backup'
    area.mkdir(mode=0o700)
    with (area / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(BlockingIOError):
            never_send(tmp_path)
    assert not list(area.glob('run-*'))
