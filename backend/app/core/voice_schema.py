"""Additive provenance for archived voice rounds; old fixtures stay fixtures."""
from sqlalchemy import inspect, text


def ensure_voice_columns(engine):
    with engine.begin() as connection:
        inspector = inspect(connection)
        table = 'companion_voice_rounds'
        if inspector.has_table(table) and 'origin' not in {c['name'] for c in inspector.get_columns(table)}:
            connection.execute(text("ALTER TABLE companion_voice_rounds ADD COLUMN origin VARCHAR(32) NOT NULL DEFAULT 'offline_fixture'"))
