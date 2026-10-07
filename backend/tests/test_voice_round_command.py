import json
import sqlite3

import pytest

from scripts import check_voice_round as script


@pytest.fixture
def prepared(tmp_path, monkeypatch):
    database = tmp_path / 'sample.db'
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE characters(id INTEGER,owner_id TEXT,status TEXT)')
        db.execute("INSERT INTO characters VALUES(4,'owner','ready')")
    (tmp_path / 'input.wav').write_bytes(b'preflight-only')
    monkeypatch.setattr(script, 'ROOT', tmp_path)
    monkeypatch.setattr(script, 'DATABASE', database)
    return tmp_path, database


def test_plan_does_not_touch_data_or_create_execution(prepared, monkeypatch, capsys):
    root, database = prepared
    before = database.read_bytes()
    monkeypatch.setattr('sys.argv', ['check_voice_round'])
    script.main()
    output = json.loads(capsys.readouterr().out)
    assert output['max_requests'] == 1 and output['new_model_requests'] == 0
    assert database.read_bytes() == before and not (root / 'real-execution.json').exists()


def test_execute_requires_explicit_new_reference(prepared, monkeypatch):
    monkeypatch.setattr('sys.argv', ['check_voice_round', '--execute'])
    with pytest.raises(SystemExit): script.main()
    assert not (prepared[0] / 'real-execution.json').exists()


def test_prior_execution_cannot_be_replayed(prepared, monkeypatch):
    receipt = prepared[0] / 'real-execution.json'
    receipt.write_text('keep previous execution')
    monkeypatch.setattr('sys.argv', ['check_voice_round', '--execute', '--authorization-ref', 'new-explicit-ref'])
    with pytest.raises(FileExistsError): script.main()
    assert receipt.read_text() == 'keep previous execution'
