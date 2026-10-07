import pytest

from scripts import check_competition_ai as review
from tests.test_competitions import arena, ready  # noqa: F401
from tests.auth_helpers import TEST_USER_ID


@pytest.mark.parametrize('kind,duration', [('observe', 180), ('leaves', 180), ('garden', 480)])
def test_real_rules_wait_includes_garden_voting_without_casting_a_vote(arena, monkeypatch, kind, duration):
    store, clock, ids = arena
    match = ready(store, ids, kind)
    start = clock[0]
    states = []

    class Observed:
        def read(self, owner, mid):
            value = store.read(owner, mid)
            states.append(value['status'])
            return value

    monkeypatch.setattr(review.time, 'time', lambda: clock[0])
    monkeypatch.setattr(review.time, 'sleep', lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    review.wait_for_completion(Observed(), TEST_USER_ID, match['id'])
    assert clock[0] - start == duration
    assert ('voting' in states) == (kind == 'garden')
    completed = store.read(TEST_USER_ID, match['id'])
    assert completed['votes'] == {}
    if kind == 'garden':
        assert all(not p.get('winner') and len(p['layout']) == 10 for p in completed['participants'].values())


def test_wait_stops_on_cancel_without_generating_or_sleeping(monkeypatch):
    class Cancelled:
        def read(self, owner, mid):
            return dict(status='cancelled')
    monkeypatch.setattr(review.time, 'sleep', lambda _: pytest.fail('must not keep waiting'))
    with pytest.raises(RuntimeError, match='比赛状态变化'):
        review.wait_for_completion(Cancelled(), 'owner', 'match')
