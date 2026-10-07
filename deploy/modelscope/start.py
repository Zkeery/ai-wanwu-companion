"""One container, one persistent data root, graceful shutdown of all services."""
import os
import json
from pathlib import Path
import signal
import subprocess
import time


def main():
    root = Path('/mnt/workspace/wanwu-companion')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('data', 'runtime'):
        (root / name).mkdir(exist_ok=True, mode=0o700)
    target = Path('/app/.runtime')
    if not target.exists():
        target.symlink_to(root / 'runtime', target_is_directory=True)
    if target.resolve() != root / 'runtime':
        raise RuntimeError('Persistent runtime path mismatch')
    env = dict(os.environ)
    # These cannot be overridden with an ephemeral path in the platform UI.
    env['DATABASE_URL'] = f'sqlite:///{root}/data/app.db'
    env['UPLOAD_DIR'] = str(root / 'data/uploads')
    env['WALK_WORKFLOW_ROOT'] = str(root / 'runtime/c155-aihubmix-walk')
    if env.get('BOOTSTRAP_INVITES'):
        subprocess.run(['python', '-m', 'scripts.bootstrap_invites'],
            cwd='/app/backend', env=env, check=True, timeout=30)
        env['CLOUD_ACCEPTANCE_OWNER_ID'] = json.loads(env['BOOTSTRAP_INVITES'])[0]['user_id']
        env.pop('BOOTSTRAP_INVITES', None)
        os.environ.pop('BOOTSTRAP_INVITES', None)
    children = []
    stopping = False

    def stop(_signum=None, _frame=None):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        children.append(subprocess.Popen(['python', '-m', 'scripts.cloud_serve'],
            cwd='/app/backend', env=env, start_new_session=True))
        # Only public build settings are needed by Next. Do not pass model keys.
        public_env = {k: v for k, v in env.items() if k in ('PATH', 'NODE_ENV', 'NEXT_TELEMETRY_DISABLED')}
        public_env.update(PORT='3020', HOSTNAME='127.0.0.1', NODE_ENV='production')
        children.append(subprocess.Popen(['node', 'server.js'], cwd='/app/frontend',
            env=public_env, start_new_session=True))
        children.append(subprocess.Popen(['nginx', '-g', 'daemon off;'], start_new_session=True))
        while not stopping and all(child.poll() is None for child in children):
            time.sleep(0.25)
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        deadline = time.monotonic() + 25
        for child in children:
            try:
                child.wait(timeout=max(0.1, deadline-time.monotonic()))
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
    return 0 if stopping else 1


if __name__ == '__main__':
    raise SystemExit(main())
