"""R1 rule/transaction tests use an isolated file database, never model services."""
from concurrent.futures import ThreadPoolExecutor
import json
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, event, select, update

from app.living.rules import DAY, TREE_MATURITY, LivingError
from app.living.store import LivingStore, receipts, spaces


@pytest.fixture
def world(tmp_path):
    clock = [1000]
    engine = create_engine(f"sqlite:///{tmp_path / 'living.db'}",
                           connect_args={"check_same_thread": False, "timeout": 10})
    store = LivingStore(engine, lambda: clock[0])
    store.initialize()
    snapshot = store.create_space("alice", str(uuid4()), "home", "private", "fruit")
    yield store, clock, snapshot["id"]
    engine.dispose()


def act(world, action, **params):
    store, _, space_id = world
    revision = store.read_space("alice", space_id)["revision"]
    return store.execute("alice", space_id, str(uuid4()), revision, {"action": action, **params})


def plant(world):
    return act(world, "place", kind="tree", x=.3, y=.4)["items"][-1]["id"]


def read_item(world):
    return world[0].read_space("alice", world[2])["items"][0]


def fails(code, fn):
    with pytest.raises(LivingError) as error:
        fn()
    assert error.value.code == code
    assert set(error.value.as_dict()) == {"error"}


@pytest.mark.parametrize("scene,kind", [("home", "bench"), ("desert", "shade"), ("forest", "cushion")])
def test_three_scenes_and_asset_rules(world, scene, kind):
    store, clock, _ = world
    space = store.create_space("alice", str(uuid4()), scene, "shared")
    result = act((store, clock, space["id"]), "place", kind=kind, x=0., y=1.)
    assert result["items"][0]["stage"] is None
    wrong = "mushroom" if scene != "home" else "shade"
    fails("invalid_action", lambda: act((store, clock, space["id"]), "place", kind=wrong, x=.5, y=.5))


def test_private_unique_and_shared_independent(world):
    store, _, space_id = world
    assert store.create_space("alice", space_id, "home", "private", "fruit")["revision"] == 0
    fails("conflict", lambda: store.create_space("alice", str(uuid4()), "home", "private", "fruit"))
    fails("conflict", lambda: store.create_space("alice", space_id, "forest", "private", "fruit"))
    one = store.create_space("alice", str(uuid4()), "home", "shared")
    two = store.create_space("alice", str(uuid4()), "home", "shared")
    assert one["id"] != two["id"] and one["companion_id"] is None


@pytest.mark.parametrize("mode,companion", [("private", None), ("shared", "fruit"), ("auto", None)])
def test_residence_must_be_explicit(world, mode, companion):
    fails("invalid_request", lambda: world[0].create_space("alice", str(uuid4()), "home", mode, companion))


def test_owner_boundary_including_receipt_replay(world):
    store, _, sid = world
    request = str(uuid4())
    command = dict(action="place", kind="tree", x=.2, y=.3)
    store.execute("alice", sid, request, 0, command)
    for call in [lambda: store.read_space("bob", sid),
                 lambda: store.create_space("bob", sid, "home", "private", "fruit"),
                 lambda: store.execute("bob", sid, request, 0, command)]:
        fails("not_found", call)


@pytest.mark.parametrize("hours,expected,status", [(0, 0, "growing"), (12, 12, "growing"),
                                                  (24, 24, "needs_care"), (36, 24, "needs_care"),
                                                  (720, 24, "needs_care")])
def test_offline_growth_and_care_expiry(world, hours, expected, status):
    tree = plant(world)
    act(world, "care", item_id=tree)
    world[1][0] += hours * 3600
    item = read_item(world)
    assert item["growth_seconds"] == expected * 3600
    assert item["growth_status"] == status
    assert read_item(world) == item  # GET cannot accumulate twice.


def test_uncared_tree_never_dies_or_grows(world):
    plant(world)
    world[1][0] += 365 * DAY
    item = read_item(world)
    assert item["stage"] == "planted" and item["growth_seconds"] == 0


def test_72_effective_hours_mature_and_cap(world):
    tree = plant(world)
    for day in range(3):
        act(world, "care", item_id=tree)
        world[1][0] += DAY
        assert read_item(world)["growth_seconds"] == (day + 1) * DAY
    assert read_item(world)["stage"] == "mature"
    act(world, "care", item_id=tree)
    world[1][0] += 100 * DAY
    assert read_item(world)["growth_seconds"] == TREE_MATURITY


