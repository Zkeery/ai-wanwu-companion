"""Create three isolated apple companions for classified sprite review; no provider calls."""
import hashlib
import json
import shutil
import sys
from uuid import uuid4

import c110_life_dispatch_preview as preview
from app.api import life_runtime

SOURCE = preview.PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.14古灵精怪免费体验/apple-9b.jpg"
SOURCE_SHA256 = "7195f21cd80cefe8385308005f54acdabef54e12ac5e0c0254d2a7651445063c"
STATE = preview.PROJECT / ".runtime/c138-sheet-qa"
MANIFEST = STATE / "companions.json"
FILENAME = "c138-apple.jpg"
ACTIVITIES = ("rest", "walk", "observe")


def main() -> int:
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("apple source changed")
    STATE.mkdir(parents=True, exist_ok=True)
    upload = preview.uploads / FILENAME
    if upload.exists():
        if hashlib.sha256(upload.read_bytes()).hexdigest() != SOURCE_SHA256:
            raise RuntimeError("apple upload changed")
    else:
        shutil.copyfile(SOURCE, upload)

    samples = json.loads(MANIFEST.read_text(encoding="utf8")) if MANIFEST.exists() else {}
    for activity in ACTIVITIES:
        saved = samples.get(activity)
        if saved:
            with preview.SessionLocal() as db:
                character = db.get(preview.Character, saved["character_id"])
                if (character is None or character.owner_id != preview.owner
                        or character.image_path != FILENAME or character.current_space_id != saved["space_id"]):
                    raise RuntimeError("stored QA companion differs")
        else:
            with preview.SessionLocal() as db:
                photo = preview.Photo(filename=FILENAME, status="done", owner_id=preview.owner)
                db.add(photo)
                db.flush()
                obj = preview.Object(photo_id=photo.id, label=f"苹果{activity}分帧隔离样例")
                db.add(obj)
                db.flush()
                character = preview.Character(
                    object_id=obj.id, owner_id=preview.owner, name=f"苹果小怪灵·{activity}分帧",
                    persona="仅供隔离分帧动作验收；离线样例，不代表真实AI自主经历",
                    opening_line="一起看看动作。", image_path=FILENAME, status="ready", location_epoch=1,
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
            saved = {"character_id": character_id, "space_id": space_id}
            if activity == "observe":
                preview.living_store.execute(preview.owner, space_id, str(uuid4()), 0,
                                             {"action": "place", "kind": "tree", "x": 0.72, "y": 0.67})
            samples[activity] = saved
            MANIFEST.write_text(json.dumps(samples, indent=2) + "\n", encoding="utf8")

        runtime = life_runtime.selected_runtime()
        if runtime.read_permission(preview.owner, saved["space_id"]) is None:
            runtime.save_permission(preview.owner, saved["space_id"], str(uuid4()), 0, True, (activity,))
        status = runtime.snapshot(preview.owner, saved["space_id"])
        if not status.tasks and status.next_allowed_at <= status.observed_at:
            task = runtime.schedule(preview.owner, saved["space_id"], str(uuid4()), "viewing")
            runtime.run_fixture(preview.owner, saved["space_id"], task.spec.basis.plan_id)
    print(json.dumps({activity: {**samples[activity], "url":
        f"http://127.0.0.1:3049/companions/{samples[activity]['character_id']}/scenes/desert/{samples[activity]['space_id']}"}
        for activity in ACTIVITIES}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
