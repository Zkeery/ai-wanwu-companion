import hashlib
import json
import sqlite3

import pytest

from scripts import prepare_manan_motion as script


@pytest.fixture
def source(tmp_path, monkeypatch):
    data = tmp_path / 'data'
    (data / 'uploads').mkdir(parents=True)
    image = data / 'uploads' / 'synthetic.png'
    image.write_bytes(b'synthetic adopted image')
    digest = hashlib.sha256(image.read_bytes()).hexdigest()
    monkeypatch.setattr(script, 'IMAGE_SHA256', digest)
    with sqlite3.connect(data / 'check.db') as db:
        db.execute('CREATE TABLE characters (id INTEGER PRIMARY KEY, owner_id TEXT, image_path TEXT, status TEXT)')
        db.execute("INSERT INTO characters VALUES (9, 'synthetic-owner', 'synthetic.png', 'ready')")
    review = tmp_path / 'review.json'
    review.write_text(json.dumps(dict(status='accepted', user_reply='采用', accepted_character_id=9, image_sha256=digest)))
    return data, review, image


def test_adopted_source_can_be_read_without_business_changes(source):
    data, review, image = source
    before = (data / 'check.db').read_bytes()
    assert script.approved_source(data, review) == ('synthetic-owner', image)
    assert (data / 'check.db').read_bytes() == before


@pytest.mark.parametrize('fault', ['unaccepted', 'different_character', 'changed_image', 'symlink'])
def test_refuse_wrong_approval_or_changed_source(source, fault):
    data, review, image = source
    accepted = json.loads(review.read_text())
    if fault == 'unaccepted':
        accepted['status'] = 'needs_review'
    elif fault == 'different_character':
        accepted['accepted_character_id'] = 8
    elif fault == 'changed_image':
        image.write_bytes(b'changed image')
    else:
        target = image.parent.parent / 'elsewhere.png'
        target.write_bytes(image.read_bytes())
        image.unlink()
        image.symlink_to(target)
    review.write_text(json.dumps(accepted))
    with pytest.raises(ValueError):
        script.approved_source(data, review)


def test_prepare_never_overwrites_existing_batch(tmp_path, monkeypatch):
    monkeypatch.setattr(script, 'ROOT', tmp_path)
    with pytest.raises(FileExistsError):
        script.prepare()
