"""Private three-video candidates; web review is free and never generates media."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from uuid import uuid4

from app.services import character_walk_workflow as flow
from app.services.character_motion_video import ACTIVITIES, prepare_character_videos
from app.services.motion_bindings import MotionBindingError, owned_character, source_digest
from app.services.motion_atlas_provider import AtlasProviderError

SHA = re.compile(r'^[a-f0-9]{64}$')


def _read(path):
    if path.parent.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise AtlasProviderError('job_invalid')
    record = json.loads(path.read_bytes())
    if (not isinstance(record, dict) or record.get('schema') != 1
            or not isinstance(record.get('videos'), dict)
            or set(record['videos']) != set(ACTIVITIES)
            or record.get('state') not in ('needs_review', 'rejected', 'queued')
            or not isinstance(record.get('history'), list)):
        raise AtlasProviderError('job_invalid')
    if (type(record.get('character_id')) is not int or record['character_id'] <= 0
            or not isinstance(record.get('owner_id'), str)
            or not SHA.fullmatch(str(record.get('source_sha256', '')))
            or len(record['history']) > 3
            or any(not isinstance(r, dict) or not SHA.fullmatch(str(r.get('job_id', '')))
                   or not SHA.fullmatch(str(r.get('sha256', '')))
                   or r.get('decision') not in (None, 'accept', 'reject')
                   for r in record['videos'].values())):
        raise AtlasProviderError('job_invalid')
    return record


def _save(path, value):
    temp = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    with os.fdopen(os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as out:
        json.dump(value, out, sort_keys=True); out.flush(); os.fsync(out.fileno())
    os.replace(temp, path)
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _root():
    root = flow.DEFAULT_ROOT
    if root.is_symlink():
        raise AtlasProviderError('workflow_path_invalid')
    return root


def register(db, cid, owner, videos):
    probe = prepare_character_videos(db, cid, owner, videos)
    root = _root(); root.mkdir(parents=True, exist_ok=True)
    batch = hashlib.sha256(uuid4().bytes).hexdigest()
    target = root / ('video-batch-' + batch)
    temp = Path(tempfile.mkdtemp(prefix='.video-staging-', dir=root)); temp.chmod(0o700)
    try:
        rows = {}
        for activity in ACTIVITIES:
            raw = Path(videos[activity]).read_bytes()
            if hashlib.sha256(raw).hexdigest() != probe['videos'][activity]:
                raise AtlasProviderError('candidate_changed')
            file = temp / (activity + '.mp4'); file.write_bytes(raw); file.chmod(0o600)
            rows[activity] = {'job_id': hashlib.sha256((batch + activity).encode()).hexdigest(),
                              'sha256': probe['videos'][activity], 'decision': None}
        db.expire_all()
        ch = owned_character(db, cid, owner)
        if source_digest(ch) != probe['source_sha256']:
            raise AtlasProviderError('source_changed')
        record = {'schema': 1, 'batch_id': batch, 'character_id': cid, 'owner_id': owner,
                  'source_image_path': ch.image_path, 'source_sha256': probe['source_sha256'],
                  'state': 'needs_review', 'created_at': int(time.time()), 'videos': rows, 'history': []}
        _save(temp / 'record.json', record)
        temp.rename(target)
        return {'state': 'needs_review', 'batch_id': batch, 'new_model_requests': 0,
                'items': [_public(record, a, cid) for a in ACTIVITIES]}
    finally:
        if temp.exists(): shutil.rmtree(temp)


def _owned(record, cid, owner):
    if record.get('character_id') != cid or record.get('owner_id') != owner:
        raise AtlasProviderError('job_invalid')
    source, name = flow._current(cid, owner)
    if name != record['source_image_path'] or hashlib.sha256(source.read_bytes()).hexdigest() != record['source_sha256']:
        raise AtlasProviderError('source_changed')


def _public(record, activity, cid):
    row = record['videos'][activity]
    state = record['state']
    if state == 'queued':
        from app.core.database import SessionLocal
        from app.services.motion_preparation import preparation_status
        with SessionLocal() as db:
            prepared = preparation_status(db, cid, record['owner_id'])
        slot = next((v for v in prepared['activities'] if v['activity'] == activity), {})
        if slot.get('state') == 'ready':
            state = 'ready'
        elif slot.get('state') == 'failed':
            state = 'reviewed'
    if state == 'needs_review' and row['decision'] == 'accept':
        state = 'reviewed'
    return {'job_id': row['job_id'], 'activity': activity, 'state': state,
            'candidate_sha256': row['sha256'], 'image_url': None, 'kind': 'video',
            'video_url': '/api/v1/characters/' + str(cid) + '/motion-candidates/' +
                         row['job_id'] + '/video/' + row['sha256']}


def listing(cid, owner, activity):
    result = []
    for path in sorted(_root().glob('video-batch-*/record.json')):
        try:
            record = _read(path)
            if record.get('character_id') != cid or record.get('owner_id') != owner:
                continue
            _owned(record, cid, owner)
            result.append(_public(record, activity, cid))
        except (AtlasProviderError, ValueError, KeyError, OSError):
            continue
    return result


def _find(job, cid, owner):
    if not isinstance(job, str) or not SHA.fullmatch(job):
        raise AtlasProviderError('job_invalid')
    for file in _root().glob('video-batch-*/record.json'):
        # A damaged historical batch must not block another batch's playback
        # or review. Keep the original evidence on disk and omit it as listing
        # already does; an unreadable requested batch still ends as not found.
        try:
            record = _read(file)
        except (AtlasProviderError, ValueError, KeyError, OSError):
            continue
        if record.get('character_id') != cid or record.get('owner_id') != owner:
            continue
        for activity, row in record.get('videos', {}).items():
            if row.get('job_id') == job:
                _owned(record, cid, owner)
                return file, record, activity
    raise AtlasProviderError('job_invalid')


def describe(job, cid, owner):
    _, record, activity = _find(job, cid, owner)
    return _public(record, activity, cid)


def read_video(job, cid, owner, digest):
    path, record, activity = _find(job, cid, owner)
    if digest != record['videos'][activity]['sha256']:
        raise AtlasProviderError('candidate_changed')
    file = path.parent / (activity + '.mp4')
    if file.is_symlink() or not file.is_file() or not 0 < file.stat().st_size <= 10*1024*1024:
        raise AtlasProviderError('candidate_changed')
    raw = file.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise AtlasProviderError('candidate_changed')
    return raw


def review(job, cid, owner, decision, digest, *, session_factory):
    file, _, _ = _find(job, cid, owner)
    lock = file.parent / '.review.lock'
    if lock.is_symlink():
        raise AtlasProviderError('workflow_path_invalid')
    with lock.open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            file, record, activity = _find(job, cid, owner)
            read_video(job, cid, owner, digest)
            row = record['videos'][activity]
            if decision not in ('accept', 'reject') or (row['decision'] and row['decision'] != decision):
                raise AtlasProviderError('review_conflict')
            if record['state'] == 'rejected' and decision != 'reject':
                raise AtlasProviderError('review_conflict')
            if record['state'] == 'queued':
                current = _public(record, activity, cid)
                if current['state'] != 'reviewed':
                    return current
                # Only an explicit repeated accept may resume failed local
                # preparation. All three durable decisions remain unchanged.
            if row['decision'] is None:
                row['decision'] = decision
                record['history'].append({'activity': activity, 'decision': decision,
                                          'sha256': digest, 'at': int(time.time())})
            if decision == 'reject':
                record['state'] = 'rejected'
            _save(file, record)  # Preserve the actual human decision even on local preparation failure.
            if record['state'] != 'rejected' and all(r['decision'] == 'accept' for r in record['videos'].values()):
                videos = {a: file.parent / (a + '.mp4') for a in ACTIVITIES}
                review = {'confirmed': True, 'viewed_all_three': True, 'review_ref': 'web-' + record['batch_id'],
                          'source_sha256': record['source_sha256'],
                          'videos': {a: r['sha256'] for a, r in record['videos'].items()}}
                with session_factory() as db:
                    prepare_character_videos(db, cid, owner, videos, apply=True, review=review)
                record['state'] = 'queued'; _save(file, record)
            return _public(record, activity, cid)
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
