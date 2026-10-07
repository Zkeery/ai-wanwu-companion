"""照片上传与对象识别。"""
from __future__ import annotations

import re
import hashlib
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Header, Request, UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.model_availability import require_model_available
from app.core.database import get_db
from app.core.errors import api_error
from app.models.models import Object, Photo, PhotoRequest, User
from app.schemas.schemas import ObjectOut, PhotoOut
from app.services.input_limits import MAX_CANDIDATES
from app.services.model_client import ModelClient
from app.services.photo_input import normalize_photo
from app.services.generation_timing import timed_call
from app.services.character_concept import save_concept
from app.services.generation_errors import record_failure, recognition_failure_message
from app.services.themes import validate_theme

router = APIRouter(prefix="/photos", tags=["photos"])

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/heic", "image/webp"}
MAX_SIZE = 10 * 1024 * 1024  # 10MB


async def theme_from_form(request: Request) -> str | None:
    values = (await request.form()).getlist("theme_id")
    if not values:
        return None
    if len(values) != 1 or not isinstance(values[0], str):
        raise api_error(422, "invalid_theme", "请选择一个有效主题")
    return validate_theme(values[0])


def _photo_out(photo: Photo) -> PhotoOut:
    # Never slice the ORM relationship in place: delete-orphan would delete old objects.
    return PhotoOut(id=photo.id, status=photo.status, theme_id=photo.theme_id, objects=[
        ObjectOut.model_validate(obj)
        for obj in sorted(photo.objects, key=lambda obj: obj.id)[:MAX_CANDIDATES]
    ])


def _sniff_image_type(data: bytes) -> str | None:
    """按文件头识别真实图片类型，不信任客户端 content_type。"""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and len(data) >= 12 and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"):
            return "image/heic"
    return None


def _safe_filename(name: str | None) -> str:
    """去除路径与非法字符，防止路径穿越，仅保留文件名。"""
    name = (name or "").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[^\w.\-\u4e00-\u9fff]", "_", name).strip("._")
    return (name or "upload")[:255]


def _validate_image(file: UploadFile) -> bytes:
    data = file.file.read(MAX_SIZE + 1)
    if len(data) > MAX_SIZE:
        raise api_error(400, "too_large", "图片不能超过 10MB")
    if _sniff_image_type(data) not in ALLOWED_TYPES:
        raise api_error(400, "invalid_type", "仅支持 JPG/PNG/HEIC/WebP 图片")
    return data


@router.post("", response_model=PhotoOut, status_code=201, dependencies=[Depends(require_model_available)])
def upload_photo(file: UploadFile = File(...), db: Session = Depends(get_db),
                 user: User = Depends(get_current_user),
                 theme_id: str | None = Depends(theme_from_form),
                 idempotency_key: str | None = Header(default=None)):
    validate_theme(theme_id)
    data = _validate_image(file)
    operation_id = f"photo:{uuid4().hex}"
    normalized = timed_call("photo_prepare", operation_id, normalize_photo, data)
    receipt = None
    if idempotency_key:
        try:
            key = str(UUID(idempotency_key))
        except ValueError:
            raise api_error(400, "invalid_key", "请求标识无效")
        digest = hashlib.sha256(data if theme_id is None else theme_id.encode() + b"\0" + data).hexdigest()
        receipt = db.get(PhotoRequest, key)
        if receipt is None:
            receipt = PhotoRequest(id=key, owner_id=user.id, digest=digest, status="running")
            db.add(receipt)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                receipt = db.get(PhotoRequest, key)
            else:
                # This request owns the only model call for this key.
                receipt = None
        if receipt is not None:
            if receipt.owner_id != user.id:
                raise api_error(404, "not_found", "未找到这次识别，请重新选择照片")
            if receipt.digest != digest:
                raise api_error(409, "key_conflict", "同一请求不能使用不同照片")
            if receipt.status == "ready":
                return _photo_out(db.get(Photo, receipt.photo_id))
            raise api_error(409, "recognition_" + receipt.status, "请先核对原识别结果")
        receipt = db.get(PhotoRequest, key)
    try:
        objects = timed_call("recognition", operation_id, ModelClient().recognize, normalized)
    except Exception as exc:
        details = record_failure("recognition_concept", operation_id, exc)
        if receipt:
            receipt.status = "failed"
            db.commit()
        error = api_error(502, "recognize_failed", recognition_failure_message(details["reason"]))
        error.detail["error"]["reason"] = details["reason"]
        raise error

    photo = Photo(filename=_safe_filename(file.filename), status="done", owner_id=user.id, theme_id=theme_id)
    db.add(photo)
    db.flush()
    for obj in objects[:MAX_CANDIDATES]:
        db.add(Object(photo_id=photo.id, label=obj.label, visual_features=obj.visual_features, category=obj.category,
                      character_concept_json=save_concept(obj.label, obj.visual_features, obj.concept) if obj.concept else None))
    if receipt:
        receipt.status = "ready"
        receipt.photo_id = photo.id
    db.commit()
    db.refresh(photo)
    return _photo_out(photo)


