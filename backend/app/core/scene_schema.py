"""Additive, idempotent upgrade for existing scene bindings."""
from sqlalchemy import inspect, text


def ensure_scene_columns(engine) -> None:
    additions = {
        "characters": [("location_epoch", "INTEGER NOT NULL DEFAULT 0")],
        "scene_proposals": [("space_id", "TEXT"), ("space_revision", "INTEGER"), ("location_epoch", "INTEGER")],
    }
    with engine.begin() as connection:
        inspector = inspect(connection)
        tables = set(inspector.get_table_names())
        for table, columns in additions.items():
            if table not in tables:
                continue
            existing = {c["name"] for c in inspector.get_columns(table)}
            for column, definition in columns:
                if column not in existing:
                    # Identifiers and definitions are constants, never request input.
                    connection.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {definition}'))
