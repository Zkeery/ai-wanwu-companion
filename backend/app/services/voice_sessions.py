"""Durable, owner-scoped allowance for explicitly approved voice conversations."""
from uuid import uuid4

from sqlalchemy import Column, Integer, String, Table, insert, select, update

from app.living.gatherings import fail
from app.living.store import metadata
from app.living.life_provider import RESERVE_MICRO

sessions = Table('companion_voice_sessions', metadata,
    Column('sequence', Integer, primary_key=True), Column('id', String(36), nullable=False, unique=True),
    Column('authorization_ref', String(120), nullable=False, unique=True),
    Column('owner_id', String(128), nullable=False), Column('character_id', Integer, nullable=False),
    Column('state', String(16), nullable=False), Column('max_rounds', Integer, nullable=False),
    Column('used_rounds', Integer, nullable=False), Column('created_at', Integer, nullable=False),
    Column('expires_at', Integer, nullable=False), Column('in_flight', String(36)))


def latest(conn, uid, cid):
    return conn.execute(select(sessions).where(sessions.c.owner_id == uid,
        sessions.c.character_id == cid).order_by(sessions.c.sequence.desc())
        .limit(1)).mappings().first()


def summary(row, now):
    if row is None:
        return None
    state = row['state']
    if state == 'active':
        if row['expires_at'] <= now:
            state = 'expired'
        elif row['used_rounds'] >= row['max_rounds']:
            state = 'exhausted'
    return dict(state=state, remaining_rounds=max(0, row['max_rounds'] - row['used_rounds']),
        max_rounds=row['max_rounds'], used_rounds=row['used_rounds'], expires_at=row['expires_at'],
        budget_micro=row['max_rounds'] * 1_200_000, reserved_micro=row['used_rounds'] * RESERVE_MICRO)


def authorize(conn, uid, cid, ref, count, now):
    if not isinstance(ref, str) or not 8 <= len(ref) <= 120 or type(count) is not int or not 1 <= count <= 10:
        fail('需要新的具体授权编号与1至10轮额度', 'invalid_request')
    if conn.execute(select(sessions.c.id).where(sessions.c.authorization_ref == ref)).first():
        fail('该授权已登记，不能再次补充额度', 'conflict')
    old = latest(conn, uid, cid)
    if old and (old['in_flight'] or summary(old, now)['state'] == 'active'):
        fail('当前真实聊天尚未结束', 'conflict')
    conn.execute(insert(sessions).values(id=str(uuid4()), authorization_ref=ref, owner_id=uid,
        character_id=cid, state='active', max_rounds=count, used_rounds=0,
        created_at=now, expires_at=now + 86400, in_flight=None))
    return summary(latest(conn, uid, cid), now)


def reserve(conn, row, rid, now):
    if summary(row, now)['state'] != 'active':
        fail('真实聊天已结束、到期或额度已用完，录音未发送', 'voice_session_unavailable')
    if row['in_flight']:
        fail('上一轮真实回复尚未结束，请先核对结果', 'voice_session_busy')
    conn.execute(update(sessions).where(sessions.c.id == row['id']).values(
        used_rounds=row['used_rounds'] + 1, in_flight=rid))


def finish(conn, rid, *, success):
    row = conn.execute(select(sessions).where(sessions.c.in_flight == rid)).mappings().first()
    if row:
        state = row['state'] if success else 'failed'
        conn.execute(update(sessions).where(sessions.c.id == row['id']).values(state=state, in_flight=None))


def revoke(conn, uid, cid):
    conn.execute(update(sessions).where(sessions.c.owner_id == uid, sessions.c.character_id == cid,
        sessions.c.state == 'active').values(state='revoked'))


def recover(conn):
    conn.execute(update(sessions).where(sessions.c.in_flight.is_not(None)).values(state='failed', in_flight=None))


def project_reply(messages):
    """Called only by an injected service after a durable allowance is reserved."""
    import asyncio
    from pathlib import Path
    from dotenv import dotenv_values
    from app.core.config import get_settings
    from app.living.life_live_planner import check_current_catalog
    from app.living.life_provider import BASE_URL, MODEL
    from app.services.voice_reply import configured_reply

    values = dotenv_values(Path(__file__).resolve().parents[2] / '.env')
    if values.get('MODEL_BASE_URL') != BASE_URL or not values.get('MODEL_API_KEY'):
        fail('本项目语音模型配置不可用')
    asyncio.run(check_current_catalog())
    settings = get_settings().model_copy(update=dict(app_env='development', model_base_url=BASE_URL,
        model_api_key=values['MODEL_API_KEY'], chat_model=MODEL, voice_live_reply_enabled=True,
        model_max_retries=0, model_timeout_seconds=30, model_enable_thinking=False))
    return configured_reply(messages, settings=settings, max_payload_bytes=32768)
