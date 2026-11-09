/**
 * #2650 item 5 (Sentinel's Windows installer review): keep the Windows account that started the install across the
 * Administrator prompt and the restart. A standard account that answers the prompt with another administrator's
 * credentials used to run the installer as that other account: WSL, the shortcuts, the progress file and the resume
 * after a restart all went to its profile. Now install.ps1 passes the SID it was started with (-InitiatingSid), and
 * install-agend.ps1 stops before it changes anything when its own SID differs, naming both accounts. A restart names
 * the account to log in with, because the resume and the progress live under it.
 * The functions are the scripts' own, sliced in Node and run in pwsh. A real alternate-admin UAC run is
 * the user's Windows checklist.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractPsFunction } from './support/installer-ps-extract.js';
import { InstallerC2Batch, hasPwsh as pwsh } from './support/installer-pwsh-c2.js';

const ROOT = join(import.meta.dirname, "..");
const BOOTSTRAP = join(ROOT, "website", "public", "install.ps1");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const installerSource = readFileSync(INSTALLER,'utf8'), bootstrapSource = readFileSync(BOOTSTRAP,'utf8');
const batch = new InstallerC2Batch({
 installer: ['Get-InstallIdentityMismatch','Write-InstallIdentityMismatch','Get-AccountName','Request-Reboot','Write-Err','Write-Warn','Write-Info','Write-InstallLog','Protect-LogText']
  .map(n => extractPsFunction(installerSource,n)).join('\n'),
 bootstrap: ['Start-ElevatedInstaller','Resolve-AgendInstallVersion','Resolve-AgendWslDrive','Write-BootstrapLog','Get-LaunchFailure']
  .map(n => extractPsFunction(bootstrapSource,n)).join('\n'),
});
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("static", () => {
  it("install-agend.ps1 checks the account right after the Administrator check, before it reads or changes anything", () => {
    const c = code(INSTALLER);
    const check = c.indexOf("$identityMismatch = Get-InstallIdentityMismatch $InitiatingSid (Get-CurrentSid)");
    expect(check).toBeGreaterThan(c.indexOf("if (-not (Check-Admin))"));
    for (const later of ["$existing = Find-ExistingAgend", "Clear-ResumeAtLogon\nStart-FreshProgress", "Write-Step 1 $TOTAL", "if (-not (Test-WindowsNetwork))"]) {
      expect(c.indexOf(later)).toBeGreaterThan(check);
    }
    expect(c.slice(check)).toMatch(/^\$identityMismatch = [^\n]+\nif \(\$identityMismatch\) \{\n\s+Write-InstallIdentityMismatch \$identityMismatch\n\s+Read-Host "按 Enter 結束"; exit 1\n\}/);
  });
  it("install.ps1 sends its SID only on the elevation path, and stays ASCII", () => {
    const boot = readFileSync(BOOTSTRAP, "utf8");
    expect(/^[\x00-\x7f]*$/.test(boot)).toBe(true);
    const c = code(BOOTSTRAP);
    const admin = c.slice(c.indexOf("if (-not $onWindows -or $admin)"), c.indexOf("Write-Host \"AgEnD: the installer needs Administrator rights"));
    const elevate = c.slice(c.indexOf("Write-Host \"AgEnD: the installer needs Administrator rights"));
    expect(admin).not.toContain("-InitiatingSid");                                   // already admin (WT or here): no SID
    const add = elevate.indexOf("$installerArgs += @('-InitiatingSid', $sid)");
    expect(add).toBeGreaterThan(0);
    expect(add).toBeLessThan(elevate.indexOf("$result = Start-ElevatedInstaller"));
    expect(c).toMatch(/\$sid = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
  });
});

async function run(file: string, body: string) {
 const dir=mkdtempSync(join(tmpdir(),'agend-2650id-')); dirs.push(dir);
 return batch.run(file === INSTALLER ? 'installer' : 'bootstrap',body,dir);
}

const A = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const B = "S-1-5-21-1111111111-2222222222-3333333333-500";

describe.skipIf(!pwsh)("with pwsh: the account check", () => {
  it("same account, no SID passed, or a malformed one: no mismatch; another account: both are named", async () => {
    const out = (await run(INSTALLER, `function Get-AccountName([string]$sid) { if ($sid -eq '${A}') { return 'PC\\alice' }; return 'PC\\admin' }
Write-Output ('SAME=' + ($null -eq (Get-InstallIdentityMismatch '${A}' '${A}')))
Write-Output ('NONE=' + ($null -eq (Get-InstallIdentityMismatch '' '${A}')))
Write-Output ('BAD=' + ($null -eq (Get-InstallIdentityMismatch 'S-1-5; whoami' '${A}')))
Write-Output ('NOCURRENT=' + ($null -eq (Get-InstallIdentityMismatch '${A}' $null)))
$m = Get-InstallIdentityMismatch '${A}' '${B}'
Write-Output ('DIFF=' + $m.Started + '|' + $m.Running)
Write-InstallIdentityMismatch $m`));
    expect(out).toContain("SAME=True");
    expect(out).toContain("NONE=True");
    expect(out).toContain("BAD=True");
    expect(out).toContain("NOCURRENT=True");
    expect(out).toContain("DIFF=PC\\alice|PC\\admin");
    expect(out).toContain("安裝是從 Windows 帳號「PC\\alice」開始的，但系統管理員確認視窗用的是另一個帳號「PC\\admin」。");
    expect(out).toContain("都會裝到「PC\\admin」底下，「PC\\alice」看不到也用不到");
    expect(out).toContain("沒有安裝或修改任何東西");
    expect(out).toContain("要給「PC\\alice」用：請公司的 IT 人員暫時讓這個帳號有系統管理員權限");
    expect(out).toContain("要給「PC\\admin」用：登出，用「PC\\admin」登入 Windows");
  });
  it("an unresolvable SID is shown as the SID itself", async () => {
    expect((await run(INSTALLER, `Write-Output ('NAME=' + (Get-AccountName '${B}'))`))).toContain(`NAME=${B}`);
  });
  it("a restart names the account to log in with, registered or not", async () => {
    for (const registered of ["$true", "$false"]) {
      const out = (await run(INSTALLER, `function Register-ResumeAtLogon { return ${registered} }
function Get-InstallAccountName { return 'PC\\alice' }
function Read-Host { return 'n' }
function Restart-Computer { throw 'must not restart' }
Request-Reboot 'reboot needed'`));
      expect(out).toContain("請用 Windows 帳號「PC\\alice」登入");
      expect(out).toContain("用別的帳號登入不會接續：進度和自動接續只記在「PC\\alice」底下。");
    }
  });
  it.each(["auto", "conhost"])("the SID reaches the installer through the %s elevation; a malformed one is not passed to Windows Terminal", async mode => {
    const out = (await run(BOOTSTRAP, `$tmp = Join-Path $env:TMPDIR 'stub installer.ps1'
Set-Content $tmp 'param([switch]$Force, [string]$InstallVersion, [string]$InitiatingSid); [IO.File]::WriteAllText((Join-Path $env:TMPDIR "sid.txt"), $InitiatingSid)'
function Get-Command { param($Name, $CommandType); return @{ Source = 'stub-wt' } }
function Start-Process { param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
  if ($FilePath -eq 'stub-wt') { . ($ArgumentList[-1].Trim('"')); return }
  $child=($ArgumentList -join ' ') -replace '^-NoProfile -File ', ''; . ([scriptblock]::Create('& '+$child)); return @{ ExitCode = 0 } }
$r = Start-ElevatedInstaller 'pwsh' @('-NoProfile', '-File', $tmp, '-InitiatingSid', '${A}') $tmp '${mode}' 5 2
Write-Output ('SID=' + [IO.File]::ReadAllText((Join-Path $env:TMPDIR 'sid.txt')))
if ('${mode}' -eq 'auto') {
  $r = Start-ElevatedInstaller 'pwsh' @('-NoProfile', '-File', $tmp, '-InitiatingSid', 'S-1-5;x') $tmp 'auto' 5 2
  Write-Output ('BADSID=[' + [IO.File]::ReadAllText((Join-Path $env:TMPDIR 'sid.txt')) + ']')
}`));
    expect(out).toContain(`SID=${A}`);
    if (mode === "auto") expect(out).toContain("BADSID=[]");
  });
});
