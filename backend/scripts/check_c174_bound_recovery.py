"""Restore adopted motion assets and durable approval receipts into a new directory."""
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys

from scripts import c174_batch as batch
from scripts import run_c174_motion as motion


def files(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for name in ('uploads', 'workflow') for p in sorted((root/name).rglob('*')) if p.is_file()}


def database(path):
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        assets=db.execute('select character_id,activity,pack_id,source_sha256,manifest_json '
                          'from character_activity_motion_assets order by character_id,activity').fetchall()
        requests=db.execute('select character_id,activity,state from motion_generation_activity_requests '
                            'order by character_id,activity').fetchall()
        tasks=db.execute('select character_id,activity,state from motion_preparation_tasks '
                         'order by character_id,activity').fetchall()
        return {'integrity':db.execute('pragma integrity_check').fetchone()[0],
                'assets':[list(r) for r in assets],'requests':[list(r) for r in requests],
                'tasks':[list(r) for r in tasks]}


def main():
    if len(sys.argv)>1:
        print(json.dumps(database(sys.argv[1]),ensure_ascii=False));return
    source=motion.ROOT
    target=batch.WORK/'bound-restore'
    before=database(source/'motion.db');before_files=files(source)
    if not target.exists():
        target.mkdir()
        with sqlite3.connect(f'file:{source / "motion.db"}?mode=ro',uri=True) as src:
            with sqlite3.connect(target/'motion.db') as dst: src.backup(dst)
        for name in ('uploads','workflow'): shutil.copytree(source/name,target/name)
        shutil.copyfile(source/'state.json',target/'state.json')
    # A fresh Python interpreter opens the restored database; no model imports or network.
    process=subprocess.run([sys.executable,'-m','scripts.check_c174_bound_recovery',str(target/'motion.db')],
                           capture_output=True,text=True,check=True)
    after=json.loads(process.stdout)
    passed=(before==after and before_files==files(target) and database(source/'motion.db')==before
            and files(source)==before_files and after['integrity']=='ok' and len(after['assets'])==15
            and len(after['tasks'])==15 and all(r[2]=='ready' for r in after['tasks']))
    evidence={'passed':passed,'fresh_process_verified':True,'integrity':after['integrity'],
              'bound_assets':len(after['assets']),'ready_preparation_tasks':sum(r[2]=='ready' for r in after['tasks']),
              'generation_request_rows_preserved':len(after['requests']),
              'asset_and_receipt_files':len(before_files),'all_file_hashes_equal':before_files==files(target),
              'database_rows_equal':before==after,'source_unchanged':database(source/'motion.db')==before,
              'additional_model_requests':0,'restore_path':str(target.relative_to(batch.PROJECT))}
    previous=batch.EVIDENCE/'动作绑定异目录恢复.json'
    initial=batch.EVIDENCE/'初次恢复探针.json'
    if previous.exists() and not initial.exists(): batch.save(initial,json.loads(previous.read_text()))
    batch.save(previous,evidence)
    print(json.dumps(evidence,ensure_ascii=False))
    if not passed: raise ValueError('Bound recovery did not pass')


if __name__=='__main__':main()
