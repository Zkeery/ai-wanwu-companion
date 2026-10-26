"""Reviewed three-video delivery to the existing preparation queue. No provider."""
import hashlib
from pathlib import Path
import tempfile

from app.api.wall import image_file
from app.core.config import get_settings
from app.services.motion_bindings import MotionBindingError, owned_character, source_digest
from app.services.motion_preparation import submit_prepared_packs
from scripts.build_video_motion import build

ACTIVITIES = ('rest', 'walk', 'observe')


def prepare_character_videos(db, cid, owner, videos, *, apply=False, review=None):
    if set(videos) != set(ACTIVITIES):
        raise MotionBindingError('three_reviewed_activities_required', 422)
    ch = owned_character(db, cid, owner)
    source = image_file(ch)
    digest = source_digest(ch)
    fingerprints = {}
    for activity, value in videos.items():
        value = Path(value)
        if value.is_symlink() or not value.is_file() or not 0 < value.stat().st_size <= 10 * 1024 * 1024:
            raise MotionBindingError('motion_video_invalid', 422)
        fingerprints[activity] = hashlib.sha256(value.read_bytes()).hexdigest()
    if apply and (not isinstance(review, dict) or review.get('confirmed') is not True
                  or review.get('viewed_all_three') is not True
                  or not isinstance(review.get('review_ref'), str)
                  or not 8 <= len(review['review_ref']) <= 120
                  or review.get('source_sha256') != digest
                  or review.get('videos') != fingerprints):
        raise MotionBindingError('motion_review_required', 422)
    # Dry-run really validates/transcodes the candidates in a temporary directory,
    # but never writes business rows or permanent packs.
    root = Path(get_settings().upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.video-delivery-', dir=root) as temp:
        directories = {a: Path(temp) / a for a in ACTIVITIES}
        for activity in ACTIVITIES:
            built = build(source, Path(videos[activity]), directories[activity], activity=activity, write=True)
            if built['source_sha256'] != digest:
                raise MotionBindingError('motion_source_changed')
        if source_digest(ch) != digest or any(
                hashlib.sha256(Path(videos[a]).read_bytes()).hexdigest() != fingerprints[a] for a in ACTIVITIES):
            raise MotionBindingError('motion_source_changed')
        result = submit_prepared_packs(db, cid, owner, directories, apply=apply)
    return {**result, 'source_sha256': digest, 'videos': fingerprints,
            'review_required': not apply, 'new_model_requests': 0,
            'automatic_generation_enabled': False}
