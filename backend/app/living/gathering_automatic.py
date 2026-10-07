"""Opt-in shared dialogue scheduling. No implicit grants, retries or catch-up calls."""
import asyncio
import hashlib
import json
import logging
from uuid import uuid4

from sqlalchemy import Column, Integer, String, Table, Text, case, delete, func, insert, select, update

from app.living.gatherings import fail
from app.living.gathering_dialogue import DialogueStore, grants, tasks, run_exchange
from app.living.life_provider import RESERVE_MICRO
from app.living.rules import LivingError
from app.living.store import metadata, _uuid

INTERVAL = 600
VIEW_TTL = 75
DAY_SECONDS = 86400

sessions = Table('life_dialogue_auto_sessions', metadata,
    Column('id', String(36), primary_key=True), Column('group_id', String(36), nullable=False),
    Column('owner_id', String(128), nullable=False), Column('characters_json', Text, nullable=False),
    Column('authorization_ref', String(128), unique=True, nullable=False),
    Column('authorization_digest', String(64), nullable=False),
    Column('max_rounds', Integer, nullable=False), Column('used_rounds', Integer, nullable=False),
    Column('cap_micro', Integer, nullable=False), Column('expires_at', Integer, nullable=False),
    Column('stopped', Integer, nullable=False))
automatic = Table('life_dialogue_automatic', metadata,
    Column('group_id', String(36), primary_key=True), Column('revision', Integer, nullable=False),
    Column('enabled', Integer, nullable=False), Column('session_id', String(36)),
    Column('next_at', Integer, nullable=False), Column('day', Integer, nullable=False),
    Column('today_count', Integer, nullable=False), Column('last_task_id', String(36)),
    Column('stop_reason', String(48)))
links = Table('life_dialogue_auto_tasks', metadata,
    Column('task_id', String(36), primary_key=True), Column('session_id', String(36), nullable=False),
    Column('group_id', String(36), nullable=False), Column('revision', Integer, nullable=False))
viewers = Table('life_dialogue_auto_viewers', metadata,
    Column('owner_id', String(128), primary_key=True), Column('group_id', String(36), primary_key=True),
    Column('viewer_id', String(36), primary_key=True), Column('expires_at', Integer, nullable=False),
    Column('closed', Integer, nullable=False))
receipts = Table('life_dialogue_auto_receipts', metadata,
    Column('owner_id', String(128), primary_key=True), Column('request_id', String(36), primary_key=True),
    Column('digest', String(64), nullable=False))
limits = Table('life_dialogue_auto_limits', metadata,
    Column('scope', String(80), primary_key=True), Column('cap_micro', Integer, nullable=False))


def day_number(now):
    return (now + 8 * 3600) // DAY_SECONDS


def manual_available(conn, gid):
    row = conn.execute(select(automatic.c.enabled).where(automatic.c.group_id == gid)).first()
    if row and row[0]:
        fail('请先暂停自动交流，再发起单轮交流')


