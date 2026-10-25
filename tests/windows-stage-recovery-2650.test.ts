import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
const installer=resolve('website/public/install-agend.ps1'), source=readFileSync(installer,'utf8');
const pwsh=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command','1'],{timeout:60000}).status===0;
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'agend-stage-2650-')),bin=join(dir,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'wsl.exe'),'#!/bin/sh\necho "Unexpected native WSL boundary" >&2\nexit 91\n');chmodSync(join(bin,'wsl.exe'),0o755);
 const run=(body:string)=>{
  const file=join(dir,'test.ps1');writeFileSync(file,`$ErrorActionPreference='Stop'
$t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$t,[ref]$e)
if($e.Count){throw ($e|Out-String)}
foreach($f in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($f.Extent.Text))}
foreach($a in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(WSL_COMMAND_FN|RESTART_FN|ALL_BACKENDS|BACKEND_PROBE|BACKEND_PATH|UNATTENDED_INSTALL)$'},$false)){. ([scriptblock]::Create($a.Extent.Text))}
. ([scriptblock]::Create($WSL_COMMAND_FN)); . ([scriptblock]::Create($RESTART_FN))
function wsl {throw 'Direct native WSL forbidden'}
function Test-LiveConsole {return $false}
function Read-Host {throw 'Unexpected terminal question'}
$script:OnWindows=$false;$UBUNTU_DISTRO='Scratch';$AGEND_USER='operator';$AGEND_ENV='PRIVATE; ';$ProgressFile='${dir}/progress'
${body}`);
  return execFileSync('pwsh',['-NoProfile','-NonInteractive','-File',file],{encoding:'utf8',timeout:20000,env:{...process.env,HOME:dir,USERPROFILE:dir,TMPDIR:dir,PATH:`${bin}:${process.env.PATH}`}});
 };
 return {dir,bin,run,close:()=>rmSync(dir,{recursive:true,force:true})};
}
function scratch<T>(body:(f:ReturnType<typeof fixture>)=>T):T {const f=fixture();try{return body(f)}finally{f.close()}}

