"""Pure authority rules: no clocks, providers, or external resources."""
import copy
import random

import pytest

from app.living import gathering_mahjong_rules as rules


ROSTER = [dict(character_id=i + 1, seat_id=f'mahjong-{i}') for i in range(4)]


def game(seed=1):
    wall = list(range(108))
    random.Random(seed).shuffle(wall)
    return rules.new_state(ROSTER, wall, seed)


def test_fixed_physical_wall_exchange_and_dingque():
    state = game()
    before = copy.deepcopy(state)
    exchanged = rules.advance(state)
    assert state == before
    assert exchanged['phase'] == 'dingque'
    assert [len(p['hand']) for p in exchanged['players']] == [14, 13, 13, 13]
    assigned = rules.advance(exchanged)
    assert assigned['phase'] == 'hold'
    assert all(p['missing_suit'] in rules.SUITS for p in assigned['players'])
    assert len(state['wall']) == 55
    assert len(set(rules.FACES)) == 27


@pytest.mark.parametrize('seed', range(1, 41))
def test_full_games_conserve_all_physical_tiles_and_zero_sum(seed):
    state = game(seed)
    seen = set()
    for _ in range(2000):
        rules.validate_state(state)
        seen.add(state['phase'])
        if state['status'] != 'playing':
            break
        state = rules.advance(state)
    assert state['status'] == 'ended'
    assert state['settlement']['reason'] in ('three-winners', 'wall-exhausted')
    assert sum(p['score'] for p in state['players']) == 0
    assert {'exchange', 'dingque', 'hold', 'discard', 'draw'} <= seen


def test_missing_suit_has_priority_and_no_chow_scoring():
    state = rules.advance(rules.advance(game(19)))
    player = state['players'][state['turn']]
    missing = [t for t in player['hand'] if rules.face(t).endswith(player['missing_suit'])]
    state = rules.advance(state)
    assert state['phase'] == 'discard'
    if missing:
        assert state['discard']['tile'] in missing
    assert rules.score_hand(['一万'] * 2, [dict(kind='chow', tiles=['一万', '二万', '三万'])] * 4, '筒') is None


def test_score_and_waits_match_existing_sichuan_scope():
    hand = ['一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万', '一筒', '一筒', '一筒', '九筒']
    result = rules.score_hand(hand, [], '条', '九筒', self_draw=True, after_kong=True)
    assert result['points'] == 4 and {'自摸', '杠上花'} <= set(result['labels'])
    assert any(w['tile'] == '九筒' for w in rules.waits(hand, [], '条'))
    assert rules.score_hand(hand, [], '万', '九筒') is None
    seven = ['一万', '一万', '二万', '二万', '三万', '三万', '四万', '四万', '五筒', '五筒', '六筒', '六筒', '九筒', '九筒']
    assert rules.score_hand(seven, [], '条')['points'] == 4


def test_invalid_wall_and_corruption_fail_closed():
    with pytest.raises(ValueError):
        rules.new_state(ROSTER, [0] * 108, 1)
    state = game()
    state['players'][0]['hand'][0] = state['wall'][0]
    with pytest.raises(ValueError):
        rules.advance(state)


def arranged(hands, *, melds=None, phase='hold', discard=None, won=()):
    """Allocate real, unique copies; unused tiles remain in the same fixed wall."""
    state = game(5)
    pool = list(range(108))
    def take(names):
        result = []
        for name in names:
            tile = next(t for t in pool if rules.face(t) == name)
            pool.remove(tile)
            result.append(tile)
        return result
    for p in state['players']:
        p.update(hand=[], melds=[], discards=[], won=False, winning_tile=None, missing_suit='条', score=0)
    for i, names in enumerate(hands):
        state['players'][i]['hand'] = take(names)
    for index, entries in (melds or {}).items():
        state['players'][index]['melds'] = [dict(kind=kind, tiles=take(names)) for kind, names in entries]
    if discard:
        tile = take([discard])[0]
        state['players'][0]['discards'] = [tile]
        state['discard'] = dict(tile=tile, source=0, kong_discard=False, last_tile=False, earthly=False)
    # Missing-suit fillers ensure unspecified players cannot accidentally claim Hu.
    for i, p in enumerate(state['players']):
        target = 14 - 3 * len(p['melds']) if i == 0 and phase == 'hold' else 13 - 3 * len(p['melds'])
        if len(p['hand']) < target:
            tile = next(t for t in pool if rules.face(t).endswith('条'))
            pool.remove(tile)
            p['hand'].append(tile)
    for i, p in enumerate(state['players']):
        target = 14 - 3 * len(p['melds']) if i == 0 and phase == 'hold' else 13 - 3 * len(p['melds'])
        while len(p['hand']) < target:
            tile = next((t for t in pool if rules.face(t).endswith('条')), pool[0])
            pool.remove(tile)
            p['hand'].append(tile)
        p['won'] = i in won
    state.update(wall=pool, phase=phase, hold_from_draw=phase == 'hold',
                 any_meld=bool(melds), discard_count=2, last_drawn_tile=None)
    rules.validate_state(state)
    return state


