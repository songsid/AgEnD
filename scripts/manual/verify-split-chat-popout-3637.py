"""Verify capture-time Git/served-byte bindings and unchanged ordinary single-pane pixels."""
import hashlib,json,pathlib,subprocess,sys
from functools import lru_cache
from PIL import Image,ImageChops
root=pathlib.Path(__file__).resolve().parents[2]
evidence=root/'docs/evidence/desktop-split-chat-pr4'
def sha(b): return hashlib.sha256(b).hexdigest()
@lru_cache(maxsize=None)
def blob(ref,path): return subprocess.check_output(['git','show',f'{ref}:{path}'],cwd=root,stderr=subprocess.DEVNULL)
def source(path):
 if path=='/assets/inter.woff2': return 'src/ui/shared/fonts/inter.woff2'
 if path.startswith('/assets/office-'): return 'src/ui/shared/office/'+path[15:]
 if path.startswith('/assets/'): return 'src/ui/shared/'+path[8:]
 if path.startswith('/ui/js/'): return 'src/ui/'+path[7:]
 raise AssertionError(path)
summary={'runs':0,'checkpoints':0,'pngs':0,'inputBindings':0,'servedBindings':0,'substitutions':0,'omittedAssetBodies':0,'pixelPairs':[],'unknownAssets':[],'currentAssetDeltas':[]}
for p in sorted((evidence/'browser').glob('*/receipt.json')):
 r=json.loads(p.read_text()); assert not r['dirty'],p
 tree=subprocess.check_output(['git','rev-parse',r['head']+'^{tree}'],cwd=root,text=True).strip(); assert tree==r['tree'],p
 for digest,paths in r['inputs'].items():
  for path in paths:
   path='scripts/manual/smoke/smoke-split-chat-popout-3637.mts' if path=='harness' else path
   assert sha(blob(r['head'],path))==digest,(p,path)
   # Presentation/product inputs must remain byte-identical to the reviewed tree.
   if path.startswith('src/'):
    assert sha((root/path).read_bytes())==digest,(p,'changed capture input',path)
   summary['inputBindings']+=1
 for digest,paths in r['substitutions'].items():
  for path in paths:
   assert sha(blob(r['oldRef'],path))==digest,(p,path);summary['substitutions']+=1
 for digest,paths in r['assets'].items():
  for path in paths:
   src=source(path)
   try: candidate=sha(blob(r['head'],src))
   except subprocess.CalledProcessError:
    summary['unknownAssets'].append(path);continue
   assert candidate==digest or src in r['substitutions'].get(digest,[]),(p,path,digest)
   if candidate==digest and (root/src).exists() and sha((root/src).read_bytes())!=candidate and src not in summary['currentAssetDeltas']: summary['currentAssetDeltas'].append(src)
   summary['servedBindings']+=1
 assert not r.get('errors') and not r.get('external') and not r.get('effects'),p
 summary['runs']+=1;summary['checkpoints']+=len(r['cases']);summary['pngs']+=len(list(p.parent.glob('*.png')));summary['omittedAssetBodies']+=len(r.get('omittedAssets',[]))
for theme in ['light','dark']:
 for prefix in ['', 'phone-']:
  a=evidence/'browser'/f'{prefix}before-{theme}'/f'{theme}-zh-TW-single-before.png'
  b=evidence/'browser'/f'{prefix}current-{theme}'/f'{theme}-zh-TW-single-before.png'
  x,y=Image.open(a).convert('RGBA'),Image.open(b).convert('RGBA');assert x.size==y.size
  count=sum(1 for pixel in ImageChops.difference(x,y).getdata() if any(pixel))
  summary['pixelPairs'].append({'before':str(a.relative_to(evidence)),'after':str(b.relative_to(evidence)),'size':x.size,'changedPixels':count});assert count==0,(a,b,count)
assert not summary['unknownAssets'],summary['unknownAssets']
print(json.dumps(summary,indent=2))
if len(sys.argv)>1: pathlib.Path(sys.argv[1]).write_text(json.dumps(summary,indent=2)+'\n')
