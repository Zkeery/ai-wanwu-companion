"""Seed authored motion fixtures in a guarded, isolated test database only."""
import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.engine import make_url
from app.core.config import get_settings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    if not args.write:
        print("dry-run: two synthetic companions, no model calls")
        return
    project = Path(__file__).resolve().parents[2]
    runtime = project / ".runtime/motion-r14"
    settings = get_settings()
    url = make_url(settings.database_url)
    if (settings.app_env != "test" or url.get_backend_name() != "sqlite"
            or url.database != str(runtime / "app.db")
            or Path(settings.upload_dir).resolve() != runtime / "uploads"
            or settings.model_api_key or settings.scene_agent_enabled):
        raise SystemExit("isolated test configuration required")
    from app.main import app  # noqa: F401 - initializes only the guarded database
    from app.core.database import SessionLocal
    from app.models.models import Character, Object, Photo, User
    from app.services.motion_bindings import import_motion_pack
    fixture = project / "frontend/public/motion-preview-assets"
    root = Path(settings.upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    with SessionLocal() as db:
        if db.query(User).count():
            print("isolated preview already initialized")
            return
        user = User(id="motion-r14-preview-owner", phone="13800990001")
        db.add(user)
        db.flush()
        for n, suffix in [(1, "已绑定"), (2, "无素材")]:
            filename = f"motion-preview-{n}.png"
            shutil.copyfile(fixture / "static.png", root / filename)
            photo = Photo(filename=filename, owner_id=user.id, status="done")
            db.add(photo)
            db.flush()
            obj = Object(photo_id=photo.id, label="手绘示意杯")
            db.add(obj)
            db.flush()
            ch = Character(object_id=obj.id, owner_id=user.id, name=f"动作示意杯·{suffix}",
                           persona="手绘测试角色，未使用用户照片", opening_line="这是动作接入示意，不是真实生成。",
                           image_path=filename, status="ready")
            db.add(ch)
            db.flush()
            cid = ch.id
            db.commit()
            if n == 1:
                import_motion_pack(db, cid, user.id, fixture, apply=True)
    print("isolated synthetic preview ready; no model calls")


if __name__ == "__main__":
    main()
