"""Durable requests; paid work requires a trusted, source-specific one-shot grant."""
import asyncio
from datetime import date
import json
from uuid import uuid4

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, MotionGenerationRequest, MotionGenerationActivityRequest
from app.services import character_walk_workflow as flow
from app.services.motion_atlas_provider import AtlasProviderError
from app.services.motion_bindings import MotionBindingError, owned_character
from app.services.motion_preparation import preparation_status


ACTIVITIES = ('rest', 'walk', 'observe')
REQUEST_MODELS = (MotionGenerationRequest, MotionGenerationActivityRequest)


def _model(activity):
    if activity not in ACTIVITIES:
        raise AtlasProviderError('activity_invalid')
    return MotionGenerationRequest if activity == 'walk' else MotionGenerationActivityRequest


def _activity(row):
    return row.activity if isinstance(row, MotionGenerationActivityRequest) else 'walk'


def _by_id(db, request_id):
    for model in REQUEST_MODELS:
        row = db.get(model, request_id)
        if row is not None:
            return row
    return None


def _batch_rows(db, row):
    """Recognize the three exact references atomically issued by grant-all."""
    reference = row.approval_ref or ''
    prefix, separator, activity = reference.rpartition(':')
    if not separator or activity != _activity(row):
        return []
    found = []
    for kind in ACTIVITIES:
        model = _model(kind)
        sibling = db.scalar(select(model).where(model.approval_ref == f'{prefix}:{kind}',
            model.character_id == row.character_id, model.owner_id == row.owner_id,
            model.source_image_path == row.source_image_path, model.source_sha256 == row.source_sha256))
        if sibling is None or _activity(sibling) != kind:
            return []
        found.append(sibling)
    return found


def _request(db, ch, activity='walk'):
    model = _model(activity)
    query = select(model).where(model.character_id == ch.id, model.source_image_path == ch.image_path)
    if activity != 'walk':
        query = query.where(model.activity == activity)
    return db.scalar(query)


def register_request(db, ch: Character):
    """Shares the character-generation transaction; no file reads or dispatch."""
    if ch.status != 'ready' or not ch.owner_id or not ch.image_path:
        return None
    # Sessions disable autoflush. The same transaction may register twice
    # before INSERTs have reached SQLite, so include pending ORM rows.
    rows = {}
    for activity in ACTIVITIES:
        model = _model(activity)
        found = next((row for row in db.new if isinstance(row, model)
                      and row.character_id == ch.id and row.source_image_path == ch.image_path
                      and _activity(row) == activity), None)
        if found is None:
            found = _request(db, ch, activity)
        if found is None:
            found = model(id=str(uuid4()), character_id=ch.id, owner_id=ch.owner_id,
                          source_image_path=ch.image_path, state='waiting_authorization',
                          **({'activity': activity} if activity != 'walk' else {}))
            db.add(found)
        if found.owner_id != ch.owner_id:
            raise MotionBindingError('character_not_found', 404)
        rows[activity] = found
    return rows['walk']


def _existing_candidate(cid: int, owner: str, activity='walk'):
    root = flow.DEFAULT_ROOT
    if root.is_symlink():
        raise AtlasProviderError('workflow_path_invalid')
    for file in root.glob('approval-*.json'):
        try:
            record = json.loads(flow._read(file, 65536))
            if (not isinstance(record, dict) or record.get('character_id') != cid
                    or record.get('owner_id') != owner or not record.get('job_id')
                    or record.get('activity', 'walk') != activity):
                continue
            value = flow.status(record['job_id'], cid, owner, root=root)
            if value['state'] in {'needs_review', 'reviewed', 'queued', 'ready', 'attempted', 'unknown'}:
                return value
        except (ValueError, AtlasProviderError):
            continue
    return None


def _public(row, state=None):
    return {'state': state or row.state, 'request_id': row.id}


def status(cid: int, owner: str, *, activity='walk'):
    _model(activity)
    with SessionLocal() as db:
        ch = owned_character(db, cid, owner)
        row = _request(db, ch, activity)
        if row is not None and row.owner_id != owner:
            raise MotionBindingError('character_not_found', 404)
        prepared = preparation_status(db, cid, owner)
        if any(item['activity'] == activity and item['state'] == 'ready' for item in prepared['activities']):
            return {'state': 'ready', 'request_id': row.id if row else None}
        if row is not None and row.approval_sha256:
            try:
                result = flow.status(row.approval_sha256, cid, owner, root=flow.DEFAULT_ROOT)
                mapped = {'attempted': 'unknown', 'reserved': 'unknown'}.get(result['state'], result['state'])
                if row.state == 'running' and mapped == 'unknown':
                    mapped = 'running'
                return _public(row, 'reviewed' if result.get('queue_state') == 'failed' else mapped)
            except AtlasProviderError as exc:
                if exc.code == 'source_changed':
                    return _public(row, 'blocked')
        candidate = _existing_candidate(cid, owner, activity)
        if candidate:
            state = {'attempted': 'unknown'}.get(candidate['state'], candidate['state'])
            return {'state': state, 'request_id': row.id if row else None}
        return _public(row) if row else {'state': 'not_requested', 'request_id': None}


