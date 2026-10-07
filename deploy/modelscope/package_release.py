"""Create a source-only upload directory; never copy local accounts or secrets."""
from pathlib import Path
import json
import shutil
import tarfile
import base64
import io

PROJECT = Path(__file__).resolve().parents[2]
TARGET = PROJECT / '.runtime/modelscope-release/source'


def main():
    if TARGET.exists():
        raise SystemExit('Release source already exists; inspect it before replacing.')
    candidates = []
    roots = ['backend/app', 'backend/assets', 'backend/scripts', 'frontend/app',
             'frontend/components', 'frontend/lib', 'frontend/public']
    for root in roots:
        candidates.extend(path for path in (PROJECT / root).rglob('*')
                          if path.is_file() and '__pycache__' not in path.parts)
    files = ['backend/requirements.txt', 'frontend/package.json', 'frontend/package-lock.json',
             'frontend/next.config.ts', 'frontend/tsconfig.json', 'frontend/next-env.d.ts',
             'frontend/postcss.config.mjs', 'deploy/modelscope/nginx.conf',
             'deploy/modelscope/start.py']
    candidates.extend(PROJECT / name for name in files)
    secrets = []
    for file in (PROJECT / '.env', PROJECT / 'backend/.env', PROJECT / 'frontend/.env.local'):
        if not file.exists():
            continue
        for line in file.read_text().splitlines():
            key, sep, value = line.partition('=')
            value = value.strip().strip('"\'')
            if sep and any(word in key.upper() for word in ('KEY', 'TOKEN', 'SECRET', 'PASSWORD')) and len(value) >= 8:
                secrets.append(value.encode())
    mappings = [(path, path.relative_to(PROJECT)) for path in candidates]
    mappings.extend((PROJECT / 'deploy/modelscope' / name, Path(name)) for name in
                    ('Dockerfile', 'README.md', 'start.py', 'bootstrap_invites.py', 'serve.py'))
    mappings.append((PROJECT / 'backend/app/services/prompts.py', Path('prompts.py')))
    mappings.append((PROJECT / 'backend/app/services/parsers.py', Path('parsers.py')))
    mappings.append((PROJECT / 'backend/app/services/generation_errors.py', Path('generation_errors.py')))
    mappings.append((PROJECT / 'backend/scripts/real_web_budget.py', Path('real_web_budget.py')))
    mappings.extend((PROJECT / 'backend/app/api' / name, Path(name)) for name in
                    ('model_availability.py', 'characters.py', 'photos.py', 'chat.py', 'life_runtime.py', 'personality.py'))
    mappings.append((PROJECT / 'frontend/components/create-companion.tsx', Path('create-companion.tsx')))
    mappings.append((PROJECT / 'frontend/lib/api.ts', Path('api.ts')))
    mappings.append((PROJECT / 'frontend/lib/personality.ts', Path('personality.ts')))
    for source, relative in mappings:
        if source.is_symlink() or '.env' in relative.name or relative.suffix in ('.db', '.sqlite', '.pem'):
            raise SystemExit(f'Unexpected private file: {relative}')
        if any(secret in source.read_bytes() for secret in secrets):
            raise SystemExit(f'Credential found in source: {relative}')
    for source, relative in mappings:
        dest = TARGET / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
    upload = TARGET.parent / 'upload'
    upload.mkdir(exist_ok=True)
    # The web uploader also stores large binary files as LFS pointers.
    # Small text parts remain ordinary blobs in the Docker build context.
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name in ('backend', 'frontend', 'deploy'):
            archive.add(TARGET / name, arcname=name)
    encoded = base64.b64encode(buffer.getvalue())
    for number, offset in enumerate(range(0, len(encoded), 900_000)):
        (upload / f'source-part-{number:03d}.txt').write_bytes(encoded[offset:offset + 900_000])
    for name in ('Dockerfile', 'README.md', 'start.py', 'bootstrap_invites.py', 'serve.py', 'prompts.py', 'parsers.py', 'generation_errors.py', 'real_web_budget.py',
                 'model_availability.py', 'characters.py', 'photos.py', 'chat.py', 'life_runtime.py', 'personality.py', 'create-companion.tsx', 'api.ts', 'personality.ts'):
        shutil.copyfile(TARGET / name, upload / name)
    print(json.dumps({'path': str(upload), 'files': len(mappings),
                      'credential_matches': 0, 'local_accounts_included': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