def test_care_refreshes_not_stacks_and_no_backfill(world):
    tree = plant(world)
    act(world, "care", item_id=tree)
    act(world, "care", item_id=tree)
    assert read_item(world)["care_remaining_seconds"] == DAY
    world[1][0] += 36 * 3600
    act(world, "care", item_id=tree)
    assert read_item(world)["growth_seconds"] == DAY
    world[1][0] += DAY
    assert read_item(world)["growth_seconds"] == 2 * DAY


def test_storage_keeps_identity_progress_and_expired_care(world):
    tree = plant(world)
    act(world, "care", item_id=tree)
    world[1][0] += 6 * 3600
    act(world, "store", item_id=tree)
    world[1][0] += 2 * DAY
    assert read_item(world)["growth_seconds"] == 6 * 3600
    fails("invalid_action", lambda: act(world, "care", item_id=tree))
    act(world, "restore", item_id=tree, x=.8, y=.1)
    item = read_item(world)
    assert item["id"] == tree and item["x"] == .8 and item["growth_status"] == "needs_care"
    act(world, "care", item_id=tree)
    world[1][0] += 6 * 3600
    assert read_item(world)["growth_seconds"] == 12 * 3600


def test_storage_with_unexpired_care_and_undo_without_backfill(world):
    tree = plant(world)
    act(world, "care", item_id=tree)
    world[1][0] += 3600
    act(world, "store", item_id=tree)
    world[1][0] += 3600
    act(world, "undo")
    assert read_item(world)["growth_seconds"] == 3600
    world[1][0] += 3600
    assert read_item(world)["growth_seconds"] == 7200


def test_move_and_undo_preserve_growth_and_care(world):
    tree = plant(world)
    act(world, "care", item_id=tree)
    world[1][0] += 3600
    act(world, "move", item_id=tree, x=.9, y=.9)
    world[1][0] += 3600
    act(world, "care", item_id=tree)
    care = read_item(world)["cared_until"]
    act(world, "undo")
    item = read_item(world)
    assert item["x"] == .3 and item["growth_seconds"] == 7200 and item["cared_until"] == care
    fails("invalid_action", lambda: act(world, "undo"))


def test_restore_undo_preserves_growth_earned_while_placed(world):
    tree = plant(world)
    act(world, "care", item_id=tree)
    act(world, "store", item_id=tree)
    act(world, "restore", item_id=tree, x=.1, y=.2)
    world[1][0] += 3600
    act(world, "undo")
    item = read_item(world)
    assert item["stored"] and item["growth_seconds"] == 3600
    world[1][0] += 3600
    assert read_item(world)["growth_seconds"] == 3600


def test_undo_place_removes_only_last_object(world):
    tree = plant(world)
    act(world, "place", kind="bench", x=.4, y=.4)
    result = act(world, "undo")
    assert [item["id"] for item in result["items"]] == [tree]


def test_cross_space_target_and_wrong_state(world):
    tree = plant(world)
    store, clock, _ = world
    other = store.create_space("alice", str(uuid4()), "desert", "private", "fruit")
    fails("not_found", lambda: act((store, clock, other["id"]), "store", item_id=tree))
    fails("invalid_action", lambda: act(world, "restore", item_id=tree, x=.2, y=.2))
    act(world, "store", item_id=tree)
    fails("invalid_action", lambda: act(world, "move", item_id=tree, x=.2, y=.2))
    fails("invalid_action", lambda: act(world, "store", item_id=tree))


@pytest.mark.parametrize("command", [
    {"action": "place", "kind": "tree", "x": -0.1, "y": .2},
    {"action": "place", "kind": "tree", "x": float("nan"), "y": .2},
    {"action": "place", "kind": "tree", "x": float("inf"), "y": .2},
    {"action": "place", "kind": "tree", "x": 1.1, "y": .2},
    {"action": "place", "kind": "tree", "x": .1, "y": .2, "growth_seconds": 100},
    {"action": "undo", "now": 12345}, {"action": "care"}, {"action": "delete_all"},
])
def test_invalid_commands_no_write(world, command):
    store, _, sid = world
    fails("invalid_request", lambda: store.execute("alice", sid, str(uuid4()), 0, command))
    assert store.read_space("alice", sid)["revision"] == 0


def test_furniture_cannot_be_cared_for(world):
    item = act(world, "place", kind="bench", x=.2, y=.4)["items"][0]
    fails("invalid_action", lambda: act(world, "care", item_id=item["id"]))


