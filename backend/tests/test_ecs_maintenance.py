import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import ecs_maintenance as maintenance
from scripts import ecs_runtime as runtime
from scripts.check_full_flow_recovery import load_snapshot


@pytest.fixture(autouse=True)
def no_network_or_stop(monkeypatch):
    import socket
    monkeypatch.setattr(socket.socket, 'connect', lambda *_: pytest.fail('network forbidden'))
    monkeypatch.setattr(runtime, 'ensure_backend_stopped', lambda: pytest.fail('must not stop service'))


@pytest.fixture
def data(tmp_path, monkeypatch):
    source = tmp_path / 'data'
    source.mkdir(mode=0o700)
    (source / runtime.MARKER).write_text('synthetic-volume')
    (source / 'uploads').mkdir()
    (source / 'ledger').mkdir()
    with sqlite3.connect(source / 'app.db') as db:
        db.execute('create table records(id integer primary key, value text)')
        db.execute('insert into records values(1, "synthetic")')
    (source / 'uploads' / 'image.bin').write_bytes(b'synthetic-image')
    (source / 'ledger' / 'approval.json').write_text('{"state":"synthetic"}')
    (source / 'authorization.json').write_text('{"calls":0}')
    backups, output = tmp_path / 'backups', tmp_path / 'monitor'
    backups.mkdir(mode=0o700)
    output.mkdir(mode=0o700)
    monkeypatch.setattr(runtime.os.path, 'ismount', lambda p: Path(p) == source)
    monkeypatch.setattr(maintenance.shutil, 'disk_usage', lambda p: SimpleNamespace(free=20 * maintenance.GIB))
    monkeypatch.setattr(maintenance.time, 'time', lambda: 100000)
    return source, backups, output


def monitor(data, monkeypatch, *, now=100000):
    monkeypatch.setattr(maintenance, 'service_ready', lambda _: True)
    monkeypatch.setattr(maintenance, 'loopback_ready', lambda _: True)
    return maintenance.monitor_once(*data, 'synthetic-volume', now=now)


def test_online_snapshot_archive_restore_and_source_preserved(data, monkeypatch):
    source, backups, _ = data
    before = runtime.snapshot_facts(source, 'app.db', True)
    result = maintenance.backup_once(source, backups)
    assert result['state'] == 'verified'
    assert result['cloud_requests'] == result['automatic_retries'] == 0
    assert result['counts'] == dict(table_count=1, file_count=1, ledger_file_count=1, state_file_count=1)
    assert runtime.snapshot_facts(source, 'app.db', True) == before
    directory = backups / result['run_id']
    assert load_snapshot(directory / 'snapshot', 'app.db', True)[0] == before
    assert (directory / 'snapshot.tar').is_file()
    assert not (directory / 'restore-check').exists()
    status = monitor(data, monkeypatch)
    assert status['status'] == 'ok'
    assert json.loads((data[2] / 'status.json').read_text()) == status


@pytest.mark.parametrize('kind', ['database', 'uploads', 'ledger', 'root_state'])
def test_concurrent_business_mutation_refuses_snapshot(data, monkeypatch, kind):
    source, backups, _ = data
    original = runtime.copy_uploads
    changed = False
    def copy_and_change(src, target):
        nonlocal changed
        original(src, target)
        if changed:
            return
        changed = True
        if kind == 'database':
            with sqlite3.connect(source / 'app.db') as db:
                db.execute('insert into records values(2, "during backup")')
        elif kind == 'uploads':
            (source / 'uploads' / 'image.bin').write_bytes(b'new-image')
        elif kind == 'ledger':
            (source / 'ledger' / 'approval.json').write_text('{"state":"new"}')
        else:
            (source / 'authorization.json').write_text('{"calls":1}')
    monkeypatch.setattr(runtime, 'copy_uploads', copy_and_change)
    result = maintenance.backup_once(source, backups)
    assert result['state'] == 'failed'
    assert not (backups / result['run_id'] / 'snapshot.tar').exists()
    assert 'latest_backup_failed' in monitor(data, monkeypatch)['alarms']
    assert (source / 'app.db').exists()


