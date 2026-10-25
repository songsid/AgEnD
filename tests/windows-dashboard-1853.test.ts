/**
 * #1853 step ④ (the user's approved plan, 2026-10-20): the Windows installer ends on the web dashboard, not on console
 * commands. It runs `agend web --code` inside WSL, opens the sign-in page in the Windows browser, puts the one-time
 * code on the clipboard and shows it large; a desktop shortcut, "AgEnD 儀表板", does the same later (its script is the
 * same function text). The console commands move under "進階" (advanced) in the summary.
 * The helpers are the installer's own, run in pwsh with a fake native wsl.exe on PATH (and the browser and clipboard
 * stubbed where the test needs to see them). The real shortcut, browser and clipboard are the user's Windows checklist.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const ending = code.slice(code.indexOf('if ($script:InstallerReady) { Write-Host "  服務與儀表板已就緒"'));

describe("the installer ends on the dashboard (static)", () => {
  it("the shortcut is made and the dashboard opened, after the progress is cleared; console commands only under 進階", () => {
    expect(ending).toMatch(/\$shortcuts = @\(Install-AgendShortcuts \$UBUNTU_DISTRO \$AGEND_USER\)/);
    // #2650 item 10: a dashboard that does not open names the two ways back to it (neither reinstalls).
    expect(ending).toContain('if (-not (Invoke-OpenDashboard $UBUNTU_DISTRO $AGEND_USER -BackendSignins $browserSignins))');
    expect(ending).toContain('if ($script:InstallerReady -and $missingBackends.Count -eq 0)');
    expect(ending).toContain('安裝已經完成，設定都保留著。之後要打開儀表板：');
    expect(ending).toContain('再貼一次同一行安裝指令會從沒完成的步驟繼續');
    expect(ending.indexOf("Invoke-OpenDashboard $UBUNTU_DISTRO")).toBeGreaterThan(ending.indexOf("Clear-ResumeAtLogon"));
    const advanced = ending.indexOf("── 進階（需要用主控台時才看）──");
    expect(advanced).toBeGreaterThan(ending.indexOf("日常使用："));
    for (const cmd of ["agend ls", "agend attach", "agend update", "agend web", "Get-AgendStartHint $UBUNTU_DISTRO $AGEND_USER"]) expect(ending.indexOf(cmd)).toBeGreaterThan(advanced);
    expect(ending).not.toMatch(/管理指令/);
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
/** A native wsl.exe that prints `out` (agend web --code's own lines, or its error) and records its arguments. */
function fakeWsl(out: string) {
  const bin = scratch("agend-1853dash-bin-");
  writeFileSync(join(bin, "wsl.exe"), `#!/bin/sh\nprintf '%s\\n' "$*" > '${join(bin, "args.txt")}'\nprintf '%s' '${out.replace(/'/g, "'\\''")}'\n`);
  chmodSync(join(bin, "wsl.exe"), 0o755);
  return bin;
}
function withHelpers(body: string, bin: string, input = "") {
  const dir = scratch("agend-1853dash-");
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(WSL_COMMAND_FN|DASHBOARD_OPENER_FN)$' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
. ([scriptblock]::Create($WSL_COMMAND_FN)); . ([scriptblock]::Create($DASHBOARD_OPENER_FN))
$script:OnWindows = $false
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, input, env: { ...process.env, TMPDIR: dir, PATH: `${bin}:${process.env.PATH}` } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return { out: r.stdout + r.stderr, dir };
}
const SIGNIN = "Sign-in page: http://localhost:19280/signin\nCode:         K7QM-3XRD   (works once, valid ~5 min)\n";

