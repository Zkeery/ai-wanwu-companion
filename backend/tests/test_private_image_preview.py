from io import BytesIO
from pathlib import Path
from uuid import uuid4
from PIL import Image
import pytest
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character
from tests.test_release_security import other_account

@pytest.fixture
def portrait(ready_character_id):
    root=Path(get_settings().upload_dir);root.mkdir(parents=True,exist_ok=True)
    path=root/(str(uuid4())+'.png')
    with Image.effect_noise((1024,1024),60).convert('RGB') as image:
        image.save(path,format='PNG')
    with SessionLocal() as db:
        db.get(Character,ready_character_id).image_path=path.name;db.commit()
    return path, '/uploads/'+path.name

def test_preview_is_smaller_and_original_file_and_get_stay_exact(client,portrait):
    path,url=portrait;original=path.read_bytes()
    result=client.get(url+'?preview=true')
    assert result.status_code==200 and result.headers['content-type']=='image/webp'
    assert len(result.content)<len(original)
    with Image.open(BytesIO(result.content)) as image:
        assert image.size==(768,768)
    assert path.read_bytes()==original and client.get(url).content==original
    assert 'no-store' in result.headers['cache-control']
    assert result.headers['x-content-type-options']=='nosniff'

def test_preview_keeps_authentication_and_ownership_checks(client,anon,portrait):
    _,url=portrait;_,headers=other_account()
    assert anon.get(url+'?preview=true').status_code==401
    assert client.get(url+'?preview=true',headers=headers).status_code==404
    assert client.get('/uploads/missing.png?preview=true').status_code==404

def test_preview_failure_falls_back_without_touching_source(client,portrait):
    path,url=portrait;path.write_bytes(b'not-decodable-but-preserved')
    response=client.get(url+'?preview=true')
    assert response.status_code==200 and response.content==path.read_bytes()

def test_preview_preserves_alpha(client,portrait):
    path,url=portrait
    with Image.effect_noise((1024,1024),60).convert('RGBA') as image:
        image.putalpha(100);image.save(path,format='PNG')
    response=client.get(url+'?preview=true')
    with Image.open(BytesIO(response.content)) as image:
        assert image.getpixel((10,10))[3]==100

def test_preview_does_not_decode_images_above_pixel_bound(client,portrait,monkeypatch):
    from app.api import private_images
    path,url=portrait
    with Image.new('RGB',(2049,2049),'beige') as image:image.save(path,format='PNG')
    def forbidden(*args,**kwargs):raise AssertionError('must not transform above bound')
    monkeypatch.setattr(private_images.ImageOps,'exif_transpose',forbidden)
    response=client.get(url+'?preview=true')
    assert response.status_code==200 and response.content==path.read_bytes()


def test_gathering_card_uses_small_preview_after_membership_check(client, anon, portrait, ready_character_id):
    path, url = portrait
    original = path.read_bytes()
    base = '/api/v1/gatherings'
    group = client.post(base, json=dict(request_id=str(uuid4()), title='预览联测',
        display_name='主人', scene_type='home')).json()
    def command(group, action, headers=None, **values):
        response = client.post(f'{base}/{group["id"]}/commands', headers=headers,
            json=dict(request_id=str(uuid4()), expected_revision=group['revision'],
                      command=dict(action=action, **values)))
        assert response.status_code == 200
        return response.json()
    group = command(group, 'visit', character_id=ready_character_id)
    image_url = f'{base}/{group["id"]}/companions/{ready_character_id}/image'
    _, other = other_account()
    assert anon.get(image_url).status_code == 401
    assert client.get(image_url, headers=other).status_code == 404
    group = command(group, 'invite')
    joined = client.post(base+'/invitations/join', headers=other,
        json=dict(request_id=str(uuid4()), token=group['invitation'], display_name='访客'))
    assert joined.status_code == 200
    group = joined.json()
    response = client.get(image_url, headers=other)
    assert response.status_code == 200 and response.headers['content-type'] == 'image/webp'
    assert len(response.content) < 65536 and len(response.content) < len(original)
    with Image.open(BytesIO(response.content)) as image:
        assert image.size == (256, 256)
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['vary'] == 'Authorization'
    assert response.headers['x-content-type-options'] == 'nosniff'
    command(group, 'leave', headers=other)
    assert client.get(image_url, headers=other).status_code == 404
    assert path.read_bytes() == original and client.get(url).content == original
