"""Network-free durable call and cost limits for the newly approved batch."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import sqlite3

import pytest

from scripts import c174_batch as batch


@pytest.fixture
def prepared(tmp_path,monkeypatch):
    monkeypatch.setattr(batch,'WORK',tmp_path/'batch')
    monkeypatch.setattr(batch,'authorization',lambda:{'authorization_ref':'synthetic-only',
        'approved_on':'2026-10-01','plan_sha256':'synthetic-plan'})
    batch.initialize()
    return batch


def test_recorded_before_response_and_ambiguity_blocks_new_calls(prepared):
    call=prepared.claim('image','one-image')
    assert prepared.status()['in_flight']==1
    assert prepared.status()['reserved_cny']==.016
    prepared.settle(call,'unknown',{'error_type':'SyntheticTimeout'})
    with pytest.raises(ValueError,match='unresolved'):
        prepared.claim('vision','next-case')
    with pytest.raises(ValueError):
        prepared.settle(call,'succeeded',{})
    assert prepared.status()['provider_requests']==1


def test_concurrent_replay_is_one_durable_attempt(prepared):
    def attempt(_):
        try: return prepared.claim('image','same-operation')
        except sqlite3.IntegrityError: return None
    with ThreadPoolExecutor(max_workers=4) as pool:
        values=list(pool.map(attempt,range(4)))
    assert sum(v is not None for v in values)==1
    assert prepared.status()['counts']['image']==1


def test_independent_life_retains_interrupted_static_reservation(prepared):
    call=prepared.claim('text','repeat:text:1')
    prepared.settle(call,'unknown',{'error_type':'Interrupted'})
    with pytest.raises(ValueError,match='unresolved'):
        prepared.claim('image','repeat:image:1')
    life=prepared.claim('private','unique-life-task')
    prepared.settle(life,'succeeded',{})
    assert prepared.status()['unknown_results']==1
    assert prepared.status()['reserved_cny']==2.2912
    with pytest.raises(sqlite3.IntegrityError):
        prepared.claim('private','unique-life-task')
    failed=prepared.claim('shared','failed-life-task')
    prepared.settle(failed,'unknown',{})
    with pytest.raises(ValueError,match='unresolved'):
        prepared.claim('private','another-life-task')


def test_no_unused_budget_can_expand_fixed_motion_count(prepared):
    for i in range(18):
        call=prepared.claim('motion','motion-'+str(i))
        prepared.settle(call,'succeeded',{'usage':None})
    assert prepared.status()['reserved_usd']==1.999998
    with pytest.raises(ValueError,match='count or budget'):
        prepared.claim('motion','nineteenth')
    assert prepared.status()['provider_requests']==18


def manual_grant(prepared, tmp_path, monkeypatch):
    monkeypatch.setattr(prepared,'EVIDENCE',tmp_path/'evidence')
    prepared.EVIDENCE.mkdir()
    old=prepared.claim('text','repeat_pothos:text:1')
    prepared.settle(old,'unknown',{'error_type':'SyntheticInterrupted'})
    receipt={'ledger_call_id':old,'operation':'repeat_pothos:text:1',
             'response_code_source':'downstream_remote_disconnect','actual_bill_verified':False}
    file=prepared.EVIDENCE/'再创作中断平台回执.json'
    file.write_text(json.dumps(receipt))
    grant={'authorization_ref':prepared.MANUAL_REF,'original_authorization_ref':'synthetic-only',
           'plan_sha256':'synthetic-plan','user_reply':'synthetic explicit manual approval',
           'manual_attempt_confirmed':True,'retain_unknown_reservation':True,
           'text_requests_max':1,'image_requests_max':1,'automatic_retries':0,
           'budget_cny':20,'budget_usd':2,'unknown_call_id':old,
           'receipt_sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
    prepared.save(prepared.EVIDENCE/'同图再创作手动续跑确认.json',grant)
    return grant


def test_manual_continuation_needs_new_confirmation_and_retains_old_cost(prepared,tmp_path,monkeypatch):
    grant=manual_grant(prepared,tmp_path,monkeypatch)
    with pytest.raises(ValueError,match='paused'):
        prepared.claim('text',prepared.MANUAL_PREFIX+':text:1')
    with pytest.raises(ValueError,match='restricted'):
        prepared.claim('vision',prepared.MANUAL_PREFIX+':vision:1',continuation=prepared.MANUAL_REF)
    with pytest.raises(ValueError,match='before the image'):
        prepared.claim('image',prepared.MANUAL_PREFIX+':image:1',continuation=prepared.MANUAL_REF)
    call=prepared.claim('text',prepared.MANUAL_PREFIX+':text:1',continuation=prepared.MANUAL_REF)
    prepared.settle(call,'succeeded',{})
    image=prepared.claim('image',prepared.MANUAL_PREFIX+':image:1',continuation=prepared.MANUAL_REF)
    prepared.settle(image,'succeeded',{})
    assert prepared.status()['reserved_cny']==2.3072
    assert prepared.status()['unknown_results']==1
    assert prepared.status()['counts']['vision']==0
    with pytest.raises(sqlite3.IntegrityError):
        prepared.claim('text',prepared.MANUAL_PREFIX+':text:1',continuation=prepared.MANUAL_REF)
    with pytest.raises(ValueError,match='restricted'):
        prepared.claim('image',prepared.MANUAL_PREFIX+':image:2',continuation=prepared.MANUAL_REF)
    with prepared.connect() as db:
        assert db.execute('SELECT outcome,cny_micro FROM calls WHERE id=?',(grant['unknown_call_id'],)).fetchone()['outcome']=='unknown'


def test_new_unknown_manual_result_stops_the_image(prepared,tmp_path,monkeypatch):
    manual_grant(prepared,tmp_path,monkeypatch)
    call=prepared.claim('text',prepared.MANUAL_PREFIX+':text:1',continuation=prepared.MANUAL_REF)
    prepared.settle(call,'unknown',{})
    with pytest.raises(ValueError,match='additional unresolved'):
        prepared.claim('image',prepared.MANUAL_PREFIX+':image:1',continuation=prepared.MANUAL_REF)
    assert prepared.status()['counts']['image']==0
    assert prepared.status()['reserved_cny']==2.2912


def test_manual_approval_is_bound_to_durable_digest(prepared,tmp_path,monkeypatch):
    grant=manual_grant(prepared,tmp_path,monkeypatch)
    call=prepared.claim('text',prepared.MANUAL_PREFIX+':text:1',continuation=prepared.MANUAL_REF)
    prepared.settle(call,'succeeded',{})
    grant['user_reply']='modified after the first request'
    prepared.save(prepared.EVIDENCE/'同图再创作手动续跑确认.json',grant)
    with pytest.raises(ValueError,match='confirmation changed'):
        prepared.claim('image',prepared.MANUAL_PREFIX+':image:1',continuation=prepared.MANUAL_REF)
    assert prepared.status()['counts']['image']==0


def test_missing_or_changed_manual_receipt_is_rejected(prepared,tmp_path,monkeypatch):
    manual_grant(prepared,tmp_path,monkeypatch)
    receipt=prepared.EVIDENCE/'再创作中断平台回执.json'
    receipt.write_text('{}')
    with pytest.raises(ValueError,match='receipt changed'):
        prepared.claim('text',prepared.MANUAL_PREFIX+':text:1',continuation=prepared.MANUAL_REF)
    assert prepared.status()['counts']['text']==1
