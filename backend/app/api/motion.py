"""Authenticated, read-only delivery of bound motion resources."""
import hashlib
from typing import Literal

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.errors import api_error
from app.models.models import CharacterMotionAsset, CharacterActivityMotionAsset, User
from app.services.motion_bindings import MotionBindingError, owned_character, read_binding

router = APIRouter(tags=["motion"])
HEADERS = {"Cache-Control": "private, no-store", "Vary": "Authorization",
           "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"}


def unavailable(exc: MotionBindingError):
    return api_error(exc.status, exc.code, "伙伴不存在" if exc.code == "character_not_found"
                     else "动作素材暂不可用，静态形象仍保留")


@router.get("/characters/{character_id}/motion-preparation")
def preparation(character_id: int, response: Response, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    from app.services.motion_preparation import preparation_status
    try:
        response.headers.update(HEADERS)
        return preparation_status(db, character_id, user.id)
    except MotionBindingError as exc:
        raise unavailable(exc)


@router.get("/characters/{character_id}/motion")
def metadata(character_id: int, response: Response, user: User = Depends(get_current_user),
             db: Session = Depends(get_db), activity: Literal["rest", "walk", "observe"] | None = None):
    try:
        ch = owned_character(db, character_id, user.id)
        response.headers.update(HEADERS)
        if activity is not None:
            selected = db.get(CharacterActivityMotionAsset, (character_id, activity))
            if selected is not None:
                _, data = read_binding(ch, selected)
                return describe(selected.pack_id, selected.source_sha256, data,
                                f"/api/v1/characters/{character_id}/motion/activity/{activity}/{selected.pack_id}",
                                slot="activity")
        binding = db.get(CharacterMotionAsset, character_id)
        if binding is None:
            return {"state": "missing"}
        _, data = read_binding(ch, binding)
        if activity is not None and data.get("activity") != activity:
            return {"state": "missing"}
        return describe(binding.pack_id, binding.source_sha256, data,
                        f"/api/v1/characters/{character_id}/motion/{binding.pack_id}")
    except MotionBindingError as exc:
        raise unavailable(exc)


def describe(pack_id: str, source_sha256: str, data: dict, base: str, *, slot: str | None = None) -> dict:
    result = {"state": "ready", "pack_id": pack_id, "source_sha256": source_sha256}
    if slot:
        result["slot"] = slot
    if "activity" in data:
        result["activity"] = data["activity"]
    if "video_file" in data:
        return {**result, "kind": "video",
                **{key: data[key] for key in ("width", "height", "fps", "duration_ms", "video_sha256")},
                "video_url": base + "/video"}
    return {**result,
            **{key: data[key] for key in ("frame_width", "frame_height", "frame_count", "fps",
                                          "sprite_sha256", "background_sha256")},
            "sprite_url": base + "/sprite", "background_url": base + "/background"}


def media(directory, data: dict, kind: str) -> Response:
    if kind + "_file" not in data:
        raise MotionBindingError("motion_not_found", 404)
    file = directory / data[kind + "_file"]
    if file.is_symlink() or not 0 < file.stat().st_size <= 10 * 1024 * 1024:
        raise MotionBindingError()
    encoded = file.read_bytes()
    if hashlib.sha256(encoded).hexdigest() != data[kind + "_sha256"]:
        raise MotionBindingError()
    return Response(encoded, media_type="video/mp4" if kind == "video" else "image/png", headers=HEADERS)


@router.get("/characters/{character_id}/motion/{pack_id}/{kind}")
def resource(character_id: int, pack_id: str, kind: Literal["sprite", "background", "video"],
             user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        ch = owned_character(db, character_id, user.id)
        binding = db.get(CharacterMotionAsset, character_id)
        if binding is None or binding.pack_id != pack_id:
            raise MotionBindingError("motion_not_found", 404)
        directory, data = read_binding(ch, binding)
        return media(directory, data, kind)
    except MotionBindingError as exc:
        raise unavailable(exc)
    except OSError:
        raise unavailable(MotionBindingError()) from None


@router.get("/characters/{character_id}/motion/activity/{activity}/{pack_id}/{kind}")
def activity_resource(character_id: int, activity: Literal["rest", "walk", "observe"],
                      pack_id: str, kind: Literal["sprite", "background", "video"],
                      user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        ch = owned_character(db, character_id, user.id)
        binding = db.get(CharacterActivityMotionAsset, (character_id, activity))
        if binding is None or binding.pack_id != pack_id:
            raise MotionBindingError("motion_not_found", 404)
        directory, data = read_binding(ch, binding)
        return media(directory, data, kind)
    except MotionBindingError as exc:
        raise unavailable(exc)
    except OSError:
        raise unavailable(MotionBindingError()) from None
