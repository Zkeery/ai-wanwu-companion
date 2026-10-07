"""Add one existing generated image to the isolated R1.4 preview, without model calls."""
import argparse
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.engine import make_url
from app.core.config import get_settings
from app.services.motion_assets import validate_motion_pack


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--variant", choices=("original", "lively", "video"), default="original")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[2]
    evidence = project / "docs/PRD/版本/V1.2/验收证据"
    source = evidence / "阶段7/R7.14古灵精怪免费体验/apple-9b.jpg"
    pack = evidence / "阶段1/R1.5真实样图本地动作/apple-motion-pack"
    if args.variant == "lively":
        pack = pack.parent / "自然度修订/apple-motion-pack"
    if args.variant == "video":
        pack = evidence / "阶段1/R1.7私有视频动作接入/apple-video-pack"
    data = source.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    validate_motion_pack(pack, digest)
    if not args.write:
        print("dry-run: validated one existing apple image; manual contours; no model calls")
        return
    runtime = project / ".runtime/motion-r14"
    settings = get_settings()
    url = make_url(settings.database_url)
    if (settings.app_env != "test" or url.get_backend_name() != "sqlite"
            or url.database != str(runtime / "app.db")
            or Path(settings.upload_dir).resolve() != runtime / "uploads"
            or settings.model_api_key or settings.scene_agent_enabled
            or not (runtime / "app.db").is_file()):
        raise SystemExit("existing isolated R1.4 test configuration required")
    from app.core.database import SessionLocal
    from app.models.models import Character, Object, Photo, User
    from app.services.motion_bindings import import_motion_pack
    owner = "motion-r14-preview-owner"
    filename = "motion-r15-apple-9b.jpg" if args.variant == "original" else "motion-r15-apple-lively.jpg"
    if args.variant == "video":
        filename = "motion-r17-apple-video.jpg"
    target = runtime / "uploads" / filename
    with SessionLocal() as db:
        user = db.get(User, owner)
        if not user or user.phone != "13800990001":
            raise SystemExit("isolated preview owner required")
        if target.is_symlink() or (target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != digest):
            raise SystemExit("preview image collision; existing data preserved")
        character = db.query(Character).filter_by(owner_id=owner, image_path=filename).one_or_none()
        if not target.exists():
            with target.open("xb") as handle:
                handle.write(data)
        if character is None:
            photo = Photo(filename=filename, owner_id=owner, status="done")
            db.add(photo)
            db.flush()
            obj = Object(photo_id=photo.id, label="已有生成苹果样图")
            db.add(obj)
            db.flush()
            name = "苹果样图·动作试作" if args.variant == "original" else "苹果样图·轻快摆动"
            if args.variant == "video":
                name = "苹果样图·表情与转圈"
            character = Character(object_id=obj.id, owner_id=owner, name=name,
                                  persona="已有样图的视频动作试作。" if args.variant == "video" else "已有生成样图，手工分层制作本地动作。", status="ready",
                                  opening_line="嘿，看我转个圈～" if args.variant == "video" else "嘿，看我摆个手～这是已有苹果图的动作试作。", image_path=filename)
            db.add(character)
            db.commit()
            db.refresh(character)
        import_motion_pack(db, character.id, owner, pack, apply=True)
        print(f"isolated apple preview ready: character_id={character.id}; no model calls")


if __name__ == "__main__":
    main()
