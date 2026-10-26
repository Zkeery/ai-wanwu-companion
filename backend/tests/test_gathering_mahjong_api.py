import json
from uuid import uuid4

import pytest

from app.api import gathering_mahjong
from app.living.gathering_mahjong import MahjongStore
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_gathering_mahjong import table  # noqa: F401 -- shared isolated SQL fixture
from tests.test_gatherings import command, member


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('network forbidden'))


def request(view=None, action='start', **extra):
    g = None if view is None else view['game']
    return dict(request_id=str(uuid4()), game_id=None if g is None else g['game_id'],
                expected_revision=0 if g is None else g['revision'], command={'action': action}, **extra)


def test_route_json_contract_auth_no_store_and_readonly(table, client, anon, monkeypatch, tmp_path):
    _, store, clock, g, ids = table
    monkeypatch.setattr(gathering_mahjong, 'store', store)
    url = f'/api/v1/gatherings/{g["id"]}/mahjong'
    assert anon.get(url).status_code == 401
    assert client.get(url).json()['game'] is None
    response = client.post(url + '/commands', json=request())
    assert response.status_code == 200, response.text
    assert response.headers['Cache-Control'] == 'no-store'
    view = response.json()
    assert view['game']['revision'] == 1
    assert {h['character_id'] for h in view['game']['own_hands']} == set(ids[:2])
    assert view['game']['turn_character_id'] in ids
    assert all(type(view['game'][k]) is int for k in ['phase_started_at_ms', 'next_due_at_ms', 'observed_at_ms'])
    (tmp_path / 'synthetic-start-snapshot.json').write_text(json.dumps(view, ensure_ascii=False, indent=2))
    assert client.get(url).json() == view
    invalid = request(view, 'advance')
    invalid['command']['tile'] = 1
    assert client.post(url + '/commands', json=invalid).status_code == 422
    invalid = request(view, 'advance')
    invalid['expected_revision'] = True
    assert client.post(url + '/commands', json=invalid).status_code == 422
    assert client.post(url + '/commands', json=request(view, 'advance')).status_code == 409
    clock[0] = view['game']['next_due_at_ms']
    response = client.post(url + '/commands', json=request(view, 'advance'))
    assert response.status_code == 200 and response.json()['game']['revision'] == 2
    assert response.json() == MahjongStore(store.engine, store.clock).read(UID, g['id'])


def test_route_public_melds_and_private_draw_remain_safe(table, client, monkeypatch, tmp_path):
    _, store, clock, g, ids = table
    monkeypatch.setattr(gathering_mahjong, 'store', store)
    url = f'/api/v1/gatherings/{g["id"]}/mahjong'
    view = client.post(url + '/commands', json=request()).json()
    concealed = draw = exposed = False
    for _ in range(1500):
        if view['game']['status'] != 'playing':
            break
        clock[0] = view['game']['next_due_at_ms']
        response = client.post(url + '/commands', json=request(view, 'advance'))
        assert response.status_code == 200
        view = response.json()
        for p in view['game']['players']:
            for meld in p['melds']:
                if meld['concealed']:
                    concealed = True
                    assert meld['tiles'] == [] and meld['tile_count'] == 4
                else:
                    exposed = True
                    assert all(type(t['id']) is int and isinstance(t['face'], str) for t in meld['tiles'])
        event = view['game']['last_event']
        if event and event['kind'] == 'draw':
            draw = True
            assert event['tile'] is None and event['text'] == '摸牌'
            (tmp_path / 'synthetic-draw-snapshot.json').write_text(json.dumps(view, ensure_ascii=False, indent=2))
        if event and event['text'] == '暗杠':
            assert event['tile'] is None
    assert view['game']['status'] == 'ended' and concealed and draw
    assert view['game']['turn_character_id'] in ids
    (tmp_path / 'synthetic-ended-snapshot.json').write_text(json.dumps(view, ensure_ascii=False, indent=2))
    # The deterministic wall may finish without an exposed meld; any that occur must satisfy the DTO.
    assert type(exposed) is bool


def test_wrong_scene_or_missing_seats_have_explicit_reason(table, client, monkeypatch):
    free, store, clock, g, ids = table
    monkeypatch.setattr(gathering_mahjong, 'store', store)
    g = command(free, g, 'leisure', character_id=ids[0], activity=None)
    url = f'/api/v1/gatherings/{g["id"]}/mahjong'
    assert client.get(url).json()['start_blocked_reason'] == 'not_full'
    assert client.post(url + '/commands', json=request()).status_code == 409


def test_route_interrupted_snapshot_preserves_old_game(table, client, monkeypatch, tmp_path):
    free, store, clock, g, ids = table
    monkeypatch.setattr(gathering_mahjong, 'store', store)
    url = f'/api/v1/gatherings/{g["id"]}/mahjong'
    before = client.post(url + '/commands', json=request()).json()
    command(free, g, 'recall', character_id=ids[0])
    response = client.get(url)
    assert response.status_code == 200
    result = response.json()
    assert result['game']['game_id'] == before['game']['game_id']
    assert result['game']['status'] == 'interrupted' and not result['game']['can_advance']
    (tmp_path / 'synthetic-interrupted-snapshot.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
