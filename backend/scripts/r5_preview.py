"""Offline R5.1 browser fixture. Never loads real providers or the main database.

Run from the project: backend/.venv/bin/python backend/scripts/r5_preview.py
Red synthetic sample -> fruit; blue sample -> cup. This is not image recognition.
"""
import os
import sys
from io import BytesIO
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / ".runtime" / "r5-preview"
STATE.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(PROJECT / "backend"))
os.environ.update({
    "DATABASE_URL": f"sqlite:///{STATE / 'preview.db'}",
    "UPLOAD_DIR": str(STATE / "uploads"),
    "MODEL_API_KEY": "", "MODEL_BASE_URL": "", "IMAGE_BASE_URL": "",
    "DEV_AUTH_TOKEN": "", "DEV_SMS_FIXED_CODE": "123456",
    "GENERATION_QUOTA_ENABLED": "false", "SCENE_AGENT_ENABLED": "false",
})

from PIL import Image
from app.services.model_client import ModelClient
from app.services.parsers import RecognizedObject


def recognize_sample(self, data):
    with Image.open(BytesIO(data)).convert("RGB") as image:
        r, _, b = image.getpixel((0, 0))
    return [RecognizedObject(label="苹果" if r > b else "杯子",
                             category="fruit" if r > b else "object",
                             visual_features="离线测试素材，不代表真实识别结果")]


ModelClient.recognize = recognize_sample
for name, color in [("fruit-sample.png", (225, 90, 110)), ("cup-sample.png", (100, 130, 230))]:
    with Image.new("RGB", (120, 120), color) as image:
        image.save(STATE / name)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="127.0.0.1", port=8035)