class AutomaticDialogueStore(DialogueStore):
    def _setting(self, conn, gid):
        row = conn.execute(select(automatic).where(automatic.c.group_id == gid)).mappings().first()
        return dict(row) if row else dict(group_id=gid, revision=0, enabled=0, session_id=None,
            next_at=0, day=day_number(self.clock()), today_count=0, last_task_id=None, stop_reason=None)

    @staticmethod
    def _save_setting(conn, setting):
        if conn.execute(select(automatic.c.group_id).where(automatic.c.group_id == setting['group_id'])).first():
            conn.execute(update(automatic).where(automatic.c.group_id == setting['group_id']).values(**setting))
        else:
            conn.execute(insert(automatic).values(**setting))

    @staticmethod
    def _budget(conn, gid=None):
        query = select(func.coalesce(func.sum(sessions.c.used_rounds * RESERVE_MICRO), 0))
        if gid is not None:
            query = query.where(sessions.c.group_id == gid)
        used = conn.execute(query).scalar_one()
        scope = 'space:' + gid if gid is not None else 'project'
        cap = conn.execute(select(limits.c.cap_micro).where(limits.c.scope == scope)).scalar() or 0
        return dict(cap_micro=cap, committed_micro=used, remaining_micro=max(0, cap-used))

    def _allocated(self, conn, gid=None):
        reserved = case(((sessions.c.stopped == 0) & (sessions.c.expires_at > self.clock()), sessions.c.max_rounds),
                        else_=sessions.c.used_rounds)
        query = select(func.coalesce(func.sum(reserved * RESERVE_MICRO), 0))
        if gid is not None:
            query = query.where(sessions.c.group_id == gid)
        return conn.execute(query).scalar_one()

    def authorize_session(self, uid, gid, ids, rounds, authorization_ref, *, project_cap_micro, space_cap_micro):
        """Trusted maintenance only: one specific auto batch and cumulative allocated ceilings."""
        if (type(rounds) is not int or not 1 <= rounds <= 10
                or not isinstance(authorization_ref, str) or not 8 <= len(authorization_ref) <= 128
                or any(type(n) is not int or not 0 <= n <= 1000000000 for n in (project_cap_micro, space_cap_micro))):
            fail('需要有效的独立自动交流批次及累计上限', 'invalid_request')
        with self.transaction() as conn:
            g, _ = self.load(conn, gid)
            self.facts(conn, g, uid, ids)
            digest = hashlib.sha256(json.dumps([uid, gid, ids, rounds, project_cap_micro, space_cap_micro]).encode()).hexdigest()
            previous = conn.execute(select(sessions).where(sessions.c.authorization_ref == authorization_ref)).mappings().first()
            if previous:
                if previous['authorization_digest'] != digest:
                    fail('同一授权编号不能修改批次', 'conflict')
                return previous['id']
            active = conn.execute(select(sessions.c.id).where(sessions.c.group_id == gid, sessions.c.stopped == 0,
                sessions.c.expires_at > self.clock(), sessions.c.used_rounds < sessions.c.max_rounds)).first()
            if active or conn.execute(select(tasks.c.id).where(tasks.c.group_id == gid, tasks.c.state == 'running')).first():
                fail('当前批次或交流尚未结束，请先核对', 'conflict')
            for scope, cap, space in [('project', project_cap_micro, None), ('space:' + gid, space_cap_micro, gid)]:
                if cap < self._allocated(conn, space) + rounds * RESERVE_MICRO:
                    fail('累计上限不足以覆盖本批次数', 'budget_exhausted')
                if conn.execute(select(limits.c.scope).where(limits.c.scope == scope)).first():
                    conn.execute(update(limits).where(limits.c.scope == scope).values(cap_micro=cap))
                else:
                    conn.execute(insert(limits).values(scope=scope, cap_micro=cap))
            sid = str(uuid4())
            conn.execute(insert(sessions).values(id=sid, group_id=gid, owner_id=uid, characters_json=json.dumps(ids),
                authorization_ref=authorization_ref, authorization_digest=digest,
                max_rounds=rounds, used_rounds=0, cap_micro=rounds*RESERVE_MICRO,
                expires_at=self.clock()+DAY_SECONDS, stopped=0))
            return sid

    def _stop(self, conn, setting, reason, *, close_session=True):
        setting.update(enabled=0, revision=setting['revision']+1, stop_reason=reason)
        self._save_setting(conn, setting)
        if close_session and setting['session_id']:
            conn.execute(update(sessions).where(sessions.c.id == setting['session_id']).values(stopped=1))

    def _settle(self, conn, setting):
        if not setting['enabled']:
            return
        task = conn.execute(select(tasks).where(tasks.c.id == setting['last_task_id'])).mappings().first()
        if task and task['state'] == 'running':
            if self.clock() - task['created_at'] < 60:
                return
            conn.execute(update(tasks).where(tasks.c.id == task['id']).values(
                state='unknown' if task['dispatched'] else 'failed', error_code='interrupted'))
            self._stop(conn, setting, 'interrupted')
            return
        if task and task['state'] in ('failed', 'unknown'):
            self._stop(conn, setting, 'failed')
            return
        session = conn.execute(select(sessions).where(sessions.c.id == setting['session_id'])).mappings().first()
        if not session or session['stopped']:
            self._stop(conn, setting, 'authorization_closed')
        elif session['expires_at'] <= self.clock():
            self._stop(conn, setting, 'expired')
        elif session['used_rounds'] >= session['max_rounds']:
            self._stop(conn, setting, 'completed')
        else:
            try:
                g, _ = self.load(conn, setting['group_id'])
                self.facts(conn, g, session['owner_id'], json.loads(session['characters_json']))
            except LivingError as exc:
                if exc.code not in ('not_found', 'invalid_action', 'invalid_request'):
                    raise
                self._stop(conn, setting, 'permission_changed')

    def status(self, uid, gid):
        with self.transaction() as conn:
            g, _ = self.load(conn, gid)
            self.member(g, uid)
            setting = self._setting(conn, gid)
            self._settle(conn, setting)
            candidate = conn.execute(select(sessions).where(sessions.c.group_id == gid, sessions.c.owner_id == uid,
                sessions.c.stopped == 0, sessions.c.expires_at > self.clock(),
                sessions.c.used_rounds < sessions.c.max_rounds).order_by(sessions.c.expires_at.desc()).limit(1)).mappings().first()
            own = None if not candidate else dict(id=candidate['id'], character_ids=json.loads(candidate['characters_json']),
                max_rounds=candidate['max_rounds'], used_rounds=candidate['used_rounds'], cap_micro=candidate['cap_micro'],
                expires_at=candidate['expires_at'])
            active = conn.execute(select(sessions).where(sessions.c.id == setting['session_id'])).mappings().first()
            task_state = conn.execute(select(tasks.c.state).where(tasks.c.id == setting['last_task_id'])).scalar()
            return dict(revision=setting['revision'], enabled=bool(setting['enabled']), next_at=setting['next_at'],
                today_count=setting['today_count'] if setting['day'] == day_number(self.clock()) else 0,
                stop_reason=setting['stop_reason'], last_task_id=setting['last_task_id'], last_task_state=task_state,
                character_ids=json.loads(active['characters_json']) if active else [], authorization=own)

    def configure(self, uid, gid, rid, revision, enabled, session_id=None):
        _uuid(rid)
        if type(revision) is not int or revision < 0 or type(enabled) is not bool or (enabled and not session_id):
            fail('请核对自动交流设置', 'invalid_request')
        if session_id:
            _uuid(session_id)
        digest = hashlib.sha256(json.dumps([gid, revision, enabled, session_id]).encode()).hexdigest()
        with self.transaction() as conn:
            g, _ = self.load(conn, gid)
            self.member(g, uid)
            prior = conn.execute(select(receipts.c.digest).where(receipts.c.owner_id == uid, receipts.c.request_id == rid)).first()
            if prior:
                if prior[0] != digest:
                    fail('同一请求不能修改设置', 'conflict')
            else:
                setting = self._setting(conn, gid)
                self._settle(conn, setting)
                if setting['revision'] != revision:
                    fail('自动安排已更新，请刷新后再试', 'conflict')
                if enabled:
                    session = conn.execute(select(sessions).where(sessions.c.id == session_id,
                        sessions.c.group_id == gid, sessions.c.owner_id == uid)).mappings().first()
                    if (not session or session['stopped'] or session['expires_at'] <= self.clock()
                            or session['used_rounds'] >= session['max_rounds']):
                        fail('没有可用的自动交流额度', 'budget_exhausted')
                    self.facts(conn, g, uid, json.loads(session['characters_json']))
                    if setting['enabled'] or conn.execute(select(tasks.c.id).where(tasks.c.group_id == gid, tasks.c.state == 'running')).first():
                        fail('已有交流正在安排，请先暂停或等待完成', 'conflict')
                    if any(self._budget(conn, scope)['remaining_micro'] < RESERVE_MICRO for scope in (None, gid)):
                        fail('自动交流累计额度不足', 'budget_exhausted')
                    # Preserve the space cadence and daily count across pause or new batches.
                    setting.update(enabled=1, revision=revision+1, session_id=session_id, stop_reason=None, last_task_id=None)
                    self._save_setting(conn, setting)
                else:
                    task = conn.execute(select(tasks).where(tasks.c.id == setting['last_task_id'])).mappings().first()
                    pending = bool(task and task['state'] == 'running')
                    if pending:
                        conn.execute(update(tasks).where(tasks.c.id == task['id']).values(
                            state='unknown' if task['dispatched'] else 'failed', error_code='interrupted'))
                    self._stop(conn, setting, 'interrupted' if pending else 'paused', close_session=pending)
                conn.execute(insert(receipts).values(owner_id=uid, request_id=rid, digest=digest))
        return self.status(uid, gid)

    def viewing(self, uid, gid, viewer_id, active):
        _uuid(viewer_id)
        if type(active) is not bool:
            fail('观看状态不正确', 'invalid_request')
        with self.transaction() as conn:
            g, _ = self.load(conn, gid)
            self.member(g, uid)
            # Retain ended page IDs for a day so a late heartbeat cannot resurrect a closed page.
            conn.execute(delete(viewers).where(viewers.c.expires_at < self.clock()-DAY_SECONDS))
            condition = (viewers.c.owner_id == uid) & (viewers.c.group_id == gid) & (viewers.c.viewer_id == viewer_id)
            prior = conn.execute(select(viewers).where(condition)).mappings().first()
            if active and prior and prior['closed']:
                return dict(active=False, expires_at=None)
            if active:
                count = conn.execute(select(func.count()).select_from(viewers).where(
                    viewers.c.owner_id == uid, viewers.c.group_id == gid,
                    viewers.c.closed == 0, viewers.c.expires_at > self.clock())).scalar_one()
                if count >= 10 and not (prior and prior['expires_at'] > self.clock()):
                    fail('打开的观看页面过多，请关闭部分页面', 'invalid_action')
            values = dict(expires_at=self.clock()+VIEW_TTL if active else self.clock(), closed=0 if active else 1)
            if prior:
                conn.execute(update(viewers).where(condition).values(**values))
            else:
                conn.execute(insert(viewers).values(owner_id=uid, group_id=gid, viewer_id=viewer_id, **values))
        return dict(active=active, expires_at=self.clock()+VIEW_TTL if active else None)

    def claim_next(self):
        """One transaction owns both the round and its sole execution; never redeliver."""
        with self.transaction() as conn:
            settings = conn.execute(select(automatic).where(automatic.c.enabled == 1).order_by(automatic.c.next_at)).mappings().all()
            for row in settings:
                setting = dict(row)
                self._settle(conn, setting)
                if not setting['enabled'] or setting['next_at'] > self.clock():
                    continue
                if conn.execute(select(tasks.c.id).where(tasks.c.group_id == setting['group_id'], tasks.c.state == 'running')).first():
                    continue
                gid = setting['group_id']
                g, rev = self.load(conn, gid)
                watched = conn.execute(select(viewers.c.viewer_id).where(viewers.c.group_id == gid,
                    viewers.c.owner_id.in_(list(g['members'])), viewers.c.closed == 0, viewers.c.expires_at > self.clock())).first()
                today = day_number(self.clock())
                count = setting['today_count'] if setting['day'] == today else 0
                if not watched and count >= 2:
                    continue
                if any(self._budget(conn, scope)['remaining_micro'] < RESERVE_MICRO for scope in (None, gid)):
                    self._stop(conn, setting, 'budget_exhausted')
                    continue
                session = conn.execute(select(sessions).where(sessions.c.id == setting['session_id'])).mappings().one()
                ids = json.loads(session['characters_json'])
                facts = self.facts(conn, g, session['owner_id'], ids)
                tid, grant, rid = str(uuid4()), str(uuid4()), str(uuid4())
                conn.execute(insert(grants).values(id=grant, group_id=gid, owner_id=session['owner_id'],
                    characters_json=session['characters_json'], authorization_ref='automatic:' + tid,
                    cap_micro=RESERVE_MICRO, used=1, expires_at=self.clock()+60))
                task = dict(id=tid, grant_id=grant, group_id=gid, owner_id=session['owner_id'], request_id=rid,
                    digest=hashlib.sha256(tid.encode()).hexdigest(), revision=rev, facts_json=json.dumps(facts, ensure_ascii=False),
                    state='running', created_at=self.clock(), dispatched=0, result_json=None, error_code=None)
                conn.execute(insert(tasks).values(**task))
                conn.execute(insert(links).values(task_id=tid, session_id=session['id'], group_id=gid, revision=setting['revision']))
                conn.execute(update(sessions).where(sessions.c.id == session['id']).values(used_rounds=session['used_rounds']+1))
                setting.update(next_at=self.clock()+INTERVAL, day=today, today_count=count+(0 if watched else 1), last_task_id=tid)
                self._save_setting(conn, setting)
                return task
        return None

    def check(self, conn, task):
        link = conn.execute(select(links).where(links.c.task_id == task['id'])).mappings().first()
        if link:
            setting = self._setting(conn, task['group_id'])
            session = conn.execute(select(sessions).where(sessions.c.id == link['session_id'])).mappings().one()
            if (not setting['enabled'] or setting['revision'] != link['revision']
                    or setting['session_id'] != session['id'] or session['stopped'] or session['expires_at'] <= self.clock()):
                fail('自动交流已暂停或本批已结束', 'conflict')
        return super().check(conn, task)


async def consume_once(store, factory, catalog_check=None):
    task = store.claim_next()
    if task is None:
        return
    kwargs = {} if catalog_check is None else dict(catalog_check=catalog_check)
    await run_exchange(store, task, factory, **kwargs)
    # Failure/unknown closes the batch before the next scheduling iteration.
    with store.transaction() as conn:
        setting = store._setting(conn, task['group_id'])
        store._settle(conn, setting)


async def consume(store, factory):
    while True:
        try:
            await consume_once(store, factory)
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.getLogger(__name__).warning('shared_automatic_scan_unavailable')
        await asyncio.sleep(2)
