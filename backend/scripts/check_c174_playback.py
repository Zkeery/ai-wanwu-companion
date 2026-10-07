"""Real browser checks of fifteen production-player bindings; no model calls."""
import json
import argparse
import os
import subprocess
import sys

from scripts import c174_batch as batch

SCRIPT=r'''
const t=await taskSpace(16);const p=t.page("p1");
const root="/Users/zoe/Documents/happy/项目开发必备文档/projects/AI万物伙伴/docs/PRD/版本/V1.2/验收证据/阶段3/C1.74质量与稳定性/";
const results=[];
await p.cdp("Emulation.setDeviceMetricsOverride",{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
for(let cid=1;cid<=5;cid++){
  await p.goto("http://localhost:3058/companions/"+cid);
  await p.waitForSelector("button[aria-label=放大伙伴形象]");
  await p.click("button[aria-label=放大伙伴形象]");
  for(const [activity,label] of [["rest","休息"],["walk","散步"],["observe","观察"]]){
    const result=await p.evaluate(async label=>{
      const delay=ms=>new Promise(r=>setTimeout(r,ms));
      const find=text=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===text);
      const choose=find(label);if(!choose)throw Error("Action control unavailable");choose.click();
      const deadline=Date.now()+15000;let play;
      while(!(play=find("看看"+label+"动作"))&&Date.now()<deadline)await delay(100);
      if(!play)throw Error("Bound action did not become ready");
      play.click();await delay(1500);
      const canvas=document.querySelector("canvas");if(!canvas)throw Error("Production canvas missing");
      const hashes=[];
      const sizes=[];
      for(let i=0;i<12;i++){
        sizes.push(canvas.toDataURL().length);
        const raw=new TextEncoder().encode(canvas.toDataURL());
        const digest=await crypto.subtle.digest("SHA-256",raw);
        hashes.push([...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join(""));
        await delay(250);
      }
      return {unique_frame_hashes:new Set(hashes).size,frame_changed:new Set(hashes).size>1,
        painted_frame_count:sizes.filter(n=>n>5000).length,
        images_loaded:[...document.images].every(i=>i.complete&&i.naturalWidth>0),
        overflow:document.documentElement.scrollWidth>innerWidth};
    },label);
    results.push({character_id:cid,activity,...result});
  }
  await p.screenshot({path:root+"绑定播放-"+cid+"-桌面.png"});
}
await p.cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
await p.screenshot({path:root+"绑定播放-5-手机.png"});
const mobile=await p.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,
  images_loaded:[...document.images].every(i=>i.complete&&i.naturalWidth>0)}));
await p.reload();await p.waitForSelector("button[aria-label=放大伙伴形象]");
await p.click("button[aria-label=放大伙伴形象]");
const refreshed=await p.evaluate(async()=>{
  const deadline=Date.now()+10000;
  while(![...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="看看休息动作")&&Date.now()<deadline)
    await new Promise(r=>setTimeout(r,100));
  return document.body.textContent.includes("已就绪");
});
console.log("C174_PLAYBACK="+JSON.stringify({results,mobile,refresh_kept_ready:refreshed}));
'''


def main():
    before=batch.status()['counts']['motion']
    result=subprocess.run(['ego-browser','nodejs','-e',SCRIPT],capture_output=True,text=True)
    lines=(result.stdout+'\n'+result.stderr).splitlines()
    matches=[line.split('C174_PLAYBACK=',1)[1] for line in lines if line.startswith('C174_PLAYBACK=')]
    if result.returncode or len(matches)!=1:
        print(json.dumps({'status':'failed','error':'browser_check_incomplete'}));sys.exit(1)
    evidence=json.loads(matches[0])
    evidence.update(origin='real_bound_assets',paid_motion_requests_before=before,
        paid_motion_requests_after=batch.status()['counts']['motion'],
        additional_model_requests=0 if before==batch.status()['counts']['motion'] else None)
    evidence['passed']=(len(evidence['results'])==15 and all(r['frame_changed'] and r['painted_frame_count']>1 and r['images_loaded']
        and not r['overflow'] for r in evidence['results']) and evidence['refresh_kept_ready']
        and not evidence['mobile']['overflow'] and evidence['mobile']['images_loaded']
        and evidence['additional_model_requests']==0)
    batch.save(batch.EVIDENCE/'实际播放验证.json',evidence)
    print(json.dumps({'passed':evidence['passed'],'checked':len(evidence['results']),
        'frame_changes':sum(r['frame_changed'] for r in evidence['results']),
        'additional_model_requests':evidence['additional_model_requests']}))
    if not evidence['passed']:sys.exit(1)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--launch',action='store_true')
    if parser.parse_args().launch:
        previous=batch.EVIDENCE/'实际播放验证.json'
        initial=batch.EVIDENCE/'初次播放探针.json'
        if previous.exists() and not initial.exists():
            batch.save(initial,json.loads(previous.read_text()))
        with (batch.WORK/'playback.log').open('a') as log:
            proc=subprocess.Popen([sys.executable,'-m','scripts.check_c174_playback'],
                cwd=batch.PROJECT/'backend',env=os.environ.copy(),stdin=subprocess.DEVNULL,
                stdout=log,stderr=log,start_new_session=True)
        print(json.dumps({'status':'running','pid':proc.pid}))
    else: main()