describe.skipIf(!pwsh)("with pwsh: opening the dashboard", { timeout: 90_000 }, () => {
  it("reads agend web --code's two lines, and nothing else", () => {
    const { out } = withHelpers(`$a = Get-DashboardSignIn "${SIGNIN.replace(/\n/g, "`n")}"
$b = Get-DashboardSignIn "Sign-in page: http://localhost:19280/signin\`nCode:         K7QM3XRD   (works once)"
$c = Get-DashboardSignIn "Web token not found. Is the fleet running?"
$d = Get-DashboardSignIn "Sign-in page: http://localhost:19280/signin\`nCode:         undefined   (works once)"
Write-Output ("A=" + $a.Url + " " + $a.Code + " B=" + $b.Code + " C=" + ($null -eq $c) + " D=" + ($null -eq $d))`, fakeWsl(""));
    expect(out).toContain("A=http://localhost:19280/signin K7QM-3XRD B=K7QM3XRD C=True D=True");   // never a non-code on the clipboard
  });
  it("AgEnD running: the page opened, the code copied and shown large — and wsl asked for exactly agend web --code", () => {
    const bin = fakeWsl(SIGNIN);
    const { out, dir } = withHelpers(`function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Set-Clipboard { param($Value) Add-Content (Join-Path $env:TMPDIR 'clip.txt') $Value }
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04' 'han'))`, bin);
    expect(readFileSync(join(dir, "opened.txt"), "utf8")).toBe("http://localhost:19280/signin\n");
    expect(readFileSync(join(dir, "clip.txt"), "utf8")).toBe("K7QM-3XRD\n");
    expect(out).toContain("儀表板登入碼：  K 7 Q M - 3 X R D");
    expect(out).toContain("登入頁網址：http://localhost:19280/signin");       // #2650 item 10: even when the browser opened
    expect(out).toContain("RESULT=True");
    // The user AgEnD was installed as, and its own home — never a hard-coded root.
    expect(readFileSync(join(bin, "args.txt"), "utf8")).toBe("-d Ubuntu-24.04 -u han -- timeout --signal=TERM --kill-after=2s 25 bash -lc export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; agend web --code\n");
  });
  it("AgEnD not running: says so and how to start it; nothing opened", () => {
    const { out, dir } = withHelpers(`function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04' 'han'))`, fakeWsl("Web token not found. Is the fleet running?\n"));
    expect(out).toContain("現在打不開 AgEnD 儀表板：AgEnD 可能還沒啟動。");
    expect(out).toContain("wsl -d Ubuntu-24.04 -u han -- bash -lc 'export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; agend start'"); // the recorded user, not root
    expect(out).toContain("RESULT=False");
    expect(() => readFileSync(join(dir, "opened.txt"))).toThrow();
  });
  it("agend web --code failing as the real CLI does (stderr, exit 1): the message, nothing opened, the window waits; the caller's preference untouched (#2242 review)", () => {
    const bin = scratch("agend-1853dash-err-");
    writeFileSync(join(bin, "wsl.exe"), `#!/bin/sh\necho "Web token not found. Is the fleet running?" >&2\nexit 1\n`); chmodSync(join(bin, "wsl.exe"), 0o755);
    const { out, dir } = withHelpers(`function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Set-Clipboard { param($Value) Add-Content (Join-Path $env:TMPDIR 'clip.txt') $Value }
function Read-Host { param($p) Add-Content (Join-Path $env:TMPDIR 'waited.txt') $p }
$ErrorActionPreference = 'Stop'
$r = Invoke-OpenDashboard 'Ubuntu-24.04' -Wait
Write-Output ("RESULT=" + $r + " EAP=" + $ErrorActionPreference)`, bin);
    expect(out).toContain("現在打不開 AgEnD 儀表板：AgEnD 可能還沒啟動。");
    expect(out).toContain("RESULT=False EAP=Stop\n");
    expect(readFileSync(join(dir, "waited.txt"), "utf8")).toBe("按 Enter 關閉\n");
    expect(() => readFileSync(join(dir, "opened.txt"))).toThrow();
    expect(() => readFileSync(join(dir, "clip.txt"))).toThrow();
  });
  it("Windows PowerShell 5.1's boundary, modelled: the native stderr arrives as an error record under Stop — still the message, never a throw", () => {
    // 5.1 wraps a redirected native stderr line in a NativeCommandError record that ErrorActionPreference=Stop turns
    // into a terminating error; pwsh 7.2+ does not. A wsl.exe *function* writing that record reproduces it here.
    const { out, dir } = withHelpers(`function Invoke-BoundedWsl {return @{Code=1;Text='Web token not found. Is the fleet running?'}}
function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Read-Host { param($p) Add-Content (Join-Path $env:TMPDIR 'waited.txt') $p }
$ErrorActionPreference = 'Stop'
try { $r = Invoke-OpenDashboard 'Ubuntu-24.04' -Wait; Write-Output ("RESULT=" + $r + " EAP=" + $ErrorActionPreference) } catch { Write-Output ("THREW=" + $_.FullyQualifiedErrorId) }`, fakeWsl(""));
    expect(out).not.toContain("THREW=");
    expect(out).toContain("RESULT=False EAP=Stop\n");
    expect(readFileSync(join(dir, "waited.txt"), "utf8")).toBe("按 Enter 關閉\n");
    expect(() => readFileSync(join(dir, "opened.txt"))).toThrow();
  });
  it("5.1's boundary, modelled: stderr noise as an error record, then the sign-in and exit 0 — still opens the page", () => {
    const { out, dir } = withHelpers(`function Invoke-BoundedWsl {return @{Code=0;Text="Sign-in page: http://localhost:19280/signin\`nCode:         K7QM-3XRD   (works once, valid ~5 min)\`nnvm: a warning"}}
function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Set-Clipboard { param($Value) Add-Content (Join-Path $env:TMPDIR 'clip.txt') $Value }
$ErrorActionPreference = 'Stop'
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04'))`, fakeWsl(""));
    expect(out).toContain("RESULT=True");
    expect(readFileSync(join(dir, "clip.txt"), "utf8")).toBe("K7QM-3XRD\n");
  });
  it("no wsl.exe to start: the message, not a crash", () => {
    const { out } = withHelpers(`$env:PATH = '/nonexistent'
$ErrorActionPreference = 'Stop'
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04') + " EAP=" + $ErrorActionPreference)`, fakeWsl(""));
    expect(out).toContain("現在打不開 AgEnD 儀表板");
    expect(out).toContain("RESULT=False EAP=Stop\n");
  });
  it("success with stderr noise (exit 0) still opens the page and copies the code", () => {
    const bin = scratch("agend-1853dash-noise-");
    writeFileSync(join(bin, "wsl.exe"), `#!/bin/sh\necho "nvm: a warning" >&2\nprintf '%s' '${SIGNIN}'\nexit 0\n`); chmodSync(join(bin, "wsl.exe"), 0o755);
    const { out, dir } = withHelpers(`function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Set-Clipboard { param($Value) Add-Content (Join-Path $env:TMPDIR 'clip.txt') $Value }
$ErrorActionPreference = 'Stop'
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04'))`, bin);
    expect(out).toContain("RESULT=True");
    expect(readFileSync(join(dir, "opened.txt"), "utf8")).toBe("http://localhost:19280/signin\n");
    expect(readFileSync(join(dir, "clip.txt"), "utf8")).toBe("K7QM-3XRD\n");
  });
  it("the shortcut's script is the same function plus one call: it parses, and run on its own it shows the code and waits for Enter", () => {
    const bin = fakeWsl(SIGNIN);
    const { out, dir } = withHelpers(`$f = Join-Path $env:TMPDIR 'open-dashboard.ps1'
[IO.File]::WriteAllText($f, (Get-DashboardOpenerScript 'Ubuntu-22.04' 'root'), (New-Object System.Text.UTF8Encoding $true))
$t2 = $null; $e2 = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t2, [ref]$e2)
Write-Output ("PARSE-ERRORS=" + $e2.Count)
Write-Output ("BOM=" + (([IO.File]::ReadAllBytes($f)[0..2] | ForEach-Object { '{0:X2}' -f $_ }) -join ''))
Write-Output ("NEW-SHORTCUT-OFF-WINDOWS=[" + (@(Install-AgendShortcuts 'Ubuntu-22.04' 'root') -join ',') + "]")`, bin);
    expect(out).toContain("PARSE-ERRORS=0");
    expect(out).toContain("BOM=EFBBBF");
    expect(out).toContain("NEW-SHORTCUT-OFF-WINDOWS=[]");
    // As the shortcut runs it: a fresh pwsh, the file alone. No browser or clipboard here, so it says what to do by hand.
    const r = spawnSync("pwsh", ["-NoProfile", "-File", join(dir, "open-dashboard.ps1")], { encoding: "utf8", timeout: 60_000, input: "\n", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BROWSER: "false" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("儀表板登入碼：  K 7 Q M - 3 X R D");
    expect(r.stdout).toContain("登入頁網址：http://localhost:19280/signin");
    expect(readFileSync(join(bin, "args.txt"), "utf8")).toMatch(/^-d Ubuntu-22\.04 -u root -- timeout --signal=TERM --kill-after=2s 25 bash -lc /);
  });
});