def test_idempotent_replay_returns_original_receipt(world):
    store, clock, sid = world
    rid = str(uuid4())
    command = dict(action="place", kind="tree", x=.2, y=.3)
    first = store.execute("alice", sid, rid, 0, command)
    clock[0] += DAY
    assert store.execute("alice", sid, rid, 0, command) == first
    fails("conflict", lambda: store.execute("alice", sid, rid, 0, dict(command, x=.4)))
    fails("conflict", lambda: store.execute("alice", sid, str(uuid4()), 0, command))
    assert store.read_space("alice", sid)["revision"] == 1


def test_retrying_care_does_not_extend_deadline(world):
    tree = plant(world)
    store, clock, sid = world
    request = str(uuid4())
    command = {"action": "care", "item_id": tree}
    original = store.execute("alice", sid, request, 1, command)
    deadline = original["items"][0]["cared_until"]
    clock[0] += 20 * 3600
    assert store.execute("alice", sid, request, 1, command) == original
    assert read_item(world)["cared_until"] == deadline


def test_corrupt_receipt_is_rejected_without_reexecution(world):
    store, _, sid = world
    request = str(uuid4())
    command = dict(action="place", kind="tree", x=.2, y=.3)
    store.execute("alice", sid, request, 0, command)
    with store.engine.begin() as conn:
        conn.execute(update(receipts).values(result_json='{"items":"broken"}'))
    fails("corrupt_state", lambda: store.execute("alice", sid, request, 0, command))
    assert store.read_space("alice", sid)["revision"] == 1


@pytest.mark.parametrize("field,value", [("space_id", "invalid"), ("request_id", "invalid"),
                                        ("expected_revision", True), ("owner_id", "")])
def test_invalid_envelope_is_rejected(world, field, value):
    args = dict(owner_id="alice", space_id=world[2], request_id=str(uuid4()),
                expected_revision=0, command={"action": "undo"})
    args[field] = value
    fails("invalid_request", lambda: world[0].execute(**args))


def test_same_request_concurrent_is_applied_once(world):
    store, _, sid = world
    rid = str(uuid4())
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: store.execute("alice", sid, rid, 0,
                            dict(action="place", kind="tree", x=.2, y=.3)), range(6)))
    assert all(result == results[0] for result in results)
    assert len(store.read_space("alice", sid)["items"]) == 1


def test_different_concurrent_commands_do_not_overwrite(world):
    store, _, sid = world
    def write(_):
        try:
            return store.execute("alice", sid, str(uuid4()), 0,
                                 dict(action="place", kind="tree", x=.2, y=.3))
        except LivingError as exc:
            return exc.code
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(write, range(6)))
    assert sum(isinstance(result, dict) for result in results) == 1
    assert all(isinstance(result, dict) or result == "conflict" for result in results)
    assert len(store.read_space("alice", sid)["items"]) == 1