describe.skipIf(!pwsh)('bounded resumable Windows stages, all WSL/backend/service calls stubbed',()=>{
 it.each(['ok','headers','body'])('download byte/response deadlines abort and remove partial files: %s',mode=>scratch(f=>{
  const out=f.run(`$script:aborted=$false;$script:disposed=$false
$script:stream=[IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('download bytes'))
${mode==='body'?"$script:stream=[pscustomobject]@{};$script:stream|Add-Member ScriptMethod ReadAsync {param($b,$o,$n);return ([Threading.Tasks.TaskCompletionSource[int]]::new()).Task};$script:stream|Add-Member ScriptMethod Dispose {}":''}
$response=[pscustomobject]@{};$response|Add-Member ScriptMethod GetResponseStream {return $script:stream};$response|Add-Member ScriptMethod Dispose {$script:disposed=$true}
$script:responseTask=${mode==='headers'?"([Threading.Tasks.TaskCompletionSource[object]]::new()).Task":"[Threading.Tasks.Task]::FromResult($response)"}
$request=[pscustomobject]@{};$request|Add-Member ScriptMethod GetResponseAsync {return $script:responseTask};$request|Add-Member ScriptMethod Abort {$script:aborted=$true}
function New-InstallDownloadRequest {return $request}
try{Invoke-InstallDownload -Uri 'https://stub.invalid/file' -OutFile '${f.dir}/download' -TimeoutSec 2 -NoProgressSeconds 0.05;Write-Output 'DONE'}catch{Write-Output ('FAILED='+$_)}
Write-Output ('ABORTED='+$script:aborted+' EXISTS='+(Test-Path '${f.dir}/download'))`);
  expect(out).toContain('ABORTED=True');expect(out).toContain(mode==='ok'?'DONE':'no-progress deadline');
  expect(existsSync(join(f.dir,'download'))).toBe(mode==='ok');
  if(mode==='ok')expect(readFileSync(join(f.dir,'download'),'utf8')).toBe('download bytes');
 }));
 it('bootstrap and installer use identical download deadline helpers',()=>{
  const bootstrap=readFileSync(resolve('website/public/install.ps1'),'utf8');
  const helper=(s:string)=>s.slice(s.indexOf('function New-InstallDownloadRequest'),s.indexOf('\n}\n',s.indexOf('function Invoke-InstallDownload('))+3);
  expect(helper(source)).toBe(helper(bootstrap));
 });
 it.each([['exit 3',3],['sleep 10',124]])('bounded native probe returns its outcome: %s',(command,code)=>scratch(f=>{
  writeFileSync(join(f.bin,'wsl.exe'),`#!/bin/sh\n${command}\n`);
  const out=f.run(`$r=Invoke-BoundedWsl -Arguments @('--probe') -TimeoutSeconds 1; Write-Output ('CODE='+$r.Code)`);
  expect(out).toContain(`CODE=${code}`);
 }));
 it.each([[0.2,0],[10,0.2]])('watched absolute/no-progress deadlines stop only the owned child: %s/%s',(absolute,idle)=>scratch(f=>{
  const out=f.run(`$c=Invoke-Watched -Label 'private sleeper' -Usually 'test' -File '/bin/sleep' -Arguments @('10') -TimeoutSeconds ${absolute} -NoProgressSeconds ${idle}; Write-Output ('CODE='+$c)`);
  expect(out).toContain('CODE=124');expect(out).toContain('超過等待上限');
 }));
 it('keeps progressing output alive until the absolute deadline',()=>scratch(f=>{
  const job=join(f.dir,'progress.py');writeFileSync(job,'import time\nwhile True:\n print("progress",flush=True)\n time.sleep(0.1)\n');
  const out=f.run(`$c=Invoke-Watched -Label 'private progress' -Usually 'test' -File '/usr/bin/python3' -Arguments @('${job}') -TimeoutSeconds 1 -NoProgressSeconds 0.4; Write-Output ('CODE='+$c)`);
  expect(out.match(/progress/g)?.length).toBeGreaterThan(3);expect(out).toContain('CODE=124');
 }));
 it.each([['2.3.2-beta.7','2.3.2-beta.7',0,true],['2.3.1','2.3.2-beta.7',0,false],['2.3.2-beta.7','',1,false],['garbage','',0,false]])('version/dependency proof is required: %s / %s / %s',(actual,expected,code,ok)=>scratch(f=>{
  const out=f.run(`function Invoke-AgendInWsl($d,$u,$c){if($c -notmatch 'node -e'){throw 'Wrong proof'};return @{Code=${code};Text='AGEND_VERSION=${actual}'}}
$v=Get-VerifiedAgendVersion '${expected}';Write-Output ('VALID='+[bool]$v)`);
  expect(out).toContain(`VALID=${ok?'True':'False'}`);
 }));
 it('tag resolution and actual installation must agree; exact versions do not need a registry query',()=>scratch(f=>{
  const out=f.run(`function Invoke-AgendInWsl($d,$u,$c){if($c -cne 'npm view @songsid/agend@beta version --json --fetch-timeout=15000 --fetch-retries=0'){throw 'Wrong registry lookup'};return @{Code=0;Text='"2.3.2-beta.7"'}}
Write-Output (Resolve-RequestedAgendVersion 'beta')
function Invoke-AgendInWsl {throw 'Exact version queried registry'}
Write-Output (Resolve-RequestedAgendVersion '2.3.2-beta.7')`);
  expect(out.match(/2\.3\.2-beta\.7/g)).toHaveLength(2);
 }));
 it.each([true,false])('the generated dependency program actually exercises SQLite: valid=%s',valid=>scratch(f=>{
  const out=f.run(`function Invoke-AgendInWsl($d,$u,$c){Write-Host ('PROGRAM='+($c.Split(' ')[-1]));return @{Code=1;Text=''}}
$null=Get-VerifiedAgendVersion`);
  const program=Buffer.from(out.match(/PROGRAM=(\S+)/)![1],'base64').toString();
  const root=join(f.dir,'global');mkdirSync(join(root,'@songsid/agend/node_modules/better-sqlite3'),{recursive:true});
  writeFileSync(join(root,'@songsid/agend/package.json'),'{}');
  writeFileSync(join(root,'@songsid/agend/node_modules/better-sqlite3/index.js'),valid?'module.exports=class {prepare(q){if(q!=="select 1")throw Error("wrong query");return {get(){return {}}}}close(){}}':'throw Error("native module broken")');
  const stub=`(()=>{const cp=require('child_process');cp.execFileSync=(bin,args)=>{if(bin==='npm'&&args.join(' ')==='root -g')return ${JSON.stringify(root)};if(bin==='tmux'&&args.join(' ')==='-V')return 'tmux 3.4';if(bin==='agend'&&args.join(' ')==='--version')return '2.3.2-beta.7';throw Error('Forbidden process '+bin)};})();`;
  const result=spawnSync(process.execPath,['-e',stub+program],{encoding:'utf8',timeout:5000,env:{PATH:`${f.bin}:/usr/bin:/bin`,HOME:f.dir}});
  expect(result.status).toBe(valid?0:1);if(valid)expect(result.stdout).toContain('AGEND_VERSION=2.3.2-beta.7');
 }));
 it('a failed curl cannot be hidden by a successful empty installer shell',()=>scratch(f=>{
  const command=f.run(`Get-AgendInstallCommand 'beta'`).trim();
  for(const [name,code]of [['curl',22],['bash',0]] as const){writeFileSync(join(f.bin,name),`#!/bin/sh\nexit ${code}\n`);chmodSync(join(f.bin,name),0o755)}
  const result=spawnSync('/bin/bash',['-c',command],{env:{PATH:`${f.bin}:/usr/bin:/bin`,HOME:f.dir},timeout:3000});
  expect(result.status).toBe(22);
 }));
 it('clear one stale stage without dropping other stages, backend selection or requested version',()=>scratch(f=>{
  const out=f.run(`@('STAGE_1_DONE','STAGE_2_DONE','STAGE_4_DONE','BACKENDS=1,4','AGEND_VERSION=beta') | Set-Content -LiteralPath $ProgressFile
Clear-InstallStage 2
Write-Output ([IO.File]::ReadAllText($ProgressFile))`);
  expect(out).not.toContain('STAGE_2_DONE');for(const s of ['STAGE_1_DONE','STAGE_4_DONE','BACKENDS=1,4','AGEND_VERSION=beta'])expect(out).toContain(s);
 }));
 it.each([0,1,124])('only successful local service/dashboard proof means ready: %s',code=>scratch(f=>{
  const out=f.run(`function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$TimeoutSeconds,$NoProgressSeconds,$Script)
if($TimeoutSeconds -ne 90 -or $Script -notmatch 'systemctl --user is-active'){throw 'Missing bounded unit gate'}; return ${code}}
Write-Output ('READY='+(Test-InstallerReady))`);
  expect(out).toContain(`READY=${code===0?'True':'False'}`);
 }));
 it.each([[true,true,0],[false,true,1],[true,false,1]])('the generated HTTP proof requires finished startup and a working dashboard: %s/%s', (complete,uiOk,status)=>scratch(f=>{
  const out=f.run(`function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$TimeoutSeconds,$NoProgressSeconds,$Script);Write-Host ('PROGRAM='+($Script.Split(' ')[-1]));return 1};$null=Test-InstallerReady`);
  const program=Buffer.from(out.match(/PROGRAM=(\S+)/)![1],'base64').toString();
  const stub=`(()=>{const cp=require('child_process'),m=require('module'),fs=require('fs');cp.execFileSync=()=>'/scratch/global';m.createRequire=()=>()=>({load:()=>({health_port:12345})});fs.readFileSync=()=>'';global.fetch=async url=>{if(!url.startsWith('http://127.0.0.1:12345/'))throw Error('Forbidden URL');return {ok:url.endsWith('/health')||${uiOk},json:async()=>({status:'ok',startupComplete:${complete}})}};global.setTimeout=fn=>{fn();return {}};})();`;
  const result=spawnSync(process.execPath,['-e',stub+program],{encoding:'utf8',timeout:3000,env:{HOME:f.dir,PATH:`${f.bin}:/usr/bin:/bin`}});
  expect(result.status,result.stderr).toBe(status);
 }));
 it.each([['degraded',503,0],['down',503,1],['unrecognised',200,1]])('degraded is usable with warnings; down or invalid health stays blocked: %s', (status,http,exit)=>scratch(f=>{
  const out=f.run(`function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$TimeoutSeconds,$NoProgressSeconds,$Script);Write-Host ('PROGRAM='+($Script.Split(' ')[-1]));return 1};$null=Test-InstallerReady`);
  const program=Buffer.from(out.match(/PROGRAM=(\S+)/)![1],'base64').toString();
  const stub=`(()=>{const cp=require('child_process'),m=require('module'),fs=require('fs');cp.execFileSync=()=>'/scratch/global';m.createRequire=()=>()=>({load:()=>({})});fs.readFileSync=()=>'';global.fetch=async url=>({ok:url.endsWith('/health')?${http}===200:true,status:${http},json:async()=>({status:${JSON.stringify(status)},startupComplete:true,problems:['host memory pressure is elevated']})});global.setTimeout=fn=>{fn();return {}};})();`;
  const result=spawnSync(process.execPath,['-e',stub+program],{encoding:'utf8',timeout:3000,env:{HOME:f.dir,PATH:`${f.bin}:/usr/bin:/bin`}});
  expect(result.status,result.stderr).toBe(exit);
  if(status==='degraded')expect(result.stdout).toContain('AgEnD warning: host memory pressure is elevated');
 }));
 it('quiet MSI/import/no-launch installs keep an absolute deadline without an output-idle deadline',()=>{
  const calls=source.split('\n').filter(line=>line.includes('Invoke-Watched -Label')&&(line.includes('-File "msiexec.exe"')||line.includes('-Arguments @("--import"')||(line.includes('-Arguments @("--install"')&&line.includes('"--no-launch"'))));
  expect(calls).toHaveLength(4);
  for(const line of calls){expect(line).toContain('-TimeoutSeconds 1800');expect(line).toContain('-NoProgressSeconds 0')}
 });
 it('a failed or incomplete final handover exits nonzero',()=>{
  expect(source).toMatch(/if \(-not \$script:InstallerReady -or \$missingBackends\.Count -gt 0\) \{ exit 1 \}/);
  const start=source.indexOf('$scriptLines = @(',source.indexOf('安裝 tmux...'));
  expect(source.slice(start,start+100)).toContain("'set -e'");
 });
 it.each([[0,true],[124,false]])('the merged WSL network probe has a finite host-side wait and honours its exit: %s',(code,ok)=>scratch(f=>{
  const out=f.run(`$NET_WSL=@(@{Host='stub.invalid';Why='stub';Required=$true})
function New-WslScriptFile {param($Script);[IO.File]::WriteAllText('${f.dir}/network.sh',$Script);return @('${f.dir}/network.sh','/scratch/network.sh')}
function Invoke-BoundedWsl {param($Arguments,$TimeoutSeconds);if($TimeoutSeconds -ne 60 -or ($Arguments -join ' ') -cne '-d Scratch -u root -- bash /scratch/network.sh'){throw 'Unbounded/wrong probe'};return @{Code=${code};Text='NET|stub.invalid|0'}}
function Resolve-NetResults($jobs,$side){return @($jobs|Where-Object {$_.Kind}).Count -eq 0}
Write-Output ('OK='+(Test-WslNetwork 'Scratch'))`);
  expect(out).toContain(`OK=${ok?'True':'False'}`);
 }));
 it('a registered Linux name cannot hide a failed install exit',()=>scratch(f=>{
  const out=f.run(`$WSL_NAME_MIN=[version]'2.4.4';function Get-InstalledWslVersion{return [version]'3.0'};function Invoke-Watched{return 7};function Get-WslDistroNames{return @('Scratch')};Write-Output ('OK='+(Install-AgendDistro 'Scratch' '/scratch/location'))`);
  expect(out).toContain('OK=False');expect(out).toContain('結束碼 7');
 }));
 it('a partial backend failure stays retryable; rerun preserves successes and retries only missing CLI',()=>scratch(f=>{
  const a=source.indexOf('$savedBackends = Get-ProgressValue'),b=source.indexOf('# Progress IDs stay compatible',a);
  const stage=source.slice(a,b);writeFileSync(join(f.dir,'stage.ps1'),stage);
  const out=f.run(`$script:attempts=0;$script:codex=$false;$Force=$false
function Get-InstalledBackend($b){if($b.Key -eq 'kiro' -or ($b.Key -eq 'codex' -and $script:codex)){return @{Version='1.2.3';LinkedFrom=$null}};return $null}
function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$Script)
if($Label -eq '安裝 OpenAI Codex'){$script:attempts++;if($script:attempts -eq 1){return 7};$script:codex=$true};return 0}
@('BACKENDS=1,4','STAGE_2_DONE') | Set-Content -LiteralPath $ProgressFile
. '${f.dir}/stage.ps1'
Write-Output ('FIRST='+(Stage-Done 2))
. '${f.dir}/stage.ps1'
Write-Output ('SECOND='+(Stage-Done 2)+' ATTEMPTS='+$script:attempts)`);
  expect(out).toContain('FIRST=False');expect(out).toContain('SECOND=True ATTEMPTS=2');
 }));
 it.each(['same','new','receipt'])('unconfirmed Linux cancellation is fenced until cleanup or a new boot: %s',mode=>scratch(f=>{
  const pending=join(f.dir,'step-0123456789abcdef0123456789abcdef.sh.cancel');
  const old='11111111-1111-1111-1111-111111111111',current=mode==='new'?'22222222-2222-2222-2222-222222222222':old;
  writeFileSync(pending,'cancel');writeFileSync(pending+'.boot',old);
  if(mode==='receipt')writeFileSync(pending+'.done','complete');
  const out=f.run(`@('STAGE_1_DONE','PENDING_WSL_CANCEL=${pending}') | Set-Content -LiteralPath $ProgressFile
function Invoke-BoundedWsl {return @{Code=0;Text='${current}'}}
try { Assert-NoPendingWslCancellation; Write-Output 'RELEASED' } catch { Write-Output ('HELD='+$_) }
Write-Output ([IO.File]::ReadAllText($ProgressFile))`);
  expect(out).toContain(mode==='same'?'HELD=':'RELEASED');expect(out).toContain('STAGE_1_DONE');
  expect(existsSync(pending)).toBe(mode==='same');
 }));
 it.each([[false,false],[true,true],[true,false]])('completion keeps resumable state unless healthy and all backends exist: ready=%s missing=%s',(ready,missing)=>scratch(f=>{
  const a=source.lastIndexOf('$missingBackends = @($selected'),b=source.indexOf('Clear-ResumeAtLogon',a);
  writeFileSync(join(f.dir,'complete.ps1'),source.slice(a,b));
  const out=f.run(`'BACKENDS=1' | Set-Content -LiteralPath $ProgressFile
$script:InstallerReady=$${ready};$selected=@(@{Key='kiro'})
function Get-InstalledBackend {return ${missing?'$null':'@{Version="1.2.3"}'}}
. '${f.dir}/complete.ps1'
Write-Output ('KEPT='+(Test-Path -LiteralPath $ProgressFile))`);
  expect(out).toContain(`KEPT=${ready&&!missing?'False':'True'}`);
 }));
 it.each([false,true])('a stale service marker never overrides actual readiness: %s',ready=>scratch(f=>{
  const out=f.run(`'STAGE_5_DONE' | Set-Content -LiteralPath $ProgressFile
function Test-InstallerReady {return $${ready}}
function Invoke-SetupAndService {return $true}
function Invoke-AgendInWsl {return @{Code=0;Text=''}}
function Start-Sleep {}
$browserSignins='';$service=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ((Stage-Done 5)')},$true)[0]
. ([scriptblock]::Create($service.Extent.Text))
Write-Output ('STAGE='+(Stage-Done 5)+' READY='+$script:InstallerReady)`);
  expect(out).toContain(`STAGE=${ready?'True':'False'} READY=${ready?'True':'False'}`);
 }));
 it('generated Linux job deadline kills its own descendants, not an unrelated canary',async()=>{
  const f=fixture(),canary=spawn('/bin/sleep',['30']);
  try{
   const job=join(f.dir,'job.sh'),pidfile=join(f.dir,'child.pid');writeFileSync(job,`sleep 30 &\necho $! > '${pidfile}'\nwait\n`);
   const script=f.run(`Get-OwnedWslStepScript '${job}' '${f.dir}/cancel' 1`);
   const r=spawnSync('/bin/bash',['-c',script],{encoding:'utf8',timeout:8000,env:{PATH:'/usr/bin:/bin',HOME:f.dir}});
   expect(r.status).toBe(124);expect(existsSync(pidfile)).toBe(true);expect(existsSync(join(f.dir,'cancel.done'))).toBe(true);
   const pid=Number(readFileSync(pidfile,'utf8').trim());
   let state='gone';try{state=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[0]}catch{}
   expect(['gone','Z','X']).toContain(state);expect(canary.exitCode).toBeNull();
  }finally{canary.kill();await once(canary,'close');f.close()}
 });
 it('a no-progress cancellation receipt stops the Linux job before its absolute deadline',async()=>{
  const f=fixture();let child:ReturnType<typeof spawn>|undefined;
  try{
   const job=join(f.dir,'job.sh'),pidfile=join(f.dir,'pid'),cancel=join(f.dir,'cancel');
   writeFileSync(job,`sleep 30 &\necho $! > '${pidfile}'\nwait\n`);
   const script=f.run(`Get-OwnedWslStepScript '${job}' '${cancel}' 30`);
   child=spawn('/bin/bash',['-c',script],{stdio:'ignore',env:{PATH:'/usr/bin:/bin',HOME:f.dir}});
   const closed=once(child,'close');
   for(let i=0;i<100&&!existsSync(pidfile);i++)await new Promise(r=>setTimeout(r,10));
   expect(existsSync(pidfile)).toBe(true);writeFileSync(cancel,'cancel');
   const result=await Promise.race([closed,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('cancel ignored')),6000).unref())]);
   expect(result[0]).not.toBe(0);expect(existsSync(cancel+'.done')).toBe(true);
   const pid=Number(readFileSync(pidfile,'utf8').trim());let state='gone';try{state=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[0]}catch{}
   expect(['gone','Z','X']).toContain(state);
  }finally{if(child?.exitCode===null){child.kill('SIGTERM');await once(child,'close')}f.close()}
 });
});
