import collections, functools, hashlib, json, pathlib, subprocess
from urllib.parse import urlsplit
from PIL import Image, ImageChops
root=pathlib.Path.cwd(); evidence=root/'docs/evidence/desktop-split-chat-pr3'
sha=lambda b:hashlib.sha256(b).hexdigest()
@functools.cache
def blob(head,path): return subprocess.check_output(['git','show',f'{head}:{path}'],cwd=root,stderr=subprocess.DEVNULL)
checked=[]; totals=collections.Counter()
for receipt in sorted((evidence/'browser').glob('*/receipt.json')):
    r=json.loads(receipt.read_text()); assert r['dirty'] is False
    assert r['tree']==subprocess.check_output(['git','rev-parse',r['head']+'^{tree}'],cwd=root,text=True).strip()
    own=0; served=0; replaced=0
    for digest,paths in r['inputs'].items():
        for path in paths:
            actual='scripts/manual/smoke/smoke-split-chat-docking-3637.mts' if path=='harness' else path
            assert sha(blob(r['head'],actual))==digest,(receipt,path)
            own+=1
    for digest,paths in r['substitutions'].items():
        for path in paths:
            if not path.startswith('src/'): assert r['retained']=='server'; continue
            assert sha(blob(r['oldRef'],path))==digest,(receipt,path,'substitution')
            replaced+=1
    for digest,paths in r['assets'].items():
        for path in paths:
            path=urlsplit(path).path
            source=('src/ui/shared/'+path[8:]) if path.startswith('/assets/') else ('src/ui/'+path[7:]) if path.startswith('/ui/js/') else None
            if source=='src/ui/shared/inter.woff2': source='src/ui/shared/fonts/inter.woff2'
            assert source,(receipt,path)
            versions=[r['head']]
            if r['retained']: versions.append(r['oldRef'])
            assert any(sha(blob(ref,source))==digest for ref in versions),(receipt,path,'served')
            served+=1
    for case in r['cases']: assert (receipt.parent/case['file']).is_file()
    totals.update(inputs=own,served=served,substitutions=replaced,cases=len(r['cases']))
    checked.append({'receipt':str(receipt.relative_to(evidence)),'head':r['head'],'tree':r['tree'],'inputs':own,'served':served,'substitutions':replaced,'cases':len(r['cases'])})
(evidence/'checks/capture-provenance.json').write_text(json.dumps({'scope':'Original clean captures; each input, served asset and retained substitution compared with its recorded Git object. No historical relabelling.','totals':dict(totals),'runs':checked},indent=2)+'\n')
pixels=[]
for theme in ['light','dark']:
    before=evidence/f'browser/before-{theme}/{theme}-zh-TW-single.png'; after=evidence/f'browser/current-{theme}/{theme}-zh-TW-single.png'
    a=Image.open(before).convert('RGBA'); b=Image.open(after).convert('RGBA'); assert a.size==b.size
    changed=sum(p!=(0,0,0,0) for p in ImageChops.difference(a,b).getdata()); assert changed==0,(theme,changed)
    pixels.append({'theme':theme,'before':str(before.relative_to(evidence)),'after':str(after.relative_to(evidence)),'size':a.size,'differentPixels':changed})
(evidence/'checks/single-pixel-comparison.json').write_text(json.dumps({'comparisons':pixels},indent=2)+'\n')
print(json.dumps({'provenance':dict(totals),'singlePixelComparisons':pixels},indent=2))
