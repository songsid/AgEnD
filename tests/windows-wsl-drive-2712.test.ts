import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const installer=resolve('website/public/install-agend.ps1'),bootstrap=resolve('website/public/install.ps1');
const source=readFileSync(installer,'utf8'),boot=readFileSync(bootstrap,'utf8');
const pwsh=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command','1'],{timeout:60000}).status===0;
function run(body:string, input='') {
 const dir=mkdtempSync(join(tmpdir(),'agend-drive-2712-'));
 try{
  const file=join(dir,'test.ps1');writeFileSync(file,`$ErrorActionPreference='Stop'
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)}
foreach($f in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($f.Extent.Text))}
$ProgressFile='${dir}/progress';$Force=$false;$script:InstallLog=$null
function wsl {throw 'Unstubbed WSL forbidden'}
function Invoke-BoundedWsl {throw 'Native WSL forbidden'}
$disks=@([pscustomobject]@{Root='C:\\';Free=30GB},[pscustomobject]@{Root='D:\\';Free=120GB})
${body}`);
  return execFileSync('pwsh',['-NoProfile','-File',file],{encoding:'utf8',timeout:20000,input,env:{...process.env,HOME:dir,USERPROFILE:dir,TMPDIR:dir}});
 }finally{rmSync(dir,{recursive:true,force:true})}
}