@pytest.mark.parametrize('copies,kind,points', [(2, 'pung', 0), (3, 'kong', 2)])
def test_discard_claims_pung_or_exposed_kong_without_chow(copies, kind, points):
    state = arranged([[], ['一万'] * copies, [], []], phase='claim', discard='一万')
    result = rules.advance(state)
    assert result['last_event']['kind'] == kind and result['last_event']['character_id'] == 2
    assert result['players'][1]['melds'][0]['kind'] == kind
    assert len(result['players'][1]['melds'][0]['tiles']) == copies + 1
    assert result['players'][0]['discards'] == []
    assert [p['score'] for p in result['players']] == [-points, points, 0, 0]
    assert result['phase'] == ('draw' if kind == 'kong' else 'hold')


def test_concealed_and_added_kong_use_supplement_and_pay_only_active():
    state = arranged([['一万'] * 4, [], [], []], won=(3,))
    result = rules.advance(state)
    assert result['last_event']['concealed'] and result['supplement']
    assert result['players'][0]['melds'][0]['concealed']
    assert [p['score'] for p in result['players']] == [4, -2, -2, 0]
    drawn = rules.advance(result)
    assert drawn['last_event']['kind'] == 'draw' and drawn['last_event']['after_kong']
    state = arranged([['一万'], [], [], []], melds={0: [('pung', ['一万'] * 3)]})
    result = rules.advance(state)
    assert result['players'][0]['melds'][0]['kind'] == 'kong'
    assert [p['score'] for p in result['players']] == [3, -1, -1, -1]


WAIT_A = ['二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万', '一筒', '一筒', '一筒', '九筒', '九筒']
WAIT_B = ['二万', '三万', '四筒', '五筒', '六筒', '七筒', '八筒', '九筒', '二筒', '二筒', '二筒', '八万', '八万']


def test_multiple_winners_share_discard_reference_and_blood_battle_continues():
    state = arranged([[], WAIT_A, WAIT_B, []], phase='claim', discard='一万')
    tile = state['discard']['tile']
    result = rules.advance(state)
    assert result['last_event']['kind'] == 'win'
    assert [p['won'] for p in result['players']] == [False, True, True, False]
    assert result['players'][0]['discards'] == [tile]
    assert result['players'][1]['winning_tile'] == result['players'][2]['winning_tile'] == tile
    assert [p['score'] for p in result['players']] == [-2, 1, 1, 0]
    result = rules.advance(result)
    assert result['last_event']['character_id'] == 3
    result = rules.advance(result)
    assert result['phase'] == 'draw' and result['turn'] == 3


def test_robbed_added_kong_does_not_complete_or_pay_kong():
    state = arranged([['一万'], WAIT_A, [], []], melds={0: [('pung', ['一万'] * 3)]})
    result = rules.advance(state)
    assert result['last_event']['kind'] == 'win' and result['last_event']['robbed_kong']
    assert result['players'][0]['melds'][0]['kind'] == 'pung'
    assert len(result['players'][0]['discards']) == 1
    assert result['players'][1]['won'] and result['kong_ledger'] == []
    assert [p['score'] for p in result['players']] == [-2, 2, 0, 0]


def test_self_draw_three_winners_ends_without_new_deal():
    state = arranged([['一万'] + WAIT_A, [], [], []], won=(1, 2))
    result = rules.advance(state)
    assert result['last_event']['kind'] == 'win' and result['players'][0]['won']
    assert [p['score'] for p in result['players']] == [2, 0, 0, -2]
    result = rules.advance(result)
    assert result['status'] == 'ended' and result['settlement']['reason'] == 'three-winners'
    with pytest.raises(ValueError):
        rules.advance(result)


