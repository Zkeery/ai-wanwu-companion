"""Real codecs and API boundaries; model calls are captured, never paid."""
from io import BytesIO
from uuid import uuid4

import pytest
from PIL import Image, PngImagePlugin

from app.core.database import SessionLocal
from app.models.models import Object, Photo, PhotoRequest
from app.services.model_client import ModelClient, RecognizedObject
from app.services.photo_input import normalize_photo


def encoded(fmt="PNG", size=(48, 32), mode="RGB", color="red", **options):
    output = BytesIO()
    with Image.new(mode, size, color) as image:
        image.save(output, format=fmt, **options)
    return output.getvalue()


def post(client, data, key=None, name="photo.png"):
    return client.post("/api/v1/photos", files={"file": (name, data, "image/png")},
                       headers={"Idempotency-Key": key or str(uuid4())})


@pytest.mark.parametrize("fmt,name", [("PNG", "photo.png"), ("JPEG", "photo.jpg"),
                                     ("WEBP", "photo.webp"), ("HEIF", "photo.heic"),
                                     ("HEIF", "photo.heif")])
def test_real_formats_reach_model_as_metadata_free_jpeg(client, monkeypatch, fmt, name):
    calls = []
    def capture(self, data):
        with Image.open(BytesIO(data)) as image:
            image.load()
            assert image.format == "JPEG" and image.size == (48, 32)
            assert not image.getexif() and not image.info.get("xmp")
        calls.append(data)
        return [RecognizedObject(label="杯子")]
    monkeypatch.setattr(ModelClient, "recognize", capture)
    response = post(client, encoded(fmt), name=name)
    assert response.status_code == 201
    assert len(calls) == 1


@pytest.mark.parametrize("data,code", [
    (b"\x89PNG\r\n\x1a\ninvalid", "invalid_image"),
    (b"\xff\xd8\xffinvalid", "invalid_image"),
    (b"RIFF0000WEBPinvalid", "invalid_image"),
    (b"0000ftypheicinvalid", "invalid_image"),
    (b"<svg>not a photo</svg>", "invalid_type"),
    (b"", "invalid_type"),
])
def test_bad_images_never_call_model_or_create_rows(client, monkeypatch, data, code):
    calls = []
    monkeypatch.setattr(ModelClient, "recognize", lambda *_: calls.append(1))
    response = post(client, data)
    assert response.status_code == 400 and response.json()["error"]["code"] == code
    assert calls == []
    with SessionLocal() as db:
        assert all(db.query(model).count() == 0 for model in (PhotoRequest, Photo, Object))


@pytest.mark.parametrize("size,allowed", [((4096, 1), True), ((4097, 1), False), ((1, 4097), False)])
def test_edge_limit_before_model(client, monkeypatch, size, allowed):
    calls = []
    monkeypatch.setattr(ModelClient, "recognize", lambda *args: calls.append(1) or [RecognizedObject(label="杯子")])
    response = post(client, encoded(size=size))
    assert response.status_code == (201 if allowed else 400)
    assert len(calls) == int(allowed)
    if not allowed:
        assert response.json()["error"]["code"] == "image_dimensions"


def test_truncated_pixel_data_fails_before_model(client, monkeypatch):
    calls = []
    monkeypatch.setattr(ModelClient, "recognize", lambda *_: calls.append(1))
    jpeg = encoded("JPEG", size=(200, 200))
    response = post(client, jpeg[:-100])
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_image"
    assert calls == []


@pytest.mark.parametrize("fmt", ["PNG", "WEBP"])
def test_animation_rejected(client, monkeypatch, fmt):
    calls = []
    monkeypatch.setattr(ModelClient, "recognize", lambda *_: calls.append(1))
    with Image.new("RGB", (16, 16), "blue") as second:
        response = post(client, encoded(fmt, size=(16, 16), save_all=True, append_images=[second], duration=100, loop=0))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "animated_image"
    assert calls == []


def test_heif_container_uses_primary_image():
    with Image.new("RGB", (32, 48), "blue") as primary:
        data = encoded("HEIF", save_all=True, append_images=[primary], primary_index=1)
    with Image.open(BytesIO(normalize_photo(data))) as image:
        assert image.size == (32, 48)
        assert image.getpixel((8, 8))[2] > 240


def test_orientation_and_metadata_are_normalized():
    exif = Image.Exif()
    exif[274] = 6
    exif[270] = "private description"
    data = encoded("JPEG", exif=exif, comment=b"private", icc_profile=b"private profile")
    with Image.open(BytesIO(normalize_photo(data))) as image:
        assert image.size == (32, 48)
        assert not image.getexif()
        assert not any(key in image.info for key in ("exif", "xmp", "icc_profile", "comment"))


def test_transparent_pixels_have_white_background():
    with Image.open(BytesIO(normalize_photo(encoded(mode="RGBA", color=(0, 0, 0, 0))))) as image:
        assert image.getpixel((0, 0)) == (255, 255, 255)


def test_normalized_output_size_failure_has_no_model_call(client, monkeypatch):
    calls = []
    monkeypatch.setattr("app.services.photo_input.MAX_NORMALIZED_SIZE", 10)
    monkeypatch.setattr(ModelClient, "recognize", lambda *_: calls.append(1))
    response = post(client, encoded())
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "normalized_too_large"
    assert calls == []


def test_decompression_bomb_rejected_before_model(client, monkeypatch):
    calls = []
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 10)
    monkeypatch.setattr(ModelClient, "recognize", lambda *_: calls.append(1))
    response = post(client, encoded())
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "image_dimensions"
    assert calls == []


def test_idempotency_digest_stays_bound_to_original_bytes(client, monkeypatch):
    calls = []
    monkeypatch.setattr(ModelClient, "recognize", lambda *args: calls.append(1) or [RecognizedObject(label="杯子")])
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("private", "metadata")
    first, second = encoded(), encoded(pnginfo=metadata)
    assert first != second and normalize_photo(first) == normalize_photo(second)
    key = str(uuid4())
    response = post(client, first, key)
    assert response.status_code == 201
    assert post(client, first, key).json() == response.json()
    assert post(client, second, key).status_code == 409
    assert len(calls) == 1


def test_heif_receipt_recovers_in_fresh_process(client):
    import json
    import os
    from pathlib import Path
    import subprocess
    import sys
    key = str(uuid4())
    created = post(client, encoded("HEIF"), key)
    assert created.status_code == 201
    script = f"""
import json
from fastapi.testclient import TestClient
from app.main import app
with TestClient(app, headers={{"Authorization": "Bearer test-token-for-local-tests-only"}}) as client:
    print(json.dumps(client.get('/api/v1/photos/requests/{key}').json()))
"""
    run = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1],
                         env=os.environ.copy(), capture_output=True, text=True, check=True)
    assert json.loads(run.stdout) == {"status": "ready", "photo": created.json()}
