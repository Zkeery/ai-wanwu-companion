"""The paid-evaluation guard must never free unknown or unfinished charges."""
import pytest

from scripts.run_acceptance_real import accounted_batch_cost


def test_known_usage_settles_with_conservative_prices():
    assert accounted_batch_cost({"reserved_cny": 0.005, "results": [{"reserved_cny": 0.005, "usage": {"prompt_tokens": 100, "completion_tokens": 200}}]}) == pytest.approx(0.00075)


def test_pending_calls_keep_reservation():
    assert accounted_batch_cost({"reserved_cny": 0.015, "results": [{"reserved_cny": 0.005, "usage": {"prompt_tokens": 100, "completion_tokens": 200}}]}) == pytest.approx(0.01075)


@pytest.mark.parametrize("usage", [None, {}, {"prompt_tokens": 100}, {"prompt_tokens": -1, "completion_tokens": 100}, {"prompt_tokens": "100", "completion_tokens": 100}])
def test_unknown_or_invalid_usage_keeps_full_reservation(usage):
    assert accounted_batch_cost({"reserved_cny": 0.005, "results": [{"reserved_cny": 0.005, "usage": usage}]}) == pytest.approx(0.005)
