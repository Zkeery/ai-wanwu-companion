import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import ecs_runtime as runtime


@pytest.fixture
def volume(tmp_path, monkeypatch):
    root = tmp_path / 'volume'
    root.mkdir()
    (root / runtime.MARKER).write_text('synthetic-volume')
    (root / 'uploads').mkdir()
    (root / 'ledger').mkdir()
    monkeypatch.setattr(runtime.os.path, 'ismount', lambda p: Path(p) == root)
    return root


def production(root):
    return dict(APP_ENV='production', DATA_VOLUME_ID='synthetic-volume',
                DATABASE_URL=f'sqlite:///{root / "app.db"}', UPLOAD_DIR=str(root / 'uploads'),
                WALK_WORKFLOW_ROOT=str(root / 'ledger'), MODEL_BASE_URL='https://models.example.invalid/v1',
                MODEL_API_KEY='synthetic-not-a-real-key', MODEL_MAX_RETRIES='0',
                SMS_PROVIDER='volcengine', SMS_LIVE_ENABLED='true',
                SMS_ACCESS_KEY_ID='synthetic-ak', SMS_SECRET_ACCESS_KEY='synthetic-sk',
                SMS_ACCOUNT='synthetic-group', SMS_SIGN='测试主体', SMS_TEMPLATE_ID='synthetic-template',
                SMS_DAILY_LIMIT='1')


def test_unmounted_volume_never_creates_data(tmp_path):
    root = tmp_path / 'not-mounted'
    with pytest.raises(ValueError):
        runtime.mounted_volume(root, 'id')
    assert not root.exists()


def test_wrong_volume_and_symlink_rejected(volume, tmp_path):
    with pytest.raises(ValueError):
        runtime.mounted_volume(volume, 'other')
    link = tmp_path / 'link'
    link.symlink_to(volume)
    with pytest.raises(ValueError):
        runtime.mounted_volume(link, 'synthetic-volume')


def test_backend_inputs_no_network_or_data_writes(volume, monkeypatch):
    import socket
    monkeypatch.setattr(socket.socket, 'connect', lambda *args: pytest.fail('network forbidden'))
    before = sorted(p.name for p in volume.iterdir())
    assert runtime.check_environment('backend', production(volume), volume)['network_requests'] == 0
    assert sorted(p.name for p in volume.iterdir()) == before


@pytest.mark.parametrize('change', [
    {'APP_ENV': 'development'}, {'DATABASE_URL': 'sqlite:///:memory:'},
    {'UPLOAD_DIR': '/tmp/uploads'}, {'WALK_WORKFLOW_ROOT': '/tmp/ledger'},
    {'DEV_SMS_FIXED_CODE': '123456'}, {'DEV_AUTH_TOKEN': 'synthetic-dev-token'},
    {'SMS_LIVE_ENABLED': 'false'}, {'LIFE_RUNTIME_PREVIEW_ENABLED': 'true'},
    {'MODEL_BASE_URL': 'http://models.example.invalid'},
])
def test_invalid_production_inputs_rejected(volume, change):
    env = production(volume) | change
    with pytest.raises(ValueError):
        runtime.check_environment('backend', env, volume)


def test_symlink_database_rejected(volume, tmp_path):
    (volume / 'app.db').symlink_to(tmp_path / 'elsewhere.db')
    with pytest.raises(ValueError):
        runtime.check_environment('backend', production(volume), volume)


@pytest.mark.parametrize('change', [
    {}, {'NEXT_PUBLIC_DEV_SMS_CODE': '123456'}, {'NEXT_PUBLIC_API_KEY': 'synthetic'},
    {'BACKEND_URL': 'http://127.0.0.1:8056'}, {'HOSTNAME': '0.0.0.0'},
    {'NEXT_PUBLIC_OFFLINE_PREVIEW': 'true'},
])
def test_frontend_inputs(volume, change):
    env = dict(DATA_VOLUME_ID='synthetic-volume', BACKEND_URL='http://127.0.0.1:8020',
               HOSTNAME='127.0.0.1', PORT='3020', NODE_ENV='production') | change
    if change:
        with pytest.raises(ValueError):
            runtime.check_environment('frontend', env, volume)
    else:
        assert runtime.check_environment('frontend', env, volume)['startup_inputs_verified']


