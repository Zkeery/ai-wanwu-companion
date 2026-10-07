"""Process-bound keep-awake leases for this project's continuous checks only."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

PROJECT = Path(__file__).resolve().parents[2]
RERUN = PROJECT/'.runtime/c174-quality-stability/wall-clock-24h-20261002-rerun'


def attach(root: Path, pid: int):
    if (root.is_symlink() or not root.resolve().is_relative_to((PROJECT/'.runtime').resolve())
            or root.resolve() == (PROJECT/'.runtime').resolve()):
        raise ValueError('Guard root must belong to this project')
    command = subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True).strip()
    cwd = subprocess.check_output(['lsof','-a','-p',str(pid),'-d','cwd','-Fn'],text=True)
    allowed = ('scripts.check_life_soak wall-clock', 'scripts.run_c174_life_soak run',
               'scripts.run_acceptance_life run')
    if not any(' -m '+module in command for module in allowed) or f'n{PROJECT/"backend"}\n' not in cwd:
        raise ValueError('Only this project soak process can hold a lease')
    path = root/'awake.json'
    if path.exists():
        old = json.loads(path.read_text())
        try:
            current = subprocess.check_output(['ps','-p',str(old['guard_pid']),'-o','command='],text=True).strip()
            if current.endswith(f'caffeinate -i -s -w {old["owner_pid"]}') and old['owner_pid']!=pid:
                raise ValueError('Previous lease is still active')
            if old['owner_pid']==pid and current.endswith(f'caffeinate -i -s -w {pid}'):
                return old
        except subprocess.CalledProcessError:
            pass
        if old['owner_pid']!=pid:
            history=root/f'awake-history-{old["owner_pid"]}.json'
            if history.exists():
                raise ValueError('Retain lease history without overwriting')
            path.rename(history)
    guard = subprocess.Popen(['/usr/bin/caffeinate','-i','-s','-w',str(pid)],cwd=PROJECT/'backend',
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    value = dict(owner_pid=pid,guard_pid=guard.pid,flags=['-i','-s','-w'],
                 release='owner_process_exit',system_power_settings_changed=False)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value));temp.chmod(0o600);temp.replace(path)
    return value


def launch_offline():
    if RERUN.exists():
        raise FileExistsError('Never overwrite or reset an existing continuous window')
    result = subprocess.check_output([sys.executable,'-m','scripts.check_life_soak','launch',
        '--run',str(RERUN),'--seconds','86400'],cwd=PROJECT/'backend',text=True)
    value = json.loads(result)
    value['awake'] = attach(RERUN,value['pid'])
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['launch-offline','attach'])
    parser.add_argument('--root',type=Path)
    parser.add_argument('--pid',type=int)
    args = parser.parse_args()
    if args.mode=='attach' and (args.root is None or args.pid is None):
        parser.error('attach requires this project run root and PID')
    print(json.dumps(launch_offline() if args.mode=='launch-offline' else attach(args.root,args.pid)))


if __name__=='__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'status':'stopped','error_type':type(exc).__name__}));sys.exit(1)
