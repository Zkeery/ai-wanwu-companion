"""Isolated synthetic UI proof. Never calls a real model or touches review data."""
from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

from scripts import rehearse_release as release

WORK = release.PROJECT / '.runtime' / 'c173-three-activities'
release.WORK = WORK
release.BACKEND_PORT, release.FRONTEND_PORT = 8058, 3058


def environment(state=None):
    state = state or WORK / 'backend-state'
    return release.backend_env(state) | {'WALK_WORKFLOW_ROOT': str(state / 'ledger')}


def seeded_character():
    from PIL import Image, ImageDraw
    from app.core.database import SessionLocal
    from app.models.models import Character
    from app.services.motion_generation import register_request
    receipt = original_seed()
    path = Path(os.environ['UPLOAD_DIR']) / 'synthetic-character.png'
    image = Image.new('RGB', (512, 512), '#f5efe2')
    draw = ImageDraw.Draw(image)
    draw.ellipse((145, 130, 367, 360), fill='#ee8c87')
    draw.ellipse((200, 215, 214, 229), fill='#503b37')
    draw.ellipse((296, 215, 310, 229), fill='#503b37')
    image.save(path)
    with SessionLocal() as db:
        character = db.get(Character, receipt['character'])
        character.name = '离线三类动作伙伴'
        character.image_path = path.name
        register_request(db, character)
        db.commit()
    return receipt


original_seed = release.seed


def advance(activity, accept=False):
    os.environ.update(environment())
    release.block_external_network()
    from PIL import Image, ImageDraw
    from datetime import date
    from app.core.config import get_settings
    from app.services import character_walk_workflow as flow, motion_generation as gen
    session = json.loads((WORK / 'session.json').read_text())
    cid, owner = session['character'], session['owner']
    # Both credential and image provider are synthetic, scoped to this process.
    flow.dotenv_values = lambda *args, **kwargs: {'AIHUBMIX_API_KEY': 'synthetic-offline-key'}
    get_settings().motion_generation_enabled = True
    def provider(path, key, *, expected_sha256, on_task, activity='walk'):
        assert key == 'synthetic-offline-key'
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected_sha256
        image = Image.new('RGBA', (1024, 1024))
        draw = ImageDraw.Draw(image)
        for y in (0, 512):
            for x in (0, 512):
                draw.ellipse((x + 145, y + 130, x + 367, y + 360), fill='#ee8c87')
        output = BytesIO(); image.save(output, format='PNG')
        on_task('synthetic-c173-' + activity)
        return output.getvalue(), {'input_tokens': 0, 'output_tokens': 0}
    plan = flow.plan(cid, owner, activity=activity)
    current = gen.status(cid, owner, activity=activity)
    gen.authorize(current['request_id'], owner, expected_source_sha256=plan['source_sha256'],
                  approval_ref='synthetic-c173-' + activity,
                  price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    assert gen.process_one(provider=provider, request_id=current['request_id'])
    candidate = gen._existing_candidate(cid, owner, activity)
    if accept:
        flow.review(candidate['job_id'], cid, owner, decision='accept',
                    candidate_sha256=candidate['candidate_sha256'], review_ref='offline-synthetic-accept')
    return {'activity': activity, 'state': gen.status(cid, owner, activity=activity)['state'],
            'synthetic_provider_calls': 1, 'actual_model_calls': 0}


def start(restored=False):
    for port in (8058, 3058):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))
    processes = []
    try:
        state = WORK / ('restored-state' if restored else 'backend-state')
        for name, command, cwd, env, port, route in (
            ('backend', [sys.executable, '-m', 'scripts.check_three_activity_flow', '_serve'],
             release.PROJECT / 'backend', environment(state), 8058, '/api/v1/auth/me'),
            ('frontend', ['node', 'server.js'], WORK / 'frontend-server',
             release.child_env(PORT='3058', HOSTNAME='127.0.0.1'), 3058, '/')):
            if name == 'backend' and restored:
                command.append('--restored')
            with (WORK / (name + '-start.log')).open('wb') as log:
                os.chmod(log.name, 0o600)
                process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=log,
                                           start_new_session=True)
            processes.append(process)
            release.private_json(WORK / 'processes.json', {'pids': [item.pid for item in processes]})
            release.wait_ready(process, port, route)
        return {'started': True, 'backend_port': 8058, 'frontend_port': 3058}
    except BaseException:
        for process in processes:
            release.stop(process)
        raise


