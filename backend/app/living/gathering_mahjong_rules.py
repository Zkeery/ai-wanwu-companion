"""Pure persisted Sichuan blood-battle reducer, matching the existing local table.

Physical tiles are unique integers 0..107; face = tile // 4. No clock, I/O,
network, model, money or entropy is read here. Every transition returns a copy.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
from functools import lru_cache

RULES_VERSION = 'sichuan-blood-battle-v1'
SUITS = ('万', '筒', '条')
FACES = tuple(n + suit for suit in SUITS for n in '一二三四五六七八九')
PHASE_MS = dict(exchange=2000, dingque=1200, draw=1000, hold=1800,
                discard=800, claim=1200, win=1200, ended=0)


def face(tile):
    if type(tile) is not int or not 0 <= tile < 108:
        raise ValueError('invalid physical tile')
    return FACES[tile // 4]


@lru_cache(maxsize=20000)
def _groups(counts, remaining, terminals=False):
    first = next((i for i, count in enumerate(counts) if count), -1)
    if first < 0:
        return remaining == 0
    if remaining <= 0:
        return False
    values = list(counts)
    if values[first] >= 3 and (not terminals or first % 9 in (0, 8)):
        values[first] -= 3
        if _groups(tuple(values), remaining - 1, terminals):
            return True
        values[first] += 3
    if (first % 9 <= 6 and values[first + 1] and values[first + 2]
            and (not terminals or first % 9 in (0, 6))):
        for i in (first, first + 1, first + 2):
            values[i] -= 1
        if _groups(tuple(values), remaining - 1, terminals):
            return True
    return False


def _standard(counts, meld_count, terminals=False):
    for pair in range(27):
        if counts[pair] >= 2 and (not terminals or pair % 9 in (0, 8)):
            remaining = list(counts)
            remaining[pair] -= 2
            if _groups(tuple(remaining), 4 - meld_count, terminals):
                return True
    return False


def score_hand(hand, melds, missing_suit, winning_tile=None, **flags):
    """Face-name scoring contract shared by golden fixtures and the reducer."""
    if missing_suit not in SUITS or len(melds) > 4:
        return None
    names = list(hand) + ([] if winning_tile is None else [winning_tile])
    if len(names) != 14 - len(melds) * 3 or any(tile not in FACES for tile in names):
        return None
    values, meld_values = [FACES.index(tile) for tile in names], []
    for meld in melds:
        tiles = meld.get('tiles', [])
        if (meld.get('kind') not in ('pung', 'kong') or
                len(tiles) != (4 if meld['kind'] == 'kong' else 3) or
                any(tile not in FACES or tile != tiles[0] for tile in tiles)):
            return None
        meld_values.extend(FACES.index(tile) for tile in tiles)
    all_values = values + meld_values
    counts = tuple(values.count(i) for i in range(27))
    all_counts = Counter(all_values)
    if any(count > 4 for count in all_counts.values()) or any(SUITS[i // 9] == missing_suit for i in all_values):
        return None
    seven = not melds and all(n % 2 == 0 for n in counts)
    regular = _standard(counts, len(melds))
    if not seven and not regular:
        return None
    triplets = regular and any(counts[pair] >= 2 and all(
        (n - (2 if i == pair else 0)) % 3 == 0 for i, n in enumerate(counts)) for pair in range(27))
    labels, raw_fan = [], 0

    def add(label, fan):
        nonlocal raw_fan
        labels.append(label)
        raw_fan += fan

    if seven:
        add('七对', 2)
    elif triplets:
        add('对对胡', 1)
    if len({i // 9 for i in all_values}) == 1:
        add('清一色', 2)
    if regular and all(i % 9 in (0, 8) for i in meld_values) and _standard(counts, len(melds), True):
        add('带幺九', 2)
    if not seven and triplets and all(i % 9 in (1, 4, 7) for i in all_values):
        add('将对', 2)
    if len(melds) == 4:
        add('金钩钓', 1)
    roots = sum(n == 4 for n in all_counts.values())
    if roots:
        add('根' if roots == 1 else str(roots) + '根', roots)
    for flag, label in [('self_draw', '自摸'), ('after_kong', '杠上花'), ('kong_discard', '杠上炮'), ('robbed_kong', '抢杠胡')]:
        if flags.get(flag):
            add(label, 1)
    if flags.get('last_tile'):
        add('海底捞月' if flags.get('self_draw') else '海底炮', 1)
    if flags.get('heavenly') or flags.get('earthly'):
        labels.append('天胡' if flags.get('heavenly') else '地胡')
        raw_fan = max(raw_fan, 4)
    if not labels:
        labels.append('平胡')
    return dict(fan=min(4, raw_fan), raw_fan=raw_fan, points=2 ** min(4, raw_fan), labels=labels)


def waits(hand, melds, missing_suit):
    if missing_suit not in SUITS or len(hand) != 13 - len(melds) * 3:
        return []
    counts = Counter(hand + [tile for meld in melds for tile in meld['tiles']])
    return [dict(result, tile=tile) for tile in FACES if counts[tile] < 4 and not tile.endswith(missing_suit)
            and (result := score_hand(hand, melds, missing_suit, tile))]


def new_state(roster, wall, rng_state, *, dealer=0, exchange_direction=None):
    if (len(roster) != 4 or len({r['character_id'] for r in roster}) != 4 or
            {r['seat_id'] for r in roster} != {f'mahjong-{i}' for i in range(4)} or
            type(dealer) is not int or dealer not in range(4) or
            sorted(wall) != list(range(108)) or any(type(t) is not int for t in wall) or
            type(rng_state) is not int or not 0 < rng_state <= 0xffffffff):
        raise ValueError('invalid fixed game input')
    players = [dict(character_id=r['character_id'], seat_id=r['seat_id'],
                    hand=sorted(wall[i * 13:i * 13 + 13]), melds=[], discards=[],
                    won=False, winning_tile=None, missing_suit=None, score=0)
               for i, r in enumerate(sorted(roster, key=lambda r: r['seat_id']))]
    players[dealer]['hand'].append(wall[52])
    players[dealer]['hand'].sort()
    state = dict(rules_version=RULES_VERSION, players=players, wall=list(wall[53:]),
        turn=dealer, dealer=dealer, phase='exchange', status='playing', rng_state=rng_state,
        event_seq=0, last_event=None, exchange_direction=exchange_direction,
        any_meld=False, discard_count=0, hold_from_draw=False, supplement=False,
        last_draw_after_kong=False, last_draw_was_last_tile=False, last_drawn_tile=None,
        discard=None, pending_wins=[], resume_from=0, settlement=None,
        score_transfers=[], kong_ledger=[])
    if exchange_direction is None:
        state['exchange_direction'] = _rand(state, 3) + 1
    elif type(exchange_direction) is not int or exchange_direction not in (1, 2, 3):
        raise ValueError('invalid exchange direction')
    validate_state(state)
    return state


def validate_state(s):
    required = {'rules_version', 'players', 'wall', 'turn', 'dealer', 'phase', 'status', 'rng_state',
        'event_seq', 'last_event', 'exchange_direction', 'any_meld', 'discard_count', 'hold_from_draw',
        'supplement', 'last_draw_after_kong', 'last_draw_was_last_tile', 'last_drawn_tile', 'discard',
        'pending_wins', 'resume_from', 'settlement', 'score_transfers', 'kong_ledger'}
    if (not isinstance(s, dict) or s.get('rules_version') != RULES_VERSION or
            set(s) != required or
            s.get('phase') not in PHASE_MS or s.get('status') not in ('playing', 'ended', 'interrupted') or
            not isinstance(s.get('players'), list) or len(s['players']) != 4 or
            type(s.get('rng_state')) is not int or not 0 < s['rng_state'] <= 0xffffffff or
            any(type(s[k]) is not int or s[k] not in range(4) for k in ('turn', 'dealer', 'resume_from')) or
            any(type(s[k]) is not bool for k in ('any_meld', 'hold_from_draw', 'supplement',
                'last_draw_after_kong', 'last_draw_was_last_tile')) or
            any(type(s[k]) is not int or s[k] < 0 for k in ('event_seq', 'discard_count')) or
            type(s['exchange_direction']) is not int or s['exchange_direction'] not in (1, 2, 3) or
            not isinstance(s['wall'], list) or not isinstance(s['pending_wins'], list) or
            not isinstance(s['score_transfers'], list) or not isinstance(s['kong_ledger'], list)):
        raise ValueError('invalid saved game')
    if s['last_drawn_tile'] is not None:
        face(s['last_drawn_tile'])
    tiles = list(s['wall'])
    for player in s['players']:
        if (not isinstance(player, dict) or set(player) != {'character_id', 'seat_id', 'hand', 'melds',
                'discards', 'won', 'winning_tile', 'missing_suit', 'score'} or
                type(player['character_id']) is not int or player['character_id'] <= 0 or
                player['seat_id'] not in {f'mahjong-{i}' for i in range(4)} or
                type(player['won']) is not bool or type(player['score']) is not int or
                player['missing_suit'] not in (*SUITS, None) or
                (player['missing_suit'] is None and s['phase'] not in ('exchange', 'dingque')) or
                any(not isinstance(player[k], list) for k in ('hand', 'discards', 'melds')) or
                len(player['hand']) > 14 or len(player['melds']) > 4):
            raise ValueError('invalid saved player')
        if player['winning_tile'] is not None:
            face(player['winning_tile'])
        tiles.extend(player['hand'])
        tiles.extend(player['discards'])
        for meld in player['melds']:
            if (not isinstance(meld, dict) or not {'kind', 'tiles'} <= set(meld) or
                    not set(meld) <= {'kind', 'tiles', 'concealed'} or
                    meld['kind'] not in ('pung', 'kong') or not isinstance(meld['tiles'], list) or
                    ('concealed' in meld and type(meld['concealed']) is not bool) or
                    len(meld['tiles']) != (3 if meld['kind'] == 'pung' else 4) or
                    any(type(t) is not int or not 0 <= t < 108 for t in meld['tiles']) or
                    len({t // 4 for t in meld['tiles']}) != 1):
                raise ValueError('invalid meld')
            tiles.extend(meld['tiles'])
    if (any(type(t) is not int for t in tiles) or sorted(tiles) != list(range(108)) or
            len({p['character_id'] for p in s['players']}) != 4 or
            {p['seat_id'] for p in s['players']} != {f'mahjong-{i}' for i in range(4)} or
            sum(p['score'] for p in s['players']) != 0):
        raise ValueError('game tile conservation or score invariant failed')
    ids = {p['character_id'] for p in s['players']}
    event = s['last_event']
    if event is not None:
        if (not isinstance(event, dict) or not {'seq', 'kind', 'character_id', 'tile', 'text'} <= set(event) or
                not set(event) <= {'seq', 'kind', 'character_id', 'tile', 'text', 'from_character_id',
                                    'after_kong', 'robbed_kong', 'concealed'} or
                type(event['seq']) is not int or event['seq'] != s['event_seq'] or event['seq'] <= 0 or
                event['kind'] not in ('draw', 'discard', 'pung', 'kong', 'win', 'exhausted') or
                event['character_id'] not in ids or event['text'] not in (*FACES, '碰', '杠', '抢杠胡', '杠上花', '自摸', '胡', '流局') or
                ('from_character_id' in event and event['from_character_id'] not in ids) or
                any(type(event[k]) is not bool for k in ('after_kong', 'robbed_kong', 'concealed') if k in event)):
            raise ValueError('invalid saved event')
        if event['tile'] is not None:
            face(event['tile'])
    elif s['event_seq'] != 0:
        raise ValueError('missing saved event')
    for transfer in s['score_transfers']:
        if (not isinstance(transfer, dict) or set(transfer) != {'from_character_id', 'to_character_id', 'points', 'reason'} or
                transfer['from_character_id'] not in ids or transfer['to_character_id'] not in ids or
                transfer['from_character_id'] == transfer['to_character_id'] or
                type(transfer['points']) is not int or transfer['points'] <= 0 or transfer['reason'] not in
                ('win', 'exposed-kong', 'added-kong', 'concealed-kong', 'flower-pig', 'ready', 'kong-refund')):
            raise ValueError('invalid saved score transfer')
    if s['discard'] is not None:
        d = s['discard']
        if (not isinstance(d, dict) or set(d) != {'tile', 'source', 'kong_discard', 'last_tile', 'earthly'} or
                type(d['source']) is not int or d['source'] not in range(4) or
                any(type(d[k]) is not bool for k in ('kong_discard', 'last_tile', 'earthly'))):
            raise ValueError('invalid pending discard')
        face(d['tile'])
    for pending in s['pending_wins']:
        if (not isinstance(pending, dict) or set(pending) != {'actor', 'tile', 'text', 'details'} or
                type(pending['actor']) is not int or pending['actor'] not in range(4) or
                pending['text'] not in ('抢杠胡', '杠上花', '自摸', '胡') or
                not isinstance(pending['details'], dict) or not set(pending['details']) <= {'from_character_id', 'after_kong', 'robbed_kong'}):
            raise ValueError('invalid pending win')
        if pending['tile'] is not None:
            face(pending['tile'])
    for entry in s['kong_ledger']:
        if (not isinstance(entry, dict) or set(entry) != {'payer', 'recipient', 'points', 'refunded'} or
                any(type(entry[k]) is not int or entry[k] not in range(4) for k in ('payer', 'recipient')) or
                type(entry['points']) is not int or entry['points'] <= 0 or type(entry['refunded']) is not bool):
            raise ValueError('invalid saved kong ledger')
    settlement = s['settlement']
    if settlement is not None and (not isinstance(settlement, dict) or
            set(settlement) != {'reason', 'ready_character_ids', 'flower_pig_character_ids'} or
            settlement['reason'] not in ('three-winners', 'wall-exhausted') or
            any(not isinstance(settlement[k], list) or any(i not in ids for i in settlement[k])
                for k in ('ready_character_ids', 'flower_pig_character_ids'))):
        raise ValueError('invalid saved settlement')
    return s


def _rand(s, size):
    value = s['rng_state']
    value ^= (value << 13) & 0xffffffff
    value ^= value >> 17
    value ^= (value << 5) & 0xffffffff
    s['rng_state'] = value & 0xffffffff
    return s['rng_state'] % size


def _others(s, index):
    return [(index + offset) % 4 for offset in (1, 2, 3) if not s['players'][(index + offset) % 4]['won']]


def _next(s, index):
    return next(((index + offset) % 4 for offset in (1, 2, 3, 4) if not s['players'][(index + offset) % 4]['won']), None)


def _missing(player, tile):
    return SUITS[(tile // 4) // 9] == player['missing_suit']


def _score(s, index, tile=None, **flags):
    p = s['players'][index]
    if p['won'] or p['missing_suit'] is None:
        return None
    return score_hand([face(t) for t in p['hand']],
        [dict(kind=m['kind'], tiles=[face(t) for t in m['tiles']]) for m in p['melds']],
        p['missing_suit'], None if tile is None else face(tile), **flags)


def _transfer(s, payer, recipient, points, reason):
    if payer == recipient:
        return
    s['players'][payer]['score'] -= points
    s['players'][recipient]['score'] += points
    s['score_transfers'].append(dict(from_character_id=s['players'][payer]['character_id'],
        to_character_id=s['players'][recipient]['character_id'], points=points, reason=reason))
    if reason in ('exposed-kong', 'added-kong', 'concealed-kong'):
        s['kong_ledger'].append(dict(payer=payer, recipient=recipient, points=points, refunded=False))


def _emit(s, kind, actor, tile, text, **details):
    s['event_seq'] += 1
    s['last_event'] = dict(seq=s['event_seq'], kind=kind,
        character_id=s['players'][actor]['character_id'], tile=tile, text=text, **details)


def _wins(s, winners, tile, payer, kind, after_kong=False):
    payers = _others(s, payer) if kind == 'self' else [payer]
    for winner, points in winners:
        for source in payers:
            _transfer(s, source, winner, points, 'win')
        s['players'][winner]['won'] = True
        s['players'][winner]['winning_tile'] = None if kind == 'self' else tile
        details = {} if kind == 'self' else dict(from_character_id=s['players'][payer]['character_id'])
        if after_kong:
            details['after_kong'] = True
        if kind == 'rob':
            details['robbed_kong'] = True
        s['pending_wins'].append(dict(actor=winner, tile=tile,
            text='抢杠胡' if kind == 'rob' else ('杠上花' if after_kong else '自摸') if kind == 'self' else '胡', details=details))
    s.update(resume_from=payer, discard=None, supplement=False,
             last_draw_after_kong=False, last_draw_was_last_tile=False, last_drawn_tile=None, phase='win')
    _next_win(s)


def _next_win(s):
    pending = s['pending_wins'].pop(0)
    s['turn'] = pending['actor']
    _emit(s, 'win', pending['actor'], pending['tile'], pending['text'], **pending['details'])


def _take(p, face_index, count):
    selected = [tile for tile in p['hand'] if tile // 4 == face_index][:count]
    if len(selected) != count:
        raise ValueError('missing tiles')
    for tile in selected:
        p['hand'].remove(tile)
    return selected


def _discard_tile(s, p):
    forced = [t for t in p['hand'] if _missing(p, t)]
    counts = Counter(t // 4 for t in p['hand'])
    scores = {}
    for tile in forced or p['hand']:
        i = tile // 4
        rank = i % 9
        value = 12 if counts[i] == 1 else -2 if counts[i] == 2 else -13
        value += int(rank in (0, 8))
        for offset in (-2, -1, 1, 2):
            if 0 <= rank + offset <= 8 and counts[i + offset]:
                value -= 5 if abs(offset) == 1 else 2
        scores[i] = value
    best = sorted(i for i, value in scores.items() if value == max(scores.values()))
    chosen = best[_rand(s, len(best))] if len(best) > 1 else best[0]
    return _take(p, chosen, 1)[0]


def _settle_wall(s):
    if s['settlement'] is not None:
        return
    active = [i for i, p in enumerate(s['players']) if not p['won']]
    pigs = [i for i in active if any(_missing(s['players'][i], tile) for tile in
        s['players'][i]['hand'] + [t for m in s['players'][i]['melds'] for t in m['tiles']])]
    non_pigs = [i for i in active if i not in pigs]
    possible = {i: waits([face(t) for t in s['players'][i]['hand']],
        [dict(kind=m['kind'], tiles=[face(t) for t in m['tiles']]) for m in s['players'][i]['melds']],
        s['players'][i]['missing_suit']) for i in non_pigs}
    ready = [i for i in non_pigs if possible[i]]
    for pig in pigs:
        for other in non_pigs:
            _transfer(s, pig, other, 16, 'flower-pig')
    for payer in (i for i in non_pigs if i not in ready):
        for recipient in ready:
            _transfer(s, payer, recipient, max(w['points'] for w in possible[recipient]), 'ready')
    for entry in s['kong_ledger']:
        if not entry['refunded'] and entry['recipient'] in active and entry['recipient'] not in ready:
            _transfer(s, entry['recipient'], entry['payer'], entry['points'], 'kong-refund')
            entry['refunded'] = True
    s['settlement'] = dict(reason='wall-exhausted',
        ready_character_ids=[s['players'][i]['character_id'] for i in ready],
        flower_pig_character_ids=[s['players'][i]['character_id'] for i in pigs])


def advance(state):
    validate_state(state)
    if state['status'] != 'playing':
        raise ValueError('game is not playing')
    s = deepcopy(state)
    _advance(s)
    validate_state(s)
    return s


def _advance(s):
    players, phase = s['players'], s['phase']
    if phase == 'exchange':
        outgoing = []
        for p in players:
            counts = [sum(t // 4 // 9 == suit for t in p['hand']) for suit in range(3)]
            suit = min((n, i) for i, n in enumerate(counts) if n >= 3)[1]
            outgoing.append([t for t in p['hand'] if t // 4 // 9 == suit][:3])
        for p, tiles in zip(players, outgoing):
            for tile in tiles:
                p['hand'].remove(tile)
        for giver, tiles in enumerate(outgoing):
            players[(giver + s['exchange_direction']) % 4]['hand'].extend(tiles)
        for p in players:
            p['hand'].sort()
        s['phase'] = 'dingque'
        return
    if phase == 'dingque':
        for p in players:
            suit = min((sum(t // 4 // 9 == i for t in p['hand']), i) for i in range(3))[1]
            p['missing_suit'] = SUITS[suit]
        s.update(turn=s['dealer'], hold_from_draw=True, phase='hold')
        return
    if phase == 'win':
        if s['pending_wins']:
            _next_win(s)
        elif sum(p['won'] for p in players) >= 3:
            s.update(status='ended', phase='ended', settlement=dict(reason='three-winners', ready_character_ids=[], flower_pig_character_ids=[]))
        else:
            s.update(turn=_next(s, s['resume_from']), phase='draw')
        return
    index = s['turn']
    p = players[index]
    if phase == 'draw':
        if not s['wall']:
            _settle_wall(s)
            s.update(status='ended', phase='ended')
            _emit(s, 'exhausted', index, None, '流局')
            return
        after_kong = s['supplement']
        tile = s['wall'].pop(0)
        p['hand'].append(tile)
        p['hand'].sort()
        s.update(last_drawn_tile=tile, last_draw_after_kong=after_kong,
                 last_draw_was_last_tile=not s['wall'], supplement=False, hold_from_draw=True, phase='hold')
        _emit(s, 'draw', index, tile, face(tile), **({'after_kong': True} if after_kong else {}))
        return
    if phase == 'hold':
        score = _score(s, index, self_draw=True, after_kong=s['last_draw_after_kong'],
            last_tile=s['last_draw_was_last_tile'], heavenly=index == s['dealer'] and not s['discard_count'] and not s['any_meld']) if s['hold_from_draw'] else None
        if score:
            _wins(s, [(index, score['points'])], s['last_drawn_tile'], index, 'self', s['last_draw_after_kong'])
            return
        added = next((m for m in p['melds'] if m['kind'] == 'pung' and not _missing(p, m['tiles'][0]) and any(t // 4 == m['tiles'][0] // 4 for t in p['hand'])), None) if s['hold_from_draw'] and s['wall'] else None
        if added:
            tile = next(t for t in p['hand'] if t // 4 == added['tiles'][0] // 4)
            winners = [(i, score['points']) for i in _others(s, index) if (score := _score(s, i, tile, robbed_kong=True, last_tile=s['last_draw_was_last_tile']))]
            p['hand'].remove(tile)
            if winners:
                p['discards'].append(tile)
                _wins(s, winners, tile, index, 'rob')
                return
            added.update(kind='kong', tiles=added['tiles'] + [tile])
            for other in _others(s, index):
                _transfer(s, other, index, 1, 'added-kong')
            s.update(any_meld=True, supplement=True, last_drawn_tile=None, last_draw_after_kong=False, last_draw_was_last_tile=False, phase='draw')
            _emit(s, 'kong', index, tile, '杠')
            return
        counts = Counter(t // 4 for t in p['hand'])
        quad = next((i for i in range(27) if counts[i] == 4 and not _missing(p, i * 4)), None) if s['hold_from_draw'] and s['wall'] and len(p['melds']) < 4 else None
        if quad is not None:
            tiles = _take(p, quad, 4)
            p['melds'].append(dict(kind='kong', concealed=True, tiles=tiles))
            for other in _others(s, index):
                _transfer(s, other, index, 2, 'concealed-kong')
            s.update(any_meld=True, supplement=True, last_drawn_tile=None, last_draw_after_kong=False, last_draw_was_last_tile=False, phase='draw')
            _emit(s, 'kong', index, tiles[0], '杠', concealed=True)
            return
        tile = _discard_tile(s, p)
        p['discards'].append(tile)
        s['discard'] = dict(tile=tile, source=index, kong_discard=s['last_draw_after_kong'],
            last_tile=s['last_draw_was_last_tile'], earthly=not s['discard_count'] and index == s['dealer'] and not s['any_meld'])
        s['discard_count'] += 1
        s['phase'] = 'discard'
        _emit(s, 'discard', index, tile, face(tile))
        return
    if phase == 'discard':
        s['phase'] = 'claim'
        return
    if phase == 'claim':
        pending = s['discard']
        if pending is None:
            s.update(turn=_next(s, index), phase='draw')
            return
        tile, source = pending['tile'], pending['source']
        order = _others(s, source)
        winners = [(i, score['points']) for i in order if (score := _score(s, i, tile,
            kong_discard=pending['kong_discard'], last_tile=pending['last_tile'], earthly=pending['earthly']))]
        if winners:
            _wins(s, winners, tile, source, 'discard')
            return
        eligible = [i for i in order if not _missing(players[i], tile) and len(players[i]['melds']) < 4]
        kong = next((i for i in eligible if sum(t // 4 == tile // 4 for t in players[i]['hand']) >= 3), None) if s['wall'] else None
        pung = next((i for i in eligible if sum(t // 4 == tile // 4 for t in players[i]['hand']) >= 2), None) if kong is None else None
        claimant = kong if kong is not None else pung
        if claimant is not None:
            is_kong = kong is not None
            tiles = _take(players[claimant], tile // 4, 3 if is_kong else 2)
            if players[source]['discards'].pop() != tile:
                raise ValueError('pending discard identity mismatch')
            players[claimant]['melds'].append(dict(kind='kong' if is_kong else 'pung', tiles=tiles + [tile]))
            if is_kong:
                _transfer(s, source, claimant, 2, 'exposed-kong')
            s.update(any_meld=True, turn=claimant, discard=None, supplement=is_kong,
                hold_from_draw=False, last_drawn_tile=None, last_draw_after_kong=False,
                last_draw_was_last_tile=False, phase='draw' if is_kong else 'hold')
            _emit(s, 'kong' if is_kong else 'pung', claimant, tile, '杠' if is_kong else '碰', from_character_id=players[source]['character_id'])
        else:
            s.update(turn=_next(s, source), discard=None, last_drawn_tile=None,
                last_draw_after_kong=False, last_draw_was_last_tile=False, phase='draw')
        return
    raise ValueError('unsupported game phase')
