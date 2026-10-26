"""Private ECS checks and at-most-once Feishu fault/recovery delivery."""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import socket
import ssl
import subprocess
import time
import urllib.request
from uuid import uuid4

KNOWN_CODES = frozenset({
    'BACKEND_DOWN', 'FRONTEND_DOWN', 'BACKEND_HEALTH', 'FRONTEND_HEALTH',
    'BACKUP_MISSING', 'BACKUP_STALE', 'BACKUP_REVIEW', 'DISK_LOW',
    'OFFSITE_STALE', 'OFFSITE_REVIEW', 'CERTIFICATE_EXPIRING',
    'CERTIFICATE_UNREADABLE', 'CERTIFICATE_RENEW_FAILED', 'DRILL_FAULT',
    'HTTPS_LOCAL',
})


def save(path: Path, value: dict) -> None:
    tmp = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    with tmp.open('x', encoding='utf8') as stream:
        tmp.chmod(0o600)
        json.dump(value, stream, ensure_ascii=False, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    tmp.replace(path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def service(unit: str) -> dict:
    out = subprocess.check_output(['systemctl', 'show', unit, '-p', 'ActiveState,Result'],
                                  text=True, timeout=5)
    return dict(line.split('=', 1) for line in out.splitlines())


def collect(root: Path, *, now: int | None = None) -> list[str]:
    now = int(time.time()) if now is None else now
    codes = []
    for unit, code in [('wanwu-partner-backend', 'BACKEND_DOWN'),
                       ('wanwu-partner-frontend', 'FRONTEND_DOWN')]:
        if service(unit).get('ActiveState') != 'active':
            codes.append(code)
    for url, code in [('http://127.0.0.1:8020/healthz', 'BACKEND_HEALTH'),
                      ('http://127.0.0.1:3020/partner', 'FRONTEND_HEALTH')]:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status != 200:
                    codes.append(code)
        except Exception:
            codes.append(code)
    try:
        with socket.create_connection(('127.0.0.1', 443), timeout=5) as raw:
            with ssl.create_default_context().wrap_socket(raw, server_hostname='101.96.210.187'):
                pass
    except Exception:
        codes.append('HTTPS_LOCAL')
    backups = root / 'backups/scheduled'
    verified = []
    for path in backups.glob('run-*/scheduled-result.json'):
        try:
            data = json.loads(path.read_text())
            if data.get('state') == 'verified' and data.get('restore_verified') is True:
                verified.append(path.stat().st_mtime)
        except (ValueError, OSError):
            pass
    if not verified:
        codes.append('BACKUP_MISSING')
    elif max(verified) > now + 120 or now - max(verified) > 26 * 3600:
        codes.append('BACKUP_STALE')
    if (backups / 'review-required.json').exists():
        codes.append('BACKUP_REVIEW')
    usage = shutil.disk_usage(root)
    if usage.free < 512 * 1024 * 1024 or usage.free / usage.total < 0.10:
        codes.append('DISK_LOW')
    offsite = root / 'private/offsite-backup'
    if (offsite / 'review-required.json').exists():
        codes.append('OFFSITE_REVIEW')
    authorization = root / 'private/offsite-authorization.json'
    if authorization.is_file():
        config = json.loads(authorization.read_text())
        if config.get('enabled') is True:
            try:
                job = service('wanwu-partner-offsite-backup.service')
                if job.get('Result', '') not in ('success', ''):
                    codes.append('OFFSITE_REVIEW')
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
                codes.append('OFFSITE_REVIEW')
            status = json.loads((offsite / 'state.json').read_text()) if (offsite / 'state.json').exists() else {}
            if now - status.get('verified_at', 0) > 27 * 3600:
                codes.append('OFFSITE_STALE')
    certificate = root / 'private/acme/production/config/live/101.96.210.187/cert.pem'
    try:
        text = subprocess.check_output(['openssl', 'x509', '-in', str(certificate),
                                        '-noout', '-enddate'], text=True, timeout=5)
        expiry = dt.datetime.strptime(text.strip().split('=', 1)[1], '%b %d %H:%M:%S %Y %Z')
        if expiry.replace(tzinfo=dt.timezone.utc).timestamp() - now < 48 * 3600:
            codes.append('CERTIFICATE_EXPIRING')
    except Exception:
        codes.append('CERTIFICATE_UNREADABLE')
    if service('wanwu-partner-certificate-renew.service').get('Result') not in ('success', ''):
        codes.append('CERTIFICATE_RENEW_FAILED')
    return sorted(set(codes))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate(config: dict) -> None:
    if (config.get('enabled') is not True or config.get('approved') is not True
            or config.get('group_name') != '万物伙伴运维通知群'
            or not config.get('approval_ref') or not config.get('signing_secret')
            or not re.fullmatch(r'https://open\.feishu\.cn/open-apis/bot/v2/hook/[0-9a-f-]{32,36}',
                                config.get('webhook', ''))):
        raise ValueError('feishu_not_authorized_or_configured')


def deliver(config: dict, payload: dict) -> None:
    validate(config)
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    request = urllib.request.Request(config['webhook'], data=json.dumps(payload).encode(),
                                     headers={'Content-Type': 'application/json'}, method='POST')
    with opener.open(request, timeout=10) as response:
        raw = response.read(16385)
        if response.status != 200 or len(raw) > 16384:
            raise ValueError('feishu_response_invalid')
        data = json.loads(raw)
        code = data.get('code', data.get('StatusCode'))
        if type(code) is not int or code != 0:
            raise ValueError('feishu_business_failure')


def notify_once(area: Path, config: dict, codes: list[str], *, sender=deliver,
                now: int | None = None, drill_id: str | None = None) -> dict:
    validate(config)  # A disabled or incomplete configuration cannot open a network connection.
    if any(code not in KNOWN_CODES for code in codes):
        raise ValueError('unrecognized_alarm_code')
    now = int(time.time()) if now is None else now
    if area.is_symlink():
        raise ValueError('unsafe_notification_directory')
    area.mkdir(mode=0o700, parents=True, exist_ok=True)
    if area.stat().st_mode & 0o077:
        raise ValueError('notification_directory_not_private')
    fd = os.open(area / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = area / 'delivery.sqlite3'
        if path.is_symlink():
            raise ValueError('unsafe_notification_ledger')
        if path.exists():
            with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as pending:
                if pending.execute("select 1 from deliveries where state!='sent' limit 1").fetchone():
                    return {'state': 'delivery_review_required', 'network_requests': 0}
        previous = json.loads((area / 'state.json').read_text()) if (area / 'state.json').exists() else {}
        if previous.get('delivery_state') == 'unknown_or_failed':
            return {'state': 'delivery_review_required', 'network_requests': 0}
        codes = sorted(set(codes))
        signature = hashlib.sha256(json.dumps(codes).encode()).hexdigest()
        if previous.get('signature') == signature and not drill_id:
            return {'state': 'unchanged', 'network_requests': 0}
        if not codes and not previous and not drill_id:
            save(area / 'state.json', {'signature': signature, 'codes': [], 'observed_at': now, 'sequence': 0})
            return {'state': 'initial_healthy_silent', 'network_requests': 0}
        sequence = previous.get('sequence', 0) + 1
        destination = hashlib.sha256(config['webhook'].encode()).hexdigest()
        event = hashlib.sha256(f'{destination}:{sequence}:{signature}:{drill_id or ""}'.encode()).hexdigest()
        with sqlite3.connect(path) as db:
            path.chmod(0o600)
            db.execute('pragma synchronous=FULL')
            db.execute('create table if not exists deliveries(event text primary key, created integer, state text)')
            db.commit()
            if db.execute('select 1 from deliveries where event=?', (event,)).fetchone():
                return {'state': 'already_attempted', 'network_requests': 0}
            if db.execute('select count(*) from deliveries where created>=?', (now - 86400,)).fetchone()[0] >= 24:
                return {'state': 'daily_delivery_cap', 'network_requests': 0}
            db.execute('insert into deliveries values(?,?,?)', (event, now, 'attempted'))
            db.commit()  # A crash after this point must never cause automatic replay.
            timestamp = str(now)
            signing_key = (timestamp + '\n' + config['signing_secret']).encode()
            sign = base64.b64encode(hmac.new(signing_key, b'', hashlib.sha256).digest()).decode()
            kind = '故障' if codes else '恢复'
            text = f'【万物伙伴运维】{kind}' + ('（合成演练）' if drill_id else '')
            text += '\n状态码：' + (','.join(codes) if codes else 'RECOVERED')
            text += '\n事件：' + event[:12]
            payload = {'timestamp': timestamp, 'sign': sign, 'msg_type': 'text', 'content': {'text': text}}
            try:
                sender(config, payload)
                state = 'sent'
            except Exception:
                state = 'unknown_or_failed'
            db.execute('update deliveries set state=? where event=?', (state, event))
            db.commit()
        save(area / ('event-' + event + '.json'), {'event': event, 'state': state, 'codes': codes,
                                                  'observed_at': now, 'synthetic_drill': bool(drill_id)})
        save(area / 'state.json', {'signature': signature, 'codes': codes, 'observed_at': now,
                                  'sequence': sequence, 'delivery_state': state})
        return {'state': state, 'event': event, 'network_requests': 1}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--collect-only', action='store_true')
    args = parser.parse_args()
    try:
        codes = collect(args.root)
        area = args.root / 'private/ops-notifications'
        if area.is_symlink():
            raise ValueError('unsafe_notification_directory')
        area.mkdir(mode=0o700, parents=True, exist_ok=True)
        if area.stat().st_mode & 0o077:
            raise ValueError('notification_directory_not_private')
        save(area / 'latest-check.json', {'checked_at': int(time.time()), 'codes': codes})
        if args.collect_only:
            result = {'state': 'collected_only', 'codes': codes, 'network_requests': 0}
        else:
            if args.config.is_symlink() or args.config.stat().st_mode & 0o077:
                raise ValueError('private_notification_config_required')
            result = notify_once(area, json.loads(args.config.read_text()), codes)
    except Exception as error:
        result = {'state': 'blocked', 'error_type': type(error).__name__}
    print(json.dumps(result))
    return 0 if result['state'] in ('collected_only', 'sent', 'unchanged', 'initial_healthy_silent') else 2


if __name__ == '__main__':
    raise SystemExit(main())
