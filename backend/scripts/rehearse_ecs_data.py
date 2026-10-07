"""Project-local, synthetic and offline verification of the ECS data tools."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3

from scripts import ecs_runtime as runtime

PROJECT = Path(__file__).resolve().parents[2]
WORK = PROJECT / '.runtime/r815-ecs-data'
EVIDENCE = PROJECT / 'docs/PRD/版本/V1.2/验收证据/阶段8/R8.15常驻部署准备'


def protected_facts() -> dict:
    result = {}
    for relative in ('backend/.env', '.env', 'frontend/.env.local', '.runtime/real-web/process.json'):
        path = PROJECT / relative
        result[relative] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    return result


def main() -> int:
    before = protected_facts()
    if WORK.exists() or (EVIDENCE / '验证结果.json').exists():
        raise FileExistsError('Do not overwrite the rehearsal or evidence')
    WORK.mkdir(mode=0o700)
    source = WORK / 'synthetic-data'
    source.mkdir(mode=0o700)
    for name in ('uploads', 'ledger'):
        (source / name).mkdir(mode=0o700)
    with sqlite3.connect(source / 'app.db') as db:
        db.execute('CREATE TABLE synthetic_events (id INTEGER PRIMARY KEY, state TEXT)')
        db.execute("INSERT INTO synthetic_events VALUES (1, 'durable')")
    (source / 'uploads' / 'synthetic.txt').write_text('synthetic asset')
    (source / 'ledger' / 'synthetic.json').write_text('{"status":"waiting"}')
    (source / 'synthetic-policy.json').write_text('{"enabled":false,"remaining":0}')

    original_connect = socket.socket.connect
    socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('network_forbidden'))
    try:
        capture = runtime.capture_data(source, WORK / 'snapshot')
        restored = runtime.restore_data(WORK / 'snapshot', WORK / 'restored')
        with sqlite3.connect((WORK / 'restored/app.db').as_uri() + '?mode=ro', uri=True) as db:
            reopened = db.execute('SELECT state FROM synthetic_events WHERE id=1').fetchone() == ('durable',)
        equal = runtime.snapshot_facts(source, 'app.db', True) == runtime.snapshot_facts(WORK / 'restored', 'app.db', True)
        reject_target = WORK / 'must-not-be-created'
        (WORK / 'snapshot/ledger/synthetic.json').write_text('{"status":"changed"}')
        try:
            runtime.restore_data(WORK / 'snapshot', reject_target)
            rejected = False
        except ValueError:
            rejected = not reject_target.exists()
        try:
            runtime.mounted_volume(WORK / 'absent-volume', 'synthetic-volume')
            unmounted_rejected = False
        except ValueError:
            unmounted_rejected = not (WORK / 'absent-volume').exists()
        preserved = protected_facts() == before
        if not all((reopened, equal, rejected, unmounted_rejected, preserved)):
            raise ValueError('Rehearsal did not pass')
        result = dict(checked_at=datetime.now(timezone.utc).isoformat(), evidence_origin='synthetic_offline_rehearsal',
                      capture=capture, restore=restored, reopened_sqlite=reopened,
                      full_data_equal=equal, tampered_ledger_rejected=rejected,
                      unmounted_directory_not_created=unmounted_rejected,
                      local_configs_and_process_record_unchanged=preserved,
                      service_restarts=0, model_requests=0, sms_requests=0, cloud_requests=0,
                      linux_systemd_nginx='pending', x86_cloud_build='pending', offsite_backup='pending',
                      temporary_synthetic_data_cleaned=True)
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        with (EVIDENCE / '验证结果.json').open('x', encoding='utf8') as out:
            json.dump(result, out, ensure_ascii=False, indent=2)
        for item in (source, WORK / 'restored', WORK / 'snapshot'):
            shutil.rmtree(item)
        print(json.dumps({'status': 'passed', 'evidence': str((EVIDENCE / '验证结果.json').relative_to(PROJECT)),
                          'model_requests': 0, 'sms_requests': 0, 'cloud_requests': 0}))
        return 0
    finally:
        socket.socket.connect = original_connect


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'error': {'code': 'ecs_rehearsal_failed',
                                   'message': '隔离演练未通过，保留现场，请检查原始记录。'}}, ensure_ascii=False))
        raise SystemExit(1) from None