def seed(root):
    with sqlite3.connect(root / 'app.db') as db:
        db.execute('CREATE TABLE history (id INTEGER PRIMARY KEY, value TEXT)')
        db.execute("INSERT INTO history VALUES (1, 'synthetic event')")
    (root / 'uploads' / 'synthetic.txt').write_text('synthetic asset')
    (root / 'ledger' / 'job.json').write_text('{"status":"pending"}')
    (root / 'authorization.json').write_text('{"remaining":0}')


def test_full_backup_and_new_directory_restore(volume, tmp_path):
    seed(volume)
    snapshot, target = tmp_path / 'snapshot', tmp_path / 'restored'
    result = runtime.capture_data(volume, snapshot)
    assert (result['table_count'], result['file_count'], result['ledger_file_count'], result['state_file_count']) == (1, 1, 1, 1)
    assert not (snapshot / runtime.MARKER).exists()
    assert runtime.restore_data(snapshot, target)['restored_verified']
    assert runtime.snapshot_facts(volume, 'app.db', True) == runtime.snapshot_facts(target, 'app.db', True)
    assert snapshot.stat().st_mode & 0o077 == 0
    assert (snapshot / 'manifest.json').stat().st_mode & 0o077 == 0


@pytest.mark.parametrize('fault', ['asset', 'ledger', 'state', 'database', 'overwrite', 'overlap', 'symlink'])
def test_restore_refuses_damage_or_unsafe_targets(volume, tmp_path, fault):
    seed(volume)
    snapshot, target = tmp_path / 'snapshot', tmp_path / 'restored'
    runtime.capture_data(volume, snapshot)
    if fault in ('asset', 'ledger', 'state'):
        name = {'asset': 'uploads/synthetic.txt', 'ledger': 'ledger/job.json', 'state': 'authorization.json'}[fault]
        (snapshot / name).unlink()
    elif fault == 'database':
        with sqlite3.connect(snapshot / 'app.db') as db:
            db.execute("UPDATE history SET value='changed'")
    elif fault == 'overwrite':
        target.mkdir()
    elif fault == 'overlap':
        target = snapshot / 'nested'
    else:
        link = tmp_path / 'link'
        link.symlink_to(snapshot)
        snapshot = link
    with pytest.raises((ValueError, FileNotFoundError)):
        runtime.restore_data(snapshot, target)
    assert (volume / 'uploads/synthetic.txt').read_text() == 'synthetic asset'
    if fault != 'overwrite':
        assert not target.exists()


@pytest.mark.parametrize('active', ['active', 'activating', 'deactivating', 'failed', 'inactive'])
def test_backup_requires_stopped_loaded_unit(monkeypatch, active):
    output = f'LoadState=loaded\nActiveState={active}\nSubState={"dead" if active == "inactive" else "running"}\n'
    monkeypatch.setattr(runtime.subprocess, 'run', lambda *a, **k: SimpleNamespace(returncode=0, stdout=output))
    if active == 'inactive':
        runtime.ensure_backend_stopped()
    else:
        with pytest.raises(ValueError):
            runtime.ensure_backend_stopped()


def test_cli_error_does_not_echo_paths_or_secrets(monkeypatch, capsys):
    monkeypatch.setattr('sys.argv', ['ecs_runtime', 'check', 'backend'])
    monkeypatch.setattr(runtime, 'check_environment', lambda *a: (_ for _ in ()).throw(ValueError('synthetic-sensitive-value')))
    assert runtime.main() == 1
    output = capsys.readouterr().out
    assert 'synthetic-sensitive-value' not in output
    assert json.loads(output)['error']['code'] == 'ecs_runtime_check_failed'
