#!/usr/bin/env python3
"""Owned, offline acceptance; requires existing Node/deps, Chrome/Playwright, CJK Fontconfig and unshare."""
import hashlib, json, os, pathlib, shutil, subprocess, tempfile, time

repo=pathlib.Path(os.environ.get('REPO',os.getcwd())).resolve()
out=pathlib.Path(os.environ['OUT']).resolve();out.mkdir(parents=True,exist_ok=True)
candidate='6ef9f3f6bdceabedf42e3feaf83c40a8218e3f1e'
protected=['src','tests','scripts','package.json','package-lock.json','vitest.config.ts']
def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],text=True).strip()
subprocess.run(['git','-C',str(repo),'diff','--exit-code',candidate,'--',*protected],check=True)
assert git('status','--porcelain','--',*protected)=='', 'protected inputs must be clean'
node=shutil.which('node');assert node
workspace=repo.parents[1] if repo.parent.name=='.worktrees' else repo
scratch=pathlib.Path(tempfile.mkdtemp(prefix='.b5-',dir=workspace))
(scratch/'package.json').write_text('{"type":"commonjs"}\n')
for name in ['home','tmp','xdg-data','xdg-config']:(scratch/name).mkdir()
assert len(str(scratch/'tmp/org.chromium.Chromium.XXXXXX/SingletonSocket'))<108
env={'PATH':str(pathlib.Path(node).parent)+':/usr/bin:/bin','HOME':str(scratch/'home'),'TMPDIR':str(scratch/'tmp'),
     'XDG_CONFIG_HOME':str(scratch/'xdg-config'),'XDG_DATA_HOME':str(scratch/'xdg-data'),'LANG':'C.UTF-8','TZ':'UTC','IS_SANDBOX':'1','REPO':str(repo)}
for name in ['CHROME','PW_DIR','FONTCONFIG_FILE']:env[name]=os.environ[name]
harness=repo/'docs/screenshots/beta5-acceptance-6ef9/harness'
receipt={'candidate':candidate,'head':git('rev-parse','HEAD'),'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
 'inputs':{p:git('rev-parse',candidate+':'+p) for p in protected},
 'harnesses':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in harness.iterdir() if p.is_file()},
 'namespace':'unshare user + network + PID + private /proc; only loopback enabled; PID1 exit ends descendants',
 'environmentKeys':sorted(env),'browser':subprocess.check_output([env['CHROME'],'--version'],text=True).strip(),
 'fontconfigDigest':hashlib.sha256(pathlib.Path(env['FONTCONFIG_FILE']).read_bytes()).hexdigest(),'runs':[]}
def run(name,args,extra=None):
    active={**env,**(extra or {})}
    command=['unshare','-Urnpf','--mount-proc','/bin/sh','-c','ip link set lo up; exec "$@"','acceptance',*args]
    with (out/(name+'.log')).open('w') as log:
        p=subprocess.run(command,cwd=repo,env=active,stdout=log,stderr=subprocess.STDOUT,timeout=180)
    receipt['runs'].append({'name':name,'exit':p.returncode,'command':command})
    assert p.returncode==0,name+' failed; see log'
try:
    files=['codex-receipt-latency-3578','delivery-forwards-1756','wake-saved-config','claude-cold-resume-retry-2322','claude-file-send-card-2322','muse-1.4.15-audit','zh-admin-word-2820']
    run('focused',[node,str(repo/'node_modules/vitest/vitest.mjs'),'run',*['tests/'+x+'.test.ts' for x in files],'--maxWorkers=3','--reporter=json','--outputFile='+str(out/'focused.json')])
    run('codex-replay',[node,'--import','tsx','scripts/manual/codex-receipt-3578/replay.mts'],{'MODE':'after','OUT':str(out/'codex-replay.json')})
    run('recorded-stories',[node,'--import','tsx',str(harness/'recorded-stories.mts')],{'OUT':str(out/'recorded-stories.json')})
    run('wording',[node,'--import','tsx',str(harness/'wording.mts')],{'OUT':str(out/'wording'),'HP':'48680'})
    subprocess.run(['git','-C',str(repo),'diff','--exit-code',candidate,'--',*protected],check=True)
    receipt['protectedInputsCleanAfter']=git('status','--porcelain','--',*protected)==''
finally:
    shutil.rmtree(scratch)
    receipt['scratchRemoved']=not scratch.exists()
    receipt['finishedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    (out/'campaign-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print('PASS: isolated 178-test campaign, recorded tmux and parser stories, four browser wording journeys; scratch removed.')
