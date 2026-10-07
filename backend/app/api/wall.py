"""R5.2: explicit publishing, a narrow public view, and revocable image URLs."""
from datetime import datetime
from pathlib import Path
import re
import unicodedata
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.core.errors import api_error
from app.models.models import Character, ThemePublication, User
from app.services.themes import THEMES, validate_theme

router = APIRouter(tags=["wall"])


class PublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    author_name: str

    @field_validator("author_name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not 1 <= len(value) <= 20 or any(unicodedata.category(c).startswith("C") for c in value):
            raise ValueError("invalid display name")
        if re.search(r"1[3-9]\d{9}", value):
            raise ValueError("phone number is not a display name")
        return value


class PublicWork(BaseModel):
    id: str
    theme_id: str
    name: str
    introduction: str
    author_name: str
    image_url: str
    published_at: datetime


class WorkPage(BaseModel):
    items: list[PublicWork]
    total: int
    next_offset: int | None


class PublicationPreview(BaseModel):
    name: str
    introduction: str
    theme_id: str
    image_url: str
    author_name: str
    publication_id: str | None


def no_cache(response: Response):
    response.headers["Cache-Control"] = "no-store"


def image_file(ch: Character) -> Path | None:
    if not ch.image_path:
        return None
    root = Path(get_settings().upload_dir).resolve()
    candidate = Path(ch.image_path)
    if candidate.is_absolute() or ".." in candidate.parts:
        return None
    candidate = (root / candidate).resolve()
    if not candidate.is_relative_to(root) or candidate.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".svg"}:
        return None
    return candidate if candidate.is_file() else None


def owned(db: Session, uid: str, cid: int) -> Character:
    ch = db.get(Character, cid)
    if ch is None or ch.owner_id != uid:
        raise api_error(404, "character_not_found", "伙伴不存在")
    return ch


def publishable(ch: Character):
    if ch.status != "ready" or ch.theme_id not in THEMES or image_file(ch) is None:
        raise api_error(409, "not_publishable", "只有已完成且有主题和形象的伙伴才能发布")


def preview(db: Session, ch: Character) -> PublicationPreview:
    publishable(ch)
    pub = db.query(ThemePublication).filter_by(character_id=ch.id).first()
    # Only this owner-only DTO can include the existing private image URL.
    from urllib.parse import quote
    return PublicationPreview(name=ch.name, introduction=ch.persona[:160], theme_id=ch.theme_id,
                              image_url="/uploads/" + quote(ch.image_path, safe="/"),
                              author_name=pub.author_name if pub else "小小创作者",
                              publication_id=pub.id if pub else None)


def public_query(db: Session, theme_id: str):
    validate_theme(theme_id)
    return db.query(ThemePublication, Character).join(Character, ThemePublication.character_id == Character.id).filter(
        Character.theme_id == theme_id, Character.status == "ready")


def public_work(pub: ThemePublication, ch: Character) -> PublicWork:
    return PublicWork(id=pub.id, theme_id=ch.theme_id, name=ch.name, introduction=ch.persona[:160],
                      author_name=pub.author_name, published_at=pub.published_at,
                      image_url=f"/api/v1/themes/{ch.theme_id}/works/{pub.id}/image")


def find_public(db: Session, theme_id: str, publication_id: str):
    row = public_query(db, theme_id).filter(ThemePublication.id == publication_id).first()
    if row is None:
        raise api_error(404, "work_not_found", "这份作品已撤下或暂不可见")
    return row


@router.get("/themes/{theme_id}/works", response_model=WorkPage)
def list_works(theme_id: str, response: Response, offset: int = Query(0, ge=0),
               limit: int = Query(20, ge=1, le=50), db: Session = Depends(get_db)):
    no_cache(response)
    query = public_query(db, theme_id)
    total = query.count()
    rows = query.order_by(ThemePublication.published_at.desc(), ThemePublication.id.desc()).offset(offset).limit(limit).all()
    end = offset + len(rows)
    return WorkPage(items=[public_work(pub, ch) for pub, ch in rows], total=total,
                    next_offset=end if end < total else None)


@router.get("/themes/{theme_id}/works/{publication_id}", response_model=PublicWork)
def work_detail(theme_id: str, publication_id: str, response: Response, db: Session = Depends(get_db)):
    no_cache(response)
    return public_work(*find_public(db, theme_id, publication_id))


@router.get("/themes/{theme_id}/works/{publication_id}/image")
def work_image(theme_id: str, publication_id: str, db: Session = Depends(get_db)):
    _, ch = find_public(db, theme_id, publication_id)
    path = image_file(ch)
    if path is None:
        raise api_error(404, "image_not_found", "形象暂不可用")
    return FileResponse(path, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                       "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.get("/wall/characters/{character_id}", response_model=PublicationPreview)
def publication_preview(character_id: int, response: Response,
                        user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    no_cache(response)
    return preview(db, owned(db, user.id, character_id))


@router.put("/wall/characters/{character_id}", response_model=PublicationPreview)
def publish(character_id: int, payload: PublishRequest, response: Response,
            user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    no_cache(response)
    ch = owned(db, user.id, character_id)
    publishable(ch)
    pub = db.query(ThemePublication).filter_by(character_id=character_id).first()
    if pub is None:
        db.add(ThemePublication(id=str(uuid4()), character_id=character_id, author_name=payload.author_name))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            # A simultaneous identical publish is successful, but deletion is not.
            owned(db, user.id, character_id)
            if not db.query(ThemePublication).filter_by(character_id=character_id).first():
                raise api_error(409, "publication_conflict", "发布状态已变化，请先核对")
    # Already published is a no-op, including alias/time: retries cannot edit it.
    return preview(db, ch)


@router.delete("/wall/characters/{character_id}", status_code=204)
def unpublish(character_id: int, response: Response,
              user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    no_cache(response)
    owned(db, user.id, character_id)
    db.execute(delete(ThemePublication).where(ThemePublication.character_id == character_id))
    db.commit()
