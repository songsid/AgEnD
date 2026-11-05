/** Real Node-sliced installer functions; one pwsh batch with WSL, console and browser boundaries stubbed. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractPsFunction } from './support/installer-ps-extract.js';
import { installerPwshBatch, type InstallerPwshCase } from './support/installer-pwsh-fixture.js';
const source = readFileSync(resolve('website/public/install-agend.ps1'), 'utf8');
const prelude = [
 'Test-BrowserSignInCapability', 'Get-BrowserSignInSelection', 'Get-BrowserSetupCommand', 'Invoke-SetupAndService',
 'Invoke-BrowserSetup', 'Get-SetupPrompt', 'Get-SetupStopText', 'Complete-LoginStage', 'Get-DashboardSignIn', 'Invoke-OpenDashboard',
 'Get-WslAgendCommand', 'Get-AgendStartHint', 'Write-Ok', 'Write-Warn', 'Write-Info', 'Write-Err', 'Write-InstallLog', 'Protect-LogText',
].map(name => extractPsFunction(source, name)).join('\n');
const capabilities = [
 ['{"version":1,"setup":true,"dashboard":true,"installer":true,"backends":["kiro-cli","claude-code","codex"]}',0,true],
 ['{"version":1,"setup":true,"dashboard":true,"backends":["kiro-cli","claude-code","codex"]}',0,false],
 ['{"version":1,"setup":"true","dashboard":true,"installer":true,"backends":["kiro-cli","claude-code","codex"]}',0,false],
 ['{"version":2,"setup":true,"dashboard":true,"installer":true,"backends":["codex"]}',0,false],
 ['garbled',0,false], ['old command',1,false],
] as const;
const setupLines = ['Setup complete — starting AgEnD.', 'Setup has already been completed.'];
const cases: Record<string, InstallerPwshCase> = {};
const add = (name: string, body: string) => { cases[name] = { prelude: 'installer', body: `function Test-WslLogin($key){return $false}
function Invoke-LoginStage {throw 'Real login forbidden'}
$UBUNTU_DISTRO='Scratch'; $AGEND_ENV='PRIVATE; '
` + body }; };
capabilities.forEach(([json, code], i) => add(`cap-${i}`, `function Invoke-AgendInWsl($d,$u,$command){if($command -cne 'agend setup --backend-signin-capabilities'){throw 'Bad probe'}; return @{Code=${code};Text='${json}'}}
Write-Output ('CAP='+(Test-BrowserSignInCapability 'Scratch' 'operator'))`));
add('selection', `function Test-WslLogin($key){return $key -eq 'kiro'}
$backends=@(@{Key='kiro'},@{Key='claude'},@{Key='codex'},@{Key='antigravity'})
Write-Output ('CSV='+(Get-BrowserSignInSelection $backends))
Write-Output (Get-BrowserSetupCommand 'claude-code,codex,antigravity')
try{Get-BrowserSetupCommand 'codex;whoami';throw 'Accepted bad selection'}catch{if($_ -match 'Accepted bad'){throw};Write-Output 'REJECTED'}`);
setupLines.forEach((line, i) => add(`setup-${i}`, `function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$OnLine,$Script)
if($Script -match 'agend setup'){Write-Host ('SETUP='+$Script); & $OnLine '${line}';return 0}
Write-Host 'SERVICE';return 0}
Write-Output ('OK='+(Invoke-SetupAndService -BackendSignins 'codex'))`));
add('close', `function Invoke-WslStep {param($Label,$Usually,$UpperMinutes,$OnLine,$Script)
if($Script -notmatch 'agend setup'){throw 'Unexpected service start'}
& $OnLine 'Setup page: http://127.0.0.1:19280/s/scratch/';return 1}
function Open-InBrowser($url){return $true}
function Read-Host {return 'n'}
Write-Output ('OK='+(Invoke-SetupAndService -BackendSignins 'codex'))`);
add('dashboard', `function Invoke-BoundedWsl {param($Arguments);Write-Host ('ARGS='+($Arguments -join '|'));return @{Code=0;Text="Sign-in page: http://localhost:19280/signin?next=checklist\`nCode: ABCD-EFGH"}}
function Set-Clipboard($Value){}
function Start-Process($FilePath){Write-Host ('OPEN='+$FilePath)}
$ok=Invoke-OpenDashboard 'Scratch' 'operator' -BackendSignins 'kiro-cli,codex'
Write-Output ('OK='+$ok)
$plain=Invoke-OpenDashboard 'Scratch' 'operator'
try{Invoke-OpenDashboard 'Scratch' 'operator' -BackendSignins 'codex;id';throw 'Bad accepted'}catch{if($_ -match 'Bad accepted'){throw};Write-Host 'REJECTED'}`);
add('fallback', `function Invoke-WslLogin($command){throw 'Unexpected helper'}
function Write-Info($text){}
function Write-Ok($text){}
function Mark-Stage($stage){Write-Host ('MARK='+$stage)}
# Already signed-in backends never invoke the console driver.
function Test-WslLogin($key){return $true}
function Invoke-LoginStage($backends){Write-Host 'CONSOLE-FALLBACK';return @()}
$r=@(Complete-LoginStage @(@{Key='codex';Name='Codex'}))
Write-Output ('SKIPPED='+$r.Count)`);
const batch = installerPwshBatch({ installer: prelude }, cases);
afterAll(batch.cleanup);
const output = (name: string) => { expect(batch.results[name]?.error).toBeNull(); return batch.results[name]!.out; };
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
describe.skipIf(!batch.available)('stub WSL installer browser sign-in',()=>{
 it.each(capabilities)('capability detection fails closed: %s', (json, code, ok)=>{
  const out=output(`cap-${capabilities.findIndex(c => c[0] === json && c[1] === code)}`);
  expect(out).toContain(`CAP=${ok?'True':'False'}`);
 });
 it('selection excludes independently verified auth, retains agy as console-only and rejects shell text',()=>{
  const out=output('selection');
  expect(out).toContain('CSV=claude-code,codex,antigravity');
  expect(out).toContain('agend setup --backend-signins claude-code,codex,antigravity');
  expect(out).toContain('REJECTED');
 });
 it.each(setupLines)('fresh or resumed setup uses browser flags then ensures service: %s', line=>{
  const out=output(`setup-${setupLines.indexOf(line)}`);
  expect(out).toContain('SETUP=PRIVATE; agend setup --backend-signins codex');
  expect(out).toContain('SERVICE');expect(out).toContain('OK=True');
 });
 it('browser close can exit without entering any backend console or starting the service',()=>{
  const out=output('close');
  expect(out).toContain('OK=False');
 });
 it('resumed dashboard receives only canonical IDs in a fixed native command; default shortcuts stay unchanged',()=>{
  const out=output('dashboard');
  expect(out).toContain('agend web --code --backend-signins kiro-cli,codex');expect(out).toContain('OK=True');expect(out).toContain('REJECTED');
  expect(out).toMatch(/agend web --code\n/);
 });
 it('old packages retain the original explicit console fallback with independent checks',()=>{
  const out=output('fallback');
  expect(out).toContain('CONSOLE-FALLBACK');expect(out).toContain('MARK=3');expect(out).toContain('SKIPPED=0');
 });
});
