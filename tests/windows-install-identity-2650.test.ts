/**
 * #2650 item 5 (Sentinel's Windows installer review): keep the Windows account that started the install across the
 * Administrator prompt and the restart. A standard account that answers the prompt with another administrator's
 * credentials used to run the installer as that other account: WSL, the shortcuts, the progress file and the resume
 * after a restart all went to its profile. Now install.ps1 passes the SID it was started with (-InitiatingSid), and
 * install-agend.ps1 stops before it changes anything when its own SID differs, naming both accounts. A restart names
 * the account to log in with, because the resume and the progress live under it.
 * The functions are the scripts' own, taken from their syntax trees and run in pwsh. A real alternate-admin UAC run is
 * the user's Windows checklist.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BOOTSTRAP = join(ROOT, "website", "public", "install.ps1");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
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
    const elevate = c.slice(c.indexOf("if (-not $onWindows -or $admin)"));
    const add = elevate.indexOf("$installerArgs += @('-InitiatingSid', $sid)");
    expect(add).toBeGreaterThan(elevate.indexOf("} else {"));
    expect(add).toBeLessThan(elevate.indexOf("$result = Start-ElevatedInstaller"));
    expect(c).toMatch(/\$sid = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
  });
});

function run(file: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2650id-")); dirs.push(dir);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: dir } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
}

const A = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const B = "S-1-5-21-1111111111-2222222222-3333333333-500";

describe.skipIf(!pwsh)("with pwsh: the account check", { timeout: 90_000 }, () => {
  it("same account, no SID passed, or a malformed one: no mismatch; another account: both are named", () => {
    const out = run(INSTALLER, `function Get-AccountName([string]$sid) { if ($sid -eq '${A}') { return 'PC\\alice' }; return 'PC\\admin' }
Write-Output ('SAME=' + ($null -eq (Get-InstallIdentityMismatch '${A}' '${A}')))
Write-Output ('NONE=' + ($null -eq (Get-InstallIdentityMismatch '' '${A}')))
Write-Output ('BAD=' + ($null -eq (Get-InstallIdentityMismatch 'S-1-5; whoami' '${A}')))
Write-Output ('NOCURRENT=' + ($null -eq (Get-InstallIdentityMismatch '${A}' $null)))
$m = Get-InstallIdentityMismatch '${A}' '${B}'
Write-Output ('DIFF=' + $m.Started + '|' + $m.Running)
Write-InstallIdentityMismatch $m`);
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
  it("an unresolvable SID is shown as the SID itself", () => {
    expect(run(INSTALLER, `Write-Output ('NAME=' + (Get-AccountName '${B}'))`)).toContain(`NAME=${B}`);
  });
  it("a restart names the account to log in with, registered or not", () => {
    for (const registered of ["$true", "$false"]) {
      const out = run(INSTALLER, `function Register-ResumeAtLogon { return ${registered} }
function Get-InstallAccountName { return 'PC\\alice' }
function Read-Host { return 'n' }
function Restart-Computer { throw 'must not restart' }
Request-Reboot 'reboot needed'`);
      expect(out).toContain("請用 Windows 帳號「PC\\alice」登入");
      expect(out).toContain("用別的帳號登入不會接續：進度和自動接續只記在「PC\\alice」底下。");
    }
  });
  it.each(["auto", "conhost"])("the SID reaches the installer through the %s elevation; a malformed one is not passed to Windows Terminal", mode => {
    const out = run(BOOTSTRAP, `$tmp = Join-Path $env:TMPDIR 'stub-installer.ps1'
Set-Content $tmp 'param([switch]$Force, [string]$InstallVersion, [string]$InitiatingSid); [IO.File]::WriteAllText((Join-Path $env:TMPDIR "sid.txt"), $InitiatingSid)'
function Get-Command { param($Name, $CommandType); return @{ Source = 'stub-wt' } }
function Start-Process { param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
  if ($FilePath -eq 'stub-wt') { & pwsh -NoProfile -File ($ArgumentList[-1].Trim('"')); return }
  & pwsh @ArgumentList; return @{ ExitCode = 0 } }
$r = Start-ElevatedInstaller 'pwsh' @('-NoProfile', '-File', $tmp, '-InitiatingSid', '${A}') $tmp '${mode}' 5 2
Write-Output ('SID=' + [IO.File]::ReadAllText((Join-Path $env:TMPDIR 'sid.txt')))
if ('${mode}' -eq 'auto') {
  $r = Start-ElevatedInstaller 'pwsh' @('-NoProfile', '-File', $tmp, '-InitiatingSid', 'S-1-5;x') $tmp 'auto' 5 2
  Write-Output ('BADSID=[' + [IO.File]::ReadAllText((Join-Path $env:TMPDIR 'sid.txt')) + ']')
}`);
    expect(out).toContain(`SID=${A}`);
    if (mode === "auto") expect(out).toContain("BADSID=[]");
  });
});
