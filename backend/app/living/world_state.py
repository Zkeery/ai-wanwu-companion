"""Version-one physical station identities. No provider, timers or user prose.

The renderer still checks real mesh clearance. This catalog authorizes existing
stations and excludes duplicate physical occupancy; it does not invent a route.
"""
from __future__ import annotations

from math import hypot

from app.living.rules import LivingError


def _value(item, key, default=None):
    return item.get(key, default) if isinstance(item, dict) else getattr(item, key, default)


def activity_area(activity):
    return {'rest': 'indoor', 'sleep': 'bedroom'}.get(activity, 'outdoor')


def leisure_area(activity):
    return 'indoor' if activity == 'television' else 'outdoor'


def station_catalog(scene_type, items):
    """Return stable seat id -> (activity, physical seat id), in visual order."""
    visible = [item for item in items if not _value(item, 'stored', False)]
    benches = [item for item in visible if _value(item, 'kind') == 'bench']
    if scene_type == 'home':
        result = {}
        # tea-0 is the existing user's bench facing the table at (2.35, 1.85).
        # These are local outdoor coordinates; the region translation cancels.
        for item in benches:
            x, z = (_value(item, 'x') - .5) * 8, (_value(item, 'y') - .5) * 5.2
            dx, dz = 2.35 - x, 1.85 - z
            distance = hypot(dx, dz)
            # Table body is 1.08 x .72m. Keep the actor's conservative .81m
            # contact envelope outside it; never move the saved bench to fit.
            outside_table = abs(dx) >= .54 + .81 or abs(dz) >= .36 + .81
            if 0 < distance <= 1.5 and dz / distance > .25 and outside_table:
                result['tea-0'] = ('tea', 'bench-' + _value(item, 'id') + '-0')
                break
        result['tea-1'] = ('tea', 'tea-1')
        result.update({f'television-{index}': ('television', f'sofa-{index}') for index in range(3)})
        result.update({f'mahjong-{index}': ('mahjong', f'mahjong-{index}') for index in range(4)})
        for item in benches:
            seat = 'bench-' + _value(item, 'id') + '-0'
            result[seat] = ('bench', seat)
        return result
    if scene_type in ('forest', 'desert'):
        prefix = 'natural-' + scene_type
        result = {f'{prefix}-tea-{index}': ('tea', f'{prefix}-tea-{index}') for index in range(2)}
        for item in benches:
            seat = prefix + '-bench-' + _value(item, 'id')
            result[seat] = ('bench', seat)
        return result
    raise LivingError('invalid_request', '请选择有效的生活场景')


def seat_positions(scene_type, items):
    """Exact version-one X/Z centers matching the actual renderer fixtures."""
    items = list(items)
    catalog = station_catalog(scene_type, items)
    benches = [item for item in items if not _value(item, 'stored', False) and _value(item, 'kind') == 'bench']
    if scene_type == 'home':
        result = {'tea-1': (2.35, 4.4)}
        result.update({f'television-{i}': (x, -5.65) for i, x in enumerate((-5.65, -7., -4.3))})
        result.update({f'mahjong-{i}': (-2.4 + x, 5.45 + z) for i, (x, z) in enumerate(((0, -1.035), (1.035, 0), (0, 1.035), (-1.035, 0)))})
        for item in benches:
            result['bench-' + _value(item, 'id') + '-0'] = ((_value(item, 'x') - .5) * 8, (_value(item, 'y') - .5) * 5.2 + 4.1)
        if 'tea-0' in catalog:
            result['tea-0'] = result[catalog['tea-0'][1]]
        return result
    prefix = 'natural-' + scene_type
    result = {f'{prefix}-tea-0': (-2.55, 2.7), f'{prefix}-tea-1': (.55, 2.7)}
    for item in benches:
        result[prefix + '-bench-' + _value(item, 'id')] = ((_value(item, 'x') - .5) * 8,
            (_value(item, 'y') - .5) * 5.2 + (.16 if scene_type == 'forest' else -.16))
    return result


def valid_leisure(scene_type, items, assignment):
    if not isinstance(assignment, dict) or type(assignment.get('station_version')) is not int or assignment.get('station_version') != 1:
        return False
    seat = station_catalog(scene_type, items).get(assignment.get('seat_id'))
    return seat is not None and seat[0] == assignment.get('activity')


def choose_leisure(scene_type, items, activity, seat_id=None, *, occupied=(), occupied_positions=()):
    items = list(items)
    catalog = station_catalog(scene_type, items)
    positions = seat_positions(scene_type, items)
    if activity not in ('tea', 'television', 'mahjong', 'bench'):
        raise LivingError('invalid_request', '请选择有效的休闲活动')
    if scene_type != 'home' and activity in ('television', 'mahjong'):
        raise LivingError('invalid_action', '这个住处没有这项设施')
    if seat_id is not None and (not isinstance(seat_id, str) or seat_id not in catalog or catalog[seat_id][0] != activity):
        raise LivingError('invalid_action', '这个座位当前不可用')
    occupied = set(occupied)
    candidates = [seat_id] if seat_id is not None else [key for key, value in catalog.items() if value[0] == activity]
    for key in candidates:
        x, z = positions[key]
        clear = all(hypot(x - px, z - pz) >= 1.25 for px, pz in occupied_positions)
        if catalog[key][1] not in occupied and clear:
            return {'activity': activity, 'seat_id': key, 'station_version': 1}
    raise LivingError('invalid_action', '座位已被使用或当前没有可用座位')


def projected_world(world):
    result = {'activity': 'observe', 'area': 'outdoor'} if world is None else dict(world)
    leisure = result.get('leisure')
    if leisure:
        result['area'] = leisure_area(leisure['activity'])
    else:
        result.pop('leisure', None)
    return result


def occupied_seats(scene_type, items, companions, *, except_id=None):
    """Include base sofa rest and saved leisure aliases in the same namespace."""
    catalog = station_catalog(scene_type, items)
    companions = list(companions)
    used = set()
    for companion in companions:
        if companion.get('id') == except_id:
            continue
        assignment = companion.get('leisure')
        if valid_leisure(scene_type, items, assignment):
            used.add(catalog[assignment['seat_id']][1])
    if scene_type == 'home':
        resting = sorted((c for c in companions if c.get('activity') == 'rest'
                          and c.get('area', 'indoor') == 'indoor'), key=lambda c: c['id'])
        for index, companion in enumerate(resting[:3]):
            if companion.get('id') != except_id:
                used.add('sofa-' + str(index))
    return used


def occupied_station_positions(scene_type, items, companions, *, except_id=None):
    items, companions = list(items), list(companions)
    positions = seat_positions(scene_type, items)
    result = []
    for companion in companions:
        if companion.get('id') == except_id:
            continue
        assignment = companion.get('leisure')
        if valid_leisure(scene_type, items, assignment):
            result.append(positions[assignment['seat_id']])
    if scene_type == 'home':
        resting = sorted((c for c in companions if c.get('activity') == 'rest'
                          and c.get('area', 'indoor') == 'indoor'), key=lambda c: c['id'])
        for index, companion in enumerate(resting[:3]):
            if companion.get('id') != except_id:
                result.append(positions['television-' + str(index)])
    return result
