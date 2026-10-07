"""Free isolated maintenance drill; synthetic data and no network/service actions."""
import json
import os
from pathlib import Path
import sqlite3
from uuid import uuid4

from scripts import ecs_maintenance as maintenance
from scripts import ecs_runtime as runtime
from scripts.check_full_flow_recovery import load_snapshot

PROJECT = Path(__file__).resolve().parents[2]


def main():
    area = runtime.safe_path(PROJECT / '.runtime' / 'ecs-maintenance-check')
    area.mkdir(mode=0o700, exist_ok=True)
    maintenance.private_directory(area)
    root = area / uuid4().hex
    root.mkdir(mode=0o700)
    source, backups, monitor = (root / name for name in ('source', 'backups', 'monitor'))
    for directory in (source, backups, monitor):
        directory.mkdir(mode=0o700)
    for name in ('uploads', 'ledger'):
        (source / name).mkdir(mode=0o700)
    (source / runtime.MARKER).write_text('synthetic-volume')
    (source / 'uploads' / 'image.bin').write_bytes(b'synthetic-only')
    (source / 'ledger' / 'approval.json').write_text('{"origin":"synthetic"}')
    (source / 'authorization.json').write_text('{"calls":0}')
    with sqlite3.connect(source / 'app.db') as db:
        db.execute('create table synthetic_records(id integer primary key, value text)')
        db.execute('insert into synthetic_records values(1, "fixture")')
    first = maintenance.backup_once(source, backups)
    if first['state'] != 'verified':
        raise ValueError('synthetic_backup_failed')
    snapshot = backups / first['run_id'] / 'snapshot'
    preserved, _ = load_snapshot(snapshot, 'app.db', True)
    original_copy = runtime.copy_uploads
    original_mount = runtime.os.path.ismount
    original_service, original_loopback = maintenance.service_ready, maintenance.loopback_ready
    try:
        def changed_copy(start, destination):
            original_copy(start, destination)
            if start == source / 'uploads':
                (source / 'uploads' / 'image.bin').write_bytes(b'concurrent-synthetic-change')
        runtime.copy_uploads = changed_copy
        second = maintenance.backup_once(source, backups)
        runtime.os.path.ismount = lambda selected: Path(selected) == source
        maintenance.service_ready = lambda _: True
        maintenance.loopback_ready = lambda _: True
        status = maintenance.monitor_once(source, backups, monitor, 'synthetic-volume')
    finally:
        runtime.copy_uploads = original_copy
        runtime.os.path.ismount = original_mount
        maintenance.service_ready, maintenance.loopback_ready = original_service, original_loopback
    success_unchanged = load_snapshot(snapshot, 'app.db', True)[0] == preserved
    if second['state'] != 'failed' or not success_unchanged or 'latest_backup_failed' not in status['alarms']:
        raise ValueError('synthetic_failure_drill_failed')
    result = {
        'evidence_origin': 'offline_fixture',
        'new_process_drill': True,
        'counts': first['counts'],
        'snapshot_archive_and_restore_verified': True,
        'concurrent_upload_change_rejected': True,
        'failure_alarm_recorded': True,
        'previous_verified_snapshot_preserved': success_unchanged,
        'probe_inputs': 'synthetic_service_and_mount',
        'external_notifications': 0, 'model_requests': 0, 'cloud_requests': 0,
        'production_activation': 'pending',
        'private_artifacts': str(root.relative_to(PROJECT)),
    }
    target = PROJECT / 'docs/PRD/版本/V1.2/验收证据/阶段8/R8.16定时备份与本地告警'
    target.mkdir(parents=True, exist_ok=True)
    output = target / '独立进程演练结果.json'
    with output.open('x', encoding='utf8') as out:
        json.dump(result, out, ensure_ascii=False, indent=2)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    print(json.dumps({k: result[k] for k in ('evidence_origin', 'snapshot_archive_and_restore_verified',
                                          'concurrent_upload_change_rejected', 'failure_alarm_recorded',
                                          'previous_verified_snapshot_preserved', 'model_requests', 'cloud_requests')},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
