"""Scene rules. No model calls, wall-clock reads, database or app configuration."""
from __future__ import annotations

from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

DAY = 86400
TREE_MATURITY = 3 * DAY
ItemKind = Literal["tree", "bench", "shade", "cushion", "flower", "mushroom", "pond", "campfire", "fireflies", "palm", "cactus", "rock", "tea_table", "tent", "string_lights", "sign", "flowerpot"]
DESERT_KINDS = ("palm", "cactus", "rock", "pond", "shade", "cushion", "tea_table", "tent", "string_lights", "sign", "bench", "flowerpot")
LAYOUTS = {
 "water": [("palm",23,56),("pond",35,73),("shade",72,57),("tea_table",70,72),("cushion",80,79),("cactus",12,79),("flowerpot",85,57),("rock",46,60),("bench",26,88),("sign",83,90)],
 "camp": [("palm",20,58),("tent",37,60),("string_lights",70,47),("tea_table",65,71),("cushion",72,80),("cushion",54,76),("flowerpot",45,89),("cactus",86,65),("rock",13,81),("sign",82,91)]
}
CATALOG = {
    "home": {"name": "家庭庭院", "items": ("tree", "bench", "flower", "mushroom", "pond", "campfire", "fireflies")},
    "desert": {"name": "沙漠绿洲", "items": ("tree", *DESERT_KINDS)},
    "forest": {"name": "林间营地", "items": ("tree", "cushion")},
}
Coordinate = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
Identifier = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
Timestamp = Annotated[int, Field(ge=0)]


class LivingError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message

    def as_dict(self) -> dict:
        return {"error": {"code": self.code, "message": self.message}}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Item(StrictModel):
    id: Identifier
    kind: ItemKind
    x: Coordinate
    y: Coordinate
    stored: bool = False
    flipped: bool = False
    growth_seconds: Annotated[int, Field(ge=0, le=TREE_MATURITY)] = 0
    settled_at: Timestamp
    cared_until: Timestamp = 0

    @model_validator(mode="after")
    def furniture_has_no_growth(self):
        if self.kind != "tree" and (self.growth_seconds or self.cared_until):
            raise ValueError("furniture cannot grow")
        return self


class Undo(StrictModel):
    action: Literal["place", "move", "store", "restore"]
    item_id: Identifier
    x: Coordinate
    y: Coordinate
    stored: bool


class Placement(StrictModel):
    x: Coordinate
    y: Coordinate
    stored: bool
    flipped: bool


class LayoutUndo(StrictModel):
    action: Literal["layout"]
    previous: dict[Identifier, Placement]
    added: list[Identifier]


class TurnUndo(StrictModel):
    action: Literal["turn"]
    item_id: Identifier
    flipped: bool


class Atmosphere(StrictModel):
    rain: bool = False
    sound: bool = True


class AtmosphereUndo(StrictModel):
    action: Literal["atmosphere"]
    previous: Atmosphere


class State(StrictModel):
    schema_version: Literal[2] = 2
    last_write_at: Timestamp
    items: dict[Identifier, Item] = Field(default_factory=dict)
    undo: Undo | AtmosphereUndo | LayoutUndo | TurnUndo | None = None
    atmosphere: Atmosphere = Field(default_factory=Atmosphere)

    @model_validator(mode="after")
    def consistent_items(self):
        if any(key != item.id or item.settled_at != self.last_write_at
               for key, item in self.items.items()):
            raise ValueError("inconsistent object identity or clock")
        if isinstance(self.undo, (Undo, TurnUndo)) and self.undo.item_id not in self.items:
            raise ValueError("undo target missing")
        if isinstance(self.undo, LayoutUndo):
            if (set(self.undo.previous) & set(self.undo.added) or
                    len(set(self.undo.added)) != len(self.undo.added) or
                    set(self.undo.previous) | set(self.undo.added) != set(self.items)):
                raise ValueError("inconsistent layout undo")
        return self


class DisplayItem(Item):
    stage: Literal["planted", "growing", "mature"] | None
    care_remaining_seconds: Timestamp | None
    growth_status: Literal["mature", "stored", "growing", "needs_care"] | None


class Snapshot(StrictModel):
    id: Identifier
    scene_type: Literal["home", "desert", "forest"]
    mode: Literal["private", "shared"]
    companion_id: str | None
    revision: Annotated[int, Field(ge=0)]
    observed_at: Timestamp
    items: list[DisplayItem]
    can_undo: bool
    atmosphere: Atmosphere = Field(default_factory=Atmosphere)


class Place(StrictModel):
    action: Literal["place"]
    kind: ItemKind
    x: Coordinate
    y: Coordinate


class Target(StrictModel):
    item_id: Identifier


class Care(Target):
    action: Literal["care"]


class Store(Target):
    action: Literal["store"]


class Move(Target):
    action: Literal["move", "restore"]
    x: Coordinate
    y: Coordinate


class UndoCommand(StrictModel):
    action: Literal["undo"]


class AtmosphereCommand(StrictModel):
    action: Literal["atmosphere"]
    weather: Literal["rain", "clear", "quiet"]


class Turn(Target):
    action: Literal["turn"]


class Layout(StrictModel):
    action: Literal["layout"]
    template: Literal["water", "camp"]


