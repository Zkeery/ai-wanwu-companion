import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.services.motion_assets import MotionAssetError, validate_motion_pack


@pytest.fixture
def pack(tmp_path):
    sprite = Image.new('RGBA', (128, 64), (255, 255, 255, 0))
    draw = ImageDraw.Draw(sprite)
    draw.rectangle((8, 8, 32, 32), fill=(255, 255, 255, 255))
    draw.rectangle((72, 8, 96, 32), fill=(255, 255, 255, 255))
    sprite.save(tmp_path / 'sprite.png')
    Image.new('RGB', (64, 64), (20, 30, 40)).save(tmp_path / 'background.png')
    data = dict(version='companion-motion-sprite-v1', source_sha256='a' * 64,
                frame_width=64, frame_height=64, frame_count=2, fps=12,
                sprite_file='sprite.png', background_file='background.png')
    for kind in ['sprite', 'background']:
        data[kind + '_sha256'] = hashlib.sha256((tmp_path / data[kind + '_file']).read_bytes()).hexdigest()
    (tmp_path / 'manifest.json').write_text(json.dumps(data))
    return tmp_path, data


def test_valid_pack_restores_in_another_process(pack):
    directory, data = pack
    assert validate_motion_pack(directory, 'a' * 64) == data
    code = 'from app.services.motion_assets import validate_motion_pack; from pathlib import Path; import json; print(json.dumps(validate_motion_pack(Path(' + repr(str(directory)) + '),"' + 'a' * 64 + '")))'
    r = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, check=True)
    assert json.loads(r.stdout) == data


@pytest.mark.parametrize('key,value', [('version', 'unknown'), ('frame_count', True), ('frame_count', 25),
    ('frame_width', 513), ('frame_height', 63), ('fps', 3), ('fps', 25), ('extra', 1),
    ('sprite_file', '../sprite.png'), ('sprite_file', '/sprite.png'), ('sprite_sha256', 'bad'),
    ('background_sha256', 'b' * 64), ('source_sha256', 'c' * 64)])
def test_invalid_manifest_is_rejected(pack, key, value):
    directory, data = pack
    data[key] = value
    (directory / 'manifest.json').write_text(json.dumps(data))
    with pytest.raises(MotionAssetError, match='动作资源不符合约定'):
        validate_motion_pack(directory, 'a' * 64)


@pytest.mark.parametrize('kind,size,mode,color', [('sprite', (64, 64), 'RGBA', (0, 0, 0, 0)),
    ('sprite', (128, 64), 'RGBA', (0, 0, 0, 255)), ('sprite', (128, 64), 'RGBA', (0, 0, 0, 0)),
    ('background', (64, 64), 'RGBA', (0, 0, 0, 0))])
def test_decoded_dimensions_and_transparency_are_checked(pack, kind, size, mode, color):
    directory, data = pack
    file = directory / data[kind + '_file']
    Image.new(mode, size, color).save(file)
    data[kind + '_sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
    (directory / 'manifest.json').write_text(json.dumps(data))
    with pytest.raises(MotionAssetError): validate_motion_pack(directory, 'a' * 64)


def test_symlinks_and_large_files_are_rejected(pack):
    directory, data = pack
    file = directory / 'sprite.png'
    file.rename(directory / 'original.png')
    file.symlink_to(directory / 'original.png')
    with pytest.raises(MotionAssetError): validate_motion_pack(directory, 'a' * 64)
    file.unlink()
    with file.open('wb') as handle: handle.truncate(10 * 1024 * 1024 + 1)
    with pytest.raises(MotionAssetError): validate_motion_pack(directory, 'a' * 64)


def test_false_png_and_manifest_errors_are_safe(pack):
    directory, data = pack
    (directory / 'sprite.png').write_bytes(b'not an image')
    data['sprite_sha256'] = hashlib.sha256(b'not an image').hexdigest()
    (directory / 'manifest.json').write_text(json.dumps(data))
    with pytest.raises(MotionAssetError): validate_motion_pack(directory, 'a' * 64)
    (directory / 'manifest.json').write_text('{bad')
    with pytest.raises(MotionAssetError): validate_motion_pack(directory, 'a' * 64)


def test_committed_hand_drawn_fixture_is_valid():
    folder = Path(__file__).resolve().parents[2] / 'frontend/public/motion-preview-assets'
    source = hashlib.sha256((folder / 'static.png').read_bytes()).hexdigest()
    assert validate_motion_pack(folder, source)['frame_count'] == 12
