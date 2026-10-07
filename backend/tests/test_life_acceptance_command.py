import hashlib
import json
import sqlite3
import sys

import pytest

from scripts import check_life_acceptance as command


@pytest.fixture
def review(tmp_path, monkeypatch):
    database = tmp_path / 'check.db'
    with sqlite3.connect(database) as conn:
        conn.execute('CREATE TABLE characters (id INTEGER, owner_id TEXT)')
        conn.execute('INSERT INTO characters VALUES (4, "review-owner")')
    monkeypatch.setattr(command, 'DATABASE', database)
    monkeypatch.setattr(command, 'ROOT', tmp_path / 'runtime')
    return database


def test_default_plan_does_not_load_credentials_runtime_or_write(review, monkeypatch, capsys):
    monkeypatch.setattr(sys, 'argv', ['check_life_acceptance'])
    before = hashlib.sha256(review.read_bytes()).hexdigest()
    # The inspection path must not even import the execution dependencies.
    monkeypatch.setitem(sys.modules, 'scripts.check_candidate_review', None)
    monkeypatch.setitem(sys.modules, 'dotenv', None)
    command.main()
    result = json.loads(capsys.readouterr().out)
    assert result['new_model_requests'] == 0
    assert result['max_requests'] == 1
    assert result['budget_yuan'] == '1.20'
    assert not command.ROOT.exists()
    assert hashlib.sha256(review.read_bytes()).hexdigest() == before


def test_execution_requires_explicit_authorization_reference(review, monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['check_life_acceptance', '--execute'])
    with pytest.raises(SystemExit):
        command.main()
    assert not command.ROOT.exists()


def test_unknown_prior_execution_cannot_be_repeated(review, monkeypatch):
    command.ROOT.mkdir()
    receipt = command.ROOT / 'real-execution.json'
    receipt.write_text('{"state":"claimed"}')
    monkeypatch.setattr(sys, 'argv', ['check_life_acceptance', '--execute', '--authorization-ref', 'test-approval'])
    monkeypatch.setitem(sys.modules, 'scripts.check_candidate_review', None)
    with pytest.raises(FileExistsError):
        command.main()
    assert receipt.read_text() == '{"state":"claimed"}'
