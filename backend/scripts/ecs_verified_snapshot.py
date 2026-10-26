"""Bounded private snapshot of this ECS layout; no production replacement or network."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, sqlite3, tarfile, time, fcntl
EXCLUDED={'.venv','node_modules','.next','__pycache__','.git','.pytest_cache','.ruff_cache'}
MANIFEST='.snapshot-manifest.json'
MAX_BYTES=512*1024*1024

def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def encode(v):
 if isinstance(v,bytes):return {'blob_hex':v.hex()}
 raise TypeError('Unsupported SQLite value')
def sqlfacts(p):
 with sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=10) as c:
  c.execute('BEGIN')
  if c.execute('pragma integrity_check').fetchone()[0]!='ok':raise ValueError('database_integrity')
  schema=c.execute('select type,name,tbl_name,sql from sqlite_master order by type,name').fetchall()
  tables={}
  for name, in c.execute("select name from sqlite_master where type='table' order by name"):
   rows=c.execute('select * from "'+name.replace('"','""')+'"').fetchall()
   encoded=sorted(json.dumps(r,ensure_ascii=False,separators=(',',':'),default=encode) for r in rows)
   tables[name]={'count':len(rows),'sha256':hashlib.sha256(json.dumps(encoded,separators=(',',':')).encode()).hexdigest()}
  return {'kind':'sqlite','schema':schema,'tables':tables,'user_version':c.execute('pragma user_version').fetchone()[0],'application_id':c.execute('pragma application_id').fetchone()[0]}
def selected(root):
 required=['data','runtime/motion-video-batch-20261016','runtime/paid-flow-acceptance-20261016','app/backend/app','app/backend/scripts','app/frontend']
 for rel in required:
  if not (root/rel).is_dir():raise ValueError('required_root_missing')
 optional=['runtime/c155-aihubmix-walk']
 extras=[]
 for p in (root/'app/backend').iterdir():
  if p.is_file() and (p.name in ['requirements.txt','requirements-dev.txt','pyproject.toml','poetry.lock','uv.lock']):extras.append(str(p.relative_to(root)))
 return sorted(required+extras+[x for x in optional if (root/x).exists()]),[x for x in optional if not (root/x).exists()]
def inventory(root,roots):
 result={};size=0
 def visit(p):
  nonlocal size
  rel=str(p.relative_to(root))
  if p.is_symlink():raise ValueError('symlink_rejected')
  if p.is_dir():
   result[rel]={'kind':'directory'}
   for x in sorted(p.iterdir()):
    if rel.startswith('app/') and (x.name in EXCLUDED or x.name.startswith(('.env','.next-')) or x.suffix in ['.pyc','.pyo','.tsbuildinfo']):continue
    if x.name.endswith(('-wal','-shm','-journal')) and Path(str(x).rsplit('-',1)[0]).suffix=='.db':continue
    visit(x)
  elif p.is_file():
   size+=p.stat().st_size
   if size>MAX_BYTES or len(result)>30000:raise ValueError('snapshot_capacity')
   result[rel]=sqlfacts(p) if p.suffix=='.db' else {'kind':'file','bytes':p.stat().st_size,'sha256':digest(p)}
  else:raise ValueError('unsupported_file')
 for rel in roots:
  for parent in reversed(Path(rel).parents):
   if str(parent)!='.':result[str(parent)]={'kind':'directory'}
  visit(root/rel)
 return json.loads(json.dumps(result)),size

def new_separate(root,target):
 if root.is_symlink() or target.is_symlink():raise ValueError('unsafe_root')
 root=root.resolve();target=target.resolve()
 if target.exists() or target.is_relative_to(root/'data') or target.is_relative_to(root/'runtime') or target.is_relative_to(root/'app') or not target.parent.is_dir():raise ValueError('new_target_required')
 return root,target

def capture(root,target):
 root,target=new_separate(root,target)
 roots,absent=selected(root);before,size=inventory(root,roots)
 if shutil.disk_usage(target.parent).free < size*4+1024**3:raise ValueError('free_space')
 # Intent must exist before any backup content is written. No retry or overwrite.
 target.mkdir(mode=0o700);save(target/'operation.json',{'state':'capturing','started_at':int(time.time())})
 snapshot=target/'snapshot';snapshot.mkdir(mode=0o700)
 try:
  for rel,fact in before.items():
   src=root/rel;dst=snapshot/rel
   if fact['kind']=='directory':dst.mkdir(mode=0o700,parents=True,exist_ok=True)
   elif fact['kind']=='sqlite':
    with sqlite3.connect(src.as_uri()+'?mode=ro',uri=True) as a,sqlite3.connect(dst) as b:a.backup(b)
    dst.chmod(0o600)
   else:
    with src.open('rb') as a,dst.open('xb') as b:shutil.copyfileobj(a,b)
    dst.chmod(0o600)
  copied,_=inventory(snapshot,roots);after,_=inventory(root,roots)
  if before!=copied or before!=after or selected(root)!=(roots,absent):raise ValueError('source_changed_or_incomplete')
  m={'schema':1,'layout':'wanwu-shared-ecs-20261016','created_at':int(time.time()),'roots':roots,'absent_roots':absent,'entries':before,'api_environment_excluded':True,'source_unchanged':True}
  save(snapshot/MANIFEST,m)
  archive=target/'snapshot.tar'
  with tarfile.open(archive,'x') as t:
   # Archive exactly the validated logical manifest; SQLite read checks may create
   # transient WAL/SHM sidecars, which are not part of the backup contract.
   for rel in sorted([*before,MANIFEST]):t.add(snapshot/rel,arcname=rel,recursive=False)
  archive.chmod(0o600)
  for p in target.rglob('*'):
   if p.is_file():
    with p.open('rb') as f:os.fsync(f.fileno())
  result={'state':'verified','created_at':m['created_at'],'entries':len(before),'databases':sum(x['kind']=='sqlite' for x in before.values()),'source_bytes':size,'archive_bytes':archive.stat().st_size,'archive_sha256':digest(archive),'source_unchanged':True,'absent_roots':absent,'network_requests':0,'automatic_retries':0}
  save(target/'operation.json',result);return result
 except Exception as e:
  save(target/'operation.json',{'state':'failed','error_type':type(e).__name__,'automatic_retries':0});raise

def restore(archive,target,sha):
 if archive.is_symlink() or digest(archive)!=sha:raise ValueError('archive_checksum')
 if target.exists() or target.is_symlink() or not target.parent.is_dir():raise ValueError('new_restore_required')
 with tarfile.open(archive) as t:
  members=t.getmembers();names=set();total=0
  for m in members:
   p=Path(m.name);total+=m.size
   if p.is_absolute() or '..' in p.parts or m.name in names or not(m.isdir() or m.isfile()) or total>MAX_BYTES*2:raise ValueError('unsafe_archive')
   names.add(m.name)
  mf=t.extractfile(MANIFEST)
  if mf is None:raise ValueError('manifest_missing')
  manifest=json.load(mf)
  if names!=set(manifest['entries'])|{MANIFEST}:raise ValueError('archive_inventory_mismatch')
  target.mkdir(mode=0o700)
  for m in members:
   p=target/m.name
   if m.isdir():p.mkdir(mode=0o700,parents=True,exist_ok=True)
   else:
    p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    with t.extractfile(m) as a,p.open('xb') as b:shutil.copyfileobj(a,b)
    p.chmod(0o600)
  actual,_=inventory(target,manifest['roots'])
  if actual!=manifest['entries']:raise ValueError('restored_content_mismatch')
 return {'state':'restored_verified','entries':len(actual),'databases':sum(x['kind']=='sqlite' for x in actual.values()),'network_requests':0,'production_overwritten':False}
def save(p,v):
 tmp=p.with_suffix(p.suffix+'.tmp')
 with tmp.open('w') as f:os.chmod(tmp,0o600);json.dump(v,f,ensure_ascii=False,sort_keys=True);f.flush();os.fsync(f.fileno())
 os.replace(tmp,p)
def main():
 a=argparse.ArgumentParser();a.add_argument('mode',choices=['capture','restore']);a.add_argument('--root',type=Path);a.add_argument('--target',type=Path,required=True);a.add_argument('--archive',type=Path);a.add_argument('--sha');v=a.parse_args()
 print(json.dumps(capture(v.root,v.target) if v.mode=='capture' else restore(v.archive,v.target,v.sha)))
if __name__=='__main__':main()