Command = TypeAdapter(Annotated[Place | Care | Store | Move | UndoCommand | AtmosphereCommand | Turn | Layout,
                                Field(discriminator="action")])


def settle(state: State, now: int) -> State:
    """Project growth from a durable anchor, never from the previous GET."""
    if now < state.last_write_at:
        raise LivingError("conflict", "服务端时间早于已保存状态，请稍后重试")
    result = state.model_copy(deep=True)
    for item in result.items.values():
        if item.kind == "tree" and not item.stored:
            elapsed = max(0, min(now, item.cared_until) - item.settled_at)
            item.growth_seconds = min(TREE_MATURITY, item.growth_seconds + elapsed)
        item.settled_at = now
    result.last_write_at = now
    return result


def apply(state: State, scene_type: str, command: StrictModel, now: int) -> State:
    result = settle(state, now)
    action = command.action
    if action == "undo":
        undo = result.undo
        if undo is None:
            raise LivingError("invalid_action", "当前没有可撤销的布置操作")
        if isinstance(undo, AtmosphereUndo):
            result.atmosphere = undo.previous.model_copy(deep=True)
        elif isinstance(undo, LayoutUndo):
            for key in undo.added:
                del result.items[key]
            for key, previous in undo.previous.items():
                item = result.items[key]
                item.x, item.y, item.stored, item.flipped = previous.x, previous.y, previous.stored, previous.flipped
        elif isinstance(undo, TurnUndo):
            result.items[undo.item_id].flipped = undo.flipped
        else:
            item = result.items[undo.item_id]
            if undo.action == "place":
                del result.items[item.id]
            else:
                item.x, item.y, item.stored = undo.x, undo.y, undo.stored
        result.undo = None
    elif action == "atmosphere":
        if scene_type != "home":
            raise LivingError("invalid_action", "这个场景暂不支持庭院天气")
        result.undo = AtmosphereUndo(action="atmosphere", previous=result.atmosphere.model_copy(deep=True))
        if command.weather == "rain":
            result.atmosphere = Atmosphere(rain=True, sound=True)
        elif command.weather == "clear":
            result.atmosphere.rain = False
        else:
            result.atmosphere.sound = False
    elif action == "layout":
        if scene_type != "desert":
            raise LivingError("invalid_action", "这个场景暂不支持绿洲方案")
        if len(result.items) + len(LAYOUTS[command.template]) > 200:
            raise LivingError("invalid_action", "物件已达上限，请先使用已有物件布置")
        previous = {key: Placement(x=i.x, y=i.y, stored=i.stored, flipped=i.flipped) for key, i in result.items.items()}
        for item in result.items.values():
            item.stored = True
        added = []
        for kind, x, y in LAYOUTS[command.template]:
            item = Item(id=str(uuid4()), kind=kind, x=(x-9)/82, y=(y-44)/49, settled_at=now)
            result.items[item.id] = item
            added.append(item.id)
        result.undo = LayoutUndo(action="layout", previous=previous, added=added)
    elif action == "place":
        if command.kind not in CATALOG[scene_type]["items"]:
            raise LivingError("invalid_action", "这个场景暂不支持该物件")
        if scene_type == "desert" and command.kind in DESERT_KINDS and len(result.items) >= 200:
            raise LivingError("invalid_action", "物件已达上限，请先使用已有物件布置")
        item = Item(id=str(uuid4()), kind=command.kind, x=command.x, y=command.y,
                    settled_at=now)
        result.items[item.id] = item
        result.undo = Undo(action="place", item_id=item.id, x=item.x, y=item.y,
                           stored=False)
    else:
        item = result.items.get(command.item_id)
        if item is None:
            raise LivingError("not_found", "当前空间没有这个物件")
        if action == "turn":
            if scene_type != "desert" or item.stored:
                raise LivingError("invalid_action", "只能转向绿洲中已摆出的物件")
            result.undo = TurnUndo(action="turn", item_id=item.id, flipped=item.flipped)
            item.flipped = not item.flipped
        elif action == "care":
            if item.kind != "tree" or item.stored:
                raise LivingError("invalid_action", "只能照料已摆出的植物")
            item.cared_until = now + DAY
            # Care is independent of placement history and must never be undone.
        else:
            if (action == "restore") != item.stored:
                raise LivingError("invalid_action", "物件当前状态不支持此操作")
            result.undo = Undo(action=action, item_id=item.id, x=item.x, y=item.y,
                               stored=item.stored)
            if action in ("move", "restore"):
                item.x, item.y = command.x, command.y
            item.stored = action == "store"
    return State.model_validate(result.model_dump())


def public_items(state: State) -> list[dict]:
    result = []
    for item in state.items.values():
        value = item.model_dump()
        value["stage"] = (None if item.kind != "tree" else
                          "mature" if item.growth_seconds == TREE_MATURITY else
                          "growing" if item.growth_seconds else "planted")
        value["care_remaining_seconds"] = (
            max(0, item.cared_until - state.last_write_at) if item.kind == "tree" else None
        )
        value["growth_status"] = (None if item.kind != "tree" else
                                  "mature" if value["stage"] == "mature" else
                                  "stored" if item.stored else
                                  "growing" if value["care_remaining_seconds"] else
                                  "needs_care")
        result.append(value)
    return result
