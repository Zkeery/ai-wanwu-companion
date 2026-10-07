"""Durable shared life. No provider calls; ownership is checked inside each transaction."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from contextlib import contextmanager
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy import Column, Integer, String, Table, Text, delete, insert, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.living import seasons
from app.living.rules import CATALOG, Command, Item, LivingError, State, apply, public_items, settle
from app.living.store import metadata, spaces, _uuid

groups = Table('life_gatherings', metadata,
    Column('id', String(36), primary_key=True), Column('revision', Integer, nullable=False),
    Column('state_json', Text, nullable=False))
receipts = Table('life_gathering_receipts', metadata,
    Column('owner_id', String(128), primary_key=True), Column('request_id', String(36), primary_key=True),
    Column('digest', String(64), nullable=False), Column('result_json', Text, nullable=False))
visits = Table('life_visits', metadata,
    Column('character_id', Integer, primary_key=True), Column('owner_id', String(128), nullable=False),
    Column('group_id', String(36), nullable=False), Column('home_id', String(36)))
inventory = Table('life_inventory', metadata,
    Column('id', String(36), primary_key=True), Column('owner_id', String(128), nullable=False),
    Column('item_json', Text, nullable=False))
notifications = Table('life_notifications', metadata,
    Column('id', String(36), primary_key=True), Column('owner_id', String(128), nullable=False),
    Column('created_at', Integer, nullable=False), Column('message', String(300), nullable=False))
memories = Table('life_shared_memories', metadata,
    Column('owner_id', String(128), primary_key=True), Column('event_id', String(36), primary_key=True),
    Column('group_id', String(36), nullable=False), Column('event_json', Text, nullable=False))


def fail(message, code='invalid_action'):
    raise LivingError(code, message)


def label(value, limit=30):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= limit or any(ord(c) < 32 for c in value):
        fail('请填写有效名称', 'invalid_request')
    return value.strip()


class GatheringStore:
    def __init__(self, engine, clock=None):
        self.engine = engine
        self.clock = clock or (lambda: int(time.time()))

    @contextmanager
    def transaction(self):
        # SQLite write lock precedes reads: voting and membership changes have one order.
        with self.engine.connect() as conn:
            try:
                conn.exec_driver_sql('BEGIN IMMEDIATE')
                yield conn
                conn.commit()
            except IntegrityError:
                conn.rollback()
                fail('记录已变化，请刷新核对后再试', 'conflict')
            except SQLAlchemyError:
                conn.rollback()
                fail('存档暂时不可用，请稍后重试', 'storage_unavailable')
            except BaseException:
                conn.rollback()
                raise

    @staticmethod
    def load(conn, gid):
        row = conn.execute(select(groups).where(groups.c.id == gid)).mappings().first()
        if not row:
            fail('共同空间不存在或无权访问', 'not_found')
        return json.loads(row['state_json']), row['revision']

    @staticmethod
    def member(g, uid):
        if g['closed'] or uid not in g['members']:
            fail('共同空间不存在或无权访问', 'not_found')

    @staticmethod
    def manager(g, uid):
        if g['manager'] != uid:
            fail('只有当前管理者可以执行此操作')

    @staticmethod
    def save(conn, g, revision):
        conn.execute(update(groups).where(groups.c.id == g['id']).values(
            revision=revision, state_json=json.dumps(g, ensure_ascii=False)))

    def event(self, conn, g, message, now, **details):
        event = dict(id=str(uuid4()), at=now, message=message, **details)
        g['events'].append(event)
        # Every recipient owns their historical copy; leaving never leaks new events.
        for uid in g['members']:
            conn.execute(insert(memories).values(owner_id=uid, event_id=event['id'],
                group_id=g['id'], event_json=json.dumps(event, ensure_ascii=False)))

    @staticmethod
    def notify(conn, uid, message, now):
        conn.execute(insert(notifications).values(id=str(uuid4()), owner_id=uid,
            created_at=now, message=message))

    @staticmethod
    def cancel_votes(g):
        for vote in g['votes']:
            if vote['status'] == 'pending':
                vote['status'] = 'cancelled_members_changed'

    def return_home(self, conn, g, cid):
        from app.models.models import Character
        row = conn.execute(select(visits).where(visits.c.character_id == cid,
            visits.c.group_id == g['id'])).mappings().first()
        if row:
            conn.execute(update(Character).where(Character.id == cid, Character.owner_id == row['owner_id'],
                Character.current_space_id == g['id']).values(current_space_id=row['home_id'],
                location_epoch=Character.location_epoch + 1))
            conn.execute(delete(visits).where(visits.c.character_id == cid))
        g['companions'].pop(str(cid), None)

    def expire(self, conn, g, now):
        for vote in g['votes']:
            if vote['status'] == 'pending' and now >= vote['deadline']:
                vote['status'] = 'expired'
        for story in g['stories']:
            if story['status'] == 'resting' and now >= story['recover_at']:
                story['status'] = 'recovered'
                self.event(conn, g, '独处的伙伴已经恢复平静，愿意时可以再次相聚。', now,
                    kind='story_recovered', characters=story['characters'])

    def snapshot(self, g, revision, uid, now):
        state = State.model_validate(g['layout'])
        projected = settle(state, now)
        s = g['season']
        season = seasons.project(seasons.settings_adapter.validate_python(s['settings']) if s else None,
            s['started_at'] if s else None, s['revision'] if s else 0, now)
        return dict(id=g['id'], title=g['title'], scene_type=g['scene_type'], revision=revision,
            closed=g['closed'], is_manager=g['manager'] == uid, me=uid,
            members=[dict(id=k, name=v['name'], manager=k == g['manager']) for k, v in g['members'].items()],
            companions=list(g['companions'].values()), season=season,
            items=[dict(**item, contribution=g['contributions'][item['id']],
                contributor_name=g['members'].get(g['contributions'][item['id']], {}).get('name', '已离开成员'),
                mine=g['contributions'][item['id']] == uid) for item in public_items(projected)],
            votes=g['votes'], events=[{k: v for k, v in e.items() if k != 'audience'} for e in g['events']
                if e.get('kind') != 'dialogue' or uid in e.get('audience', [])][-50:], goal=g['goal'], stories=g['stories'],
            dialogue_enabled=g.get('dialogue_enabled', False),
            story_enabled=g['members'].get(uid, {}).get('story_enabled', False),
            invitation=g['invitation'] if g['manager'] == uid and not g['closed'] else None,
            origin='offline_rules', observed_at=now)

    def list(self, uid):
        with self.engine.connect() as conn:
            result = []
            for row in conn.execute(select(groups)).mappings():
                g = json.loads(row['state_json'])
                if uid in g['members'] and not g['closed']:
                    result.append(dict(id=g['id'], title=g['title'], scene_type=g['scene_type'],
                        member_count=len(g['members'])))
            return result

    def read(self, uid, gid):
        with self.transaction() as conn:
            g, rev = self.load(conn, gid)
            self.member(g, uid)
            before = json.dumps(g, sort_keys=True)
            self.expire(conn, g, self.clock())
            if before != json.dumps(g, sort_keys=True):
                rev += 1
                self.save(conn, g, rev)
            return self.snapshot(g, rev, uid, self.clock())

    def preview(self, token):
        with self.engine.connect() as conn:
            g = self.invited(conn, token)
            return dict(id=g['id'], title=g['title'], scene_type=g['scene_type'],
                member_count=len(g['members']), season=self.snapshot(g, 0, '', self.clock())['season'])

    @staticmethod
    def invited(conn, token):
        if not isinstance(token, str) or not 20 <= len(token) <= 100:
            fail('邀请已失效', 'not_found')
        for row in conn.execute(select(groups)).mappings():
            g = json.loads(row['state_json'])
            if not g['closed'] and g['invitation'] and secrets.compare_digest(g['invitation'], token):
                return g
        fail('邀请已失效', 'not_found')

    def create(self, uid, rid, title, name, scene_type, season=None):
        def execute(conn):
            if scene_type not in CATALOG:
                fail('请选择有效场景', 'invalid_request')
            now = self.clock()
            initial_season = None
            if season is not None:
                initial_season = {'settings': seasons.settings_adapter.validate_python(season).model_dump(),
                          'started_at': now, 'revision': 1}
            g = dict(id=rid, title=label(title), scene_type=scene_type, manager=uid,
                members={uid: {'name': label(name, 20), 'story_enabled': False}},
                companions={}, closed=False, invitation=None, season=initial_season,
                layout=State(last_write_at=now).model_dump(), contributions={},
                events=[], votes=[], stories=[], goal=None)
            conn.execute(insert(groups).values(id=rid, revision=0, state_json=json.dumps(g)))
            self.event(conn, g, '一起生活的空间建立了。', now)
            self.save(conn, g, 0)
            return self.snapshot(g, 0, uid, now)
        # Python closure uses a local normalized season in execute.
        return self.once(uid, rid, dict(create=True, title=title, name=name, scene_type=scene_type, season=season), execute)

    def once(self, uid, rid, payload, action):
        _uuid(rid)
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        with self.transaction() as conn:
            row = conn.execute(select(receipts).where(receipts.c.owner_id == uid,
                receipts.c.request_id == rid)).mappings().first()
            if row:
                if row['digest'] != digest:
                    fail('同一请求不能更改内容', 'conflict')
                return json.loads(row['result_json'])
            result = action(conn)
            conn.execute(insert(receipts).values(owner_id=uid, request_id=rid, digest=digest,
                result_json=json.dumps(result, ensure_ascii=False)))
            return result

    def join(self, uid, rid, token, name):
        def execute(conn):
            invitation = self.invited(conn, token)
            g, rev = self.load(conn, invitation['id'])
            if uid not in g['members']:
                if len(g['members']) >= 5:
                    fail('共同空间最多 5 位成员')
                self.cancel_votes(g)
                g['members'][uid] = {'name': label(name, 20), 'story_enabled': False}
                self.event(conn, g, f'{g["members"][uid]["name"]} 加入了共同生活。', self.clock())
                rev += 1
                self.save(conn, g, rev)
            return self.snapshot(g, rev, uid, self.clock())
        return self.once(uid, rid, dict(join=True, token=token, name=name), execute)

    def command(self, uid, gid, rid, revision, command):
        def execute(conn):
            g, rev = self.load(conn, gid)
            self.member(g, uid)
            if revision != rev:
                fail('空间已更新，请刷新后再操作', 'conflict')
            now = self.clock()
            self.expire(conn, g, now)
            self.apply(conn, g, uid, command, now)
            self.save(conn, g, rev + 1)
            return self.snapshot(g, rev + 1, uid, now)
        return self.once(uid, rid, dict(group=gid, revision=revision, command=command), execute)

    def apply(self, conn, g, uid, cmd, now):
        action = cmd['action']
        if action in ('invite', 'revoke_invitation'):
            self.manager(g, uid)
            g['invitation'] = secrets.token_urlsafe(24) if action == 'invite' else None
        elif action == 'transfer':
            self.manager(g, uid)
            target = cmd['member_id']
            if target not in g['members'] or target == uid:
                fail('请选择另一位现有成员')
            g['manager'] = target
            self.notify(conn, target, f'你已成为「{g["title"]}」的管理者。', now)
        elif action in ('leave', 'remove'):
            target = uid if action == 'leave' else cmd['member_id']
            if action == 'remove':
                self.manager(g, uid)
            if target not in g['members'] or target == g['manager']:
                fail('管理者请先转交管理权，或发起解散投票')
            self.event(conn, g, f'{g["members"][target]["name"]} 离开了共同空间。', now)
            for c in list(g['companions'].values()):
                if c['owner_id'] == target:
                    self.return_home(conn, g, c['id'])
            del g['members'][target]
            self.cancel_votes(g)
            self.notify(conn, target, f'你已离开「{g["title"]}」，伙伴已回家；未撤回的贡献物件仍留在原处。', now)
        elif action == 'visit':
            from app.models.models import Character
            cid = cmd['character_id']
            from app.living.competitions import character_competing
            if character_competing(conn, cid):
                fail('伙伴正在比赛，请结束或退出比赛后再相聚')
            c = conn.execute(select(Character.__table__).where(Character.id == cid,
                Character.owner_id == uid, Character.status == 'ready')).mappings().first()
            if not c:
                fail('请选择自己的可用伙伴', 'not_found')
            if str(cid) in g['companions']:
                return
            if sum(c['owner_id'] == uid for c in g['companions'].values()) >= 2:
                fail('每位成员最多带两位伙伴')
            if conn.execute(select(visits).where(visits.c.character_id == cid)).first():
                fail('伙伴正在其他共同空间，请先召回')
            home_id = c['current_space_id']
            if home_id is None:
                home_id = conn.execute(select(spaces.c.id).where(spaces.c.owner_id == uid,
                    spaces.c.companion_id == str(cid), spaces.c.scene_type == 'home')).scalar_one_or_none()
                if home_id is None:
                    home_id = str(uuid4())
                    conn.execute(insert(spaces).values(id=home_id, owner_id=uid, scene_type='home',
                        mode='private', companion_id=str(cid), revision=0,
                        state_json=State(last_write_at=now).model_dump_json()))
            conn.execute(insert(visits).values(character_id=cid, owner_id=uid, group_id=g['id'], home_id=home_id))
            conn.execute(update(Character).where(Character.id == cid).values(current_space_id=g['id'],
                location_epoch=Character.location_epoch + 1))
            g['companions'][str(cid)] = dict(id=cid, owner_id=uid, name=c['name'], home_id=home_id,
                activity='arriving', x=0.5, y=0.65)
            self.event(conn, g, f'{c["name"]} 来相聚了。', now, kind='visit', characters=[cid])
        elif action == 'recall':
            c = g['companions'].get(str(cmd['character_id']))
            if not c or c['owner_id'] != uid:
                fail('只能召回自己的伙伴')
            self.event(conn, g, f'{c["name"]} 回到了自己的住处。', now, kind='recall', characters=[c['id']])
            self.return_home(conn, g, c['id'])
        elif action == 'restore_inventory':
            row = conn.execute(select(inventory).where(inventory.c.id == cmd['item_id'],
                inventory.c.owner_id == uid)).mappings().first()
            if not row:
                fail('物件不在你的库存中', 'not_found')
            item = Item.model_validate_json(row['item_json'])
            if item.kind not in CATALOG[g['scene_type']]['items']:
                fail('这个物件不适合当前场景')
            state = settle(State.model_validate(g['layout']), now)
            item.stored, item.settled_at = False, now
            state.items[item.id] = item
            state.undo = None
            g['layout'] = state.model_dump()
            g['contributions'][item.id] = uid
            conn.execute(delete(inventory).where(inventory.c.id == item.id))
            self.event(conn, g, '将库存中的物件放回共同空间。', now, kind='restore_inventory')
            self.check_goal(conn, g, now)
        elif action == 'layout':
            parsed = Command.validate_python(cmd['command'])
            if parsed.action not in ('place', 'care', 'move', 'store'):
                fail('共同空间支持添加、照料、移动和撤回')
            if parsed.action in ('move', 'store') and g['contributions'].get(parsed.item_id) != uid:
                fail('只能移动或撤回自己的贡献物件')
            state = State.model_validate(g['layout'])
            result = apply(state, g['scene_type'], parsed, now)
            if parsed.action == 'place':
                for iid in result.items.keys() - state.items.keys():
                    g['contributions'][iid] = uid
            elif parsed.action == 'store':
                iid = parsed.item_id
                item = result.items.pop(iid)
                conn.execute(insert(inventory).values(id=iid, owner_id=uid, item_json=item.model_dump_json()))
                del g['contributions'][iid]
            result.undo = None
            g['layout'] = result.model_dump()
            self.event(conn, g, {'place': '添加了一件共同物件。', 'care': '照料了共同的植物。',
                'move': '调整了自己的物件位置。', 'store': '将自己的物件收回库存。'}[parsed.action], now,
                kind=parsed.action)
            self.check_goal(conn, g, now)
        elif action in ('propose_season', 'propose_dissolve'):
            kind = 'season' if action == 'propose_season' else 'dissolve'
            if kind == 'dissolve':
                self.manager(g, uid)
            if any(v['kind'] == kind and v['status'] == 'pending' for v in g['votes']):
                fail('已有同类提议，请先完成当前投票')
            payload = seasons.settings_adapter.validate_python(cmd['settings']).model_dump() if kind == 'season' else None
            vote = dict(id=str(uuid4()), kind=kind, settings=payload, electorate=list(g['members']),
                choices={uid: True}, deadline=now + 86400, status='pending', created_at=now)
            g['votes'].append(vote)
            self.resolve_vote(conn, g, vote, now)
        elif action == 'vote':
            v = next((v for v in g['votes'] if v['id'] == cmd['vote_id']), None)
            if not v or v['status'] != 'pending' or uid not in v['electorate']:
                fail('此投票已结束或你不在投票名单中')
            if uid in v['choices']:
                fail('每位成员只能投一票')
            v['choices'][uid] = cmd['agree']
            self.resolve_vote(conn, g, v, now)
        elif action == 'start_goal':
            if g['goal'] is not None:
                fail('休息角落目标已经开始')
            g['goal'] = dict(status='active', started_at=now, completed_at=None)
            self.event(conn, g, '大家开始一起布置休息角落。', now, kind='goal_started')
            self.check_goal(conn, g, now)
        elif action == 'activity':
            ids = cmd['character_ids']
            from app.living.competitions import character_competing
            if any(character_competing(conn, cid) for cid in ids):
                fail('伙伴正在比赛，不能同时安排共同活动')
            if not ids or len(ids) != len(set(ids)):
                fail('请选择参与的伙伴')
            characters = [g['companions'].get(str(cid)) for cid in ids]
            if any(not c or c['owner_id'] != uid for c in characters):
                fail('只能授权自己的在场伙伴')
            activity = cmd['activity']
            for c in characters:
                c['activity'] = activity
                c['x'], c['y'] = (0.35, 0.65) if activity == 'rest' else (0.65, 0.55)
            if activity == 'talk':
                # Other owners opt in by placing their own companions in talk first.
                characters = [c for c in g['companions'].values() if c['activity'] == 'talk']
                ids = [c['id'] for c in characters]
            self.event(conn, g, '、'.join(c['name'] for c in characters) +
                {'rest': '在休息。', 'walk': '在散步。', 'observe': '在观察周围。', 'talk': '一起聊起了眼前的风景。'}[activity],
                now, kind='activity', activity=activity, characters=ids, origin='offline_rules')
        elif action == 'story_preference':
            g['members'][uid]['story_enabled'] = cmd['enabled']
        elif action == 'dialogue_space':
            self.manager(g, uid)
            g['dialogue_enabled'] = cmd['enabled']
        elif action == 'dialogue_consent':
            c = g['companions'].get(str(cmd['character_id']))
            if not c or c['owner_id'] != uid:
                fail('只能设置自己的在场伙伴')
            c['dialogue_allowed'] = cmd['enabled']
        elif action == 'story':
            ids = cmd['character_ids']
            cs = [g['companions'].get(str(cid)) for cid in ids]
            if len(ids) != 2 or len(set(ids)) != 2 or any(not c for c in cs):
                fail('请选择两位在场伙伴')
            if any(not g['members'][c['owner_id']]['story_enabled'] for c in cs) or not any(c['owner_id'] == uid for c in cs):
                fail('参与伙伴的主人都需要主动开启温和剧情')
            if not any(e.get('kind') == 'activity' and set(ids).issubset(e.get('characters', [])) for e in g['events']):
                fail('先让伙伴参加一次共同活动')
            if any(s['status'] == 'resting' for s in g['stories']):
                fail('已有伙伴在独处，请让它先休息')
            story = dict(id=str(uuid4()), characters=ids, status='resting', recover_at=now + 1200,
                message='一个想热闹，一个想安静；表达想法后，先回家休息一会儿。')
            g['stories'].append(story)
            self.event(conn, g, story['message'], now, kind='gentle_story', characters=ids)
            for cid in ids:
                self.return_home(conn, g, cid)
        elif action == 'reconcile':
            story = next((s for s in g['stories'] if s['id'] == cmd['story_id']), None)
            if not story:
                fail('故事不存在', 'not_found')
            from app.models.models import Character
            if not conn.execute(select(Character.id).where(Character.owner_id == uid,
                    Character.id.in_(story['characters']))).first():
                fail('只有故事参与伙伴的主人可以主动和好')
            if story['status'] == 'resting':
                story['status'] = 'recovered'
                self.event(conn, g, '伙伴表达了善意，愿意时可以再次相聚。', now, kind='reconciled', characters=story['characters'])
        else:
            fail('不支持此操作', 'invalid_request')

    def check_goal(self, conn, g, now):
        if not g['goal'] or g['goal']['status'] != 'active':
            return
        items = State.model_validate(g['layout']).items.values()
        furniture = {'home': 'bench', 'desert': 'shade', 'forest': 'cushion'}[g['scene_type']]
        if any(i.kind == 'tree' and i.cared_until > now for i in items) and any(i.kind == furniture for i in items):
            g['goal'].update(status='completed', completed_at=now)
            self.event(conn, g, '共同种下并照料了树，也布置好休息的位置。', now, kind='goal_completed')

    def resolve_vote(self, conn, g, v, now):
        if sum(v['choices'].values()) <= len(v['electorate']) // 2:
            return
        v['status'] = 'passed'
        if v['kind'] == 'season':
            old = g['season']
            if not old or old['settings'] != v['settings']:
                g['season'] = dict(settings=v['settings'], started_at=now, revision=old['revision'] + 1 if old else 1)
            self.event(conn, g, '共同季节提议已获过半同意，立即生效。', now, kind='season_changed')
            return
        self.event(conn, g, '大家同意结束这处共同生活，伙伴回家，贡献物件退回各自库存。', now, kind='dissolved')
        from app.living.competitions import decorations
        conn.execute(update(decorations).where(decorations.c.space_id == g['id'],
            decorations.c.space_kind == 'gathering').values(space_id=None, space_kind=None))
        for c in list(g['companions'].values()):
            self.return_home(conn, g, c['id'])
        for iid, item in settle(State.model_validate(g['layout']), now).items.items():
            item.stored = True
            conn.execute(insert(inventory).values(id=iid, owner_id=g['contributions'][iid], item_json=item.model_dump_json()))
        for uid in g['members']:
            self.notify(conn, uid, f'「{g["title"]}」已解散，物件已按贡献归属返还。', now)
        g['closed'], g['invitation'] = True, None
        for other in g['votes']:
            if other['status'] == 'pending':
                other['status'] = 'cancelled_dissolved'
        if g['goal'] and g['goal']['status'] == 'active':
            g['goal']['status'] = 'cancelled'

    def personal(self, uid):
        with self.engine.connect() as conn:
            return dict(inventory=[json.loads(r['item_json']) for r in
                conn.execute(select(inventory).where(inventory.c.owner_id == uid)).mappings()],
                notifications=[dict(id=r['id'], at=r['created_at'], message=r['message']) for r in
                conn.execute(select(notifications).where(notifications.c.owner_id == uid).order_by(notifications.c.created_at.desc()).limit(50)).mappings()],
                memories=[json.loads(r['event_json']) for r in conn.execute(select(memories).where(memories.c.owner_id == uid)).mappings()])