describe.skipIf(!pwsh)('installer drive choice, all host/WSL operations forbidden',()=>{
 it.each([['', 'C:\\'],['2','D:\\'],['bad\n0\n999999999999999999999999999999\n2','D:\\']])('validates choices and Enter uses marked recommendation: %s',(input,want)=>{
  const out=run(`Write-Output ('ROOT='+(Read-InstallDrive $disks 'C:\\').Root)`,input+'\n');
  expect(out).toContain('ROOT='+want);expect(out).toContain('[1] C:\\ — 可用 30 GB （預設）');expect(out).toContain('[2] D:\\ — 可用 120 GB');
  if(input.startsWith('bad'))expect(out.match(/請輸入 1 到 2/g)).toHaveLength(3);
 });
 it('default stays the automatic pick when the system disk is below20GB',()=>{
  expect(run(`$disks[0].Free=8GB;Write-Output ('ROOT='+(Read-InstallDrive $disks 'C:\\').Root)`,'\n')).toContain('ROOT=D:\\');
 });
 it('one eligible drive never prompts, none fails before an install',()=>{
  const out=run(`function Read-Host {throw 'No prompt allowed'}
$disks[0].Free=4GB;Write-Output ('ONE='+(Read-InstallDrive $disks 'C:\\').Root)
$disks[1].Free=4GB;try{Read-InstallDrive $disks 'C:\\'}catch{Write-Output ('NONE='+$_)}`);
  expect(out).toContain('ONE=D:\\');expect(out).toContain('NONE=找不到可用空間 5 GB');
 });
 it('a network/UNC path is never offered as a local install drive',()=>{
  const out=run(`$disks=@($disks[0],[pscustomobject]@{Root='\\\\server\\share\\';Free=900GB})
function Read-Host {throw 'Only one local drive; no prompt allowed'}
Write-Output ('ROOT='+(Read-InstallDrive $disks 'C:\\').Root)`);
  expect(out).toContain('ROOT=C:\\');
 });
 it.each(['d','D:','d:\\','D:/'])('a validated unattended override needs no prompt: %s',value=>{
  expect(run(`function Read-Host {throw 'No prompt allowed'};Write-Output ('ROOT='+(Read-InstallDrive $disks 'C:\\' '${value}').Root)`)).toContain('ROOT=D:\\');
 });
 it.each(['E:','D:\\elsewhere',"D:';exit",'D:\n'])('bad/unavailable override stops without silent fallback: %s',value=>{
  const out=run(`function Read-Host {throw 'No prompt allowed'};try{Read-InstallDrive $disks 'C:\\' '${value.replaceAll("'","''")}'}catch{Write-Output ('FAILED='+$_)}`);
  expect(out).toContain('FAILED=');expect(out).toContain('AGEND_WSL_DRIVE');
 });
 it('a planned location survives retries/reboot and changed free-space rankings without asking again',()=>{
  const out=run(`$a=Get-WslInstallLocation $disks 'C:\\' 'AgEnD' 'AgEnD' 'D:'
function Read-Host {throw 'No prompt allowed'};$disks[0].Free=900GB
$b=Get-WslInstallLocation $disks 'C:\\' 'AgEnD' 'AgEnD'
Write-Output ('A='+$a.Path+' B='+$b.Path)
Write-Output ([IO.File]::ReadAllText($ProgressFile))`);
  expect(out).toContain('A=D:\\WSL\\AgEnD B=D:\\WSL\\AgEnD');expect(out).toContain('WSL_INSTALL_DISTRO=AgEnD\nWSL_INSTALL_PATH=D:\\WSL\\AgEnD');
 });
 it('a persisted override survives a new process with no environment and Force ignores it',()=>{
  const out=run(`Save-WslDrive 'D:';Write-Output ('SAVED='+(Get-SavedWslDrive '' $false));Write-Output ('FORCE=['+(Get-SavedWslDrive '' $true)+']')`);
  expect(out).toContain('SAVED=D:\\');expect(out).toContain('FORCE=[]');
 });
 it('a planned location on a missing/full drive is held, never silently relocated',()=>{
  const out=run(`Get-WslInstallLocation $disks 'C:\\' 'AgEnD' 'AgEnD' 'D:' | Out-Null
$disks[1].Free=4GB;try{Get-WslInstallLocation $disks 'C:\\' 'AgEnD' 'AgEnD'}catch{Write-Output ('HELD='+$_)}`);
  expect(out).toContain('HELD=');expect(out).toContain('D:\\');
 });
 it('removed installed distro clears stale target/location, then allows a different drive',()=>{
  const out=run(`@('DISTRO=AgEnD','STAGE_1_DONE','BACKENDS=1','AGEND_VERSION=beta')|Set-Content -LiteralPath $ProgressFile
Get-WslInstallLocation $disks 'C:\\' 'AgEnD' 'AgEnD' 'C:' | Out-Null;Save-WslDrive 'C:'
Write-Output ('RESET='+(Clear-MissingWslTarget @('Ubuntu-22.04')))
function Read-Host {return '2'}
Write-Output ('NEW='+(Get-WslInstallLocation $disks 'C:\\' 'AgEnD' 'AgEnD').Path)
Write-Output ('STAGE='+(Stage-Done 1));Write-Output ([IO.File]::ReadAllText($ProgressFile))`);
  expect(out).toContain('RESET=True');expect(out).toContain('NEW=D:\\WSL\\AgEnD');expect(out).toContain('STAGE=False');expect(out).toContain('BACKENDS=1');expect(out).toContain('AGEND_VERSION=beta');expect(out).not.toContain('WSL_INSTALL_PATH=C:');
 });
 it('the real saved-stage check resets a removed distro before any reinstall choice',()=>{
  const out=run(`$UBUNTU_DISTRO='AgEnD';$AgendWslDrive='C:\\';$WslDrive=''
@('DISTRO=AgEnD','STAGE_1_DONE','AGEND_WSL_DRIVE=C:\\','WSL_INSTALL_DISTRO=AgEnD','WSL_INSTALL_PATH=C:\\WSL\\AgEnD')|Set-Content -LiteralPath $ProgressFile
function Get-InstalledWslVersion {return [version]'2.6.1'}
function Get-WslDistroNames {return ,@('Ubuntu-22.04')}
$wslStageVerified=$false
$guard=$ast.FindAll({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if (Stage-Done 1)')},$true)[0]
. ([scriptblock]::Create($guard.Extent.Text))
Write-Output ('TARGET='+$UBUNTU_DISTRO+' VERIFIED='+$wslStageVerified+' LOCATION=['+(Get-ProgressValue 'WSL_INSTALL_PATH')+']')`);
  expect(out).toContain('TARGET=Ubuntu-24.04 VERIFIED=False LOCATION=[]');
 });
 it('an existing recorded distro and an unknown list preserve its exact location',()=>{
  const out=run(`'DISTRO=AgEnD'|Set-Content -LiteralPath $ProgressFile
Get-WslInstallLocation $disks 'C:\\' 'AgEnD' 'AgEnD' 'D:' | Out-Null
Write-Output ('PRESENT='+(Clear-MissingWslTarget @('AgEnD'))+' UNKNOWN='+(Clear-MissingWslTarget $null))
Write-Output ([IO.File]::ReadAllText($ProgressFile))`);
  expect(out).toContain('PRESENT=False UNKNOWN=False');expect(out).toContain('WSL_INSTALL_PATH=D:\\WSL\\AgEnD');
 });
 it('list reads never mutate the shared parent console encoding',()=>{
  const out=run(`$before=[Console]::OutputEncoding
function Invoke-BoundedWsl {param($Arguments);if([Console]::OutputEncoding -ne $before){throw 'Parent console encoding changed'};return @{Code=0;Text="Ubuntu-22.04\`nAgEnD\`n"}}
function Get-WslRegisteredNames {throw 'Unexpected registry fallback'}
Write-Output ('NAMES='+((Get-WslDistroNames)-join ','))`);
  expect(out).toContain('NAMES=Ubuntu-22.04,AgEnD');
 });
});

it('drive override is validated and explicitly passed across both Windows launch routes; progress precedes reboot',()=>{
 expect(boot).toContain("$wslDrive = Resolve-AgendWslDrive ([string]$env:AGEND_WSL_DRIVE)");
 expect(boot).toContain("$installerArgs += @('-WslDrive', $wslDrive)");
 expect(boot).toContain('$versionArg += " -WslDrive');
 expect(source.indexOf('Save-WslDrive $AgendWslDrive')).toBeLessThan(source.indexOf('Write-Step 1 $TOTAL'));
 const list=source.slice(source.indexOf('function Get-WslDistroNames'),source.indexOf('function Get-WslRegisteredNames'));
 expect(list).not.toContain('[Console]::OutputEncoding');
 expect(source).toContain("$UBUNTU_DISTRO = 'Ubuntu-24.04'; $AgendWslDrive = Resolve-AgendWslDrive $WslDrive");
 const resolver=(s:string)=>s.slice(s.indexOf('function Resolve-AgendWslDrive'),s.indexOf('\n}',s.indexOf('function Resolve-AgendWslDrive'))+2);
 expect(resolver(source)).toBe(resolver(boot));
});