def stop():
    file = WORK / 'processes.json'
    if not file.exists():
        return {'stopped': True}
    # Verify command provenance before terminating any detached process.
    for pid in json.loads(file.read_text())['pids']:
        check = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True)
        command = check.stdout.strip()
        if not command:
            continue
        if ('scripts.check_three_activity_flow _serve' not in command
                and command != 'node server.js' and not command.startswith('next-server (v')):
            raise ValueError('unexpected_owned_process')
        if 'scripts.check_three_activity_flow _serve' not in command:
            location = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'],
                                      capture_output=True, text=True, check=True)
            if 'n' + str(WORK / 'frontend-server') not in location.stdout.splitlines():
                raise ValueError('unexpected_owned_directory')
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 10
    while True:
        listening = False
        for port in (8058, 3058):
            with socket.socket() as probe:
                probe.settimeout(.2)
                listening |= probe.connect_ex(('127.0.0.1', port)) == 0
        if not listening:
            break
        if time.monotonic() >= deadline:
            raise ValueError('owned_process_stop_timeout')
        time.sleep(.1)
    file.unlink()
    return {'stopped': True}


def proof():
    session = json.loads((WORK / 'session.json').read_text())
    cid, token = session['character'], session['token']
    code, body = release.request(8058, f'/api/v1/characters/{cid}/motion-generation/activities', token)
    assert code == 200
    states = json.loads(body)['activities']
    assert [item['activity'] for item in states] == ['rest', 'walk', 'observe']
    assert all(item['state'] == 'ready' for item in states)
    sprites = {}
    for activity in ('rest', 'walk', 'observe'):
        code, body = release.request(8058, f'/api/v1/characters/{cid}/motion?activity={activity}', token)
        assert code == 200
        url = json.loads(body)['sprite_url']
        code, image = release.request(8058, url, token)
        assert code == 200
        assert release.request(8058, url)[0] == 401
        assert release.request(8058, url, session['other_token'])[0] == 404
        sprites[activity] = hashlib.sha256(image).hexdigest()
        code, body = release.request(8058, f'/api/v1/characters/{cid}/motion-candidates?activity={activity}', token)
        assert code == 200
        candidates = json.loads(body)['items']
        assert len(candidates) == 1 and candidates[0]['state'] == 'ready'
        assert release.request(8058, candidates[0]['image_url'], token)[0] == 200
    facts = {'states': states, 'sprite_sha256': sprites}
    before = WORK / 'proof-before.json'
    repeated = before.exists()
    if repeated:
        assert json.loads(before.read_text()) == facts
    else:
        release.private_json(before, facts)
    return {'three_ready': True, 'three_private_sprites': True, 'three_review_records_readable': True,
            'same_requests_and_assets_after_restart': repeated, 'actual_model_calls': 0}


def verify_artifacts():
    receipt = json.loads((WORK / 'receipt.json').read_text())
    assert (WORK / 'proof-before.json').is_file()
    # UI and asset checks above exercise this separately owned rehearsal.
    receipt['phase'] = 'exercised'
    release.private_json(WORK / 'receipt.json', receipt)
    result = release.verify_artifacts()
    manifest = result['artifact_manifest']
    return {'credential_matches': sum(item['credential_matches'] for item in manifest['artifacts']),
            'archive_members': sum(item['members'] for item in manifest['artifacts']),
            'original_configuration_unchanged': manifest['original_configuration_unchanged']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'build', 'start', 'stop', 'advance', '_serve', 'proof', 'verify-artifacts', 'cleanup'])
    parser.add_argument('--activity', choices=['rest', 'walk', 'observe'])
    parser.add_argument('--accept-synthetic', action='store_true')
    parser.add_argument('--restored', action='store_true')
    args = parser.parse_args()
    if args.phase == 'prepare':
        result = release.prepare()
    elif args.phase == 'build':
        result = release.build()
    elif args.phase == 'start':
        result = start(args.restored)
    elif args.phase == 'stop':
        result = stop()
    elif args.phase == 'advance':
        if not args.activity:
            parser.error('advance requires --activity')
        result = advance(args.activity, args.accept_synthetic)
    elif args.phase == 'proof':
        result = proof()
    elif args.phase == 'verify-artifacts':
        result = verify_artifacts()
    elif args.phase == '_serve':
        state = WORK / ('restored-state' if args.restored else 'backend-state')
        os.environ.update(environment(state))
        release.seed = seeded_character
        release.serve(WORK / 'backend-source', state)
        return
    else:
        if (WORK / 'processes.json').exists():
            raise ValueError('stop_before_cleanup')
        receipt = json.loads((WORK / 'receipt.json').read_text())
        receipt['phase'] = 'verified'
        release.private_json(WORK / 'receipt.json', receipt)
        result = release.cleanup()
        for name in ('backend-source.zip', 'frontend-source.zip', 'frontend-standalone-local.zip'):
            (WORK / name).unlink(missing_ok=True)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
