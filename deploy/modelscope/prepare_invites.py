"""Prepare private local codes and public hashes for the first cloud accounts."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
from uuid import uuid4


def main():
    root = Path(__file__).resolve().parents[2] / '.runtime/modelscope-release/private'
    root.mkdir(mode=0o700, exist_ok=False)
    private, hashes = [], []
    for role, days in [('owner', 30), ('acceptance-a', 1), ('acceptance-b', 1)]:
        code, uid = secrets.token_urlsafe(32), str(uuid4())
        expiry = (datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=days)).isoformat()
        private.append(dict(role=role, code=code, user_id=uid, expires_at=expiry))
        hashes.append(dict(user_id=uid, code_hash=hashlib.sha256(code.encode()).hexdigest(), expires_at=expiry))
    for filename, data in [('invitations.json', private), ('bootstrap-hashes.json', hashes)]:
        descriptor = os.open(root / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(data, output)
    descriptor = os.open(root / 'owner-invitation.txt', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write('万物伙伴私密登录信息\nhttps://zoekker-wanwu-companion.ms.show/\n邀请码：'
                     + private[0]['code'] + '\n到期（UTC）：' + private[0]['expires_at'] + '\n')
    print(json.dumps({'private_directory': str(root), 'prepared_accounts': len(private),
                      'codes_printed': False, 'cloud_accounts_created': False}))


if __name__ == '__main__':
    main()