def test_overlapping_invocations_block(data):
    source, backups, _ = data
    with maintenance.exclusive(backups, '.backup.lock'):
        with pytest.raises(ValueError, match='already_running'):
            maintenance.backup_once(source, backups)
    assert not list(backups.glob('run-*.json'))


def test_disk_limit_preserves_existing_snapshot(data, monkeypatch):
    source, backups, _ = data
    saved = backups / 'existing.tar'
    saved.write_bytes(b'preserve-existing')
    monkeypatch.setattr(maintenance.shutil, 'disk_usage', lambda _: SimpleNamespace(free=1))
    result = maintenance.backup_once(source, backups)
    assert result['state'] == 'failed'
    assert saved.read_bytes() == b'preserve-existing'
    assert not (backups / result['run_id']).exists()
    assert 'backup_disk_low' in monitor(data, monkeypatch)['alarms']


def test_interruption_persists_and_blocks_replay_until_resolved(data, monkeypatch):
    source, backups, _ = data
    original = runtime.capture_data
    monkeypatch.setattr(runtime, 'capture_data', lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        maintenance.backup_once(source, backups)
    record = maintenance.runs(backups)[0]
    assert record['state'] == 'running'
    with pytest.raises(ValueError, match='requires_resolution'):
        maintenance.backup_once(source, backups)
    assert 'backup_interrupted' in monitor(data, monkeypatch, now=100181)['alarms']
    resolved = maintenance.resolve_run(backups, record['run_id'])
    assert resolved['state'] == 'failed'
    assert len(maintenance.runs(backups)) == 1
    monkeypatch.setattr(runtime, 'capture_data', original)
    assert maintenance.backup_once(source, backups)['state'] == 'verified'
    assert len(maintenance.runs(backups)) == 2


def test_interrupted_final_receipt_resolves_without_recopy(data, monkeypatch):
    source, backups, _ = data
    original = maintenance.save_json
    def crash_before_final(path, value):
        if value.get('state') == 'verified':
            raise SystemExit()
        original(path, value)
    monkeypatch.setattr(maintenance, 'save_json', crash_before_final)
    with pytest.raises(SystemExit):
        maintenance.backup_once(source, backups)
    pending = maintenance.runs(backups)[0]
    monkeypatch.setattr(maintenance, 'save_json', original)
    monkeypatch.setattr(runtime, 'capture_data', lambda *_: pytest.fail('cannot recopy on resolve'))
    result = maintenance.resolve_run(backups, pending['run_id'])
    assert result['state'] == 'verified'
    assert result['cloud_requests'] == 0


@pytest.mark.parametrize('unit', ['backend', 'frontend'])
def test_service_failure_records_only_codes(data, monkeypatch, unit):
    monkeypatch.setattr(maintenance, 'service_ready', lambda name: unit not in name)
    monkeypatch.setattr(maintenance, 'loopback_ready', lambda _: True)
    result = maintenance.monitor_once(*data, 'synthetic-volume')
    assert unit + '_unavailable' in result['alarms']
    assert 'backup_overdue' in result['alarms']
    assert result['external_notifications'] == result['model_requests'] == 0


def test_wrong_mount_and_stale_backup_alarm(data, monkeypatch):
    maintenance.backup_once(data[0], data[1])
    monkeypatch.setattr(maintenance, 'service_ready', lambda _: True)
    monkeypatch.setattr(maintenance, 'loopback_ready', lambda _: True)
    result = maintenance.monitor_once(*data, 'wrong-volume', now=100000+26*3600+1)
    assert set(result['alarms']) == {'data_volume_unavailable', 'backup_overdue'}


def test_invalid_record_cannot_hide_overdue_backup(data, monkeypatch):
    (data[1] / ('run-' + 'a'*32 + '.json')).write_text('{"state":"verified"}')
    assert 'backup_records_unavailable' in monitor(data, monkeypatch)['alarms']


@pytest.mark.parametrize('location', ['source', 'backups', 'output'])
def test_symlink_paths_rejected(data, tmp_path, location):
    source, backups, output = data
    link = tmp_path / 'link'
    target = dict(source=source, backups=backups, output=output)[location]
    link.symlink_to(target, target_is_directory=True)
    with pytest.raises(ValueError):
        if location == 'output':
            maintenance.monitor_once(source, backups, link, 'synthetic-volume')
        else:
            maintenance.backup_once(link if location == 'source' else source,
                                    link if location == 'backups' else backups)


def test_private_directory_and_overlap_guards(data):
    data[1].chmod(0o755)
    with pytest.raises(ValueError):
        maintenance.backup_once(data[0], data[1])
    data[1].chmod(0o700)
    with pytest.raises(ValueError):
        maintenance.backup_once(data[0], data[0])


@pytest.mark.parametrize('body,status,port,expected', [
    (b'{"info":{"title":"AI\\u4e07\\u7269\\u4f19\\u4f34"}}', 200, 8020, True),
    (b'{"info":{"title":"other"}}', 200, 8020, False),
    (b'<html>synthetic</html>', 200, 3020, True),
    (b'<html></html>', 302, 3020, False),
    (b'not-json', 200, 8020, False),
    (b'x' * (1024 ** 2 + 1), 200, 3020, False),
])
def test_loopback_probe_fixed_destination_and_bounded_body(monkeypatch, body, status, port, expected):
    calls = []
    class Connection:
        def __init__(self, host, selected_port, timeout):
            assert host == '127.0.0.1' and selected_port == port and timeout == 3
        def request(self, method, path):
            calls.append((method, path))
        def getresponse(self):
            return SimpleNamespace(status=status, read=lambda size: body[:size])
        def close(self):
            calls.append('closed')
    monkeypatch.setattr(maintenance.http.client, 'HTTPConnection', Connection)
    assert maintenance.loopback_ready(port) is expected
    assert calls == [('GET', '/openapi.json' if port == 8020 else '/'), 'closed']


def test_disabled_cli_never_probes_or_echoes_private_errors(monkeypatch, capsys):
    monkeypatch.setattr('sys.argv', ['ecs_maintenance', 'backup'])
    monkeypatch.setenv('LOCAL_MAINTENANCE_ENABLED', 'false')
    monkeypatch.setattr(runtime, 'mounted_volume', lambda *_: pytest.fail('disabled should not inspect mount'))
    assert maintenance.main() == 1
    output = json.loads(capsys.readouterr().out)
    assert output['error']['code'] == 'local_maintenance_failed'


def test_cli_error_is_sanitized(monkeypatch, capsys):
    monkeypatch.setattr('sys.argv', ['ecs_maintenance', 'backup'])
    monkeypatch.setenv('LOCAL_MAINTENANCE_ENABLED', 'true')
    monkeypatch.setattr(runtime, 'mounted_volume', lambda *_: (_ for _ in ()).throw(ValueError('synthetic-sensitive-private-value')))
    assert maintenance.main() == 1
    assert 'synthetic-sensitive-private-value' not in capsys.readouterr().out


def test_sync_failure_cannot_publish_verified_receipt(data, monkeypatch):
    monkeypatch.setattr(maintenance, 'sync_tree', lambda _: (_ for _ in ()).throw(OSError('synthetic-sync-error')))
    result = maintenance.backup_once(data[0], data[1])
    assert result['state'] == 'failed'
    assert maintenance.runs(data[1])[0]['state'] == 'failed'
    assert 'synthetic-sync-error' not in json.dumps(result)


def test_probe_rejects_other_ports_before_connection(monkeypatch):
    monkeypatch.setattr(maintenance.http.client, 'HTTPConnection', lambda *_args, **_kw: pytest.fail('must not connect'))
    assert maintenance.loopback_ready(8052) is False
