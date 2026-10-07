"""Snapshot DB + images and verify the additive R3.1 migration on an isolated restore.
Run with the local backend stopped, from backend/: .venv/bin/python scripts/backup_seasons_migration.py
Does not migrate/replace the live database, start a service, or call any model.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime

BACKEND = Path(__file__).resolve().parents[1]
PROJECT = BACKEND.parent
sys.path.insert(0, str(BACKEND))
from app.core.config import get_settings
from sqlalchemy.engine import make_url


def digest_tables(db):
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    return {name: hashlib.sha256('\n'.join(sorted(repr(tuple(row)) for row in db.execute('SELECT * FROM "' + name.replace('"', '""') + '"'))).encode()).hexdigest() for name in tables}


def digest_files(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}


def main():
    settings = get_settings()
    url = make_url(settings.database_url)
    if url.get_backend_name() != 'sqlite':
        raise SystemExit('This local migration check supports SQLite only.')
    source = Path(url.database).resolve()
    uploads = Path(settings.upload_dir).resolve()
    if not source.is_relative_to(PROJECT) or not uploads.is_relative_to(PROJECT):
        raise SystemExit('Configured storage must be inside this project.')
    # Caller stops the local service first; refuse an accidental live snapshot.
    listeners = subprocess.run(['lsof', '-t', '-iTCP:8020', '-sTCP:LISTEN'], capture_output=True)
    if listeners.stdout.strip():
        raise SystemExit('Stop the idle project backend before taking this paired snapshot.')
    backup = PROJECT / 'data' / 'backups' / ('r31-seasons-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, mode=0o700)
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as db, sqlite3.connect(backup / 'app.db') as copy:
        before = digest_tables(db)
        db.backup(copy)
    os.chmod(backup / 'app.db', 0o600)
    shutil.copytree(uploads, backup / 'uploads')
    images = digest_files(backup / 'uploads')
    if images != digest_files(uploads):
        raise RuntimeError('Uploads changed during backup; do not migrate.')
    with tempfile.TemporaryDirectory(prefix='r31-restore-', dir=PROJECT / '.runtime') as tmp:
        restored = Path(tmp)
        shutil.copy2(backup / 'app.db', restored / 'app.db')
        shutil.copytree(backup / 'uploads', restored / 'uploads')
        env = {**os.environ, 'DATABASE_URL': f'sqlite:///{restored / "app.db"}',
               'UPLOAD_DIR': str(restored / 'uploads'), 'MODEL_API_KEY': '', 'MODEL_BASE_URL': '', 'IMAGE_BASE_URL': ''}
        probe = subprocess.run([sys.executable, '-c', 'import app.main'], cwd=BACKEND, env=env, capture_output=True)
        if probe.returncode:
            raise RuntimeError('Isolated schema initialization failed; live database untouched.')
        with sqlite3.connect(restored / 'app.db') as db:
            after = digest_tables(db)
            assert all(after.get(k) == v for k, v in before.items()), 'Old table contents changed'
            assert {'living_seasons', 'living_season_receipts'} <= set(after)
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert not db.execute('PRAGMA foreign_key_check').fetchall()
        assert digest_files(restored / 'uploads') == images
    result = {'backup': str(backup.relative_to(PROJECT)), 'old_tables_unchanged': len(before),
              'image_files_restored': len(images), 'integrity_check': 'ok', 'foreign_key_check': 'ok',
              'new_season_tables_created': True, 'live_database_modified': False, 'model_calls': 0}
    (backup / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    evidence = PROJECT / 'docs/PRD/版本/V1.2/验收证据/阶段3'
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / '备份恢复验证.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
