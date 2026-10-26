"""Free authoritative shared table. No providers, user messages, or paid runtime."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from uuid import uuid4

from sqlalchemy import Column, Integer, String, Table, Text, insert, select, update

from app.living import gathering_mahjong_rules as rules
from app.living.gatherings import GatheringStore, fail, visits
from app.living.store import metadata, _uuid
from app.models.models import Character


games = Table('life_gathering_mahjong_games', metadata,
    Column('id', String(36), primary_key=True), Column('group_id', String(36), nullable=False, index=True),
    Column('ordinal', Integer, nullable=False), Column('revision', Integer, nullable=False),
    Column('status', String(16), nullable=False), Column('roster_json', Text, nullable=False),
    Column('state_json', Text, nullable=False), Column('created_at_ms', Integer, nullable=False),
    Column('phase_started_at_ms', Integer, nullable=False), Column('next_due_at_ms', Integer, nullable=False))
events = Table('life_gathering_mahjong_events', metadata,
    Column('game_id', String(36), primary_key=True), Column('seq', Integer, primary_key=True),
    Column('event_json', Text, nullable=False))
receipts = Table('life_gathering_mahjong_receipts', metadata,
    Column('owner_id', String(128), primary_key=True), Column('request_id', String(36), primary_key=True),
    Column('digest', String(64), nullable=False), Column('result_json', Text, nullable=False))


def _load_state(row):
    try:
        state = json.loads(row['state_json'])
        rules.validate_state(state)
        if state['status'] != row['status']:
            raise ValueError('status mismatch')
        return state
    except (ValueError, TypeError, KeyError, IndexError):
        fail('牌局存档暂不可用，已停止推进', 'storage_unavailable')


def latest(conn, gid):
    return conn.execute(select(games).where(games.c.group_id == gid)
                        .order_by(games.c.ordinal.desc()).limit(1)).mappings().first()


def roster_for(conn, g):
    if g['closed'] or g['scene_type'] != 'home':
        return [], 'wrong_scene'
    seated = [c for c in g['companions'].values() if c.get('leisure', {}).get('activity') == 'mahjong']
    if len(seated) != 4:
        return [], 'not_full'
    if {c['leisure'].get('seat_id') for c in seated} != {f'mahjong-{i}' for i in range(4)}:
        return [], 'seat_conflict'
    result = []
    for c in sorted(seated, key=lambda c: c['leisure']['seat_id']):
        character = conn.execute(select(Character.id, Character.owner_id, Character.status,
            Character.current_space_id, Character.location_epoch).where(Character.id == c['id'])).mappings().first()
        visit = conn.execute(select(visits).where(visits.c.character_id == c['id'],
            visits.c.group_id == g['id'], visits.c.owner_id == c['owner_id'])).mappings().first()
        if (not character or not visit or character['owner_id'] != c['owner_id'] or
                c['owner_id'] not in g['members'] or character['status'] != 'ready' or
                character['current_space_id'] != g['id'] or c['leisure'].get('station_version') != 1):
            return [], 'invalid_participant'
        result.append(dict(character_id=c['id'], owner_id=c['owner_id'],
            seat_id=c['leisure']['seat_id'], location_epoch=character['location_epoch']))
    return result, None


def interrupt_if_changed(conn, g, now_ms=None):
    """Called in the original free-space write transaction, never by GET."""
    row = latest(conn, g['id'])
    if not row or row['status'] != 'playing':
        return
    roster, reason = roster_for(conn, g)
    if reason is None and roster == json.loads(row['roster_json']):
        return
    state = _load_state(row)
    state['status'] = 'interrupted'
    at = int(time.time() * 1000) if now_ms is None else now_ms
    conn.execute(update(games).where(games.c.id == row['id'], games.c.revision == row['revision']).values(
        revision=row['revision'] + 1, status='interrupted', state_json=json.dumps(state, ensure_ascii=False),
        next_due_at_ms=at))
    # Internal lifecycle audit never substitutes a Mahjong spoken event.
    conn.execute(insert(events).values(game_id=row['id'], seq=-row['revision'] - 1,
        event_json=json.dumps(dict(kind='interrupted', reason=reason or 'roster_changed', at_ms=at))))


class MahjongStore:
    def __init__(self, engine, clock=None, wall_factory=None):
        self.engine = engine
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.wall_factory = wall_factory
        self.spaces = GatheringStore(engine)

    def _now(self):
        now = self.clock()
        if type(now) is not int or now < 0:
            fail('服务端时间不可用，牌局未推进', 'storage_unavailable')
        return now

    @staticmethod
    def _owned(conn, uid, roster):
        ids = [p['character_id'] for p in roster if p['owner_id'] == uid]
        if not ids:
            return set()
        return set(conn.execute(select(Character.id).where(Character.id.in_(ids),
                   Character.owner_id == uid)).scalars())

    def _snapshot(self, conn, g, uid, row, now):
        roster, reason = roster_for(conn, g)
        owned = self._owned(conn, uid, roster)
        if reason is None and not owned:
            reason = 'no_owned_participant'
        in_progress = bool(row and row['status'] == 'playing')
        blocked = reason or ('game_in_progress' if in_progress else None)
        result = dict(gathering_id=g['id'], server_now_ms=now, can_start=row is None and blocked is None,
            can_new_round=bool(row and not in_progress and reason is None), start_blocked_reason=blocked, game=None)
        if row is None:
            return result
        state = _load_state(row)
        original = json.loads(row['roster_json'])
        still_valid = reason in (None, 'no_owned_participant') and roster == original
        own_ids = self._owned(conn, uid, original)
        can_advance = in_progress and still_valid and bool(own_ids)
        players = []
        for p in state['players']:
            melds = [dict(kind=m['kind'], concealed=m.get('concealed', False), tile_count=len(m['tiles']),
                tiles=[] if m.get('concealed') else [dict(id=t, face=rules.face(t)) for t in m['tiles']])
                for m in p['melds']]
            players.append(dict(character_id=p['character_id'], seat_id=p['seat_id'], hand_count=len(p['hand']),
                melds=melds, discards=[dict(id=t, face=rules.face(t)) for t in p['discards']],
                won=p['won'], missing_suit=p['missing_suit'], score=p['score']))
        event = state['last_event']
        if event:
            event = dict(event)
            hidden = event['kind'] == 'draw' or event.get('concealed', False)
            event['tile'] = None if hidden or event['tile'] is None else dict(id=event['tile'], face=rules.face(event['tile']))
            if hidden:
                event['text'] = '摸牌' if event['kind'] == 'draw' else '暗杠'
            event.pop('concealed', None)
        turn = state['turn']
        result['game'] = dict(game_id=row['id'], gathering_id=g['id'], rules_version=rules.RULES_VERSION,
            revision=row['revision'], status=state['status'], phase=state['phase'],
            turn_character_id=None if turn is None else state['players'][turn]['character_id'],
            wall_remaining=len(state['wall']), phase_started_at_ms=row['phase_started_at_ms'],
            next_due_at_ms=row['next_due_at_ms'], observed_at_ms=now, can_advance=can_advance,
            advance_due=can_advance and now >= row['next_due_at_ms'], players=players, last_event=event,
            own_hands=[dict(character_id=p['character_id'], tiles=[dict(id=t, face=rules.face(t)) for t in p['hand']])
                       for p in state['players'] if p['character_id'] in own_ids],
            score_transfers=state['score_transfers'], settlement=state['settlement'])
        return result

    def read(self, uid, gid):
        gid = _uuid(gid)
        with self.engine.connect() as conn:
            g, _ = self.spaces.load(conn, gid)
            self.spaces.member(g, uid)
            return self._snapshot(conn, g, uid, latest(conn, gid), self._now())

    def command(self, uid, gid, rid, game_id, revision, action):
        gid, rid = _uuid(gid), _uuid(rid)
        if game_id is not None:
            game_id = _uuid(game_id)
        if action not in ('start', 'advance', 'new_round') or type(revision) is not int or revision < 0:
            fail('牌局命令无效', 'invalid_request')
        digest = hashlib.sha256(json.dumps(dict(group=gid, game=game_id, revision=revision, action=action), sort_keys=True).encode()).hexdigest()
        with self.spaces.transaction() as conn:
            g, _ = self.spaces.load(conn, gid)
            self.spaces.member(g, uid)
            now = self._now()
            previous = conn.execute(select(receipts).where(receipts.c.owner_id == uid,
                                   receipts.c.request_id == rid)).mappings().first()
            if previous:
                if previous['digest'] != digest:
                    fail('同一请求不能更改内容', 'conflict')
                result = json.loads(previous['result_json'])
                if result['game']:
                    original_row = conn.execute(select(games).where(games.c.id == result['game']['game_id'])).mappings().one()
                    owned = self._owned(conn, uid, json.loads(original_row['roster_json']))
                    result['game']['own_hands'] = [h for h in result['game']['own_hands'] if h['character_id'] in owned]
                return result
            row = latest(conn, gid)
            if (row is None and (action != 'start' or game_id is not None or revision != 0)) or (
                    row is not None and (game_id != row['id'] or revision != row['revision'] or action == 'start')):
                fail('牌局已更新，请刷新核对', 'conflict')
            roster, reason = roster_for(conn, g)
            if reason is not None or not self._owned(conn, uid, roster):
                fail('需要四位在场伙伴各自入座，且只能由参与者的主人推进', 'invalid_action')
            if action in ('start', 'new_round'):
                if row and row['status'] == 'playing':
                    fail('本局仍在进行，不能重开', 'conflict')
                wall = list(range(108))
                if self.wall_factory is None:
                    secrets.SystemRandom().shuffle(wall)
                else:
                    wall = self.wall_factory()
                state = rules.new_state(roster, wall, secrets.randbelow(0xffffffff) + 1)
                values = dict(id=str(uuid4()), group_id=gid, ordinal=1 if row is None else row['ordinal'] + 1,
                    revision=1, status='playing', roster_json=json.dumps(roster), state_json=json.dumps(state, ensure_ascii=False),
                    created_at_ms=now, phase_started_at_ms=now, next_due_at_ms=now + rules.PHASE_MS[state['phase']])
                conn.execute(insert(games).values(**values))
                row = values
            else:
                if row['status'] != 'playing' or roster != json.loads(row['roster_json']):
                    fail('本局已中断或参与者已变化，请查看记录', 'conflict')
                if now < row['next_due_at_ms']:
                    fail('尚未轮到下一步，请等待当前动作完成', 'conflict')
                try:
                    state = rules.advance(_load_state(row))
                except (ValueError, TypeError, KeyError, IndexError):
                    fail('牌局存档暂不可用，已停止推进', 'storage_unavailable')
                values = dict(revision=row['revision'] + 1, status=state['status'],
                    state_json=json.dumps(state, ensure_ascii=False), phase_started_at_ms=now,
                    next_due_at_ms=now + rules.PHASE_MS[state['phase']])
                changed = conn.execute(update(games).where(games.c.id == row['id'],
                    games.c.revision == revision).values(**values))
                if changed.rowcount != 1:
                    fail('牌局已更新，请刷新核对', 'conflict')
                previous_state = _load_state(row)
                if state['event_seq'] != previous_state['event_seq']:
                    conn.execute(insert(events).values(game_id=row['id'], seq=state['event_seq'],
                        event_json=json.dumps(state['last_event'], ensure_ascii=False)))
                row = dict(row, **values)
            result = self._snapshot(conn, g, uid, row, now)
            conn.execute(insert(receipts).values(owner_id=uid, request_id=rid, digest=digest,
                result_json=json.dumps(result, ensure_ascii=False)))
            return result
