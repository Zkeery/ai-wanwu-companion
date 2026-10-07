"""One-time C1.73 review update, with a full backup and unchanged-data checks."""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import urlopen

PROJECT = Path(__file__).resolve().parents[2]
SOURCE = PROJECT / '.runtime/c160-review'
SNAPSHOT = PROJECT / '.runtime/c173-review-before-update'
RECEIPT = PROJECT / '.runtime/c173-review-update.json'
sys.path.insert(0, str(PROJECT / 'backend/scripts'))
import check_full_flow_recovery as recovery  # noqa: E402


def main():
    if RECEIPT.exists() or SNAPSHOT.exists():
        raise ValueError('review_update_already_started')
    file = SOURCE / 'backend-process.json'
    original = json.loads(file.read_text())
    if original['port'] != 8048 or original['mode'] != 'serve-companions':
        raise ValueError('review_mode_changed')
    pid = original['pid']
    command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='],
                             capture_output=True, text=True, check=True).stdout.strip()
    if not command.endswith('-m scripts.check_candidate_review serve-companions'):
        raise ValueError('review_process_changed')
    config = {name: hashlib.sha256((PROJECT / name).read_bytes()).hexdigest()
              for name in ('.env', 'frontend/next-env.d.ts', 'frontend/tsconfig.json')}
    with sqlite3.connect(SOURCE / 'check.db') as db:
        if db.execute("SELECT count(*) FROM motion_generation_requests WHERE state IN ('running','queued')").fetchone()[0]:
            raise ValueError('paid_motion_pending')
    backed_up = recovery.capture(source=SOURCE, snapshot=SNAPSHOT,
                                 database_name='check.db', include_runtime_state=True)
    before = json.loads((SNAPSHOT / 'manifest.json').read_text())
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 15
    while True:
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', 8048)) != 0:
                break
        if time.monotonic() >= deadline:
            raise ValueError('review_stop_timeout')
        time.sleep(.1)
    process = subprocess.Popen([sys.executable, '-m', 'scripts.check_candidate_review', 'serve-companions'],
                               cwd=PROJECT / 'backend', stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    deadline = time.monotonic() + 30
    while True:
        if process.poll() is not None:
            raise ValueError('review_start_failed')
        try:
            urlopen('http://127.0.0.1:8048/api/v1/auth/me', timeout=1).close()
            break
        except HTTPError as exc:
            if exc.code == 401:
                break
            raise
        except OSError:
            if time.monotonic() >= deadline:
                raise ValueError('review_start_timeout')
            time.sleep(.2)
    after = recovery.snapshot_facts(SOURCE, 'check.db', True)
    assert all(after['tables'].get(name) == value for name, value in before['tables'].items())
    assert after['files'] == before['files'] and after['runtime_state'] == before['runtime_state']
    assert set(after['tables']) - set(before['tables']) == {'motion_generation_activity_requests'}
    with sqlite3.connect(SOURCE / 'check.db') as db:
        assert db.execute('SELECT count(*) FROM motion_generation_activity_requests').fetchone()[0] == 0
    assert all(hashlib.sha256((PROJECT / name).read_bytes()).hexdigest() == digest for name, digest in config.items())
    metadata = {'pid': process.pid, 'port': 8048, 'mode': 'serve-companions'}
    file.write_text(json.dumps(metadata))
    file.chmod(0o600)
    result = {'updated': True, 'old_pid': pid, 'pid': process.pid,
              'original_tables': len(before['tables']), 'current_tables': len(after['tables']),
              'original_data_unchanged': True, 'configuration_unchanged': True,
              'paid_motion_enabled': False, 'actual_model_calls': 0, 'backup': backed_up}
    RECEIPT.write_text(json.dumps(result))
    RECEIPT.chmod(0o600)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
