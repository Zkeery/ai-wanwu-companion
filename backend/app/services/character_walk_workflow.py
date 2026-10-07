"""Private, one-shot candidate generation and durable human review.

Generation is restricted to trusted maintenance commands. No automatic paid retries.
Shares the historical AIHubMix approval namespace so old grants stay spent.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import date
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from dotenv import dotenv_values

from app.api.wall import image_file
from app.core.config import BASE_DIR, get_settings
from app.core.database import SessionLocal
from app.services.motion_atlas_provider import AtlasProviderError, MAX_ATLAS, _source
from app.services.motion_bindings import MotionBindingError, owned_character
from app.services.motion_preparation import preparation_status, submit_prepared_pack
from app.services.motion_sheet import build_sheet_motion
from app.services.motion_walk_aihubmix import MODEL, generate, preflight
from app.services.motion_activity_prompts import prompt_for
from app.services.motion_walk_openai import inspect_sheet, _usage

DEFAULT_ROOT = Path(os.environ.get('WALK_WORKFLOW_ROOT', str(BASE_DIR.parent / '.runtime/c155-aihubmix-walk')))
STATES = {'reserved', 'attempted', 'unknown', 'needs_review', 'rejected', 'reviewed', 'queued', 'ready'}


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _folder(path: Path) -> Path:
    if path.is_symlink():
        raise AtlasProviderError('workflow_path_invalid')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def _atomic(path: Path, raw: bytes, *, first=False) -> None:
    if path.is_symlink():
        raise AtlasProviderError('workflow_path_invalid')
    if first:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    else:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.walk-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        try:
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _save(root: Path, record: dict, *, first=False) -> None:
    _atomic(root / f"approval-{record['job_id']}.json",
            json.dumps(record, sort_keys=True).encode(), first=first)


def _read(path: Path, limit: int) -> bytes:
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= limit:
        raise AtlasProviderError('workflow_file_invalid')
    raw = path.read_bytes()
    if not 0 < len(raw) <= limit:
        raise AtlasProviderError('workflow_file_invalid')
    return raw


def _current(cid: int, owner: str) -> tuple[Path, str]:
    with SessionLocal() as db:
        ch = owned_character(db, cid, owner)
        source = image_file(ch)
        if source is None:
            raise AtlasProviderError('source_invalid')
        return source, ch.image_path


def plan(cid: int, owner: str, *, activity: str = 'walk') -> dict:
    prompt_for(activity)
    source, _ = _current(cid, owner)
    return {**preflight(source, activity=activity), 'character_id': cid, 'state': 'dry-run',
            'generation_requests': 0, 'written': False, 'human_review_required': True}


def _assert_current(record: dict) -> None:
    source, name = _current(record['character_id'], record['owner_id'])
    if name != record['source_image_path'] or _source(source)[2] != record['source_sha256']:
        raise AtlasProviderError('source_changed')


def _load(root: Path, job_id: str, cid: int, owner: str) -> dict:
    if not re.fullmatch(r'[a-f0-9]{64}', job_id):
        raise AtlasProviderError('job_invalid')
    _current(cid, owner)
    try:
        record = json.loads(_read(root / f'approval-{job_id}.json', 65536))
        if (record.get('job_id') != job_id or record.get('character_id') != cid
                or record.get('owner_id') != owner or record.get('state') not in STATES):
            raise AtlasProviderError('job_invalid')
        activity = record.get('activity', 'walk')
        try:
            prompt_for(activity)
        except AtlasProviderError:
            raise AtlasProviderError('job_invalid') from None
        return record
    except (ValueError, TypeError, AttributeError):
        raise AtlasProviderError('job_invalid') from None


def _directory(root: Path, job_id: str) -> Path:
    directory = root / 'jobs' / job_id
    if root.is_symlink() or (root / 'jobs').is_symlink() or directory.is_symlink():
        raise AtlasProviderError('workflow_path_invalid')
    return directory


@contextmanager
def _lock(root: Path, job_id: str):
    locks = _folder(root / 'locks')
    fd = os.open(locks / job_id, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AtlasProviderError('job_busy') from None
        yield
    finally:
        os.close(fd)


def _out(root: Path, record: dict) -> dict:
    result = {k: record[k] for k in ('job_id', 'character_id', 'state', 'origin', 'source_sha256',
        'candidate_sha256', 'provider_task_id', 'error_code', 'queue_state', 'generation_requests') if k in record}
    result['activity'] = record.get('activity', 'walk')
    if 'candidate_sha256' in record:
        result['candidate'] = str(_directory(root, record['job_id']) / 'candidate.png')
    return result


def status(job_id: str, cid: int, owner: str, *, root: Path = DEFAULT_ROOT) -> dict:
    record = _load(root, job_id, cid, owner)
    _assert_current(record)
    if record['state'] in {'queued', 'ready'}:
        with SessionLocal() as db:
            current = next(item for item in preparation_status(db, cid, owner)['activities']
                           if item['activity'] == record.get('activity', 'walk'))
        record['queue_state'] = current['state']
        if current['state'] == 'ready':
            record['state'] = 'ready'
    return _out(root, record)


def _reserve(cid: int, owner: str, job_id: str, root: Path, origin: str, activity: str = 'walk') -> dict:
    prompt_for(activity)
    source, name = _current(cid, owner)
    raw, _, digest = _source(source)
    record = {'job_id': job_id, 'character_id': cid, 'owner_id': owner,
              'source_image_path': name, 'source_sha256': digest,
              'provider': 'aihubmix', 'model': MODEL, 'origin': origin, 'activity': activity,
              'state': 'reserved', 'generation_requests': 0}
    _folder(root)
    try:
        _save(root, record, first=True)
    except FileExistsError:
        raise AtlasProviderError('approval_already_used') from None
    directory = _directory(root, job_id)
    _folder(directory.parent)
    directory.mkdir(mode=0o700)
    _atomic(directory / 'source.image', raw, first=True)
    return record


def _candidate(root: Path, record: dict, raw: bytes) -> None:
    if not 0 < len(raw) <= MAX_ATLAS:
        raise AtlasProviderError('provider_image_invalid')
    # Persist the expected digest first: a crash during file writing cannot
    # cause arbitrary local bytes to be adopted later as a model result.
    record['candidate_sha256'] = _digest(raw)
    _save(root, record)
    _atomic(_directory(root, record['job_id']) / 'candidate.png', raw, first=True)
    _finish_candidate(root, record)


def _finish_candidate(root: Path, record: dict) -> None:
    raw = _read(_directory(root, record['job_id']) / 'candidate.png', MAX_ATLAS)
    if _digest(raw) != record.get('candidate_sha256'):
        raise AtlasProviderError('candidate_changed')
    _assert_current(record)
    quality = inspect_sheet(raw)
    record.update(state=quality['state'], quality_check=quality)
    record.pop('error_code', None)
    _save(root, record)


def generate_candidate(cid: int, owner: str, *, expected_source_sha256: str,
                       approval_ref: str, price_verified_on: str, accept_metered_cost: bool,
                       root: Path = DEFAULT_ROOT, provider=None, activity: str = 'walk') -> dict:
    if (not approval_ref.strip() or len(approval_ref) > 128 or not accept_metered_cost
            or price_verified_on != date.today().isoformat()):
        raise AtlasProviderError('approval_invalid')
    initial = plan(cid, owner, activity=activity)
    if initial['source_sha256'] != expected_source_sha256:
        raise AtlasProviderError('source_not_approved')
    key = dotenv_values(BASE_DIR.parent / '.env', interpolate=False).get('AIHUBMIX_API_KEY')
    if not isinstance(key, str) or not key.strip() or any(c.isspace() for c in key):
        raise AtlasProviderError('provider_not_configured')
    job_id = _digest(approval_ref.encode())
    record = _reserve(cid, owner, job_id, root, 'generated', activity)
    with _lock(root, job_id):
        try:
            if record['source_sha256'] != expected_source_sha256:
                raise AtlasProviderError('source_not_approved')
            _assert_current(record)
            record.update(state='attempted', generation_requests=1,
                          price_verified_on=price_verified_on, accept_metered_cost=True,
                          prompt_sha256=initial['prompt_sha256'], actual_bill_verified=False)
            _save(root, record)
            def on_task(task_id: str) -> None:
                if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', task_id):
                    raise AtlasProviderError('provider_response_invalid')
                record['provider_task_id'] = task_id
                _save(root, record)
            raw, usage = (provider or generate)(_directory(root, job_id) / 'source.image', key,
                expected_sha256=record['source_sha256'], on_task=on_task,
                **({'activity': activity} if activity != 'walk' else {}))
            record['usage'] = _usage(usage)
            _candidate(root, record, raw)
        except Exception as exc:
            code = exc.code if isinstance(exc, (AtlasProviderError, MotionBindingError)) else ''
            record.update(state='unknown', error_code=(code if isinstance(code, str)
                          and re.fullmatch(r'[a-z_]{1,48}', code) else 'candidate_unavailable'))
            _save(root, record)
            raise AtlasProviderError(record['error_code']) from None
    return _out(root, record)


def import_candidate(cid: int, owner: str, receipt: Path, candidate: Path, *, root: Path = DEFAULT_ROOT) -> dict:
    raw_receipt, raw = _read(receipt, 65536), _read(candidate, MAX_ATLAS)
    try:
        old = json.loads(raw_receipt)
        activity = old.get('activity', 'walk')
        prompt_for(activity)
        task = old.get('provider_task_id')
        if (old.get('provider') != 'aihubmix' or old.get('model') != MODEL
                or old.get('state') != 'needs_review' or old.get('image_sha256') != _digest(raw)
                or not isinstance(task, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', task)
                or old.get('source_sha256') != plan(cid, owner, activity=activity)['source_sha256']):
            raise AtlasProviderError('receipt_invalid')
    except (ValueError, AttributeError, TypeError):
        raise AtlasProviderError('receipt_invalid') from None
    job_id = _digest(json.dumps([_digest(raw_receipt), cid, owner]).encode())
    _folder(root)
    with _lock(root, job_id):
        if (root / f'approval-{job_id}.json').exists():
            return status(job_id, cid, owner, root=root)
        record = _reserve(cid, owner, job_id, root, 'archived_receipt', activity)
        record.update(receipt_sha256=_digest(raw_receipt), provider_task_id=task, usage=_usage(old.get('usage')))
        _candidate(root, record, raw)
        return _out(root, record)


def recover_local(job_id: str, cid: int, owner: str, *, root: Path = DEFAULT_ROOT) -> dict:
    record = _load(root, job_id, cid, owner)
    with _lock(root, job_id):
        record = _load(root, job_id, cid, owner)
        if record['state'] not in {'attempted', 'unknown', 'reserved'}:
            raise AtlasProviderError('recovery_not_needed')
        _finish_candidate(root, record)
        return _out(root, record)


def review(job_id: str, cid: int, owner: str, *, decision: str,
           candidate_sha256: str, review_ref: str, root: Path = DEFAULT_ROOT) -> dict:
    _load(root, job_id, cid, owner)
    if decision not in {'accept', 'reject'} or not review_ref.strip() or len(review_ref) > 128:
        raise AtlasProviderError('review_invalid')
    with _lock(root, job_id):
        record = _load(root, job_id, cid, owner)
        _assert_current(record)
        directory = _directory(root, job_id)
        raw = _read(directory / 'candidate.png', MAX_ATLAS)
        if candidate_sha256 != record.get('candidate_sha256') or _digest(raw) != candidate_sha256:
            raise AtlasProviderError('candidate_changed')
        previous = record.get('decision')
        if previous is not None and previous != decision:
            raise AtlasProviderError('review_conflict')
        if record['state'] == 'rejected' and previous == 'reject':
            return _out(root, record)
        if record['state'] not in {'needs_review', 'reviewed', 'queued', 'ready'}:
            raise AtlasProviderError('candidate_not_reviewable')
        record['decision'] = decision
        record.setdefault('review_ref_sha256', _digest(review_ref.encode()))
        record['state'] = 'rejected' if decision == 'reject' else 'reviewed'
        _save(root, record)
        if decision == 'reject':
            return _out(root, record)
        # Rebuild from the immutable candidate on resume; existing queue checks
        # make a crash after queue commit but before this receipt safe to retry.
        if _source(directory / 'source.image')[2] != record['source_sha256']:
            raise AtlasProviderError('source_changed')
        upload_root = _folder(Path(get_settings().upload_dir))
        with tempfile.TemporaryDirectory(prefix='.walk-review-', dir=upload_root) as temporary:
            activity = record.get('activity', 'walk')
            pack = Path(temporary) / activity
            build_sheet_motion(directory / 'source.image', directory / 'candidate.png', pack, activity=activity, write=True)
            if _digest(_read(directory / 'candidate.png', MAX_ATLAS)) != candidate_sha256:
                raise AtlasProviderError('candidate_changed')
            _assert_current(record)
            with SessionLocal() as db:
                result = submit_prepared_pack(db, cid, owner, pack, activity, apply=True)
        record.update(state=result['state'], queue_state=result['state'])
        _save(root, record)
        return _out(root, record)
