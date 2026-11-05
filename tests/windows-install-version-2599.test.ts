/** Node-sliced installer/bootstrap helpers; elevation dispatch is inert and does not start another pwsh. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractPsFunction, extractLeadingStatement } from './support/installer-ps-extract.js';
import { installerPwshBatch, type InstallerPwshCase } from './support/installer-pwsh-fixture.js';
const installer = resolve('website/public/install-agend.ps1');
const bootstrap = resolve('website/public/install.ps1');
const source = readFileSync(installer, 'utf8');
const bootstrapSource = readFileSync(bootstrap, 'utf8');
const prelude = [
 'Get-ProgressValue','Clear-InstallStage','Get-AgendInstallShScript','Resolve-AgendInstallVersion','Get-SavedInstallVersion','Save-InstallVersion','Start-FreshProgress','Get-InstallResumeScript',
 'Get-InstallResumeScriptPath','Get-InstallResumeCommand','Register-ResumeAtLogon','Get-AgendInstallCommand','Get-InstallSources',
 'Write-Ok','Write-Info','Write-Warn','Write-Err','Write-InstallLog','Protect-LogText',
].map(n => extractPsFunction(source,n)).join('\n');
const bootPrelude = ['Resolve-AgendInstallVersion','Resolve-AgendWslDrive','Start-ElevatedInstaller','Write-BootstrapLog','Get-LaunchFailure']
 .map(n => extractPsFunction(bootstrapSource,n)).join('\n');
const stage = extractLeadingStatement(source,'if ($installedVersion)');
const cases: Record<string,InstallerPwshCase> = {};
const add = (name: string, body: string, prelude = 'installer') => { cases[name] = { prelude, body: `$ProgressFile=Join-Path $env:USERPROFILE '.agend-install-progress'
` + body }; };
const grammar = `
$valid=@('beta','latest','0.0.0','2.3.2-beta.5','22.23.4','2.3.2-beta.5+build.1')
foreach($v in $valid){if((Resolve-AgendInstallVersion $v) -cne $v){throw 'Bad normalization'}}
$bad=@('Beta','next','v2.3.2','01.2.3','2.3','2.3.2-01','2.3.2-','2.3.2+','beta;whoami','beta foo','$(id)',\"beta\n\",\"beta'\",('a'*129))
foreach($v in $bad){$caught=$false;try{Resolve-AgendInstallVersion $v}catch{$caught=$true;if($_.Exception.Message -cne 'AGEND_VERSION must be beta, latest, or an exact semantic version (for example 2.3.2-beta.5).'){throw}};if(-not $caught){throw 'Invalid accepted'}}
Write-Output ('VALID='+$valid.Count+' BAD='+$bad.Count)`;
add('grammar-installer', grammar); add('grammar-bootstrap', grammar, 'bootstrap');
add('persist', `
$v=Get-SavedInstallVersion 'beta' $false
Save-InstallVersion $v
$v=Get-SavedInstallVersion '' $false
Write-Output ('RESUMED='+$v)
Write-Output ('OVERRIDE='+(Get-SavedInstallVersion 'latest' $false))
Write-Output ('FORCE='+(Get-SavedInstallVersion '' $true))
Add-Content $ProgressFile 'AGEND_VERSION=2.3.2-beta.5'
Write-Output ('LAST='+(Get-SavedInstallVersion '' $false))
Add-Content $ProgressFile 'AGEND_VERSION=beta;unsafe'
try{Get-SavedInstallVersion '' $false;Write-Output 'UNSAFE-ACCEPTED'}catch{Write-Output 'UNSAFE-REJECTED'}
Start-FreshProgress $true
Write-Output ('FRESH='+(Get-SavedInstallVersion '' $false))`);
add('resume', `
$RESUME_KEY='scratch'; $RESUME_NAME='AgEnDInstallResume'
$env:LOCALAPPDATA = Join-Path $env:TMPDIR 'lad'
$AgendInstallVersion='beta'
function Set-ItemProperty {param($Path,$Name,$Value);Write-Host ('REGISTER='+$Value)}
Register-ResumeAtLogon | Out-Null
Write-Output ('SCRIPT='+([IO.File]::ReadAllText((Get-InstallResumeScriptPath)) -replace "\`r?\`n", ' | '))
Write-Output ('DEFAULT='+((Get-InstallResumeScript '') -replace "\`r?\`n", ' | '))
try{Get-InstallResumeScript 'beta;bad';throw 'Unsafe accepted'}catch{if($_ -match 'Unsafe accepted'){throw};Write-Output 'REJECTED'}`);
add('stage', '$FixtureStage = ' + "'" + stage.replace(/'/g,"''") + "'\n" + `
$UBUNTU_DISTRO='Private'; $NODE_VERSION='22'; $ProgressFile=Join-Path $env:TMPDIR 'progress'; $installedVersion=$null

function Stage-Done {return $false}
function Mark-Stage($s){if($s -ne 4){throw 'Wrong stage'};Write-Host ('VERIFIED='+$script:installed)}
function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$Script)
  if($Script -eq 'apt-get install -y -qq tmux'){return 0}
  Write-Host ('INSTALL='+$Script)
  if($Script -match 'AGEND_VERSION=beta bash'){$script:installed='2.3.2-beta.5'}
  elseif($Script -match 'AGEND_VERSION=2.3.2-beta.4 bash'){$script:installed='2.3.2-beta.4'}
  elseif($Script -match '; (AGEND_VERSION=latest )?bash < \\$f \\)'){$script:installed='2.3.1'}
  else{throw 'Unexpected install script'}
  return 0
}
function Resolve-RequestedAgendVersion {return $script:installed}
function Get-VerifiedAgendVersion($expected){if($expected -cne $script:installed){throw 'Wrong expected version'};return $script:installed}
foreach($v in @('beta','latest','','2.3.2-beta.4')){$AgendInstallVersion=$v;. ([scriptblock]::Create($FixtureStage))}`);
for (const mode of ['terminal','conhost']) add(`elevation-${mode}`, `
$tmp=Join-Path $env:TMPDIR 'stub installer.ps1'
Set-Content $tmp 'param([switch]$Force,[string]$InstallVersion,[string]$WslDrive); if($env:AGEND_VERSION){throw "Environment leaked"}; [IO.File]::WriteAllText((Join-Path $env:TMPDIR "version.txt"),($InstallVersion+"|"+$WslDrive))'
function Get-Command {param($Name,$CommandType);return @{Source='stub-wt'}}
function Start-Process {param($FilePath,$ArgumentList,$Verb,[switch]$Wait,[switch]$PassThru)
 if($FilePath -eq 'stub-wt'){
  $wrapper=$ArgumentList[-1].Trim('"')
  . $wrapper
  return
 }
 # Exercise the real serialized argument line, but dispatch only the scratch child in this process.
 $child = ($ArgumentList -join ' ') -replace '^-NoProfile -File ', ''
 . ([scriptblock]::Create('& ' + $child))
 return @{ExitCode=0}
}
$r=Start-ElevatedInstaller 'pwsh' @('-NoProfile','-File',$tmp,'-Force','-InstallVersion','beta','-WslDrive','D:\\') $tmp '${mode === 'terminal' ? 'auto' : 'conhost'}' 2 1
Write-Output ('RESULT='+$r.Outcome)
Write-Output ('VERSION='+[IO.File]::ReadAllText((Join-Path $env:TMPDIR 'version.txt')))`, 'bootstrap');
const batch = installerPwshBatch({ installer:prelude, bootstrap:bootPrelude },cases);
afterAll(batch.cleanup);
const output = (name: string) => { expect(batch.results[name]?.error).toBeNull(); return batch.results[name]!.out; };
it('validates before native actions, saves before stage 1, and feeds the fresh install command', () => {
  expect(source.indexOf('$AgendInstallVersion = Get-SavedInstallVersion')).toBeLessThan(source.indexOf('Clear-Host'));
  expect(source.indexOf('Save-InstallVersion $AgendInstallVersion')).toBeLessThan(source.indexOf('Write-Step 1 $TOTAL'));
  expect(source).toContain('(Get-AgendInstallCommand $AgendInstallVersion)');
});
describe.skipIf(!batch.available)('version choice, using real PS helpers with stub WSL', () => {
  it('both entry points enforce the same closed semver grammar without echoing bad input', () => {
    for (const file of [installer, bootstrap]) expect(output(file === installer ? 'grammar-installer' : 'grammar-bootstrap')).toContain('VALID=6 BAD=14');
  });
  it('persists beta across a reboot/environment loss; explicit latest overrides, Force ignores old choice', () => {
    const out = output('persist');
    expect(out).toContain('RESUMED=beta'); expect(out).toContain('OVERRIDE=latest');
    expect(out).toContain('FORCE=\n'); expect(out).toContain('LAST=2.3.2-beta.5');
    expect(out).toContain('UNSAFE-REJECTED'); expect(out).toContain('FRESH=\n');
  });
  it('RunOnce restores the selected version through install.ps1 without Force or shell injection', () => {
    const out = output('resume');
    // RunOnce runs the saved resume script (github.io first, then the deployed raw copy); it carries the version.
    expect(out).toMatch(/REGISTER=powershell -NoProfile -ExecutionPolicy ByPass -File "[^"]*lad[\\/]AgEnD[\\/]install-resume\.ps1"/);
    expect(out).toContain("SCRIPT=");
    expect(out).toMatch(/SCRIPT=.*\$env:AGEND_VERSION = 'beta'.*irm|SCRIPT=.*\$env:AGEND_VERSION = 'beta'.*Invoke-RestMethod/);
    expect(out).not.toContain('-Force'); expect(out).toContain('REJECTED');
    expect(out).toMatch(/DEFAULT=(?!.*AGEND_VERSION).*Invoke-Expression/);
  });
  it('fresh stage installs beta.x in stub WSL; latest/unset/exact stay scoped to the installer bash', () => {
    const out = output('stage');
    expect(out).toContain('VERIFIED=2.3.2-beta.5'); expect(out).toContain('VERIFIED=2.3.2-beta.4');
    expect(out.match(/VERIFIED=2.3.1/g)).toHaveLength(2);
    expect(out).toContain('AGEND_VERSION=beta bash < $f )');
  });
  it.each(['terminal','conhost'])('explicit version and drive arguments survive %s elevation with an empty child environment', mode => {
    const out = output(`elevation-${mode}`);
    expect(out).toContain('RESULT=done'); expect(out).toContain('VERSION=beta|D:\\');
  });
});
