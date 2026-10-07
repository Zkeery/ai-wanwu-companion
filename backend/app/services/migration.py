"""R2 旧花园迁移：显式认领后把旧单花园转换为家庭庭院私人空间。

- 不自动把旧数据分给任何账号；由登录用户在认领动作中显式归属。
- 实体物件（树/花/蘑菇/水池/长椅/营火/萤火虫）按真实数量迁移，超限存档不裁剪；
  天气与声音同步到新庭院；旧 JSON 及其历史继续保留。
- 旧撤销记录保留在原表；迁移后的 living 空间从空撤销开始。
"""
from __future__ import annotations

from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.living.store import LivingStore, spaces as living_spaces
from app.models.models import Character, SceneState
from app.services import scene as scene_service

_ENTITY_MAP = {
    "tree": "tree", "bench": "bench", "flower": "flower", "mushroom": "mushroom",
    "pond": "pond", "campfire": "campfire", "fireflies": "fireflies",
}

_BASE_COORDS = {
    "tree": (0.2, 0.3), "bench": (0.5, 0.85), "flower": (0.6, 0.25),
    "mushroom": (0.4, 0.55), "pond": (0.72, 0.5), "campfire": (0.5, 0.5),
    "fireflies": (0.3, 0.75),
}


def _coords(kind: str, index: int) -> tuple[float, float]:
    x, y = _BASE_COORDS[kind]
    return (round(min(0.95, x + (index % 5) * 0.12), 4),
            round(min(0.95, y + (index // 5) * 0.12), 4))


def _has_home_private_space(store: LivingStore, owner_id: str, companion_id: str) -> bool:
    with store.engine.connect() as conn:
        row = conn.execute(select(living_spaces).where(
            living_spaces.c.owner_id == owner_id,
            living_spaces.c.mode == "private",
            living_spaces.c.companion_id == companion_id,
            living_spaces.c.scene_type == "home",
        )).mappings().first()
    return row is not None


def migrate_scene_to_living(db: Session, store: LivingStore, owner_id: str,
                            character: Character) -> bool:
    """Claim and import share the caller transaction; no partially migrated garden."""
    from app.models.models import SceneImport
    from app.services.scene_bridge import ensure_home
    if character.status != "ready" or db.get(SceneImport, character.id) is not None:
        return False
    if db.query(SceneState).filter_by(character_id=character.id).first() is None:
        return False
    row = ensure_home(db, store, character, create=True)
    character.current_space_id = row["id"]
    character.location_epoch += 1
    return True