@router.get("/requests/{request_id}")
def get_photo_request(request_id: str, user: User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    receipt = db.get(PhotoRequest, request_id)
    if not receipt or receipt.owner_id != user.id:
        raise api_error(404, "not_found", "未找到这次识别，请重新选择照片")
    photo = db.get(Photo, receipt.photo_id) if receipt.photo_id else None
    return {"status": receipt.status,
            "photo": _photo_out(photo).model_dump() if photo else None}


@router.post("/{photo_id}/corrections", response_model=PhotoOut, status_code=201, dependencies=[Depends(require_model_available)])
def copy_for_correction(photo_id: int, user: User = Depends(get_current_user),
                        db: Session = Depends(get_db),
                        idempotency_key: str | None = Header(default=None)):
    """Prepare a new text-only draft without overwriting a finished companion."""
    original = db.get(Photo, photo_id)
    if not original or original.owner_id != user.id:
        raise api_error(404, "not_found", "照片不存在")
    try:
        key = str(UUID(idempotency_key or ""))
    except ValueError:
        raise api_error(400, "invalid_key", "请求标识无效")
    digest = hashlib.sha256(f"correction:{photo_id}".encode()).hexdigest()

    def existing_result(receipt):
        if receipt is None or receipt.owner_id != user.id:
            raise api_error(404, "not_found", "未找到这次纠正记录")
        if receipt.digest != digest:
            raise api_error(409, "key_conflict", "同一请求不能用于不同操作")
        if receipt.status != "ready":
            raise api_error(409, "correction_pending", "请先核对原纠正记录")
        saved = db.get(Photo, receipt.photo_id)
        if saved is None:
            raise api_error(404, "not_found", "纠正记录不存在")
        return _photo_out(saved)

    receipt = db.get(PhotoRequest, key)
    if receipt is not None:
        return existing_result(receipt)
    copy = Photo(filename=original.filename, status="done", owner_id=user.id, theme_id=original.theme_id)
    db.add(copy)
    db.flush()
    for obj in sorted(original.objects, key=lambda obj: obj.id)[:MAX_CANDIDATES]:
        db.add(Object(photo_id=copy.id, label=obj.label, visual_features=obj.visual_features, category=obj.category,
                      character_concept_json=obj.character_concept_json))
    db.add(PhotoRequest(id=key, owner_id=user.id, digest=digest,
                        status="ready", photo_id=copy.id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return existing_result(db.get(PhotoRequest, key))
    db.refresh(copy)
    return _photo_out(copy)


@router.get("/{photo_id}", response_model=PhotoOut)
def get_photo(photo_id: int, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    photo = db.get(Photo, photo_id)
    if not photo or photo.owner_id != user.id:
        raise api_error(404, "not_found", "照片不存在")
    return _photo_out(photo)
