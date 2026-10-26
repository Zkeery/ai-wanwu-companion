"""Existing /uploads URLs now require an authenticated owner reference."""
from pathlib import PurePosixPath
from io import BytesIO

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageOps
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.wall import image_file
from app.core.database import get_db
from app.core.errors import api_error
from app.models.models import Character, User

router = APIRouter(tags=["private-images"])


@router.get("/uploads/{image_path:path}")
def private_image(image_path: str, preview: bool = False, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    parts = image_path.split("/")
    if (not image_path or "\\" in image_path or any(p in ("", ".", "..") for p in parts)
            or PurePosixPath(image_path).is_absolute()):
        raise api_error(404, "image_not_found", "形象暂不可用")
    character = db.query(Character).filter_by(owner_id=user.id, image_path=image_path, status="ready").first()
    path = image_file(character) if character is not None else None
    if path is None:
        raise api_error(404, "image_not_found", "形象暂不可用")
    return image_response(path, preview=preview)


def image_response(path, *, preview: bool = False, edge: int = 768):
    """Render an already-authorized image; never change its source file."""
    headers = {"Cache-Control": "private, no-store", "Vary": "Authorization",
               "X-Content-Type-Options": "nosniff",
               "Content-Security-Policy": "default-src 'none'; sandbox"}
    if preview:
        try:
            with Image.open(path) as original:
                if original.width * original.height <= 4_194_304:
                    image = ImageOps.exif_transpose(original)
                    image.thumbnail((edge, edge))
                    image = image.convert('RGBA' if 'A' in image.getbands() else 'RGB')
                    output = BytesIO()
                    image.save(output, format='WEBP', quality=85, method=4)
                    content = output.getvalue()
                    if len(content) < path.stat().st_size:
                        return Response(content, media_type='image/webp', headers=headers)
        except (OSError, ValueError, Image.DecompressionBombError):
            pass  # Preserve the original response when a preview cannot be made.
    return FileResponse(path, headers=headers)
