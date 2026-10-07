"""Persisted text-only concepts bound to one object's confirmed visual facts."""
import json

from app.services.parsers import Persona, ParseError, parse_character_profile

VERSION = 'photo-concept-v1'


def save_concept(label: str, visual_features: str, persona: Persona) -> str | None:
    if persona.opening_line is None:
        return None  # Preserve the optional legacy split pipeline.
    return json.dumps({
        'version': VERSION,
        'source': {'label': label, 'visual_features': visual_features},
        'concept': {'name': persona.name, 'persona': persona.persona,
                    'opening_line': persona.opening_line,
                    'appearance_description': persona.appearance_description},
    }, ensure_ascii=False)


def matching_concept(raw: str | None, label: str, visual_features: str) -> Persona | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get('version') != VERSION:
            return None
        if data.get('source') != {'label': label, 'visual_features': visual_features}:
            return None
        return parse_character_profile(json.dumps(data['concept'], ensure_ascii=False))
    except (ValueError, TypeError, KeyError, ParseError):
        return None  # Old or unusable cache needs a fresh, validated concept.
