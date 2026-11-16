import pathlib,subprocess,uuid,json,shutil,time,os,sys
base=pathlib.Path(__file__).resolve().parent
if '--authorization-verified' not in sys.argv:
    raise SystemExit('Requires a new, separately verified one-run approval; --authorization-verified is not itself permission')
for required in ['portable/package','proof.mjs','library.mjs','public-evidence.mjs','runtime-pane-private.ps1']:
    assert (base/required).exists(), 'Prepare the isolated WSL payload before any Windows access'
sha='6a7aeaacbe913cd54b9d12b7ca874db92e7b6446'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==sha
runid=str(uuid.uuid4())
ledgerdir=base.parent/('windows-proof-'+runid);ledgerdir.mkdir()
name='agend-answer-only-proof-M3257-'+runid
root=None
winroot=None
node='/mnt/c/Program Files/nodejs/node.exe'
marker='M3257-one-proof-'+sha
started=time.monotonic()
ledger={'source':sha,'runId':runid,'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'created':[],'removed':[],'windowsHide':True,'modelRetry':False}
def public_value(value):
    p=subprocess.run(['node',str(base/'public-evidence.mjs'),'--stdin'],input=json.dumps(value),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,check=True)
    return json.loads(p.stdout)
def write_public(path,value):
    path.write_text(json.dumps(public_value(value),indent=2)+'\n')
def nodecode(code,timeout=30):
    return subprocess.run([node,'-e',code],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout)
vercode="const cp=require('node:child_process');cp.execFile(process.env.SystemRoot+'\\\\System32\\\\cmd.exe',['/d','/c','ver'],{windowsHide:true,shell:false,timeout:10000},(e,o)=>{if(e)process.exitCode=1;else console.log(JSON.stringify({ver:o.trim(),profile:require('node:os').homedir()}));});"
proc=None
try:
    before=nodecode(vercode,15);assert before.returncode==0,'Initial cmd.exe interop failed';metadata=json.loads(before.stdout);ledger['interopBefore']=metadata['ver'];profile=metadata['profile'];assert len(profile)>3 and profile[1:3]==':\\';winroot=profile+'\\'+name;root=pathlib.Path('/mnt')/profile[0].lower()/pathlib.Path(*pathlib.PureWindowsPath(profile).parts[1:])/name;ledger['root']=winroot;print(json.dumps(public_value({'phase':'interop-before','result':ledger['interopBefore']})),flush=True)
    assert not root.exists();root.mkdir();(root/'.owned').write_text(marker);(root/'temp').mkdir()
    ledger['created']=[winroot,winroot+'\\.owned',winroot+'\\temp']
    shutil.copytree(base/'portable'/'package',root/'portable')
    for f in ['proof.mjs','library.mjs','public-evidence.mjs','runtime-pane-private.ps1']:shutil.copy2(base/f,root/f)
    shutil.copytree(base.parents[2]/'node_modules'/'ws',root/'node_modules'/'ws')
    ledger['created'] += [winroot+'\\portable (verified @openai/codex 0.167.0-win32-x64)',winroot+'\\proof.mjs',winroot+'\\library.mjs',winroot+'\\public-evidence.mjs',winroot+'\\runtime-pane-private.ps1',winroot+'\\node_modules\\ws']
    boot="""const fs=require('node:fs'),cp=require('node:child_process'),p=require('node:path');const root=ROOT;const e={...process.env,TEMP:p.join(root,'temp'),TMP:p.join(root,'temp')};const child=cp.spawn(process.execPath,[p.join(root,'proof.mjs'),root],{cwd:root,env:e,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});fs.writeFileSync(p.join(root,'host.pid'),String(child.pid),{flag:'wx'});let done=false;const timer=setTimeout(()=>{if(done)return;cp.execFile(p.join(process.env.SystemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,timeout:15000},()=>{});},810000);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.on('error',()=>{clearTimeout(timer);process.exitCode=1;});child.on('close',code=>{done=true;clearTimeout(timer);process.exitCode=code??1;});""".replace('ROOT',json.dumps(winroot))
    proc=subprocess.Popen([node,'-e',boot],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    while proc.poll() is None:
        if time.monotonic()-started>855:raise TimeoutError('15-minute proof ceiling approaching; cleanup now')
        time.sleep(2)
    out,err=proc.communicate(timeout=10)
    (ledgerdir/'host.stdout').write_text(public_value(out))
    # Top-level script errors contain no credentials; retain a bounded tail only.
    (ledgerdir/'host.stderr').write_text(public_value(err[-4096:]))
    ledger['hostExit']=proc.returncode
    if (root/'result.json').exists():
        result=json.loads((root/'result.json').read_text());write_public(ledgerdir/'result.json',result);print(json.dumps({'phase':'finished','outcome':result['outcome'],'modelAttempts':result['modelAttempts'],'checks':result['checks'],'failure':result.get('failure')}),flush=True)
    else:ledger['failure']='Host exited without a sanitized result';print(json.dumps(public_value({'phase':'host-failed','exit':proc.returncode,'stderr':err[-1500:]})),flush=True)
except Exception as e:
    ledger['controllerFailure']=type(e).__name__+': '+str(e)[:200];print(json.dumps(public_value({'phase':'controller-failure','message':ledger['controllerFailure']})),flush=True)
finally:
    # Query only this UUID's image/command line; never select by generic process name.
    ps="$ErrorActionPreference='Stop'; @((Get-CimInstance Win32_Process -Filter \"ExecutablePath LIKE '%RUNID%' OR CommandLine LIKE '%RUNID%'\") | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne NODEPID } | Select-Object ProcessId,Name) | ConvertTo-Json -Compress".replace('RUNID',runid)
    cleanup="""const cp=require('node:child_process'),p=require('node:path');const query=PS.replace('NODEPID',String(process.pid));const exe=p.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');const opts={windowsHide:true,shell:false,timeout:20000,maxBuffer:65536};function scan(){return new Promise((yes,no)=>cp.execFile(exe,['-NoProfile','-NonInteractive','-Command',query],opts,(e,o)=>{if(e)return no(Error('Owned process scan failed'));try{const x=JSON.parse(o.trim()||'[]');yes(Array.isArray(x)?x:[x]);}catch{no(Error('Owned process scan invalid'));}}));}(async()=>{const before=await scan();for(const row of before)await new Promise(yes=>cp.execFile(p.join(process.env.SystemRoot,'System32','taskkill.exe'),['/PID',String(row.ProcessId),'/T','/F'],opts,()=>yes()));const after=await scan();console.log(JSON.stringify({before,after}));if(after.length)process.exitCode=1;})().catch(e=>{console.log(JSON.stringify({error:e.message}));process.exitCode=1;});""".replace('PS',json.dumps(ps))
    try:
        c=nodecode(cleanup,60);ledger['ownedProcesses']=json.loads(c.stdout);assert c.returncode==0 and ledger['ownedProcesses'].get('after')==[],'Owned processes remain'
        if root is not None and root.exists():
            assert (root/'.owned').read_text()==marker,'Cleanup ownership mismatch'
            ledger['filesBeforeRemoval']=[str(p.relative_to(root)) for p in root.rglob('*')]
            shutil.rmtree(root);ledger['removed'].append(winroot)
        ledger['rootGone']=root is None or not root.exists()
        after=nodecode(vercode,15);assert after.returncode==0,'Final cmd.exe interop failed';ledger['interopAfter']=json.loads(after.stdout)['ver'];ledger['interopEqual']=ledger.get('interopBefore')==ledger['interopAfter']
    except Exception as e:ledger['cleanupFailure']=type(e).__name__+': '+str(e)[:200]
    if proc is not None and proc.poll() is None:
        try:proc.communicate(timeout=10)
        except:pass
    ledger['finishedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());ledger['elapsedSeconds']=round(time.monotonic()-started,2)
    write_public(ledgerdir/'cleanup-ledger.json',ledger);(base/'last-evidence-path').write_text(str(ledgerdir))
    print(json.dumps(public_value({'evidence':str(ledgerdir),'elapsedSeconds':ledger['elapsedSeconds'],'rootGone':ledger.get('rootGone'),'interopEqual':ledger.get('interopEqual'),'cleanupFailure':ledger.get('cleanupFailure')})),flush=True)
