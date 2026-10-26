"""Only R3: auxiliary daily-quota SQLite backup and restore regression."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

import pytest

from app.services.daily_model_quota import DailyModelQuota
from scripts import check_full_flow_recovery as recovery
from scripts import ecs_cloud_backup as archive
from scripts import ecs_runtime as ecs

CLOCK = 1792112400.0
QUOTA = recovery.DAILY_QUOTA_DATABASE


def record(name, value):
    output = Path(os.environ['DAILY_FIX_EVIDENCE'])
    (output / (name + '.json')).write_text(json.dumps(value, ensure_ascii=False, indent=2))


@pytest.fixture
def daily_source(tmp_path):
    source = tmp_path / 'source'
    (source / 'uploads').mkdir(parents=True)
    (source / 'ledger').mkdir()
    with sqlite3.connect(source / 'app.db') as db:
        db.execute('CREATE TABLE synthetic (id INTEGER PRIMARY KEY, note TEXT)')
        db.execute("INSERT INTO synthetic VALUES (1, 'offline fixture only')")
    quota = DailyModelQuota(source / QUOTA, 30, clock=lambda: CLOCK)
    # Keep committed records in WAL: a bare .db copy would lose these rows.
    keeper = quota.connection()
    keeper.execute('PRAGMA wal_autocheckpoint=0')
    first = quota.reserve(); quota.finish(first, 200)
    second = quota.reserve(); quota.finish(second, None)
    quota.reserve()
    assert (source / (QUOTA + '-wal')).stat().st_size > 0
    before = recovery.facts(source / QUOTA)
    yield source, before
    keeper.close()


@pytest.mark.parametrize('entry', ['ecs', 'local'])
def test_R3_daily_quota_survives_snapshot_archive_restore_and_two_fresh_processes(daily_source, tmp_path, entry):
    source, before = daily_source
    snapshot, unpacked, restored = (tmp_path / name for name in ('snapshot', 'unpacked', 'restored'))
    if entry == 'ecs':
        capture = ecs.capture_data(source, snapshot)
    else:
        capture = recovery.capture(source=source, snapshot=snapshot, database_name='app.db', include_runtime_state=True)
    assert capture['extra_database_count'] == 1
    manifest, _ = recovery.load_snapshot(snapshot, 'app.db', True)
    assert manifest['schema_version'] == 3
    assert manifest['runtime_state']['databases'] == {QUOTA: before}
    packed = archive.pack(snapshot, tmp_path / 'backup.tar')
    assert archive.unpack(tmp_path / 'backup.tar', packed['archive_sha256'], unpacked)['unpacked_snapshot_verified']
    if entry == 'ecs':
        assert ecs.restore_data(unpacked, restored)['restored_verified']
    else:
        assert recovery.restore_test(restored, source=source, snapshot=unpacked, database_name='app.db', include_runtime_state=True)['restored']
    assert recovery.facts(restored / QUOTA) == before
    assert recovery.facts(source / QUOTA) == before
    assert restored.joinpath(QUOTA).stat().st_mode & 0o777 == 0o600
    program = '''
import json,sys
from pathlib import Path
from app.services.daily_model_quota import DailyModelQuota
q=DailyModelQuota(Path(sys.argv[1]),30,clock=lambda:float(sys.argv[2]))
with q.connection() as db:
 rows=[list(row) for row in db.execute('SELECT id,day,outcome,http_status FROM model_attempts ORDER BY id')]
print(json.dumps(dict(status=q.status(),rows=rows)))
'''
    children = []
    for _ in range(2):
        result = subprocess.run([sys.executable, '-c', program, str(restored / QUOTA), str(CLOCK)],
                                env=os.environ.copy(), capture_output=True, text=True, check=True, timeout=10)
        child = json.loads(result.stdout)
        assert child['status']['used'] == 3 and child['status']['remaining'] == 27
        assert sorted(row[2] for row in child['rows']) == ['in_flight', 'response_received', 'unknown_or_error']
        children.append(child)
    assert children[0] == children[1]
    assert recovery.facts(restored / QUOTA) == before
    record('R3-' + entry, dict(status='passed', source_used=3, restored_used=3, remaining=27,
           preserved_outcomes=['in_flight', 'response_received', 'unknown_or_error'],
           committed_WAL_included=True, archive_round_trip=True, fresh_processes=2,
           original_source_unchanged=True, file_mode='0600', schema_version=3, model_requests=0))


@pytest.mark.parametrize('damage', ['missing', 'changed_row', 'corrupt'])
def test_R3_quota_damage_rejects_restore_before_target_creation(daily_source, tmp_path, damage):
    source, _ = daily_source
    snapshot, target = tmp_path / 'snapshot', tmp_path / 'refused-target'
    ecs.capture_data(source, snapshot)
    item = snapshot / QUOTA
    if damage == 'missing':
        item.unlink()
    elif damage == 'changed_row':
        with sqlite3.connect(item) as db:
            db.execute("UPDATE model_attempts SET outcome='tampered'")
    else:
        item.write_bytes(b'not a SQLite database')
    with pytest.raises((ValueError, sqlite3.DatabaseError)):
        ecs.restore_data(snapshot, target)
    assert not target.exists()
    record('R3-damage-' + damage, dict(status='passed', refused=True, target_created=False))


def test_R3_quota_change_during_capture_never_publishes_manifest(daily_source, tmp_path, monkeypatch):
    source, _ = daily_source
    snapshot = tmp_path / 'snapshot'
    original = recovery.copy_database
    changed = []
    def copy_then_change(src, dst):
        original(src, dst)
        if src.name == QUOTA:
            with sqlite3.connect(src) as db:
                db.execute("UPDATE model_attempts SET outcome='changed-during-copy'")
            changed.append(True)
    monkeypatch.setattr(recovery, 'copy_database', copy_then_change)
    with pytest.raises(ValueError, match='incomplete_backup'):
        ecs.capture_data(source, snapshot)
    assert changed == [True]
    assert not (snapshot / 'manifest.json').exists()
    record('R3-concurrent-change', dict(status='passed', refused=True, manifest_published=False))


def test_R3_daily_quota_symlink_rejected_before_snapshot_creation(daily_source, tmp_path):
    source, _ = daily_source
    real = source / QUOTA
    moved = tmp_path / 'other-quota.db'
    shutil.copyfile(real, moved)
    real.unlink()
    real.symlink_to(moved)
    snapshot = tmp_path / 'snapshot'
    with pytest.raises(ValueError, match='unsafe database'):
        ecs.capture_data(source, snapshot)
    assert not snapshot.exists()
    record('R3-quota-symlink', dict(status='passed', refused=True, target_created=False))
