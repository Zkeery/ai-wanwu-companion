from fastapi import APIRouter
from app.services.themes import THEMES

router = APIRouter(prefix="/themes", tags=["themes"])


@router.get("")
def list_themes():
    return list(THEMES.values())
