import pathlib,subprocess,json,hashlib,os,gzip,re
root=pathlib.Path.cwd();out=root/'.artifacts/menus-r1';out.mkdir(exist_ok=True)
git=lambda *a:subprocess.check_output(['git',*a],text=True).strip()
source='src/ui/shared/ui-menu.js';test='tests/web-chat-menus-2959.test.ts';p=root/source;original=p.read_bytes();needle='item.icon && item.checked ?'
assert original==subprocess.check_output(['git','show','HEAD:'+source]) and original.decode().count(needle)==2
r={'head':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'inputs':{},'checks':[]}
for name in [source,test]:r['inputs'].setdefault(hashlib.sha256((root/name).read_bytes()).hexdigest(),[]).append(name)
saved=out/'receipt.json'
if saved.exists():
 prior=json.loads(saved.read_text());assert prior['head']==r['head'] and prior['inputs']==r['inputs'];r=prior
for name in ['both','checkbox','radio','restored']:
 if any(c['label']==name for c in r['checks']):continue
 load=os.getloadavg()[0]
 if load>10:raise SystemExit(f'PAUSE {name}: load {load}')
 text=original.decode()
 if name=='both':text=text.replace(needle,'false ?')
 if name=='checkbox':text=text.replace(needle,'false ?',1)
 if name=='radio':
  i=text.rindex(needle);text=text[:i]+text[i:].replace(needle,'false ?',1)
 try:
  p.write_text(text);subprocess.run(['node','--check',source],check=True,capture_output=True)
  if os.getloadavg()[0]>10:raise SystemExit('PAUSE before Vitest; restore source')
  cmd=['npx','vitest','run',test,'--maxWorkers=1']
  if name=='restored':cmd+=['tests/web-chat-workspace-entry-3637.test.ts','tests/web-favorites-1664.test.ts']
  else:cmd+=['-t','keeps a visible selection check']
  q=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);log=q.stdout;plain=re.sub(rb'\x1b\[[0-9;]*m',b'',log)
  (out/(name+'.log.gz')).write_bytes(gzip.compress(log,mtime=0))
  if name=='restored':assert q.returncode==0 and re.search(rb'Tests\s+39 passed',plain),plain[-2000:]
  else:assert q.returncode!=0 and b'AssertionError' in plain and re.search(('Tests\\s+'+str(2 if name=='both' else 1)+' failed').encode(),plain),plain[-2000:]
  r['checks'].append({'label':name,'command':cmd,'exit':q.returncode,'assertionCaught':name!='restored','startLoad':load,'uncompressedLog':hashlib.sha256(log).hexdigest()})
  print(name,q.returncode,flush=True)
 finally:
  p.write_bytes(original);assert p.read_bytes()==original;saved.write_text(json.dumps(r,indent=2)+'\n')
assert len(r['checks'])==4
