"""Create one isolated apple companion for reviewing the real rest-motion candidate.

This reuses the 8047 synthetic account and forbids provider calls. It does not
bind a motion pack; import_motion_pack.py remains the explicit binding step.
"""
import hashlib
import json
import shutil
import sys
from uuid import uuid4

import c110_life_dispatch_preview as preview
from app.api import life_runtime
from app.living.rules import LivingError


SOURCE = preview.PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.14古灵精怪免费体验/apple-9b.jpg"
EXPECTED_SOURCE = "7195f21cd80cefe8385308005f54acdabef54e12ac5e0c0254d2a7651445063c"
FILENAME = "c135-rest-apple.jpg"
STATE = preview.PROJECT / ".runtime/c135-qa"
MANIFEST = STATE / "sample.json"


def main() -> int:
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != EXPECTED_SOURCE:
        raise RuntimeError("apple source changed")
    STATE.mkdir(parents=True, exist_ok=True)
    target = preview.uploads / FILENAME
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() != EXPECTED_SOURCE:
            raise RuntimeError("apple upload changed")
    else:
        shutil.copyfile(SOURCE, target)

    if MANIFEST.exists():
        sample = json.loads(MANIFEST.read_text(encoding="utf-8"))
        with preview.SessionLocal() as db:
            character = db.get(preview.Character, sample["character_id"])
            if (character is None or character.owner_id != preview.owner
                    or character.image_path != FILENAME
                    or character.current_space_id != sample["space_id"]):
                raise RuntimeError("stored QA companion differs")
    else:
        with preview.SessionLocal() as db:
            photo = preview.Photo(filename=FILENAME, status="done", owner_id=preview.owner)
            db.add(photo)
            db.flush()
            obj = preview.Object(photo_id=photo.id, label="真实休息动作隔离样例")
            db.add(obj)
            db.flush()
            character = preview.Character(
                object_id=obj.id, owner_id=preview.owner, name="苹果小怪灵·休息联调",
                persona="隔离素材验收样例；动作视频含水印，尚非正式素材",
                opening_line="先歇一会儿。", image_path=FILENAME, status="ready", location_epoch=1,
            )
            db.add(character)
            db.flush()
            character_id = character.id
            db.commit()
        space_id = str(uuid4())
        preview.living_store.create_space(preview.owner, space_id, "desert", "private", str(character_id))
        with preview.SessionLocal() as db:
            db.get(preview.Character, character_id).current_space_id = space_id
            db.commit()
        sample = {"character_id": character_id, "space_id": space_id, "source_sha256": EXPECTED_SOURCE}
        MANIFEST.write_text(json.dumps(sample, indent=2) + "\n", encoding="utf-8")

    runtime = life_runtime.selected_runtime()
    if runtime.read_permission(preview.owner, sample["space_id"]) is None:
        runtime.save_permission(preview.owner, sample["space_id"], str(uuid4()), 0, True, ("rest",))
    status = runtime.snapshot(preview.owner, sample["space_id"])
    if not status.tasks or "--refresh-activity" in sys.argv:
        if status.next_allowed_at <= status.observed_at and status.permission.enabled:
            try:
                task = runtime.schedule(preview.owner, sample["space_id"], str(uuid4()), "viewing")
                runtime.run_fixture(preview.owner, sample["space_id"], task.spec.basis.plan_id)
            except LivingError:
                if not status.tasks:
                    raise
    print(json.dumps({"character_id": sample["character_id"], "space_id": sample["space_id"],
                      "activity": "rest", "source_sha256": EXPECTED_SOURCE,
                      "url": f"http://127.0.0.1:3049/companions/{sample['character_id']}/scenes/desert/{sample['space_id']}"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
