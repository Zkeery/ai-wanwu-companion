"""Resume the isolated 8043 preview with V1.2 flows; no real keys or model calls."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'v12-c13-preview'
sys.path.insert(0, str(PROJECT / 'backend'))


def main():
    from c13_life_preview import database_facts
    STATE.mkdir(parents=True, exist_ok=True)
    dbpath = STATE / 'preview.db'
    if dbpath.exists():
        backup = STATE / 'backups' / ('before-full-flow-' + str(uuid4()))
        backup.mkdir(parents=True)
        with sqlite3.connect(f'file:{dbpath}?mode=ro', uri=True) as source, sqlite3.connect(backup / 'preview.db') as dest:
            source.backup(dest)
            assert database_facts(source) == database_facts(dest)
            assert dest.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            facts = database_facts(dest)
        if (STATE / 'uploads').exists():
            shutil.copytree(STATE / 'uploads', backup / 'uploads')
            for file in (STATE / 'uploads').rglob('*'):
                if file.is_file():
                    assert file.read_bytes() == (backup / 'uploads' / file.relative_to(STATE / 'uploads')).read_bytes()
        (backup / 'manifest.json').write_text(json.dumps({'verified': True, 'tables': facts}))
    os.environ.update({
        'APP_ENV': 'test', 'DATABASE_URL': f'sqlite:///{dbpath}', 'UPLOAD_DIR': str(STATE / 'uploads'),
        'MODEL_API_KEY': '', 'MODEL_BASE_URL': '', 'IMAGE_BASE_URL': '', 'DEV_AUTH_TOKEN': '',
        'LEGACY_CLAIM_USER_ID': '', 'DEV_SMS_FIXED_CODE': '123456', 'GENERATION_QUOTA_ENABLED': 'false',
        'SCENE_AGENT_ENABLED': 'false', 'LIFE_RUNTIME_PREVIEW_ENABLED': 'true', 'LIFE_SIMULATION_ENABLED': 'false',
        'VOICE_LIVE_REPLY_ENABLED': 'false',
        'VOICE_LOCAL_MODEL_PATH': str(PROJECT / '.runtime' / 'models' / 'faster-whisper-small')
            if (PROJECT / '.runtime' / 'models' / 'faster-whisper-small').is_dir() else '',
    })
    from app.services.model_client import ModelClient
    from app.services.parsers import RecognizedObject
    def forbidden(*args, **kwargs):
        raise RuntimeError('Full-flow preview forbids external model calls')
    ModelClient._call_vision = forbidden
    ModelClient._post_chat_completions = forbidden
    ModelClient._call_image_generation = forbidden
    original_recognize = ModelClient.recognize
    preview_sample_digest = '362101360d3a66935ced94474275c17638b1aee9a5979667e140bde852e9a70a'

    def recognize_preview_sample(self, image_bytes):
        if hashlib.sha256(image_bytes).hexdigest() == preview_sample_digest:
            return [RecognizedObject(label='模拟苹果', category='fruit',
                                     visual_features='内置示意图的离线规则结果，非真实照片识别')]
        return original_recognize(self, image_bytes)

    ModelClient.recognize = recognize_preview_sample
    from app.main import app
    from app.core.database import SessionLocal
    from app.models.models import User, Photo, Object, Character
    with SessionLocal() as db:
        for phone, uid, names in [('13900000133', 'c13-life-fixture', ('生活小杯', '叶子伙伴')),
                                  ('13900000134', 'full-flow-friend', ('好友小石', '森林松果'))]:
            user = db.query(User).filter_by(phone=phone).first()
            if not user:
                user = User(id=uid, phone=phone)
                db.add(user)
                db.flush()
            existing = db.query(Character).filter_by(owner_id=user.id).order_by(Character.id).all()
            for index, name in enumerate(names):
                if index < len(existing):
                    ch = existing[index]
                else:
                    photo = Photo(owner_id=user.id, filename='full-flow-fixture.png', status='done')
                    db.add(photo); db.flush()
                    obj = Object(photo_id=photo.id, label=name)
                    db.add(obj); db.flush()
                    ch = Character(object_id=obj.id, owner_id=user.id, name=name, persona='温柔、好奇的合成测试伙伴',
                        opening_line='一起度过今天吧。', status='ready')
                    db.add(ch)
                if not ch.image_path:
                    ch.image_path = ModelClient()._mock_image(ch.name)
            db.commit()
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8043, access_log=False)


if __name__ == '__main__':
    main()
