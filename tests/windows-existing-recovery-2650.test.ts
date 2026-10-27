/** Opt-in recovery of an existing install. Every WSL, service, account and browser action is stubbed. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
const installer = resolve('website/public/install-agend.ps1');
const source = readFileSync(installer, 'utf8');
const available = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { timeout: 60000 }).status === 0;
function run(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'existing-recovery-2650-'));
  try {
    const script = join(root, 'test.ps1');
    writeFileSync(script, `$ErrorActionPreference='Stop'
$t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$t,[ref]$e)
if($e.Count){throw ($e|Out-String)}
foreach($f in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($f.Extent.Text))}
$a=$ast.Find({param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$WSL_COMMAND_FN'},$false)
. ([scriptblock]::Create($a.Extent.Text));. ([scriptblock]::Create($WSL_COMMAND_FN))
$UBUNTU_DISTRO='Original';$AGEND_USER='original-user';$AGEND_ENV='original-prefix; '
$script:calls=@();$script:ready=@($false,$true);$script:setup=$true;$script:version='2.3.1'
function wsl {throw 'Native WSL forbidden'}
function Start-Process {throw 'Opening a window forbidden'}
function Invoke-BoundedWsl {throw 'Native probe forbidden'}
function Invoke-WslStep {param($Label,$Usually,$Script,$UpperMinutes);$script:calls+=('service:'+ $UBUNTU_DISTRO+'|'+$AGEND_USER+'|'+$Script);return 0}
function Get-VerifiedAgendVersion {$script:calls+=('version:'+ $UBUNTU_DISTRO+'|'+$AGEND_USER);return $script:version}
function Test-InstallerReady {$script:calls+=('health:'+ $UBUNTU_DISTRO+'|'+$AGEND_USER+'|'+$AGEND_ENV);$v=$script:ready[0];$script:ready=@($script:ready|Select-Object -Skip 1);return $v}
function Invoke-SetupAndService {$script:calls+=('setup:'+ $UBUNTU_DISTRO+'|'+$AGEND_USER+'|'+$AGEND_ENV);return $script:setup}
function Set-InstallFailure($kind) {$script:calls+=('failure:'+ $kind)}
function Read-Host {throw 'Unexpected terminal input'}
${body}
Write-Output ('CALLS='+($script:calls -join '~'))
Write-Output ('PARENT='+$UBUNTU_DISTRO+'|'+$AGEND_USER+'|'+$AGEND_ENV)
`);
    const r = spawnSync('pwsh', ['-NoProfile','-NonInteractive','-File',script], { encoding:'utf8', timeout:30000, env:{...process.env,HOME:root,USERPROFILE:root,TMPDIR:root} });
    if (r.status !== 0) throw Error(r.stdout+r.stderr);
    return r.stdout+r.stderr;
  } finally { rmSync(root,{recursive:true,force:true}); }
}
describe.skipIf(!available)('existing installer recovery (#2650 item 6)', () => {
  it.each(['2.3.1','2.3.2-beta.15'])('a runnable %s with a stopped service is repaired only in the discovered account', version => {
    const out=run(`$script:version='${version}';Write-Output ('OK='+(Invoke-ExistingAgendRecovery 'Chosen-Linux' 'alice'))`);
    expect(out).toContain('OK=True');expect(out).toContain('setup:Chosen-Linux|alice|export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; ');
    expect(out.match(/health:Chosen-Linux/g)).toHaveLength(2);
    expect(out).toContain('PARENT=Original|original-user|original-prefix; ');expect(out).toContain('設定 → 登入');
  });
  it('healthy existing installs are checked without setup, service changes or a claim of signed-in backends', () => {
    const out=run(`$script:ready=@($true);Write-Output ('OK='+(Invoke-ExistingAgendRecovery 'Chosen' 'root'))`);
    expect(out).toContain('OK=True');expect(out).not.toContain('setup:');expect(out).not.toContain('service:');expect(out).toContain('不會把服務就緒當成登入成功');
  });
  it.each(['dependencies','cancelled setup','unhealthy service'])('%s remains retryable and never claims recovery completed', mode => {
    const out=run(`${mode==='dependencies'?"$script:version=$null":mode==='cancelled setup'?"$script:setup=$false":"$script:ready=@($false,$false)"}
Write-Output ('OK='+(Invoke-ExistingAgendRecovery 'Chosen' 'alice'))`);
    expect(out).toContain('OK=False');expect(out).not.toContain('服務與儀表板已驗證就緒');expect(out).toContain('failure:');
    if(mode==='dependencies')expect(out).not.toContain('setup:');
    if(mode==='cancelled setup')expect(out.match(/health:Chosen/g)).toHaveLength(1);
  });
  it('real setup/service wiring keeps plain setup and its human confirmation, with no reset or new-version flags', () => {
    const out=run(`$f=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-SetupAndService'},$true)
. ([scriptblock]::Create($f.Extent.Text))
function Invoke-BrowserSetup($Run){$null=& $Run {param($line)};return @{Done=$false;Already=$true}}
Write-Output ('OK='+(Invoke-ExistingAgendRecovery 'Chosen' 'alice'))`);
    expect(out).toContain('OK=True');expect(out).toContain('service:Chosen|alice|export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; agend setup');
    expect(out).toContain('else agend install; fi');expect(out).not.toMatch(/--reset|--yes|--backend-signins|\/root\//);
  });
  it.each(['','n','not yes','y'])('fast-path recovery honours the explicit answer %j', answer => {
    const start=source.indexOf('        $recover = Read-Host'),end=source.indexOf('        # 捷徑目前',start),fragment=source.slice(start,end);
    expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
    const out=run(`function Read-Host {return '${answer}'}
function Invoke-ExistingAgendRecovery($d,$u){$script:calls+=('RECOVER='+$d+'|'+$u);return $true}
$existing=@{Distro='Chosen';User='alice'}
${fragment}`);
    expect(out.includes('RECOVER=Chosen|alice')).toBe(answer==='y');
  });
});
