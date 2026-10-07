"""Copy the real apple into an existing user's isolated 8048 QA account.

Default is read-only. This never changes ownership of an existing character.
"""
import argparse
import hashlib
import json
import shutil

from scripts import check_candidate_review as qa
from app.models.models import CharacterActivityMotionAsset
from app.services.motion_bindings import pack_directory
from app.services.motion_preparation import submit_prepared_pack


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner-character-id', type=int, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    qa.flow.generate = qa.flow.dotenv_values = qa.reject_generation
    with qa.SessionLocal() as db:
        anchor = db.get(qa.Character, args.owner_character_id)
        original = db.get(qa.Character, 2)
        if (anchor is None or not anchor.owner_id or anchor.owner_id == qa.OWNER
                or original is None or original.owner_id != qa.OWNER):
            raise RuntimeError('Expected isolated QA accounts are unavailable')
        binding = db.get(CharacterActivityMotionAsset, (2, 'walk'))
        if binding is None:
            raise RuntimeError('Real walk is not ready')
        source = qa.ROOT / 'uploads' / original.image_path
        if hashlib.sha256(source.read_bytes()).hexdigest() != binding.source_sha256:
            raise RuntimeError('Source changed')
        owner = anchor.owner_id
        filename = f'c162-live-apple-{hashlib.sha256(owner.encode()).hexdigest()[:16]}.jpg'
        copy = db.query(qa.Character).filter_by(owner_id=owner, image_path=filename).one_or_none()
        result = {'owner_character_id': anchor.id, 'existing_copy_id': copy.id if copy else None,
                  'source_character_id': 2, 'activity': 'walk', 'new_model_requests': 0}
        if not args.apply:
            print(json.dumps({**result, 'written': False}))
            return
        target = qa.ROOT / 'uploads' / filename
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() != binding.source_sha256:
                raise RuntimeError('Existing copy differs')
        else:
            shutil.copyfile(source, target)
        if copy is None:
            photo = qa.Photo(filename=filename, status='done', owner_id=owner)
            db.add(photo)
            db.flush()
            obj = qa.Object(photo_id=photo.id, label='本次真实苹果动作验收')
            db.add(obj)
            db.flush()
            copy = qa.Character(object_id=obj.id, owner_id=owner, image_path=filename,
                                status='ready', name='苹果散步·真实验收',
                                persona='真实生成的苹果伙伴动作体验', opening_line='来看看我的散步动作吧。')
            db.add(copy)
            db.commit()
            db.refresh(copy)
        queue = submit_prepared_pack(db, copy.id, owner, pack_directory(binding.pack_id), 'walk', apply=True)
        print(json.dumps({**result, 'written': True, 'character_id': copy.id, 'queue': queue}))


if __name__ == '__main__':
    main()