def activities_status(cid: int, owner: str):
    return {'activities': [{'activity': activity, **status(cid, owner, activity=activity)}
                           for activity in ACTIVITIES]}


def request_activities(cid: int, owner: str):
    with SessionLocal() as db:
        db.execute(text('BEGIN IMMEDIATE'))
        ch = owned_character(db, cid, owner)
        if register_request(db, ch) is None:
            raise AtlasProviderError('source_invalid')
        db.commit()
    return activities_status(cid, owner)


def request(cid: int, owner: str):
    current = status(cid, owner)
    if current['state'] != 'not_requested':
        return current
    with SessionLocal() as db:
        db.execute(text('BEGIN IMMEDIATE'))
        ch = owned_character(db, cid, owner)
        row = register_request(db, ch)
        if row is None:
            raise AtlasProviderError('source_invalid')
        db.commit()
        return _public(row)


def authorize(request_id: str, owner: str, *, expected_source_sha256: str,
              approval_ref: str, price_verified_on: str, accept_metered_cost: bool):
    if (not approval_ref.strip() or len(approval_ref) > 128 or not accept_metered_cost
            or price_verified_on != date.today().isoformat()):
        raise AtlasProviderError('approval_invalid')
    with SessionLocal() as db:
        row = _by_id(db, request_id)
        if row is None or row.owner_id != owner:
            raise AtlasProviderError('request_not_found')
        cid, source_path, activity = row.character_id, row.source_image_path, _activity(row)
    options = {'activity': activity} if activity != 'walk' else {}
    initial = flow.plan(cid, owner, **options)
    if initial['source_sha256'] != expected_source_sha256:
        raise AtlasProviderError('source_not_approved')
    approval_sha = flow._digest(approval_ref.encode())
    if (flow.DEFAULT_ROOT/f'approval-{approval_sha}.json').exists() or _existing_candidate(cid, owner, activity):
        raise AtlasProviderError('approval_already_used')
    with SessionLocal() as db:
        db.execute(text('BEGIN IMMEDIATE'))
        row = _by_id(db, request_id)
        ch = owned_character(db, cid, owner)
        if ch.image_path != source_path or row is None or row.state != 'waiting_authorization':
            raise AtlasProviderError('request_not_authorizable')
        if any(db.scalar(select(model.id).where(model.approval_sha256 == approval_sha))
               for model in REQUEST_MODELS):
            raise AtlasProviderError('approval_already_used')
        if any(item['activity'] == activity and item['state'] == 'ready'
               for item in preparation_status(db, cid, owner)['activities']):
            raise AtlasProviderError('request_not_authorizable')
        row.approval_ref, row.approval_sha256 = approval_ref, approval_sha
        row.source_sha256, row.prompt_sha256 = expected_source_sha256, initial['prompt_sha256']
        row.price_verified_on, row.state = price_verified_on, 'queued'
        try:
            db.commit()
        except IntegrityError:
            raise AtlasProviderError('approval_already_used') from None
        return _public(row)


def authorize_activities(cid: int, owner: str, *, expected_source_sha256: str,
                         approval_ref: str, price_verified_on: str, accept_metered_cost: bool):
    """One explicit three-call grant, committed all-or-none; never a public API."""
    if (not approval_ref.strip() or len(approval_ref) > 119 or not accept_metered_cost
            or price_verified_on != date.today().isoformat()):
        raise AtlasProviderError('approval_invalid')
    plans = {activity: flow.plan(cid, owner, activity=activity) for activity in ACTIVITIES}
    if any(plan['source_sha256'] != expected_source_sha256 for plan in plans.values()):
        raise AtlasProviderError('source_not_approved')
    with SessionLocal() as db:
        db.execute(text('BEGIN IMMEDIATE'))
        ch = owned_character(db, cid, owner)
        prepared = preparation_status(db, cid, owner)['activities']
        rows = []
        for activity in ACTIVITIES:
            row = _request(db, ch, activity)
            if row is None or row.owner_id != owner or row.state != 'waiting_authorization':
                raise AtlasProviderError('request_not_authorizable')
            if any(item['activity'] == activity and item['state'] == 'ready' for item in prepared):
                raise AtlasProviderError('request_not_authorizable')
            reference = f'{approval_ref}:{activity}'
            digest = flow._digest(reference.encode())
            if ((flow.DEFAULT_ROOT / f'approval-{digest}.json').exists()
                    or _existing_candidate(cid, owner, activity)
                    or any(db.scalar(select(model.id).where(model.approval_sha256 == digest))
                           for model in REQUEST_MODELS)):
                raise AtlasProviderError('approval_already_used')
            rows.append((row, reference, digest, plans[activity]['prompt_sha256']))
        for row, reference, digest, prompt in rows:
            row.approval_ref, row.approval_sha256 = reference, digest
            row.source_sha256, row.prompt_sha256 = expected_source_sha256, prompt
            row.price_verified_on, row.state = price_verified_on, 'queued'
        try:
            db.commit()
        except IntegrityError:
            raise AtlasProviderError('approval_already_used') from None
    return activities_status(cid, owner)


