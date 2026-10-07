"""Durable, guest-only full regression receipt, independent of RPC wait limits."""
from pathlib import Path
import argparse
import json
import os
import platform
import subprocess
import sys
import xml.etree.ElementTree as ET

PROJECT = Path(__file__).resolve().parents[2]


def save(path, value):
    path.write_text(json.dumps(value, indent=2))
    path.chmod(0o600)


def main():
    if sys.platform != 'linux' or platform.machine() != 'aarch64':
        raise ValueError('requires_isolated_linux_arm64_guest')
    parser = argparse.ArgumentParser()
    parser.add_argument('--native', action='store_true')
    parser.add_argument('--label', choices=['initial', 'native', 'baseline', 'fixtures'])
    parser.add_argument('--failed-only', action='store_true')
    args = parser.parse_args()
    label = args.label or ('native' if args.native else 'initial')
    native = label != 'initial'
    work = PROJECT / ('.runtime/r813-full-regression' if label == 'initial'
                      else '.runtime/r813-full-regression-' + label)
    work.mkdir(mode=0o700, parents=True)
    receipt = work / 'result.json'
    save(receipt, dict(phase='running', controller_pid=os.getpid()))
    env = {k: os.environ[k] for k in ('HOME', 'PATH', 'LANG') if k in os.environ}
    env.update(APP_ENV='development', MODEL_API_KEY='', MODEL_BASE_URL='', IMAGE_BASE_URL='',
               SMS_LIVE_ENABLED='false')
    if native:
        env['LD_LIBRARY_PATH'] = str(PROJECT / '.runtime/r813-codec/lib')
    result = dict(phase='failed', exit_code=None)
    try:
        selected = []
        if args.failed_only:
            cache = PROJECT / 'backend/.pytest_cache/v/cache/lastfailed'
            selected = sorted(json.loads(cache.read_text()))
            if not selected or any(not name.startswith('tests/test_') or '::' not in name for name in selected):
                raise ValueError('invalid_or_empty_failed_selection')
            result['selected_previous_failures'] = len(selected)
        log = work / 'pytest.log'
        with log.open('wb') as output:
            log.chmod(0o600)
            completed = subprocess.run([sys.executable, '-m', 'pytest', '-q', *selected,
                                       '--junitxml=' + str(work / 'junit.xml')],
                                      cwd=PROJECT / 'backend', env=env,
                                      stdout=output, stderr=subprocess.STDOUT, timeout=1200)
        suites = ET.parse(work / 'junit.xml').getroot().iter('testsuite')
        counts = {k: 0 for k in ('tests', 'failures', 'errors', 'skipped')}
        for suite in suites:
            for key in counts:
                counts[key] += int(suite.attrib.get(key, '0'))
        result.update(phase='finished', exit_code=completed.returncode, counts=counts,
                      summary=log.read_text().splitlines()[-1])
    except subprocess.TimeoutExpired:
        result.update(error='full_regression_timeout')
    except Exception as error:
        result.update(error=type(error).__name__)
    finally:
        save(receipt, result)


if __name__ == '__main__':
    main()