def test_receipt_failure_rolls_back_state(world):
    from sqlalchemy.exc import OperationalError
    store, _, sid = world
    def fail_receipt(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith("INSERT INTO living_receipts"):
            raise OperationalError(statement, None, Exception("private storage details"))
    event.listen(store.engine, "before_cursor_execute", fail_receipt)
    try:
        fails("storage_unavailable", lambda: act(world, "place", kind="tree", x=.2, y=.3))
    finally:
        event.remove(store.engine, "before_cursor_execute", fail_receipt)
    assert store.read_space("alice", sid)["revision"] == 0
    assert store.read_space("alice", sid)["items"] == []


def test_corrupt_state_is_not_overwritten(world):
    store, _, sid = world
    with store.engine.begin() as conn:
        conn.execute(update(spaces).where(spaces.c.id == sid).values(state_json='{"unknown":1}'))
    fails("corrupt_state", lambda: store.read_space("alice", sid))
    fails("corrupt_state", lambda: store.execute("alice", sid, str(uuid4()), 0,
                                               dict(action="place", kind="tree", x=.2, y=.3)))
    with store.engine.connect() as conn:
        assert conn.execute(select(spaces.c.state_json)).scalar_one() == '{"unknown":1}'


def test_clock_cannot_rewind_durable_state(world):
    plant(world)
    world[1][0] -= 1
    fails("conflict", lambda: world[0].read_space("alice", world[2]))


def test_new_engine_recovers_state_undo_and_receipts(world):
    store, clock, sid = world
    rid = str(uuid4())
    command = dict(action="place", kind="tree", x=.2, y=.3)
    first = store.execute("alice", sid, rid, 0, command)
    url = store.engine.url
    store.engine.dispose()
    engine = create_engine(url)
    try:
        restored = LivingStore(engine, lambda: clock[0])
        assert restored.read_space("alice", sid) == first
        assert restored.execute("alice", sid, rid, 0, command) == first
        assert restored.execute("alice", sid, str(uuid4()), 1, {"action": "undo"})["items"] == []
    finally:
        engine.dispose()


@pytest.mark.parametrize("missing", ["schema_version", "items", "undo"])
def test_partial_saved_state_is_rejected_without_repair(world, missing):
    tree = plant(world)
    store, _, sid = world
    act(world, "move", item_id=tree, x=.2, y=.1)
    act(world, "undo")  # An object may survive with no pending undo reference.
    revision = store.read_space("alice", sid)["revision"]
    with store.engine.begin() as conn:
        saved = json.loads(conn.execute(select(spaces.c.state_json)).scalar_one())
        del saved[missing]
        damaged = json.dumps(saved)
        conn.execute(update(spaces).values(state_json=damaged))
    fails("corrupt_state", lambda: store.read_space("alice", sid))
    fails("corrupt_state", lambda: store.execute("alice", sid, str(uuid4()), revision,
                                                {"action": "care", "item_id": tree}))
    with store.engine.connect() as conn:
        assert conn.execute(select(spaces.c.state_json)).scalar_one() == damaged


@pytest.mark.parametrize("missing", ["stored", "growth_seconds", "cared_until"])
def test_partial_saved_item_is_not_reset_to_defaults(world, missing):
    tree = plant(world)
    store, _, sid = world
    with store.engine.begin() as conn:
        saved = json.loads(conn.execute(select(spaces.c.state_json)).scalar_one())
        del saved["items"][tree][missing]
        conn.execute(update(spaces).values(state_json=json.dumps(saved)))
    fails("corrupt_state", lambda: store.read_space("alice", sid))


def test_partial_receipt_does_not_return_fabricated_defaults(world):
    store, _, sid = world
    request = str(uuid4())
    command = {"action": "place", "kind": "tree", "x": .2, "y": .3}
    original = store.execute("alice", sid, request, 0, command)
    del original["items"][0]["growth_seconds"]
    with store.engine.begin() as conn:
        conn.execute(update(receipts).values(result_json=json.dumps(original)))
    fails("corrupt_state", lambda: store.execute("alice", sid, request, 0, command))
    assert store.read_space("alice", sid)["revision"] == 1


def test_receipts_follow_space_deletion_at_database_level(world):
    plant(world)
    store, _, sid = world
    with store.engine.begin() as conn:
        conn.execute(delete(spaces).where(spaces.c.id == sid))
    with store.engine.connect() as conn:
        assert conn.execute(select(receipts)).first() is None


def test_initialize_errors_use_the_documented_error_shape(world, monkeypatch):
    from sqlalchemy.exc import OperationalError
    from app.living.store import metadata
    def fail(*args, **kwargs):
        raise OperationalError("CREATE TABLE", None, Exception("private storage details"))
    monkeypatch.setattr(metadata, "create_all", fail)
    fails("storage_unavailable", world[0].initialize)


def test_foreign_keys_cover_existing_pool_and_recreated_connections(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'pooled.db'}")
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        store = LivingStore(engine, lambda: 1000)
        store.initialize()
        sid = str(uuid4())
        store.create_space("alice", sid, "home", "shared")
        for restart in (False, True):
            if restart:
                engine.dispose()
            snapshot = store.read_space("alice", sid)
            store.execute("alice", sid, str(uuid4()), snapshot["revision"],
                          {"action": "place", "kind": "tree", "x": .2, "y": .3})
            with engine.connect() as conn:
                assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
        with engine.begin() as conn:
            conn.execute(delete(spaces).where(spaces.c.id == sid))
        with engine.connect() as conn:
            assert conn.execute(select(receipts)).first() is None
    finally:
        engine.dispose()


def test_unavailable_database_does_not_expose_path(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path}")  # A directory cannot be a SQLite file.
    try:
        store = LivingStore(engine)
        with pytest.raises(LivingError) as error:
            store.initialize()
        assert error.value.code == "storage_unavailable"
        assert str(tmp_path) not in str(error.value.as_dict())
        assert "CREATE TABLE" not in str(error.value.as_dict())
    finally:
        engine.dispose()
