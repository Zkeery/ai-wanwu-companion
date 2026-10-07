"""R5 additive theme attribution; safe to run repeatedly on existing databases."""
from sqlalchemy import inspect, text


def ensure_theme_columns(engine) -> None:
    additions = {"photos": ("theme_id", "TEXT"), "characters": ("theme_id", "TEXT"),
                 "objects": ("category", "TEXT NOT NULL DEFAULT 'unknown'")}
    with engine.begin() as connection:
        inspector = inspect(connection)
        tables = set(inspector.get_table_names())
        for table, (column, definition) in additions.items():
            if table in tables and column not in {c["name"] for c in inspector.get_columns(table)}:
                connection.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {definition}'))
