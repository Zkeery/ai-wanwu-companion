"""Load the character-only direction into the isolated website, with no paid calls."""
import json
import subprocess
import sys
import time

import httpx

from scripts.check_real_web_acceptance import snapshot
from scripts.run_real_web import PROJECT, ROOT, save

RUN = ROOT / 'acceptance' / 'character-only-application'
EVIDENCE = PROJECT / 'docs/PRD/版本/V1.2/验收证据/阶段3/独立3D角色约束'


def main():
    if RUN.exists():
        raise FileExistsError('Application checkpoint already exists; inspect it before any retry')
    RUN.mkdir(parents=True, mode=0o700)
    before = snapshot()
    save(RUN / 'before.json', before)
    result = {'status': 'started', 'new_model_requests': 0}
    save(RUN / 'result.json', result)
    subprocess.run([sys.executable, '-m', 'scripts.run_real_web', 'restart-backend'],
                   cwd=PROJECT / 'backend', check=True, capture_output=True, timeout=20)
    deadline = time.monotonic() + 20
    with httpx.Client(timeout=2, trust_env=False) as client:
        while True:
            try:
                response = client.get('http://127.0.0.1:8052/api/v1/real-experience')
                response.raise_for_status()
                loaded = response.json()
                break
            except httpx.HTTPError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.2)
    after = snapshot()
    checks = {key: before[key] == after[key]
              for key in ('tables', 'files', 'original_budget', 'active_budget')}
    checks['sqlite_integrity'] = after['sqlite_integrity'] == 'ok'
    checks['loaded_direction'] = loaded.get('appearance_style_id') == 'whimsical-object-spirit-v2'
    checks['real_provider'] = loaded.get('source') == 'real_provider' and loaded.get('mock_fallback') is False
    result.update(status='verified' if all(checks.values()) else 'failed', checks=checks,
                  tables=len(after['tables']), files=len(after['files']),
                  appearance_style_id=loaded.get('appearance_style_id'),
                  excluded_session_fields=['last_seen_at', 'expires_at'],
                  budget_before=before['active_budget'], budget_after=after['active_budget'])
    save(RUN / 'result.json', result)
    save(EVIDENCE / '应用与重启核对.json', result)
    print(json.dumps(result, ensure_ascii=False))
    if result['status'] != 'verified':
        raise ValueError('Application verification failed; do not make paid calls')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--after-candidate', type=int)
    args = parser.parse_args()
    if args.after_candidate is not None:
        if args.after_candidate < 9:
            parser.error('Post-generation verification requires a new character-only candidate')
        RUN = ROOT/'acceptance'/f'character-only-{args.after_candidate}-post-generation'
        EVIDENCE = PROJECT/'docs/PRD/版本/V1.2/验收证据/阶段3/四项验收续跑'/f'造型差异修订-{args.after_candidate}'
    try:
        main()
    except Exception as exc:
        print(json.dumps({'status': 'stopped', 'error_type': type(exc).__name__}))
        sys.exit(1)
