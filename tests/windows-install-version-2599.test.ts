/** Only AST-selected installer code executes; WSL, registry, UAC and downloads are stubs. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const installer = resolve('website/public/install-agend.ps1');
const bootstrap = resolve('website/public/install.ps1');
const source = readFileSync(installer, 'utf8');
const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '1']).status === 0;
function run(body: string, file = installer) {
  const home = mkdtempSync(join(tmpdir(), 'agend-install-version-'));
  try {
    const test = join(home, 'proof.ps1');
    writeFileSync(test, `$ErrorActionPreference='Stop'
$t=$null; $e=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e)
if($e.Count){throw ($e | Out-String)}
foreach($f in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($f.Extent.Text))}
function wsl {throw 'Native WSL forbidden'}
function wsl.exe {throw 'Native WSL forbidden'}
function Invoke-WebRequest {throw 'Network forbidden'}
function Start-Process {throw 'Native process launch forbidden'}
function Restart-Computer {throw 'Reboot forbidden'}
$ProgressFile=Join-Path $env:USERPROFILE '.agend-install-progress'
${body}`);
    return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', test], {
      encoding:'utf8', timeout:20_000,
      env:{...process.env, HOME:home, USERPROFILE:home, TMPDIR:home, AGEND_VERSION:''},
    });
  } finally { rmSync(home,{recursive:true,force:true}); }
}
it('validates before native actions, saves before stage 1, and feeds the fresh install command', () => {
  expect(source.indexOf('$AgendInstallVersion = Get-SavedInstallVersion')).toBeLessThan(source.indexOf('Clear-Host'));
  expect(source.indexOf('Save-InstallVersion $AgendInstallVersion')).toBeLessThan(source.indexOf('Write-Step 1 $TOTAL'));
  expect(source).toContain('(Get-AgendInstallCommand $AgendInstallVersion)');
});
describe.skipIf(!pwsh)('version choice, using real PS helpers with stub WSL', () => {
  it('both entry points enforce the same closed semver grammar without echoing bad input', () => {
    const body = `
$valid=@('beta','latest','0.0.0','2.3.2-beta.5','22.23.4','2.3.2-beta.5+build.1')
foreach($v in $valid){if((Resolve-AgendInstallVersion $v) -cne $v){throw 'Bad normalization'}}
$bad=@('Beta','next','v2.3.2','01.2.3','2.3','2.3.2-01','2.3.2-','2.3.2+','beta;whoami','beta foo','$(id)',\"beta\n\",\"beta'\",('a'*129))
foreach($v in $bad){$caught=$false;try{Resolve-AgendInstallVersion $v}catch{$caught=$true;if($_.Exception.Message -cne 'AGEND_VERSION must be beta, latest, or an exact semantic version (for example 2.3.2-beta.5).'){throw}};if(-not $caught){throw 'Invalid accepted'}}
Write-Output ('VALID='+$valid.Count+' BAD='+$bad.Count)`;
    for (const file of [installer, bootstrap]) expect(run(body,file)).toContain('VALID=6 BAD=14');
  });
  it('persists beta across a reboot/environment loss; explicit latest overrides, Force ignores old choice', () => {
    const out = run(`
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
    expect(out).toContain('RESUMED=beta'); expect(out).toContain('OVERRIDE=latest');
    expect(out).toContain('FORCE=\n'); expect(out).toContain('LAST=2.3.2-beta.5');
    expect(out).toContain('UNSAFE-REJECTED'); expect(out).toContain('FRESH=\n');
  });
  it('RunOnce restores the selected version through install.ps1 without Force or shell injection', () => {
    const out = run(`
$RESUME_KEY='scratch'; $RESUME_NAME='AgEnDInstallResume'
$RESUME_COMMAND='powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"'
$AgendInstallVersion='beta'
function Test-Path {return $true}
function Set-ItemProperty {param($Path,$Name,$Value);Write-Output ('REGISTER='+$Value) | Out-Host}
Register-ResumeAtLogon | Out-Null
Write-Output ('DEFAULT='+(Get-InstallResumeCommand ''))
try{Get-InstallResumeCommand 'beta;bad';throw 'Unsafe accepted'}catch{if($_ -match 'Unsafe accepted'){throw};Write-Output 'REJECTED'}`);
    expect(out).toContain(`REGISTER=powershell -ExecutionPolicy ByPass -c "$env:AGEND_VERSION='beta'; irm https://songsid.github.io/AgEnD/install.ps1 | iex"`);
    expect(out).not.toContain('-Force'); expect(out).toContain('REJECTED');
    expect(out).toContain('DEFAULT=powershell -ExecutionPolicy ByPass -c "irm ');
  });
  it('fresh stage installs beta.x in stub WSL; latest/unset/exact stay scoped to the installer bash', () => {
    const out = run(`
$UBUNTU_DISTRO='Private'; $NODE_VERSION='22'
$stage=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if (Stage-Done 4)')},$true)[0]
function Stage-Done {return $false}
function Mark-Stage($s){if($s -ne 4){throw 'Wrong stage'};Write-Host ('VERIFIED='+$script:installed)}
function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$Script)
  if($Script -eq 'apt-get install -y -qq tmux || true'){return 0}
  Write-Host ('INSTALL='+$Script.Split([char]10)[3])
  if($Script -match 'AGEND_VERSION=beta bash'){$script:installed='2.3.2-beta.5'}
  elseif($Script -match 'AGEND_VERSION=2.3.2-beta.4 bash'){$script:installed='2.3.2-beta.4'}
  elseif($Script -match 'install.sh \\| (AGEND_VERSION=latest )?bash'){$script:installed='2.3.1'}
  else{throw 'Unexpected install script'}
  return 0
}
function wsl {if(($args -join ' ') -notmatch 'agend --version'){throw 'Unexpected WSL'};return $script:installed}
foreach($v in @('beta','latest','','2.3.2-beta.4')){$AgendInstallVersion=$v;. ([scriptblock]::Create($stage.Extent.Text))}`);
    expect(out).toContain('VERIFIED=2.3.2-beta.5'); expect(out).toContain('VERIFIED=2.3.2-beta.4');
    expect(out.match(/VERIFIED=2.3.1/g)).toHaveLength(2);
    expect(out).toContain('install.sh | AGEND_VERSION=beta bash || true');
  });
  it.each(['terminal','conhost'])('explicit argument survives %s elevation with an empty child environment', mode => {
    const out = run(`
$tmp=Join-Path $env:TMPDIR 'stub-installer.ps1'
Set-Content $tmp 'param([switch]$Force,[string]$InstallVersion); if($env:AGEND_VERSION){throw "Environment leaked"}; [IO.File]::WriteAllText((Join-Path $env:TMPDIR "version.txt"),$InstallVersion)'
function Get-Command {param($Name,$CommandType);return @{Source='stub-wt'}}
function Start-Process {param($FilePath,$ArgumentList,$Verb,[switch]$Wait,[switch]$PassThru)
 if($FilePath -eq 'stub-wt'){
  $wrapper=$ArgumentList[-1].Trim('"')
  & pwsh -NoProfile -File $wrapper
  return
 }
 & pwsh @ArgumentList
 return @{ExitCode=0}
}
$r=Start-ElevatedInstaller 'pwsh' @('-NoProfile','-File',$tmp,'-Force','-InstallVersion','beta') $tmp '${mode === 'terminal' ? 'auto' : 'conhost'}' 2 1
Write-Output ('RESULT='+$r.Outcome)
Write-Output ('VERSION='+[IO.File]::ReadAllText((Join-Path $env:TMPDIR 'version.txt')))` , bootstrap);
    expect(out).toContain('RESULT=done'); expect(out).toContain('VERSION=beta');
  });
});
