"""Compatibility boundary: old scene endpoints project the current living space.

All writes use the caller's transaction, including imports and proposal consumption.
The original legacy JSON is retained; existing positioned items are never overwritten.
"""
from collections import Counter
from uuid import uuid4

from sqlalchemy import insert, select, update

from app.core.errors import api_error
from app.living.rules import Atmosphere, CATALOG, Item, State, settle
from app.living.store import spaces
from app.models.models import LivingMembership, SceneImport, SceneProposal, SceneState
from app.services import scene as legacy
from app.services.migration import _ENTITY_MAP


def free_position(items):
    points = [(x, y) for y in (.15, .5, .85) for x in (.05, .5, .95)]
    placed = [item for item in items if not item.stored]
    for x, y in points:
        if all(abs(item.x-x) > .4 or abs(item.y-y) > .3 for item in placed):
            return x, y
    return points[len(placed) % len(points)]


def ensure_home(db, store, ch, *, create=False):
    conn = db.connection()
    row = conn.execute(select(spaces).where(
        spaces.c.owner_id == ch.owner_id, spaces.c.companion_id == str(ch.id),
        spaces.c.scene_type == "home", spaces.c.mode == "private",
    )).mappings().first()
    if row is None and not create:
        return None
    if row is None:
        values = dict(id=str(uuid4()), owner_id=ch.owner_id, companion_id=str(ch.id),
                      scene_type="home", mode="private", revision=0,
                      state_json=State(last_write_at=store._now()).model_dump_json())
        conn.execute(insert(spaces).values(**values))
        row = values
    if db.get(SceneImport, ch.id) is not None:
        return row
    source = db.query(SceneState).filter_by(character_id=ch.id).first()
    state = store._state(row)
    if source:
        # Keep the source even after import, including its legacy undo history.
        import json
        try:
            raw_source = json.loads(source.state_json)
            if not isinstance(raw_source, dict) or not isinstance(raw_source.get("elements"), dict):
                raise ValueError()
        except (ValueError, TypeError):
            raise api_error(409, "invalid_legacy_scene", "旧花园数据需要核对，已保留原存档") from None
        elements, _ = legacy.deserialize(source.state_json)
        counts = Counter(item.kind for item in state.items.values())
        now = store._now()
        state = settle(state, now)
        for kind in _ENTITY_MAP:
            count = elements.get(kind, 0)
            if type(count) is not int or count < 0:
                raise api_error(409, "invalid_legacy_scene", "旧花园数据需要核对，已保留原存档")
            for index in range(counts[kind], count):
                x, y = free_position(state.items.values())
                item = Item(id=str(uuid4()), kind=kind, x=x, y=y, settled_at=now)
                state.items[item.id] = item
        # Existing explicit atmosphere wins; legacy v1 had no atmosphere field.
        import json
        raw = json.loads(row["state_json"])
        if row["revision"] == 0 or raw.get("schema_version") == 1:
            state.atmosphere = Atmosphere(rain=bool(elements.get("rain")), sound=bool(elements.get("sound", 1)))
        row = dict(row, revision=row["revision"] + 1, state_json=state.model_dump_json())
        conn.execute(update(spaces).where(spaces.c.id == row["id"]).values(
            state_json=row["state_json"], revision=row["revision"]))
    db.add(SceneImport(character_id=ch.id, space_id=row["id"],
                       source_json=source.state_json if source else legacy.serialize(legacy.default_elements(), [])))
    # Unbound legacy proposals must not cross the import boundary.
    db.query(SceneProposal).filter_by(character_id=ch.id).delete()
    db.flush()
    return row


def current_space(db, store, ch):
    if visiting_group(db, ch):
        return None
    home = ensure_home(db, store, ch)
    if not ch.current_space_id:
        return home
    row = store._row(db.connection(), ch.owner_id, ch.current_space_id)
    if row["mode"] == "private":
        allowed = row["companion_id"] == str(ch.id)
    else:
        allowed = db.get(LivingMembership, (row["id"], str(ch.id))) is not None
    if not allowed:
        raise api_error(409, "scene_changed", "伙伴所在场景已变化，请重新选择")
    return row


def visiting_group(db, ch):
    if not ch.current_space_id:
        return False
    from app.living.gatherings import visits
    group_id = db.connection().execute(select(visits.c.group_id).where(
        visits.c.character_id == ch.id,
        visits.c.owner_id == ch.owner_id,
    )).scalar_one_or_none()
    return group_id == ch.current_space_id


def snapshot(store, row):
    return store._snapshot(row, store._state(row), store._now())


def elements_for(snap):
    elements = legacy.default_elements()
    for item in snap["items"]:
        if not item["stored"]:
            elements[item["kind"]] = elements.get(item["kind"], 0) + 1
    elements.update(rain=int(snap["atmosphere"]["rain"]),
                    cloud=int(snap["atmosphere"]["rain"]), sound=int(snap["atmosphere"]["sound"]))
    return elements


def allowed_actions(scene_type):
    return {code: label for code, label in legacy.ACTION_LABELS.items()
            if (code in ("light_rain", "quiet") and scene_type == "home") or
            legacy.ACTIONS[code].get("increment", next(iter(legacy.ACTIONS[code].get("changes", {})), None)) in CATALOG[scene_type]["items"]}


def apply_action(db, store, ch, row, action, request_id=None):
    snap = snapshot(store, row)
    if action not in allowed_actions(row["scene_type"]):
        raise api_error(409, "invalid_action", "这个生活场景暂不支持该操作")
    elements = elements_for(snap)
    if action in ("light_rain", "quiet"):
        command = {"action": "atmosphere", "weather": "rain" if action == "light_rain" else "quiet"}
    else:
        spec = legacy.ACTIONS[action]
        kind = spec.get("increment", next(iter(spec.get("changes", {})), None))
        # Preserve old endpoint caps; the living editor retains its own existing rules.
        if elements[kind] >= spec.get("limit", 1):
            return snap, legacy.unchanged_feedback(action, elements)
        x, y = free_position(store._state(row).items.values())
        command = {"action": "place", "kind": kind, "x": x, "y": y}
    result = store.execute(ch.owner_id, row["id"], request_id or str(uuid4()),
                           row["revision"], command, connection=db.connection())
    return result, legacy.feedback_for(action)
