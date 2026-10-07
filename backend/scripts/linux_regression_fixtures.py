"""Transfer only explicitly whitelisted public regression assets to the local VM."""
import re
import zipfile
from dotenv import dotenv_values
from linux_rehearsal import PROJECT, WORK, INSTANCE, guest_root, lima
from rehearse_release import zip_files

ROOT = 'docs/PRD/版本/V1.2/验收证据/'
PUBLIC = [
    'tests/fixtures/input-limits.json',
    ROOT + '阶段1/R1.5真实样图本地动作',
    ROOT + '阶段1/R1.6表情与转圈小样',
    ROOT + '阶段3/C1.32真实生活规划新批次/真实结果.json',
    ROOT + '阶段3/C1.38原图分帧动作',
    ROOT + '阶段3/C1.45三活动姿态总图',
    ROOT + '阶段3/C1.48火山单张候选/seedream-atlas-unreviewed.png',
    ROOT + '阶段3/C1.51透明能力与步态编排',
    ROOT + '阶段7/R7.5真实首轮20260923/results.json',
    ROOT + '阶段7/R7.3杯子测试图.png',
    ROOT + '阶段7/R7.7图生图小样',
    ROOT + '阶段7/R7.5候选评测计划.json',
    ROOT + '阶段7/R7.8Seedream隔离小样/plan.json',
    ROOT + '阶段7/R7.11Klein零预算探针',
    ROOT + '阶段7/R7.14古灵精怪免费体验/apple-9b.jpg',
]


def main():
    names = []
    for name in PUBLIC:
        path = PROJECT / name
        paths = [path] if path.is_file() else path.rglob('*')
        names.extend(str(p.relative_to(PROJECT)) for p in paths if p.is_file()
                     and p.suffix.lower() in {'.json', '.jpg', '.jpeg', '.png', '.webp', '.mp4'})
    archive = WORK / 'regression-fixtures.zip'
    archive.unlink(missing_ok=True)  # Only this task's disposable fixture archive.
    zip_files(PROJECT, names, archive)
    needles = set()
    for name in ('.env', 'backend/.env', 'frontend/.env.local'):
        file = PROJECT / name
        if file.exists():
            needles.update(v.encode() for k, v in dotenv_values(file, interpolate=False).items()
                           if v and len(v) >= 8 and re.search(r'KEY|SECRET|TOKEN|PASSWORD', k))
    with zipfile.ZipFile(archive) as data:
        if any(any(v in data.read(n) for v in needles) for n in data.namelist()):
            raise ValueError('credential_in_public_regression_fixture')
    root = guest_root()
    lima('copy', str(archive), INSTANCE + ':' + root + '/' + archive.name)
    lima('shell', INSTANCE, 'python3', '-m', 'zipfile', '-e', root + '/' + archive.name, root)
    lima('shell', INSTANCE, 'sudo', 'apt-get', 'install', '-y', 'ffmpeg', timeout=600)
    print('public_regression_fixtures_and_linux_ffmpeg_ready')


if __name__ == '__main__':
    main()
