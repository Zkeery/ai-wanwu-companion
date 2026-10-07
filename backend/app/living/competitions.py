"""Server-authoritative activities, offline autonomous actions and atomic rewards."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import Column, Integer, String, Table, Text, insert, select, update

from app.living.gatherings import GatheringStore, fail, label, groups, visits
from app.living.store import metadata, spaces

KINDS = {'observe': '自然观察', 'garden': '庭院布置', 'leaves': '秋日拾叶'}
FIRST = {'observe': 'memorial_pot', 'garden': 'memorial_ornament', 'leaves': 'leaf_wreath'}
SHOP = {'colorful_pot': 20, 'warm_lights': 40, 'swing': 60}
matches = Table('life_competitions', metadata,
    Column('id', String(36), primary_key=True), Column('state_json', Text, nullable=False))
wallets = Table('life_resource_wallets', metadata,
    Column('owner_id', String(128), primary_key=True), Column('state_json', Text, nullable=False))
decorations = Table('life_decorations', metadata,
    Column('id', String(36), primary_key=True), Column('owner_id', String(128), nullable=False),
    Column('kind', String(40), nullable=False), Column('space_id', String(36)),
    Column('space_kind', String(16)), Column('x', Integer, nullable=False), Column('y', Integer, nullable=False))


class CompetitionStore:
    def __init__(self, engine, clock=None):
        self.engine, self.clock = engine, clock or (lambda: int(time.time()))
        self.storage = GatheringStore(engine, self.clock)

    @staticmethod
    def load(conn, mid):
        row = conn.execute(select(matches.c.state_json).where(matches.c.id == mid)).first()
        if not row:
            fail('活动不存在或无权访问', 'not_found')
        return json.loads(row[0])

    @staticmethod
    def save(conn, m):
        conn.execute(update(matches).where(matches.c.id == m['id']).values(state_json=json.dumps(m, ensure_ascii=False)))

    @staticmethod
    def member(m, uid):
        if uid not in m['members']:
            fail('活动不存在或无权访问', 'not_found')

    @staticmethod
    def wallet(conn, uid):
        value = conn.execute(select(wallets.c.state_json).where(wallets.c.owner_id == uid)).scalar_one_or_none()
        if value is not None:
            return json.loads(value)
        wallet = dict(balance=0, days={}, first=[], rewards=[])
        conn.execute(insert(wallets).values(owner_id=uid, state_json=json.dumps(wallet)))
        return wallet

    @staticmethod
    def save_wallet(conn, uid, w):
        conn.execute(update(wallets).where(wallets.c.owner_id == uid).values(state_json=json.dumps(w)))

    @staticmethod
    def decorate(conn, uid, kind):
        conn.execute(insert(decorations).values(id=str(uuid4()), owner_id=uid, kind=kind, x=50, y=50))

    def create(self, uid, rid, kind, name):
        if kind not in KINDS:
            fail('请选择有效活动', 'invalid_request')
        def execute(conn):
            m = dict(id=rid, kind=kind, rules_version=1, organizer=uid, members={uid: label(name, 20)},
                participants={}, status='registration', invitation=secrets.token_urlsafe(24),
                started_at=None, phase_end=None, end_at=None, votes={}, rewards={}, events=[],
                declined=[], cheers=[], origin='offline_rules')
            conn.execute(insert(matches).values(id=rid, state_json=json.dumps(m)))
            return self.public(m, uid)
        return self.storage.once(uid, rid, dict(competition='create', kind=kind, name=name), execute)

    def public(self, m, uid):
        return {**{k: v for k, v in m.items() if k not in ('declined',)},
            'me': uid, 'is_organizer': m['organizer'] == uid,
            'invitation': m['invitation'] if m['organizer'] == uid and m['status'] == 'registration' else None,
            'observed_at': self.clock()}

    def list(self, uid):
        with self.engine.connect() as conn:
            result = []
            for row in conn.execute(select(matches.c.state_json)):
                m = json.loads(row[0])
                if uid in m['members']:
                    result.append(dict(id=m['id'], kind=m['kind'], status=m['status']))
            return result

    def read(self, uid, mid):
        with self.storage.transaction() as conn:
            m = self.load(conn, mid)
            self.member(m, uid)
            self.advance(conn, m)
            self.save(conn, m)
            return self.public(m, uid)

    @staticmethod
    def invited(conn, token):
        for row in conn.execute(select(matches.c.state_json)):
            m = json.loads(row[0])
            if m['status'] == 'registration' and secrets.compare_digest(m['invitation'], token):
                return m
        fail('邀请已失效或活动已经开始', 'not_found')

    def preview(self, token):
        with self.engine.connect() as conn:
            m = self.invited(conn, token)
            return dict(id=m['id'], kind=m['kind'], participants=len(m['participants']),
                member_count=len(m['members']), duration=480 if m['kind'] == 'garden' else 180)

    def join(self, uid, rid, token, name, accept):
        def execute(conn):
            m = self.invited(conn, token)
            if accept:
                if uid not in m['members'] and len(m['members']) >= 5:
                    fail('本场最多 5 个账号')
                m['members'][uid] = label(name, 20)
            elif uid not in m['declined']:
                m['declined'].append(uid)
            self.save(conn, m)
            return self.public(m, uid) if accept else {'status': 'declined'}
        return self.storage.once(uid, rid, dict(competition='join', token=token, name=name, accept=accept), execute)

    def command(self, uid, mid, rid, cmd):
        def execute(conn):
            m = self.load(conn, mid)
            self.member(m, uid)
            self.advance(conn, m)
            self.apply(conn, m, uid, cmd)
            self.save(conn, m)
            return self.public(m, uid)
        return self.storage.once(uid, rid, dict(competition=mid, command=cmd), execute)

    def apply(self, conn, m, uid, cmd):
        from app.models.models import Character
        action, now = cmd['action'], self.clock()
        if action == 'register':
            if m['status'] != 'registration':
                fail('活动已开始，不能再报名')
            cid = cmd['character_id']
            ch = conn.execute(select(Character.__table__).where(Character.id == cid,
                Character.owner_id == uid, Character.status == 'ready')).mappings().first()
            if not ch:
                fail('只能选择自己的伙伴', 'not_found')
            if str(cid) in m['participants']:
                return
            if sum(p['owner_id'] == uid for p in m['participants'].values()) >= 2:
                fail('每账号最多 2 位伙伴')
            m['participants'][str(cid)] = dict(id=cid, owner_id=uid, name=ch['name'],
                route=int(hashlib.sha256((str(cid) + ch['persona']).encode()).hexdigest()[:8], 16),
                status='registered', score=0, targets=[], steps=0, layout=[])
        elif action == 'start':
            if uid != m['organizer'] or m['status'] != 'registration':
                fail('只有组织者能开始待报名的活动')
            if not 2 <= len(m['participants']) <= 10:
                fail('至少 2 位伙伴才能开赛')
            from app.living.competition_ai import require_strategy_idle
            require_strategy_idle(conn, m['id'], now)
            # No concurrent activity for a character; membership is frozen at start.
            ids = set(m['participants'])
            for row in conn.execute(select(matches.c.state_json).where(matches.c.id != m['id'])):
                other = json.loads(row[0])
                if other['status'] in ('running', 'voting') and ids & {k for k, p in other['participants'].items() if p['status'] != 'withdrawn'}:
                    fail('有伙伴正在其他活动中，请先完成或退出')
            for p in m['participants'].values():
                ch = conn.execute(select(Character.id).where(Character.id == p['id'],
                    Character.owner_id == p['owner_id'], Character.status == 'ready')).first()
                if not ch:
                    fail('有参赛伙伴已不可用，请重新报名')
                p['status'] = 'active'
            m.update(status='running', started_at=now, phase_end=now + (300 if m['kind'] == 'garden' else 180),
                end_at=now + (480 if m['kind'] == 'garden' else 180))
            m['events'].append('大家从同样的起点开始，私人资源不会带来比赛优势。')
        elif action == 'withdraw':
            if m['status'] in ('completed', 'cancelled'):
                fail('这场活动已经结束')
            p = m['participants'].get(str(cmd['character_id']))
            if not p or p['owner_id'] != uid:
                fail('只能退出自己的伙伴')
            if m['status'] == 'registration':
                del m['participants'][str(p['id'])]
            else:
                p['status'] = 'withdrawn'
                m['events'].append(p['name'] + ' 主动退出，本位伙伴不计完赛与获胜。')
                if all(p['status'] == 'withdrawn' for p in m['participants'].values()):
                    m['status'] = 'cancelled'
                    m['events'].append('全员退出，本场取消，不发奖励、不占每日奖励次数。')
        elif action == 'vote':
            if m['status'] != 'voting' or uid in m['votes']:
                fail('当前不能投票，或你已经投过票')
            if not any(p['owner_id'] == uid and p['status'] != 'withdrawn' for p in m['participants'].values()):
                fail('只有仍在参赛的账号可以投票')
            p = m['participants'].get(str(cmd['character_id']))
            if not p or p['status'] == 'withdrawn':
                fail('请选择仍在参赛的伙伴')
            m['votes'][uid] = p['id']
        elif action == 'cheer':
            if m['status'] not in ('running', 'voting'):
                fail('活动尚未开始或已经结束')
            if uid not in m['cheers']:
                m['cheers'].append(uid)
                m['events'].append(m['members'][uid] + ' 为伙伴们加油；加油不会改变分数。')
        elif action == 'cancel':
            if uid != m['organizer'] or m['status'] in ('completed', 'cancelled'):
                fail('只能由组织者取消尚未结算的活动')
            m['status'] = 'cancelled'
            m['events'].append('活动已取消，不发奖励、不占每日奖励次数，可以重新报名。')
        else:
            fail('未知活动操作', 'invalid_request')

    def advance(self, conn, m):
        now = self.clock()
        if m['status'] not in ('running', 'voting'):
            return
        if m['rules_version'] != 1:
            fail('比赛规则暂时无法恢复，请保留记录联系维护人员', 'corrupt_state')
        elapsed = max(0, min(now, m['phase_end']) - m['started_at'])
        for p in m['participants'].values():
            if p['status'] == 'withdrawn':
                continue
            if p.get('ai_strategy'):
                order = p['ai_strategy'].get('order')
                count = 10 if m['kind'] == 'garden' else 20
                if (not isinstance(order, list) or any(type(i) is not int for i in order)
                        or sorted(order) != list(range(count))):
                    fail('已保存的策略暂时无法恢复，请保留记录联系维护人员', 'corrupt_state')
            if m['kind'] == 'garden':
                steps = min(10, elapsed // 30)
                order = p.get('ai_strategy', {}).get('order')
                p['layout'] = [dict(kind=('tree', 'flower', 'bench', 'lamp', 'stone')[i % 5],
                    x=(order[i] % 5 if order else (i + p['route']) % 5) * 20 + 10,
                    y=((order[i] if order else i) // 5) * 50 + 25) for i in range(steps)]
                p['steps'] = steps
            else:
                # Same target catalog and travel rule for every companion. Persona chooses route.
                steps = min(20, elapsed // (8 + p['route'] % 5))
                for step in range(p['steps'], steps):
                    order = p.get('ai_strategy', {}).get('order')
                    self.score_target(m, p, order[step] if order else (step + p['route']) % 20)
                p['steps'] = steps
        if m['kind'] == 'garden' and now >= m['phase_end']:
            m['status'] = 'voting'
        if now >= m['end_at']:
            self.finish(conn, m)

    @staticmethod
    def score_target(m, p, target):
        if m['kind'] not in ('observe', 'leaves') or p['status'] != 'active' or type(target) is not int or not 0 <= target < 20:
            return False
        if target in p['targets']:
            return False
        p['targets'].append(target)
        p['score'] += 1
        return True

    def finish(self, conn, m):
        if m['status'] == 'completed':
            return
        active = [p for p in m['participants'].values() if p['status'] != 'withdrawn']
        if not active:
            m['status'] = 'cancelled'
            return
        if m['kind'] == 'garden':
            for p in active:
                p['score'] = sum(cid == p['id'] for cid in m['votes'].values())
        maximum = max(p['score'] for p in active)
        winners = {p['id'] for p in active if p['score'] == maximum and maximum > 0}
        day = datetime.fromtimestamp(m['end_at'], ZoneInfo('Asia/Shanghai')).date().isoformat()
        for p in active:
            p['status'], p['winner'] = 'completed', p['id'] in winners
        for uid in {p['owner_id'] for p in active}:
            w = self.wallet(conn, uid)
            count = w['days'].get(day, 0)
            eligible = count < 3
            won = any(p['owner_id'] == uid and p['id'] in winners for p in active)
            reward = dict(match_id=m['id'], day=day, base=10 if eligible else 0,
                bonus=10 if eligible and won else 0, first_decoration=None)
            if eligible:
                w['days'][day] = count + 1
            w['balance'] += reward['base'] + reward['bonus']
            if m['kind'] not in w['first']:
                reward['first_decoration'] = FIRST[m['kind']]
                self.decorate(conn, uid, FIRST[m['kind']])
                w['first'].append(m['kind'])
            w['rewards'].append(reward)
            m['rewards'][uid] = reward
            self.save_wallet(conn, uid, w)
        m['status'] = 'completed'
        m['events'].append('比赛正常完成。' + ('最高有效成绩并列者共同获胜。' if len(winners) > 1 else '成绩已保存。' if winners else '本场没有冠军，正常完赛仍按规则获得基础奖励。'))

    def inventory(self, uid):
        with self.storage.transaction() as conn:
            w = self.wallet(conn, uid)
            return dict(**w, shop=SHOP, decorations=[dict(r) for r in conn.execute(select(decorations).where(decorations.c.owner_id == uid)).mappings()])

    def exchange(self, uid, rid, kind):
        if kind not in SHOP:
            fail('装饰不存在', 'invalid_request')
        def execute(conn):
            w = self.wallet(conn, uid)
            if w['balance'] < SHOP[kind]:
                fail('建设资源不足')
            w['balance'] -= SHOP[kind]
            self.decorate(conn, uid, kind)
            self.save_wallet(conn, uid, w)
            return {'balance': w['balance'], 'kind': kind}
        return self.storage.once(uid, rid, dict(exchange=kind), execute)

    @staticmethod
    def require_space(conn, uid, sid, kind):
        if kind == 'private':
            if not conn.execute(select(spaces.c.id).where(spaces.c.id == sid, spaces.c.owner_id == uid)).first():
                fail('私人空间不存在或无权访问', 'not_found')
        elif kind == 'gathering':
            g, _ = GatheringStore.load(conn, sid)
            GatheringStore.member(g, uid)
        else:
            fail('空间类型不正确', 'invalid_request')

    @staticmethod
    def require_private_writable(conn, uid, sid, kind):
        if kind != 'private':
            return
        row = conn.execute(select(spaces.c.companion_id).where(
            spaces.c.id == sid, spaces.c.owner_id == uid, spaces.c.mode == 'private')).first()
        if row and row[0] and row[0].isdigit() and conn.execute(select(visits.c.character_id).where(
                visits.c.character_id == int(row[0]), visits.c.owner_id == uid)).first():
            fail('伙伴正在共同空间，原住处只可查看；请先召回', 'conflict')

    def place(self, uid, rid, iid, sid, kind, x, y):
        def execute(conn):
            item = conn.execute(select(decorations).where(decorations.c.id == iid, decorations.c.owner_id == uid)).mappings().first()
            if not item:
                fail('只能放置或撤回自己的装饰', 'not_found')
            if item['space_id']:
                self.require_space(conn, uid, item['space_id'], item['space_kind'])
                self.require_private_writable(conn, uid, item['space_id'], item['space_kind'])
            if sid:
                self.require_space(conn, uid, sid, kind)
                self.require_private_writable(conn, uid, sid, kind)
            conn.execute(update(decorations).where(decorations.c.id == iid).values(space_id=sid,
                space_kind=kind if sid else None, x=x, y=y))
            return {'id': iid, 'space_id': sid}
        return self.storage.once(uid, rid, dict(decoration=iid, space_id=sid, kind=kind, x=x, y=y), execute)

    def in_space(self, uid, sid, kind):
        with self.engine.connect() as conn:
            self.require_space(conn, uid, sid, kind)
            return [dict(id=r['id'], kind=r['kind'], mine=r['owner_id'] == uid, x=r['x'], y=r['y']) for r in
                conn.execute(select(decorations).where(decorations.c.space_id == sid, decorations.c.space_kind == kind)).mappings()]


def character_competing(conn, cid):
    for row in conn.execute(select(matches.c.state_json)):
        match = json.loads(row[0])
        participant = match['participants'].get(str(cid))
        if match['status'] in ('running', 'voting') and participant and participant['status'] != 'withdrawn':
            return True
    return False
