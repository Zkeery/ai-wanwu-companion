"""Run a separate C1.6 preview on port 8044, with zero model budget by default."""
import os
from pathlib import Path
import shutil
import sqlite3
import sys
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'c16-life-live-preview'
sys.path.insert(0, str(PROJECT / 'backend'))


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    database = STATE / 'preview.db'
    if database.exists():
        backup = STATE / 'backups' / ('before-start-' + str(uuid4()))
        backup.mkdir(parents=True)
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as source, sqlite3.connect(backup / 'preview.db') as dest:
            source.backup(dest)
            if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('隔离试用备份校验失败；服务未启动')
        if (STATE / 'uploads').exists():
            shutil.copytree(STATE / 'uploads', backup / 'uploads')

    os.environ.update({
        'APP_ENV': 'test', 'DATABASE_URL': f'sqlite:///{database}', 'UPLOAD_DIR': str(STATE / 'uploads'),
        'MODEL_BASE_URL': 'https://maas-api.antdigital.com/v1', 'CHAT_MODEL': 'qwen3.8-flash',
        'DEV_AUTH_TOKEN': '', 'LEGACY_CLAIM_USER_ID': '', 'DEV_SMS_FIXED_CODE': '123456',
        'GENERATION_QUOTA_ENABLED': 'false', 'SCENE_AGENT_ENABLED': 'false',
        'LIFE_RUNTIME_PREVIEW_ENABLED': 'true', 'LIFE_LIVE_PLANNER_PREVIEW_ENABLED': 'true',
        'LIFE_SIMULATION_ENABLED': 'false', 'VOICE_LIVE_REPLY_ENABLED': 'false',
    })

    from app.services.model_client import ModelClient
    def forbidden(*_args, **_kwargs):
        raise RuntimeError('隔离生活试用不允许其他模型流程调用')
    ModelClient._call_vision = forbidden
    ModelClient._post_chat_completions = forbidden
    ModelClient._call_image_generation = forbidden

    from app.main import app
    from app.core.database import SessionLocal
    from app.models.models import Character, Object, Photo, User
    with SessionLocal() as db:
        user = db.query(User).filter_by(phone='13900000136').first()
        if not user:
            user = User(id='c16-life-fixture', phone='13900000136')
            db.add(user)
            db.flush()
        companion = db.query(Character).filter_by(owner_id=user.id, name='小满').first()
        if not companion:
            photo = Photo(owner_id=user.id, filename='c16-synthetic-fixture.png', status='done')
            db.add(photo)
            db.flush()
            obj = Object(photo_id=photo.id, label='合成小杯子')
            db.add(obj)
            db.flush()
            companion = Character(object_id=obj.id, owner_id=user.id, name='小满',
                                  persona='温柔、好奇的合成测试伙伴', opening_line='一起度过今天吧。', status='ready')
            db.add(companion)
        if not companion.image_path:
            companion.image_path = ModelClient()._mock_image(companion.name)
        db.commit()

    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8044, access_log=False)


if __name__ == '__main__':
    main()
