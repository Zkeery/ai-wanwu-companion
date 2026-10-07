"""Bounded live acceptance. Credentials remain in ignored, mode-0600 files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import traceback
from uuid import uuid4

import httpx

PROJECT = Path(__file__).resolve().parents[2]
PRIVATE = PROJECT / '.runtime/modelscope-release/private'
SESSIONS_ROOT = PROJECT / '.runtime/modelscope-release/acceptance'
ROOT = PROJECT / '.runtime/modelscope-release/acceptance-revision2'
BASE = 'https://zoekker-wanwu-companion.ms.show'
sys.path.insert(0, str(PROJECT / 'backend'))


def save(name, value):
    ROOT.mkdir(mode=0o700, exist_ok=True)
    path = ROOT / name
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as file:
        json.dump(value, file, ensure_ascii=False, indent=2)


def load(name):
    return json.loads((ROOT / name).read_text())


def headers(role='owner'):
    path = ROOT / 'sessions.json'
    if not path.exists():
        path = SESSIONS_ROOT / 'sessions.json'
    sessions = json.loads(path.read_text())
    return {'X-Companion-Authorization': 'Bearer ' + sessions[role]}


def accounts(client):
    sessions, checks = {}, {}
    for item in json.loads((PRIVATE / 'invitations.json').read_text()):
        reply = client.post('/api/v1/auth/invite', json={'code': item['code']})
        reply.raise_for_status()
        body = reply.json()
        assert body['user']['id'] == item['user_id']
        sessions[item['role']] = body['token']
        checks[item['role'] + '_login'] = True
    save('sessions.json', sessions)
    for role in sessions:
        assert client.get('/api/v1/auth/me', headers=headers(role)).status_code == 200
        checks[role + '_session'] = True
    wrong_header = client.get('/api/v1/auth/me', headers={'Authorization': 'Bearer ' + sessions['owner']})
    # The platform itself may reject its reserved Authorization header with 403.
    assert wrong_header.status_code in (401, 403)
    checks['gateway_accepts_only_app_header'] = True
    assert client.post('/api/v1/auth/logout', headers=headers('acceptance-b')).status_code == 204
    assert client.get('/api/v1/auth/me', headers=headers('acceptance-b')).status_code == 401
    checks['logout_revokes_session'] = True
    item = next(x for x in json.loads((PRIVATE / 'invitations.json').read_text()) if x['role'] == 'acceptance-b')
    sessions['acceptance-b'] = client.post('/api/v1/auth/invite', json={'code': item['code']}).json()['token']
    save('sessions.json', sessions)
    budget = client.get('/api/v1/deployment-check', headers=headers()).json()
    assert budget['release'] in ('cloud-desktop-20261002-budget-v1', 'cloud-desktop-20261002-budget-v2', 'cloud-desktop-20261002-budget-v3')
    assert budget['authorized'] and budget['budget_cny'] in (1, 2.8, 2.6)
    save('accounts.json', dict(checks=checks, budget=budget))
    return dict(checks_passed=len(checks), budget=budget)


def once(name):
    if (ROOT / (name + '-attempt.json')).exists():
        raise ValueError('prior_attempt_retained_no_automatic_repeat')
    value = {'request_id': str(uuid4())}
    save(name + '-attempt.json', value)
    return value['request_id']


def require_revision(client, expected_requests):
    response = client.get('/api/v1/deployment-check', headers=headers())
    response.raise_for_status()
    budget = response.json()
    assert budget['release'] == 'cloud-desktop-20261002-budget-v3'
    assert budget['authorized'] and not budget['paused']
    assert budget['budget_cny'] == 2.6 and budget['prior_reserved_cny'] == .4
    assert budget['requests_max'] == 4 and budget['requests'] == expected_requests
    assert budget['total_reserved_cny'] <= 3
    return budget


def parse_events(reply):
    events = []
    for block in reply.text.replace('\r\n', '\n').split('\n\n'):
        lines = block.splitlines()
        kind = next((line[7:] for line in lines if line.startswith('event: ')), None)
        data = '\n'.join(line[6:] for line in lines if line.startswith('data: '))
        if kind and data:
            events.append({'event': kind, 'data': json.loads(data)})
    return events


def recognize(client):
    from scripts.run_creation_smoke import synthetic_cup
    require_revision(client, 0)
    request_id = once('recognize')
    fixture = synthetic_cup()
    reply = client.post('/api/v1/photos', headers={**headers(), 'Idempotency-Key': request_id},
        files={'file': ('acceptance-cup.png', fixture, 'image/png')}, timeout=180)
    body = reply.json()
    save('recognize.json', dict(status=reply.status_code, body=body,
        fixture_sha256=hashlib.sha256(fixture).hexdigest(), synthetic_fixture=True))
    reply.raise_for_status()
    assert body['objects']
    assert client.get('/api/v1/photos/' + str(body['id']), headers=headers()).status_code == 200
    assert client.get('/api/v1/photos/' + str(body['id']), headers=headers('acceptance-a')).status_code == 404
    return dict(status=reply.status_code, recognized_objects=len(body['objects']), cross_account_denied=True,
        budget=client.get('/api/v1/deployment-check', headers=headers()).json())


def generate(client):
    require_revision(client, 1)
    once('generate')
    photo = load('recognize.json')['body']
    reply = client.post('/api/v1/characters', headers=headers(),
        json={'object_id': photo['objects'][0]['id']}, timeout=180)
    events = []
    for block in reply.text.replace('\r\n', '\n').split('\n\n'):
        lines = block.splitlines()
        kind = next((line[7:] for line in lines if line.startswith('event: ')), None)
        data = '\n'.join(line[6:] for line in lines if line.startswith('data: '))
        if kind and data:
            events.append({'event': kind, 'data': json.loads(data)})
    save('generate.json', dict(status=reply.status_code, events=events))
    assert events and events[-1]['event'] in ('done', 'error')
    terminal = events[-1]
    result = dict(status=reply.status_code, terminal=terminal['event'],
        budget=client.get('/api/v1/deployment-check', headers=headers()).json())
    if terminal['event'] == 'error':
        result['error_code'] = terminal['data'].get('error', {}).get('code')
        result['reason'] = terminal['data'].get('error', {}).get('reason')
        return result
    character = terminal['data']
    save('character.json', character)
    image_path = '/uploads/' + character['image_path']
    image = client.get(image_path, headers=headers())
    assert image.status_code == 200
    assert client.get(image_path).status_code == 401
    assert client.get(image_path, headers=headers('acceptance-a')).status_code == 404
    assert client.get('/api/v1/characters/' + str(character['id']), headers=headers('acceptance-a')).status_code == 404
    descriptor = os.open(ROOT / 'generated-character.png', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'wb') as file:
        file.write(image.content)
    result.update(character_id=character['id'], private_image=True, cross_account_denied=True,
        image_sha256=hashlib.sha256(image.content).hexdigest(), image_bytes=len(image.content))
    save('generation-checks.json', result)
    return result


def chat(client):
    require_revision(client, 2)
    request_id = once('chat')
    character = load('character.json')
    path = '/api/v1/characters/' + str(character['id'])
    reply = client.post(path + '/chat', headers=headers(),
        json={'message': '你好，今天第一次见面，请用一句话介绍一下你自己。', 'request_id': request_id}, timeout=180)
    events = parse_events(reply)
    save('chat.json', dict(status=reply.status_code, events=events))
    reply.raise_for_status()
    assert events and events[-1]['event'] == 'done'
    messages = client.get(path + '/messages', headers=headers()).json()
    assert any(item['role'] == 'assistant' and item['content'].strip() for item in messages)
    assert client.get(path + '/messages', headers=headers('acceptance-a')).status_code == 404
    save('messages.json', messages)
    return dict(terminal='done', messages_persisted=True, cross_account_denied=True,
        budget=client.get('/api/v1/deployment-check', headers=headers()).json())


def prepare_life(client):
    character = load('character.json')
    response = client.get('/api/v1/living/spaces', headers=headers())
    response.raise_for_status()
    space = next((item for item in response.json() if item['mode'] == 'private'
        and str(item['companion_id']) == str(character['id']) and item['scene_type'] == 'home'), None)
    if space is None:
        response = client.post('/api/v1/living/spaces', headers=headers(),
            json={'mode': 'private', 'scene_type': 'home', 'companion_id': str(character['id'])})
        response.raise_for_status()
        space = response.json()
    space_id = space['id']
    location = client.put('/api/v1/characters/' + str(character['id']) + '/location',
        headers=headers(), json={'space_id': space_id})
    location.raise_for_status()
    assert location.json()['space_id'] == space_id
    path = '/api/v1/living/spaces/' + space_id + '/life-runtime'
    current = client.get(path, headers=headers())
    current.raise_for_status()
    snapshot = current.json()
    assert snapshot['origin'] == 'real_provider'
    assert snapshot['present']
    assert not snapshot['automatic']['enabled']
    response = client.put(path + '/permission', headers=headers(), json={
        'request_id': str(uuid4()), 'expected_revision': snapshot['permission']['revision'],
        'enabled': True, 'activities': ['rest', 'walk', 'observe']})
    response.raise_for_status()
    assert client.get(path, headers=headers('acceptance-a')).status_code == 404
    save('life-space.json', {'id': space_id})
    return dict(space_id=space_id, permission_saved=True, automatic_enabled=False,
        cloud_startup_allowance_required=True)


def life(client):
    require_revision(client, 3)
    task_id = once('life')
    space_id = load('life-space.json')['id']
    path = '/api/v1/living/spaces/' + space_id + '/life-runtime'
    scheduled = client.post(path + '/tasks', headers=headers(), json={'request_id': task_id})
    scheduled.raise_for_status()
    reply = client.post(path + '/tasks/' + task_id + '/run', headers=headers(), json={}, timeout=90)
    save('life.json', dict(status=reply.status_code, body=reply.json(), task_id=task_id))
    reply.raise_for_status()
    task = next(item for item in reply.json()['tasks'] if item['id'] == task_id)
    assert task['state'] == 'done'
    assert client.get(path, headers=headers('acceptance-a')).status_code == 404
    result = dict(task_state=task['state'], activity=task['activity'], cross_account_denied=True,
        budget=client.get('/api/v1/deployment-check', headers=headers()).json())
    save('life-checks.json', result)
    return result


def restore(client):
    checks = {}
    for role in ('owner', 'acceptance-a', 'acceptance-b'):
        assert client.get('/api/v1/auth/me', headers=headers(role)).status_code == 200
        checks[role + '_session_persisted'] = True
    if (ROOT / 'character.json').exists():
        character = load('character.json')
        current = client.get('/api/v1/characters/' + str(character['id']), headers=headers()).json()
        assert current == character
        image = client.get('/uploads/' + character['image_path'], headers=headers())
        assert hashlib.sha256(image.content).hexdigest() == load('generation-checks.json')['image_sha256']
        checks.update(character_persisted=True, private_image_persisted=True)
    if (ROOT / 'messages.json').exists():
        path = '/api/v1/characters/' + str(load('character.json')['id']) + '/messages'
        assert client.get(path, headers=headers()).json() == load('messages.json')
        checks['messages_persisted'] = True
    if (ROOT / 'life-checks.json').exists():
        space_id = load('life-space.json')['id']
        current = client.get('/api/v1/living/spaces/' + space_id + '/life-runtime', headers=headers()).json()
        task_id = load('life.json')['task_id']
        assert any(task['id'] == task_id and task['state'] == 'done' for task in current['tasks'])
        checks['life_result_persisted'] = True
    budget = client.get('/api/v1/deployment-check', headers=headers()).json()
    assert budget['paused'], 'Acceptance batch must be closed on final restart'
    checks['budget_closed_persistently'] = True
    save('restart-checks.json', dict(checks=checks, budget=budget))
    return dict(checks=checks, budget=budget)


def normal_service(client):
    state = client.get('/api/v1/deployment-check', headers=headers()).json()
    assert state['service_mode'] == 'normal'
    assert state['acceptance_guard_active'] is False
    assert state['paused'] is True  # Archived acceptance batch remains closed.
    reply = client.get('/api/v1/characters/generation-credits', headers=headers())
    reply.raise_for_status()
    credits = reply.json()
    assert credits.get('model_available', True) is True
    assert credits['available'] == 4
    assert client.get('/api/v1/characters', headers=headers()).status_code == 200
    result = dict(service_mode='normal', acceptance_guard_active=False,
        account_credits=credits['available'], archived_acceptance=state,
        verification='read_only_no_model_request')
    save('normal-service-checks.json', result)
    return result


def availability(client):
    before = client.get('/api/v1/deployment-check', headers=headers()).json()
    assert before['paused'] and before['requests'] == 4
    reply = client.get('/api/v1/characters/generation-credits', headers=headers())
    reply.raise_for_status()
    credits = reply.json()
    assert credits['model_available'] is False
    assert credits['available'] == 4
    assert 'AI服务已暂停' in credits['unavailable_message']
    # Only exercise the newly advertised closed state; never probe an open batch.
    upload = client.post('/api/v1/photos', headers=headers(),
        files={'file': ('availability-check.png', b'synthetic-no-image', 'image/png')})
    assert upload.status_code == 503
    assert upload.json()['error']['code'] == 'model_service_paused'
    after = client.get('/api/v1/deployment-check', headers=headers()).json()
    assert after == before
    result = dict(service_paused=True, credits_preserved=credits['available'],
        error_code=upload.json()['error']['code'], no_new_provider_calls=True, budget=after)
    save('availability-checks.json', result)
    return result


def diagnose(client):
    reply = client.get('/api/v1/deployment-check/receipts', headers=headers())
    reply.raise_for_status()
    save('provider-receipts.json', reply.json())
    assert client.get('/api/v1/deployment-check/receipts', headers=headers('acceptance-a')).status_code == 404
    return dict(receipts_saved=len(reply.json()['receipts']), owner_only=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['accounts', 'recognize', 'generate', 'chat', 'prepare_life', 'life', 'restore', 'diagnose', 'availability', 'normal_service'])
    args = parser.parse_args()
    try:
        # Test the public browser ingress. ModelScope sends Python SDK agents to
        # a different inference hostname, before requests reach the application.
        with httpx.Client(base_url=BASE, timeout=30, follow_redirects=False,
            headers={'User-Agent': 'Mozilla/5.0 (compatible; WanwuDeploymentCheck/1.0)'}) as client:
            result = globals()[args.phase](client)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        detail = {'phase': args.phase, 'error_type': type(exc).__name__,
                  'details_retained_privately': True,
                  'check_line': traceback.extract_tb(exc.__traceback__)[-1].lineno}
        if isinstance(exc, httpx.HTTPStatusError):
            detail['http_status'] = exc.response.status_code
            detail['route'] = exc.request.url.path
            try:
                detail['error_code'] = exc.response.json().get('error', {}).get('code')
            except (ValueError, AttributeError):
                pass
        print(json.dumps(detail))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
