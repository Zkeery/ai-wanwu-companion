"""Additive, idempotent upgrade for existing creation records."""
from sqlalchemy import inspect, text


def ensure_generation_columns(engine) -> None:
    additions = {
        "objects": [("visual_features", "TEXT NOT NULL DEFAULT ''"), ("character_concept_json", "TEXT")],
        "characters": [("generation_brief_json", "TEXT")],
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