def recover_interrupted():
    """Never requeue a request whose provider outcome may be unknown."""
    with SessionLocal() as db:
        db.execute(text('BEGIN IMMEDIATE'))
        for model in REQUEST_MODELS:
            db.query(model).filter_by(state='running').update(
                {'state': 'unknown', 'error_code': 'process_interrupted'}, synchronize_session=False)
        for model in REQUEST_MODELS:
            for row in db.query(model).filter_by(state='unknown', error_code='process_interrupted').all():
                for item in _batch_rows(db, row):
                    if item.state == 'queued':
                        item.state, item.error_code = 'blocked', 'batch_stopped'
        db.commit()


def process_one(*, provider=None, request_id=None):
    if not get_settings().motion_generation_enabled:
        return False
    with SessionLocal() as db:
        db.execute(text('BEGIN IMMEDIATE'))
        rows = []
        for model in REQUEST_MODELS:
            query = select(model).where(model.state == 'queued')
            if request_id is not None:
                query = query.where(model.id == request_id)
            item = db.scalar(query.order_by(model.created_at, model.id).limit(1))
            if item is not None:
                rows.append(item)
        row = min(rows, key=lambda item: (item.created_at, item.id)) if rows else None
        if row is None:
            return False
        batch = _batch_rows(db, row)
        if any(item.state == 'running' for item in batch):
            return False
        if any(item.state in {'unknown', 'blocked'} for item in batch):
            for item in batch:
                if item.state == 'queued':
                    item.state, item.error_code = 'blocked', 'batch_stopped'
            db.commit()
            return True
        rid, cid, owner, name = row.id, row.character_id, row.owner_id, row.source_image_path
        activity = _activity(row)
        grant = dict(expected_source_sha256=row.source_sha256, approval_ref=row.approval_ref,
                     price_verified_on=row.price_verified_on, accept_metered_cost=True)
        prompt = row.prompt_sha256
        row.state = 'running'; db.commit()
    state, error = 'unknown', None
    try:
        if grant['price_verified_on'] != date.today().isoformat():
            raise AtlasProviderError('approval_expired')
        source, current_name = flow._current(cid, owner)
        if current_name != name:
            raise AtlasProviderError('source_changed')
        options = {'activity': activity} if activity != 'walk' else {}
        initial = flow.plan(cid, owner, **options)
        if initial['source_sha256'] != grant['expected_source_sha256'] or initial['prompt_sha256'] != prompt:
            raise AtlasProviderError('source_or_prompt_changed')
        with SessionLocal() as db:
            if any(item['activity'] == activity and item['state'] == 'ready'
                   for item in preparation_status(db, cid, owner)['activities']):
                raise AtlasProviderError('activity_already_ready')
        result = flow.generate_candidate(cid, owner, **grant, root=flow.DEFAULT_ROOT,
                                         provider=provider, **options)
        state = result['state']
    except (AtlasProviderError, MotionBindingError) as exc:
        error = exc.code
        if error in {'approval_expired', 'source_changed', 'source_or_prompt_changed', 'character_not_found',
                     'activity_already_ready'}:
            state = 'blocked'
    except Exception:
        error = 'generation_unavailable'
    with SessionLocal() as db:
        row = _by_id(db, rid)
        if row is not None:
            row.state, row.error_code = state, error
            if state in {'unknown', 'blocked'}:
                for item in _batch_rows(db, row):
                    if item.state == 'queued':
                        item.state, item.error_code = 'blocked', 'batch_stopped'
            db.commit()
    return True


async def consume(stop: asyncio.Event):
    while not stop.is_set():
        try:
            await asyncio.to_thread(process_one)
        except Exception:
            # No exception contents are logged; interrupted jobs are never retried.
            pass
        try:
            await asyncio.wait_for(stop.wait(), timeout=2)
        except TimeoutError:
            pass
