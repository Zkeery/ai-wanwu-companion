"""Owned candidate inspection and explicit review; never exposes generation."""
import json
import re
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_current_user
from app.api.motion import HEADERS
from app.core.errors import api_error
from app.models.models import User
from app.services import character_walk_workflow as flow
from app.services.motion_atlas_provider import AtlasProviderError, MAX_ATLAS
from app.services.motion_bindings import MotionBindingError

router = APIRouter(tags=['motion-candidates'])
SHA = re.compile(r'[a-f0-9]{64}')


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    decision: Literal['accept', 'reject']
    candidate_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')


class RegistrationRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')


@router.get('/characters/{character_id}/motion-generation')
def generation_status(character_id: int, user: User = Depends(get_current_user)):
    from app.services.motion_generation import status
    try:
        return {'character_id': character_id, **status(character_id, user.id)}
    except (MotionBindingError, AtlasProviderError, OSError) as exc:
        raise failure(exc)


@router.post('/characters/{character_id}/motion-generation')
def register_generation(character_id: int, body: RegistrationRequest, user: User = Depends(get_current_user)):
    from app.services.motion_generation import request
    try:
        return {'character_id': character_id, **request(character_id, user.id)}
    except (MotionBindingError, AtlasProviderError, OSError) as exc:
        raise failure(exc)


@router.get('/characters/{character_id}/motion-generation/activities')
def generation_activities(character_id: int, response: Response, user: User = Depends(get_current_user)):
    from app.services.motion_generation import activities_status
    response.headers.update(HEADERS)
    try:
        return {'character_id': character_id, **activities_status(character_id, user.id)}
    except (MotionBindingError, AtlasProviderError, OSError) as exc:
        raise failure(exc)


@router.post('/characters/{character_id}/motion-generation/activities')
def register_generation_activities(character_id: int, body: RegistrationRequest, response: Response,
                                   user: User = Depends(get_current_user)):
    from app.services.motion_generation import request_activities
    response.headers.update(HEADERS)
    try:
        return {'character_id': character_id, **request_activities(character_id, user.id)}
    except (MotionBindingError, AtlasProviderError, OSError) as exc:
        raise failure(exc)


def failure(exc):
    if isinstance(exc, MotionBindingError):
        return api_error(exc.status, exc.code, '伙伴不存在或素材暂不可用')
    code = exc.code if isinstance(exc, AtlasProviderError) else 'candidate_unavailable'
    if code in {'job_invalid', 'workflow_file_invalid'}:
        return api_error(404, 'candidate_not_found', '这份动作候选已不可用，请更新列表')
    messages = {
        'source_changed': '伙伴形象已变化，请更新列表',
        'candidate_changed': '动作图片已变化，请重新查看后确认',
        'review_conflict': '这份候选已有其他决定，请更新列表',
        'job_busy': '这份动作正在处理，请稍后更新状态',
        'candidate_not_reviewable': '这份候选当前不能确认，请更新列表',
    }
    return api_error(409 if code in messages else 503,
                     code if code in messages else 'candidate_unavailable',
                     messages.get(code, '暂时无法处理动作候选，请更新状态后再试'))


def describe(job_id: str, cid: int, owner: str) -> dict:
    current = flow.status(job_id, cid, owner, root=flow.DEFAULT_ROOT)
    digest = current.get('candidate_sha256')
    if not isinstance(digest, str) or not SHA.fullmatch(digest):
        digest = None
    # The decision is durable even if the preparation worker exhausts retries.
    # Present that accepted candidate as resumable instead of endlessly queued.
    state = 'reviewed' if current.get('queue_state') == 'failed' else current['state']
    return {**({'activity': current['activity']} if current.get('activity', 'walk') != 'walk' else {}),
            'job_id': job_id, 'state': state, 'candidate_sha256': digest,
            'image_url': (f'/api/v1/characters/{cid}/motion-candidates/{job_id}/image/{digest}'
                          if digest else None)}


@router.get('/characters/{character_id}/motion-candidates')
def candidates(character_id: int, response: Response,
               cursor: str | None = Query(default=None, pattern=r'^[a-f0-9]{64}$'),
               activity: Literal['rest', 'walk', 'observe'] = 'walk',
               user: User = Depends(get_current_user)):
    try:
        flow._current(character_id, user.id)
        root = flow.DEFAULT_ROOT
        if root.is_symlink():
            raise AtlasProviderError('workflow_path_invalid')
        items = []
        # Maintenance receipts share this directory. Only current, owned jobs
        # enter the public projection; legacy grants never become candidates.
        for file in sorted(root.glob('approval-*.json')):
            job = file.stem.removeprefix('approval-')
            if not SHA.fullmatch(job) or (cursor and job <= cursor):
                continue
            try:
                record = json.loads(flow._read(file, 65536))
            except (ValueError, AtlasProviderError):
                continue
            if not isinstance(record, dict) or record.get('character_id') != character_id or record.get('owner_id') != user.id:
                continue
            if record.get('activity', 'walk') != activity:
                continue
            try:
                item = describe(job, character_id, user.id)
            except AtlasProviderError as exc:
                if exc.code in {'source_changed', 'job_invalid'}:
                    continue
                raise
            items.append(item)
            if len(items) == 21:
                break
        response.headers.update(HEADERS)
        return {'character_id': character_id, 'items': items[:20],
                'next_cursor': items[19]['job_id'] if len(items) > 20 else None}
    except (MotionBindingError, AtlasProviderError, OSError) as exc:
        raise failure(exc)


@router.get('/characters/{character_id}/motion-candidates/{job_id}/image/{digest}')
def image(character_id: int, job_id: str, digest: str, user: User = Depends(get_current_user)):
    try:
        current = describe(job_id, character_id, user.id)
        if not SHA.fullmatch(digest) or current['candidate_sha256'] != digest:
            raise AtlasProviderError('candidate_changed')
        raw = flow._read(flow._directory(flow.DEFAULT_ROOT, job_id) / 'candidate.png', MAX_ATLAS)
        if flow._digest(raw) != digest:
            raise AtlasProviderError('candidate_changed')
        return Response(raw, media_type='image/png', headers=HEADERS)
    except (MotionBindingError, AtlasProviderError, OSError) as exc:
        raise failure(exc)


@router.post('/characters/{character_id}/motion-candidates/{job_id}/review')
def review(character_id: int, job_id: str, body: ReviewRequest, response: Response,
           user: User = Depends(get_current_user)):
    try:
        flow.review(job_id, character_id, user.id, decision=body.decision,
                    candidate_sha256=body.candidate_sha256,
                    review_ref=f'web-{uuid4()}', root=flow.DEFAULT_ROOT)
        response.headers.update(HEADERS)
        return describe(job_id, character_id, user.id)
    except (MotionBindingError, AtlasProviderError, OSError, ValueError) as exc:
        raise failure(exc)
