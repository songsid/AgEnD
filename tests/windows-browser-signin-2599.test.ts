/** Installer functions under PowerShell, with every WSL/backend/browser boundary replaced. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const installer = resolve('website/public/install-agend.ps1');
const source = readFileSync(installer, 'utf8');
const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '1'], {timeout: 30000}).status === 0;
function run(body: string) {
 const home = mkdtempSync(join(tmpdir(), 'agend-2599-ps-'));
 try {
  const file = join(home, 'test.ps1');
  writeFileSync(file, `$ErrorActionPreference='Stop'
$t=$null; $e=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$t,[ref]$e)
if($e.Count){throw ($e | Out-String)}
foreach($f in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($f.Extent.Text))}
foreach($a in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(WSL_COMMAND_FN|DASHBOARD_OPENER_FN)$'},$false)){. ([scriptblock]::Create($a.Extent.Text))}
. ([scriptblock]::Create($WSL_COMMAND_FN)); . ([scriptblock]::Create($DASHBOARD_OPENER_FN))
function wsl { throw 'Native WSL forbidden' }
function wsl.exe { throw 'Native WSL forbidden' }
function Test-WslLogin($key){return $false}
function Read-Host { throw 'Unexpected terminal interaction' }
function Start-Process { throw 'Real browser forbidden' }
function Invoke-LoginStage { throw 'Real login forbidden' }
$UBUNTU_DISTRO='Scratch'; $AGEND_ENV='PRIVATE; '
${body}`);
  return execFileSync('pwsh', ['-NoProfile','-NonInteractive','-File',file], {encoding:'utf8',timeout:20000,env:{...process.env,HOME:home,USERPROFILE:home}});
 } finally {rmSync(home,{recursive:true,force:true});}
}
it('installs AgEnD before sign-in, preserves stage IDs and independently verifies final auth',()=>{
 expect(source.indexOf('Write-Step 3 $TOTAL "安裝 AgEnD"')).toBeLessThan(source.indexOf('Write-Step 4 $TOTAL "準備瀏覽器登入"'));
 expect(source).toContain('(Stage-Done 4)');
 expect(source).toContain('Get-VerifiedAgendVersion $savedVersion');
 expect(source).toContain('Mark-Stage 4');
 expect(source).toContain('$signedIn = @($selected | Where-Object { Test-WslLogin $_.Key })');
 expect(source).toContain('if ($skippedLogins.Count -eq 0) { Mark-Stage 3 }');
 expect(source).not.toContain('if (Stage-Done 3)');
 expect(source).toContain('Invoke-SetupAndService -BackendSignins $browserSignins');
 expect(source).toContain('Invoke-OpenDashboard $UBUNTU_DISTRO $AGEND_USER -BackendSignins $browserSignins');
});
describe.skipIf(!pwsh)('stub WSL installer browser sign-in',()=>{
 it.each([
  ['{"version":1,"setup":true,"dashboard":true,"installer":true,"backends":["kiro-cli","claude-code","codex"]}',0,true],
  ['{"version":1,"setup":true,"dashboard":true,"backends":["kiro-cli","claude-code","codex"]}',0,false],
  ['{"version":1,"setup":"true","dashboard":true,"installer":true,"backends":["kiro-cli","claude-code","codex"]}',0,false],
  ['{"version":2,"setup":true,"dashboard":true,"installer":true,"backends":["codex"]}',0,false],
  ['garbled',0,false], ['old command',1,false],
 ])('capability detection fails closed: %s', (json, code, ok)=>{
  const out=run(`function Invoke-AgendInWsl($d,$u,$command){if($command -cne 'agend setup --backend-signin-capabilities'){throw 'Bad probe'}; return @{Code=${code};Text='${json}'}}
Write-Output ('CAP='+(Test-BrowserSignInCapability 'Scratch' 'operator'))`);
  expect(out).toContain(`CAP=${ok?'True':'False'}`);
 });
 it('selection excludes independently verified auth, retains agy as console-only and rejects shell text',()=>{
  const out=run(`function Test-WslLogin($key){return $key -eq 'kiro'}
$backends=@(@{Key='kiro'},@{Key='claude'},@{Key='codex'},@{Key='antigravity'})
Write-Output ('CSV='+(Get-BrowserSignInSelection $backends))
Write-Output (Get-BrowserSetupCommand 'claude-code,codex,antigravity')
try{Get-BrowserSetupCommand 'codex;whoami';throw 'Accepted bad selection'}catch{if($_ -match 'Accepted bad'){throw};Write-Output 'REJECTED'}`);
  expect(out).toContain('CSV=claude-code,codex,antigravity');
  expect(out).toContain('agend setup --backend-signins claude-code,codex,antigravity');
  expect(out).toContain('REJECTED');
 });
 it.each(['Setup complete — starting AgEnD.', 'Setup has already been completed.'])('fresh or resumed setup uses browser flags then ensures service: %s', line=>{
  const out=run(`function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$OnLine,$Script)
if($Script -match 'agend setup'){Write-Host ('SETUP='+$Script); & $OnLine '${line}';return 0}
Write-Host 'SERVICE';return 0}
Write-Output ('OK='+(Invoke-SetupAndService -BackendSignins 'codex'))`);
  expect(out).toContain('SETUP=PRIVATE; agend setup --backend-signins codex');
  expect(out).toContain('SERVICE');expect(out).toContain('OK=True');
 });
 it('browser close can exit without entering any backend console or starting the service',()=>{
  const out=run(`function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$OnLine,$Script)
if($Script -notmatch 'agend setup'){throw 'Unexpected service start'}
& $OnLine 'Setup page: http://127.0.0.1:19280/s/scratch/';return 1}
function Open-InBrowser($url){return $true}
function Read-Host {return 'n'}
Write-Output ('OK='+(Invoke-SetupAndService -BackendSignins 'codex'))`);
  expect(out).toContain('OK=False');
 });
 it('resumed dashboard receives only canonical IDs in a fixed native command; default shortcuts stay unchanged',()=>{
  const out=run(`function Invoke-BoundedWsl {param($Arguments);Write-Host ('ARGS='+($Arguments -join '|'));return @{Code=0;Text="Sign-in page: http://localhost:19280/signin?next=checklist\`nCode: ABCD-EFGH"}}
function Set-Clipboard($Value){}
function Start-Process($FilePath){Write-Host ('OPEN='+$FilePath)}
$ok=Invoke-OpenDashboard 'Scratch' 'operator' -BackendSignins 'kiro-cli,codex'
Write-Output ('OK='+$ok)
$plain=Invoke-OpenDashboard 'Scratch' 'operator'
try{Invoke-OpenDashboard 'Scratch' 'operator' -BackendSignins 'codex;id';throw 'Bad accepted'}catch{if($_ -match 'Bad accepted'){throw};Write-Host 'REJECTED'}`);
  expect(out).toContain('agend web --code --backend-signins kiro-cli,codex');expect(out).toContain('OK=True');expect(out).toContain('REJECTED');
  expect(out).toMatch(/agend web --code\n/);
 });
 it('old packages retain the original explicit console fallback with independent checks',()=>{
  const out=run(`$script:n=0
function Test-WslLogin($key){$script:n++;return $script:n -gt 1}
function Get-LoginCommand($key){return 'fixed-login'}
function Invoke-WslLogin($command){throw 'Unexpected helper'}
function Write-Info($text){}
function Write-Ok($text){}
function Mark-Stage($stage){Write-Host ('MARK='+$stage)}
# Already signed-in backends never invoke the console driver.
function Test-WslLogin($key){return $true}
function Invoke-LoginStage($backends){Write-Host 'CONSOLE-FALLBACK';return @()}
$r=@(Complete-LoginStage @(@{Key='codex';Name='Codex'}))
Write-Output ('SKIPPED='+$r.Count)`);
  expect(out).toContain('CONSOLE-FALLBACK');expect(out).toContain('MARK=3');expect(out).toContain('SKIPPED=0');
 });
});
