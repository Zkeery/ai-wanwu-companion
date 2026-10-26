"""Fresh process bootstrap and non-destructive additive schema checks, no network."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys

import pytest
from sqlalchemy import create_engine, insert, select

from app.core.database import Base
from app.living.store import metadata
from app.models.models import User, Photo, Object, Character, Message
from app.services.voice import preferences

BACKEND = Path(__file__).resolve().parents[1]
MAHJONG_TABLES = {
    'life_gathering_mahjong_games',
    'life_gathering_mahjong_events',
    'life_gathering_mahjong_receipts',
}
FLOOR_TABLES = {'life_villa_floors', 'life_villa_floor_journal'}
REQUIRED_TABLES = MAHJONG_TABLES | FLOOR_TABLES


@pytest.fixture(autouse=True)
def network_forbidden(monkeypatch):
    def deny(*_args, **_kwargs):
        raise AssertionError('SCHEMA_TEST_NETWORK_FORBIDDEN')
    monkeypatch.setattr(socket.socket, 'connect', deny)
    monkeypatch.setattr(socket.socket, 'connect_ex', deny)


def test_fresh_subprocess_creates_all_queried_shared_tables_before_first_group_save(tmp_path):
    script = '''
import json, socket, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
def deny(*_a, **_kw): raise AssertionError('SCHEMA_TEST_NETWORK_FORBIDDEN')
socket.socket.connect = deny
socket.socket.connect_ex = deny
from app.services.life_acceptance_setup import create_business
directory = Path(sys.argv[2])
directory.mkdir()
create_business(directory, 'synthetic-owner', [
    {'id': 4, 'name': '合成甲', 'persona': '隔离测试'},
    {'id': 6, 'name': '合成乙', 'persona': '隔离测试'}
], 6, [4, 6], 'schema-test-only-authorization', 1792425540)
print(json.dumps({'prepared': True, 'main_app_imported': 'app.main' in sys.modules}))
'''
    env = dict(os.environ, DATABASE_URL='sqlite:///' + str(tmp_path / 'unopened-main.db'),
               UPLOAD_DIR=str(tmp_path / 'uploads'), MODEL_API_KEY='', MODEL_BASE_URL='', IMAGE_BASE_URL='',
               APP_ENV='test', USE_MOCK='true')
    directory = tmp_path / 'isolated'
    result = subprocess.run([sys.executable, '-c', script, str(BACKEND), str(directory)],
                            cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-1000:]
    assert json.loads(result.stdout) == {'prepared': True, 'main_app_imported': False}
    assert not (tmp_path / 'unopened-main.db').exists()
    for name in ('private.db', 'shared.db'):
        with sqlite3.connect(directory / name) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert REQUIRED_TABLES <= tables
            for table in REQUIRED_TABLES:
                assert db.execute('SELECT count(*) FROM ' + table).fetchone()[0] == 0
            ids = {row[0] for row in db.execute('SELECT id FROM characters')}
            assert ids == ({6} if name == 'private.db' else {4, 6})
            assert {row[0] for row in db.execute('SELECT owner_id FROM characters')} == {'synthetic-owner'}
            assert db.execute('PRAGMA foreign_key_check').fetchall() == []
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'


def test_adding_required_schema_keeps_legacy_business_rows_columns_and_private_mood_unchanged(tmp_path):
    from app.living import gathering_mahjong, villa_floor  # register additive tables only
    assert {gathering_mahjong.games.name, gathering_mahjong.events.name,
            gathering_mahjong.receipts.name} == MAHJONG_TABLES
    assert {villa_floor.floors.name, villa_floor.journal.name} == FLOOR_TABLES
    isolated = create_engine('sqlite:///' + str(tmp_path / 'legacy.db'))
    Base.metadata.create_all(isolated)
    metadata.create_all(isolated, tables=[table for table in metadata.tables.values()
                                        if table.name not in REQUIRED_TABLES])
    with isolated.begin() as conn:
        conn.execute(insert(User).values(id='schema-test-owner', phone='13900000983'))
        conn.execute(insert(Photo).values(id=1, owner_id='schema-test-owner', filename='synthetic.png'))
        conn.execute(insert(Object).values(id=1, photo_id=1, label='合成旧伙伴'))
        conn.execute(insert(Character).values(id=7, object_id=1, owner_id='schema-test-owner',
            name='合成旧名字', persona='合成旧资料', opening_line='你好', status='ready'))
        conn.execute(insert(Message).values(character_id=7, role='user', content='合成旧聊天'))
        conn.execute(insert(preferences).values(character_id=7, owner_id='schema-test-owner',
            voice='synthetic-local-voice', mood='calm', automatic=0, mood_source='user'))
    with isolated.connect() as conn:
        before_tables = conn.exec_driver_sql(
            "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        before_rows = {name: conn.exec_driver_sql('SELECT * FROM "' + name + '"').fetchall()
                       for name, _sql in before_tables}
        before_columns = {name: conn.exec_driver_sql('PRAGMA table_info("' + name + '")').fetchall()
                          for name, _sql in before_tables}
    metadata.create_all(isolated)
    with isolated.connect() as conn:
        after = dict(conn.exec_driver_sql("SELECT name,sql FROM sqlite_master WHERE type='table'").fetchall())
        assert set(after) - set(before_rows) == REQUIRED_TABLES
        for name, schema in before_tables:
            assert after[name] == schema
            assert conn.exec_driver_sql('SELECT * FROM "' + name + '"').fetchall() == before_rows[name]
            assert conn.exec_driver_sql('PRAGMA table_info("' + name + '")').fetchall() == before_columns[name]
        for table in REQUIRED_TABLES:
            assert conn.exec_driver_sql('SELECT count(*) FROM ' + table).scalar_one() == 0
        assert conn.execute(select(preferences.c.mood)).scalar_one() == 'calm'
        assert conn.exec_driver_sql('PRAGMA integrity_check').scalar_one() == 'ok'
    isolated.dispose()
