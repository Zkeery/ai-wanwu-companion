"""R1.12: durable layouts, additive legacy compatibility, boundaries and rollback."""
import json
from uuid import uuid4
import pytest
from sqlalchemy import create_engine, select, update, event
from sqlalchemy.exc import OperationalError
from app.living.rules import CATALOG, LivingError
from app.living.store import LivingStore, spaces, receipts

@pytest.fixture
def oasis(tmp_path):
    clock = [1000]
    engine = create_engine(f"sqlite:///{tmp_path / 'oasis.db'}")
    store = LivingStore(engine, lambda: clock[0]); store.initialize()
    sid = store.create_space('alice', str(uuid4()), 'desert', 'private', 'fruit')['id']
    def act(action, **params):
        return store.execute('alice', sid, str(uuid4()), store.read_space('alice', sid)['revision'], dict(action=action, **params))
    yield store, sid, clock, act
    engine.dispose()

def test_catalog_and_turn_undo(oasis):
    store, sid, clock, act = oasis
    for kind in CATALOG['desert']['items']:
        result = act('place', kind=kind, x=.2, y=.3)
    target = result['items'][0]['id']
    assert act('turn', item_id=target)['items'][0]['flipped'] is True
    assert act('undo')['items'][0]['flipped'] is False
    act('store', item_id=target)
    with pytest.raises(LivingError): act('turn', item_id=target)

def test_layout_preserves_tree_and_undo_does_not_rewind_growth(oasis):
    store, sid, clock, act = oasis
    tree = act('place', kind='tree', x=.2, y=.3)['items'][0]['id']
    act('care', item_id=tree); act('turn', item_id=tree)
    clock[0] += 60
    laid = act('layout', template='water')
    assert len(laid['items']) == 11
    old = next(i for i in laid['items'] if i['id'] == tree)
    assert old['stored'] and old['flipped'] and old['growth_seconds'] == 60
    clock[0] += 60
    restored = act('undo')['items']
    assert len(restored) == 1 and restored[0]['id'] == tree
    assert not restored[0]['stored'] and restored[0]['flipped']
    assert restored[0]['growth_seconds'] == 60 and restored[0]['x'] == .2
    clock[0] += 60
    assert store.read_space('alice', sid)['items'][0]['growth_seconds'] == 120

def test_layout_idempotency_conflicts_owner_and_reopen(oasis):
    store, sid, clock, act = oasis
    request = str(uuid4()); command = {'action':'layout','template':'camp'}
    result = store.execute('alice', sid, request, 0, command)
    assert store.execute('alice', sid, request, 0, command) == result
    assert len(result['items']) == 10 and result['revision'] == 1
    with pytest.raises(LivingError): store.execute('bob', sid, request, 0, command)
    with pytest.raises(LivingError): store.execute('alice', sid, str(uuid4()), 0, command)
    new = LivingStore(store.engine, lambda: clock[0])
    assert new.read_space('alice', sid) == result
    assert new.execute('alice', sid, str(uuid4()), 1, {'action':'undo'})['items'] == []

def test_legacy_missing_only_flipped_is_readable(oasis):
    store, sid, clock, act = oasis
    req = str(uuid4());cmd = dict(action='place',kind='tree',x=.2,y=.3)
    result = store.execute('alice', sid, req, 0, cmd)
    with store.engine.begin() as conn:
        raw = json.loads(conn.execute(select(spaces.c.state_json).where(spaces.c.id==sid)).scalar_one())
        for i in raw['items'].values(): i.pop('flipped')
        old = json.loads(json.dumps(result))
        for i in old['items']: i.pop('flipped')
        conn.execute(update(spaces).where(spaces.c.id==sid).values(state_json=json.dumps(raw)))
        conn.execute(update(receipts).where(receipts.c.space_id==sid).values(result_json=json.dumps(old)))
    assert store.read_space('alice',sid)['items'][0]['flipped'] is False
    assert store.execute('alice',sid,req,0,cmd) == result
    next(iter(raw['items'].values())).pop('stored')
    with store.engine.begin() as conn: conn.execute(update(spaces).where(spaces.c.id==sid).values(state_json=json.dumps(raw)))
    with pytest.raises(LivingError): store.read_space('alice',sid)

def test_limit_is_atomic_and_existing_items_remain_usable(oasis):
    store,sid,clock,act=oasis
    for _ in range(20): act('layout',template='water')
    before = store.read_space('alice',sid)
    with pytest.raises(LivingError): act('layout',template='camp')
    with pytest.raises(LivingError): act('place',kind='palm',x=.5,y=.5)
    assert store.read_space('alice',sid) == before
    target = next(i for i in before['items'] if not i['stored'])['id']
    assert act('move',item_id=target,x=.1,y=.2)['revision'] == before['revision']+1

def test_receipt_failure_rolls_back_entire_layout(oasis):
    store,sid,clock,act=oasis
    before = act('place',kind='tree',x=.2,y=.3)
    def fail(conn,cursor,statement,params,context,many):
        if statement.startswith('INSERT INTO living_receipts'):
            raise OperationalError(statement,params,Exception('test rollback'))
    event.listen(store.engine,'before_cursor_execute',fail)
    try:
        with pytest.raises(LivingError): act('layout',template='water')
    finally: event.remove(store.engine,'before_cursor_execute',fail)
    assert store.read_space('alice',sid) == before

@pytest.mark.parametrize('scene',['home','forest'])
def test_new_operations_are_desert_only(oasis,scene):
    store,sid,clock,act=oasis
    other=store.create_space('alice',str(uuid4()),scene,'shared')['id']
    with pytest.raises(LivingError): store.execute('alice',other,str(uuid4()),0,dict(action='layout',template='water'))
    result=store.execute('alice',other,str(uuid4()),0,dict(action='place',kind='tree',x=.2,y=.3))
    with pytest.raises(LivingError): store.execute('alice',other,str(uuid4()),1,dict(action='turn',item_id=result['items'][0]['id']))
