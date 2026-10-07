"""Bind the archived Sunburst walk candidate through the isolated private queue.

Uses only the existing C1.10 QA database (8047 / 3049). No provider calls.
The live backend consumes the queued pack; this script never bypasses it.
"""
import hashlib
import json
import shutil
from uuid import uuid4

import c110_life_dispatch_preview as preview
from app.api import life_runtime
from app.services.motion_assets import validate_motion_pack
from app.services.motion_preparation import (
    enqueue_preparation, preparation_status, submit_prepared_pack,
)

SOURCE = preview.PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.14古灵精怪免费体验/apple-9b.jpg"
SOURCE_SHA256 = "7195f21cd80cefe8385308005f54acdabef54e12ac5e0c0254d2a7651445063c"
PACK = preview.PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段3/C1.56当前模型散步预览/walk"
SPRITE_SHA256 = "76ec715c831fdfcb52ba45c69b7197fd1b9cfbe1370647cdd877c1236ac8a8fa"
STATE = preview.PROJECT / ".runtime/c157-private-walk"
MANIFEST = STATE / "companion.json"
FILENAME = "c157-sunburst-apple.jpg"


def main() -> int:
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("archived source changed")
    manifest = validate_motion_pack(PACK, SOURCE_SHA256)
    if manifest.get("activity") != "walk" or manifest.get("sprite_sha256") != SPRITE_SHA256:
        raise RuntimeError("candidate pack changed")
    runtime = life_runtime.selected_runtime()
    if runtime.origin != "offline_fixture":
        raise RuntimeError("preview must stay offline")
    STATE.mkdir(parents=True, exist_ok=True)
    upload = preview.uploads / FILENAME
    if upload.exists():
        if hashlib.sha256(upload.read_bytes()).hexdigest() != SOURCE_SHA256:
            raise RuntimeError("isolated upload changed")
    else:
        shutil.copyfile(SOURCE, upload)

    saved = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else None
    with preview.SessionLocal() as db:
        matches = db.query(preview.Character).filter_by(
            owner_id=preview.owner, image_path=FILENAME).all()
        if len(matches) > 1:
            raise RuntimeError("duplicate isolated companions")
        character = matches[0] if matches else None
        if saved and (character is None or saved["character_id"] != character.id):
            raise RuntimeError("saved isolated companion differs")
        if character is None:
            photo = preview.Photo(filename=FILENAME, status="done", owner_id=preview.owner)
            db.add(photo)
            db.flush()
            obj = preview.Object(photo_id=photo.id, label="Sunburst真实散步隔离样例")
            db.add(obj)
            db.flush()
            character = preview.Character(
                object_id=obj.id, owner_id=preview.owner, name="苹果小怪灵·Sunburst散步",
                persona="真实模型动作素材的隔离验收样例；生活安排为离线演示。",
                opening_line="一起走两步。", image_path=FILENAME,
                status="ready", location_epoch=1,
            )
            db.add(character)
            db.flush()
            enqueue_preparation(db, character)
            db.commit()
        cid, sid = character.id, character.current_space_id

    if not sid:
        sid = str(uuid4())
        preview.living_store.create_space(preview.owner, sid, "desert", "private", str(cid))
        with preview.SessionLocal() as db:
            db.get(preview.Character, cid).current_space_id = sid
            db.commit()
    saved = {"character_id": cid, "space_id": sid, "source_sha256": SOURCE_SHA256}
    temporary = MANIFEST.with_suffix(".tmp")
    temporary.write_text(json.dumps(saved, indent=2) + "\n")
    temporary.replace(MANIFEST)

    # Manual motion preview does not schedule life activities. In particular,
    # night-time rest rules must not be bypassed to demonstrate a walk asset.
    with preview.SessionLocal() as db:
        result = submit_prepared_pack(db, cid, preview.owner, PACK, "walk", apply=True)
        current = preparation_status(db, cid, preview.owner)
    print(json.dumps({**saved, "queue": result, "preparation": current,
        "new_model_requests": 0,
        "url": f"http://127.0.0.1:3049/companions/{cid}/scenes/desert/{sid}"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
