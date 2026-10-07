"""Remove unowned character images within the configured upload directory."""
from pathlib import Path

from app.core.config import get_settings


def remove_image_file(image_path: str | None) -> None:
    if not image_path:
        return
    root = Path(get_settings().upload_dir).resolve()
    path = Path(image_path)
    if not path.is_absolute():
        path = root / path
    path = path.resolve()
    if not path.is_relative_to(root):
        return
    if path.is_file():
        try:
            path.unlink()
        except OSError:
            pass
