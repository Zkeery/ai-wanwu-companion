import json
import sqlite3

import pytest

from scripts import check_shared_dialogue as script


@pytest.fixture
def local_plan(tmp_path, monkeypatch):
    path = tmp_path / 'check.db'
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE characters (id INTEGER,owner_id TEXT,name TEXT,status TEXT,current_space_id TEXT)')
        db.executemany('INSERT INTO characters VALUES (?,?,?,?,?)', [(3,'owner','杯子','ready','home3'),(4,'owner','苹果','ready','home4')])
        db.execute('CREATE TABLE life_gatherings (id TEXT,state_json TEXT)')
        db.execute('INSERT INTO life_gatherings VALUES (?,?)', (script.GROUP,json.dumps({'closed':False,'manager':'owner','members':{'owner':{}},'companions':{}})))
    monkeypatch.setattr(script,'DATABASE',path)
    monkeypatch.setattr(script,'ROOT',tmp_path/'receipts')
    return path


def test_default_reads_only_and_does_not_create_receipt(local_plan, monkeypatch, capsys):
    original=local_plan.read_bytes()
    monkeypatch.setattr('sys.argv',['check_shared_dialogue'])
    script.main()
    result=json.loads(capsys.readouterr().out)
    assert result['max_requests']==1 and result['new_model_requests']==0 and result['budget_yuan']=='1.20'
    assert not script.ROOT.exists() and local_plan.read_bytes()==original


def test_execution_requires_new_authorization(local_plan, monkeypatch):
    monkeypatch.setattr('sys.argv',['check_shared_dialogue','--execute'])
    with pytest.raises(SystemExit): script.main()
    assert not script.ROOT.exists()


def test_existing_receipt_stops_before_model_import(local_plan, monkeypatch):
    script.ROOT.mkdir(); receipt=script.ROOT/'real-execution.json';receipt.write_text('preserve')
    monkeypatch.setattr('sys.argv',['check_shared_dialogue','--execute','--authorization-ref','test-explicit-ref'])
    with pytest.raises(FileExistsError): script.main()
    assert receipt.read_text()=='preserve'