def test_wall_settlement_flower_pig_ready_and_kong_refund_is_once():
    state = arranged([[], WAIT_A, [], []], phase='draw')
    # A real exhausted wall: all unclaimed physical tiles are existing discards.
    state['players'][3]['discards'].extend(state['wall'])
    state['wall'] = []
    rules._transfer(state, 1, 0, 2, 'exposed-kong')
    result = rules.advance(state)
    assert result['settlement']['reason'] == 'wall-exhausted'
    assert result['settlement']['ready_character_ids'] == [2]
    assert result['settlement']['flower_pig_character_ids']
    assert any(t['reason'] == 'flower-pig' for t in result['score_transfers'])
    assert any(t['reason'] == 'kong-refund' for t in result['score_transfers'])
    assert sum(p['score'] for p in result['players']) == 0
    count = len(result['score_transfers'])
    rules._settle_wall(result)
    assert len(result['score_transfers']) == count


# Literal goldens copied from the existing TS score suite; not generated by this reducer.
GOLDENS = [
    ('一万 二万 三万 四万 五万 六万 七万 八万 九万 二筒 三筒 四筒 五筒 五筒', [], {}, 0, 1, ['平胡']),
    ('一万 一万 一万 三万 三万 三万 六万 六万 六万 二筒 二筒 二筒 五筒 五筒', [], {}, 1, 2, ['对对胡']),
    ('一万 二万 三万 四万 五万 六万 七万 八万 九万 二万 三万 四万 五万 五万', [], {}, 2, 4, ['清一色']),
    ('一万 一万 二万 二万 三万 三万 四万 四万 五筒 五筒 六筒 六筒 七筒 七筒', [], {}, 2, 4, ['七对']),
    ('一万 一万 一万 一万 二万 二万 三万 三万 五筒 五筒 六筒 六筒 七筒 七筒', [], {}, 3, 8, ['七对', '根']),
    ('三万 三万 三万 六万 六万 六万 二筒 二筒 二筒 五筒 五筒', [('kong', '一万')], {}, 2, 4, ['对对胡', '根']),
    ('一万 二万 三万 七万 八万 九万 一筒 二筒 三筒 七筒 八筒 九筒 九筒 九筒', [], {}, 2, 4, ['带幺九']),
    ('二万 二万 二万 五万 五万 五万 八万 八万 八万 二筒 二筒 二筒 五筒 五筒', [], {}, 3, 8, ['对对胡', '将对']),
    ('五筒 五筒', [('pung', '一万'), ('pung', '三万'), ('pung', '六万'), ('pung', '二筒')], {}, 2, 4, ['对对胡', '金钩钓']),
    ('一万 二万 三万 四万 五万 六万 七万 八万 九万 二万 三万 四万 五万 五万', [], {'self_draw': True, 'after_kong': True, 'last_tile': True}, 4, 16, ['清一色', '自摸', '杠上花', '海底捞月']),
]


@pytest.mark.parametrize('text,meld_input,flags,fan,points,labels', GOLDENS)
def test_existing_ts_static_score_goldens(text, meld_input, flags, fan, points, labels):
    melds = [dict(kind=k, tiles=[tile] * (4 if k == 'kong' else 3)) for k, tile in meld_input]
    result = rules.score_hand(text.split(), melds, '条', **flags)
    assert result['fan'] == fan and result['points'] == points and result['labels'] == labels


@pytest.mark.parametrize('flag,label,fan', [('self_draw', '自摸', 1), ('after_kong', '杠上花', 1),
    ('robbed_kong', '抢杠胡', 1), ('kong_discard', '杠上炮', 1), ('last_tile', '海底炮', 1),
    ('heavenly', '天胡', 4), ('earthly', '地胡', 4)])
def test_existing_ts_static_event_bonus_goldens(flag, label, fan):
    result = rules.score_hand(GOLDENS[0][0].split(), [], '条', **{flag: True})
    assert result == dict(fan=fan, raw_fan=fan, points=2 ** fan, labels=[label])


@pytest.mark.parametrize('field,value', [('turn', None), ('turn', True), ('dealer', -1), ('phase', 'fake'),
    ('rng_state', 0), ('wall', None), ('event_seq', '1'), ('supplement', 1), ('settlement', {'reason': 'leak'})])
def test_saved_critical_fields_are_strict(field, value):
    state = game()
    state[field] = value
    with pytest.raises(ValueError):
        rules.validate_state(state)


@pytest.mark.parametrize('field,value', [('won', 1), ('missing_suit', '东'), ('hand', None),
    ('score', True), ('seat_id', 'mahjong-9'), ('character_id', False)])
def test_saved_player_critical_fields_are_strict(field, value):
    state = game()
    state['players'][0][field] = value
    with pytest.raises(ValueError):
        rules.validate_state(state)
