/**
 * #1853 step ④ (the user's approved plan, 2026-10-20): the Windows installer ends on the web dashboard, not on console
 * commands. It runs `agend web --code` inside WSL, opens the sign-in page in the Windows browser, puts the one-time
 * code on the clipboard and shows it large; a desktop shortcut, "AgEnD 儀表板", does the same later (its script is the
 * same function text). The console commands move under "進階" (advanced) in the summary.
 * The helpers are the installer's own, run in one pwsh worker with an inert native Process model, browser, clipboard
 * and input. The real shortcut, browser and clipboard are the user's Windows checklist.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractPsAssignments, extractPsFunction } from './support/installer-ps-extract.js';
import { InstallerC2Batch, hasPwsh as pwsh } from './support/installer-pwsh-c2.js';

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

const prelude = extractPsAssignments(text,['WSL_COMMAND_FN','DASHBOARD_OPENER_FN'])
 + '\n. ([scriptblock]::Create($WSL_COMMAND_FN))\n. ([scriptblock]::Create($DASHBOARD_OPENER_FN))\n'
 + ['Get-ShortcutTargetLine','Get-DashboardOpenerScript','Install-AgendShortcuts'].map(n=>extractPsFunction(text,n)).join('\n');
const batch = new InstallerC2Batch({installer:prelude,standalone:''});
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
/** The native Process boundary is an inert object; no executable, browser or clipboard is launched. */
const PROCESS_MODEL = String.raw`function New-FixtureTask($value) {
 $task=[pscustomobject]@{Result=$value}; $task | Add-Member ScriptMethod Wait {param($ms) return $true}; return $task
}
function New-Object {
 [CmdletBinding()]param([Parameter(Position=0)][string]$TypeName,[Parameter(Position=1)][object[]]$ArgumentList,[string]$ComObject)
 if($ComObject){throw 'Real COM forbidden'}
 if($TypeName -ne 'Diagnostics.Process'){
  if($TypeName -notin @('Text.UTF8Encoding','System.Text.UTF8Encoding')){throw 'Unexpected allocation'}
  return (Microsoft.PowerShell.Utility\New-Object @PSBoundParameters)
 }
 $fixture=Get-Content -Raw -LiteralPath $env:C2_MODEL | ConvertFrom-Json
 $stdin=[pscustomobject]@{}; $stdin | Add-Member ScriptMethod Close {}
 $stdout=[pscustomobject]@{Task=(New-FixtureTask $fixture.out)}; $stdout | Add-Member ScriptMethod ReadToEndAsync { return $this.Task }
 $stderr=[pscustomobject]@{Task=(New-FixtureTask $fixture.err)}; $stderr | Add-Member ScriptMethod ReadToEndAsync { return $this.Task }
 $p=[pscustomobject]@{StartInfo=[Diagnostics.ProcessStartInfo]::new();StandardInput=$stdin;StandardOutput=$stdout;StandardError=$stderr;ExitCode=$fixture.code}
 $p | Add-Member ScriptMethod Start {
  if($this.StartInfo.FileName -ne 'wsl.exe'){throw 'Unexpected executable'}
  if($env:PATH -eq '/nonexistent'){throw 'Mock executable missing'}
  [IO.File]::WriteAllText($env:C2_ARGS,$this.StartInfo.Arguments+[char]10); return $true
 }
 $p | Add-Member ScriptMethod WaitForExit {param($ms) return $true}
 $p | Add-Member ScriptMethod Dispose {}
 $p | Add-Member ScriptMethod Kill {throw 'Unexpected process timeout'}
 return $p
}`;
function fakeWsl(out: string, err = '', code = 0) {
 const bin=scratch('agend-1853dash-model-');
 writeFileSync(join(bin,'response.json'),JSON.stringify({out,err,code})); return bin;
}
async function withHelpers(body: string, bin: string) {
 const dir=scratch('agend-1853dash-');
 const out=await batch.run('installer', PROCESS_MODEL+'\n'+body,dir,{C2_MODEL:join(bin,'response.json'),C2_ARGS:join(bin,'args.txt')});
 return {out,dir};
}

const SIGNIN = "Sign-in page: http://localhost:19280/signin\nCode:         K7QM-3XRD   (works once, valid ~5 min)\n";

describe.skipIf(!pwsh)("with pwsh: opening the dashboard", () => {
  it("reads agend web --code's two lines, and nothing else", async () => {
    const { out } = (await withHelpers(`$a = Get-DashboardSignIn "${SIGNIN.replace(/\n/g, "`n")}"
$b = Get-DashboardSignIn "Sign-in page: http://localhost:19280/signin\`nCode:         K7QM3XRD   (works once)"
$c = Get-DashboardSignIn "Web token not found. Is the fleet running?"
$d = Get-DashboardSignIn "Sign-in page: http://localhost:19280/signin\`nCode:         undefined   (works once)"
Write-Output ("A=" + $a.Url + " " + $a.Code + " B=" + $b.Code + " C=" + ($null -eq $c) + " D=" + ($null -eq $d))`, fakeWsl("")));
    expect(out).toContain("A=http://localhost:19280/signin K7QM-3XRD B=K7QM3XRD C=True D=True");   // never a non-code on the clipboard
  });
  it("AgEnD running: the page opened, the code copied and shown large — and wsl asked for exactly agend web --code", async () => {
    const bin = fakeWsl(SIGNIN);
    const { out, dir } = (await withHelpers(`function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Set-Clipboard { param($Value) Add-Content (Join-Path $env:TMPDIR 'clip.txt') $Value }
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04' 'han'))`, bin));
    expect(readFileSync(join(dir, "opened.txt"), "utf8")).toBe("http://localhost:19280/signin\n");
    expect(readFileSync(join(dir, "clip.txt"), "utf8")).toBe("K7QM-3XRD\n");
    expect(out).toContain("儀表板登入碼：  K 7 Q M - 3 X R D");
    expect(out).toContain("登入頁網址：http://localhost:19280/signin");       // #2650 item 10: even when the browser opened
    expect(out).toContain("RESULT=True");
    // The user AgEnD was installed as, and its own home — never a hard-coded root.
    expect(readFileSync(join(bin, "args.txt"), "utf8")).toBe("-d Ubuntu-24.04 -u han --exec timeout --signal=TERM --kill-after=2s 25 bash -lc \"export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; agend web --code\"\n");
  });
  it("AgEnD not running: says so and how to start it; nothing opened", async () => {
    const { out, dir } = (await withHelpers(`function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04' 'han'))`, fakeWsl("Web token not found. Is the fleet running?\n")));
    expect(out).toContain("現在打不開 AgEnD 儀表板：AgEnD 可能還沒啟動。");
    expect(out).toContain("wsl -d Ubuntu-24.04 -u han -- bash -lc 'export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; agend start'"); // the recorded user, not root
    expect(out).toContain("RESULT=False");
    expect(() => readFileSync(join(dir, "opened.txt"))).toThrow();
  });
  it("agend web --code failing as the real CLI does (stderr, exit 1): the message, nothing opened, the window waits; the caller's preference untouched (#2242 review)", async () => {
    const bin = fakeWsl('', 'Web token not found. Is the fleet running?\n', 1);
    const { out, dir } = (await withHelpers(`function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Set-Clipboard { param($Value) Add-Content (Join-Path $env:TMPDIR 'clip.txt') $Value }
function Read-Host { param($p) Add-Content (Join-Path $env:TMPDIR 'waited.txt') $p }
$ErrorActionPreference = 'Stop'
$r = Invoke-OpenDashboard 'Ubuntu-24.04' -Wait
Write-Output ("RESULT=" + $r + " EAP=" + $ErrorActionPreference)`, bin));
    expect(out).toContain("現在打不開 AgEnD 儀表板：AgEnD 可能還沒啟動。");
    expect(out).toContain("RESULT=False EAP=Stop\n");
    expect(readFileSync(join(dir, "waited.txt"), "utf8")).toBe("按 Enter 關閉\n");
    expect(() => readFileSync(join(dir, "opened.txt"))).toThrow();
    expect(() => readFileSync(join(dir, "clip.txt"))).toThrow();
  });
  it("modelled failing transport boundary: message and Stop preference preserved, never a throw", async () => {
    // Model the transport result/error preference boundary; this does not execute Windows PowerShell 5.1.
    const { out, dir } = (await withHelpers(`function Invoke-BoundedWsl {return @{Code=1;Text='Web token not found. Is the fleet running?'}}
function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Read-Host { param($p) Add-Content (Join-Path $env:TMPDIR 'waited.txt') $p }
$ErrorActionPreference = 'Stop'
try { $r = Invoke-OpenDashboard 'Ubuntu-24.04' -Wait; Write-Output ("RESULT=" + $r + " EAP=" + $ErrorActionPreference) } catch { Write-Output ("THREW=" + $_.FullyQualifiedErrorId) }`, fakeWsl("")));
    expect(out).not.toContain("THREW=");
    expect(out).toContain("RESULT=False EAP=Stop\n");
    expect(readFileSync(join(dir, "waited.txt"), "utf8")).toBe("按 Enter 關閉\n");
    expect(() => readFileSync(join(dir, "opened.txt"))).toThrow();
  });
  it("modelled noisy transport boundary: sign-in plus exit zero still opens the page", async () => {
    const { out, dir } = (await withHelpers(`function Invoke-BoundedWsl {return @{Code=0;Text="Sign-in page: http://localhost:19280/signin\`nCode:         K7QM-3XRD   (works once, valid ~5 min)\`nnvm: a warning"}}
function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Set-Clipboard { param($Value) Add-Content (Join-Path $env:TMPDIR 'clip.txt') $Value }
$ErrorActionPreference = 'Stop'
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04'))`, fakeWsl("")));
    expect(out).toContain("RESULT=True");
    expect(readFileSync(join(dir, "clip.txt"), "utf8")).toBe("K7QM-3XRD\n");
  });
  it("no wsl.exe to start: the message, not a crash", async () => {
    const { out } = (await withHelpers(`$env:PATH = '/nonexistent'
$ErrorActionPreference = 'Stop'
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04') + " EAP=" + $ErrorActionPreference)`, fakeWsl("")));
    expect(out).toContain("現在打不開 AgEnD 儀表板");
    expect(out).toContain("RESULT=False EAP=Stop\n");
  });
  it("success with stderr noise (exit 0) still opens the page and copies the code", async () => {
    const bin = fakeWsl(SIGNIN,'nvm: a warning\n');
    const { out, dir } = (await withHelpers(`function Start-Process { param($FilePath) Add-Content (Join-Path $env:TMPDIR 'opened.txt') $FilePath }
function Set-Clipboard { param($Value) Add-Content (Join-Path $env:TMPDIR 'clip.txt') $Value }
$ErrorActionPreference = 'Stop'
Write-Output ("RESULT=" + (Invoke-OpenDashboard 'Ubuntu-24.04'))`, bin));
    expect(out).toContain("RESULT=True");
    expect(readFileSync(join(dir, "opened.txt"), "utf8")).toBe("http://localhost:19280/signin\n");
    expect(readFileSync(join(dir, "clip.txt"), "utf8")).toBe("K7QM-3XRD\n");
  });
  it("the shortcut's script is the same function plus one call: it parses, and run on its own it shows the code and waits for Enter", async () => {
    const bin = fakeWsl(SIGNIN);
    const { out, dir } = (await withHelpers(`$f = Join-Path $env:TMPDIR 'open-dashboard.ps1'
[IO.File]::WriteAllText($f, (Get-DashboardOpenerScript 'Ubuntu-22.04' 'root'), (New-Object System.Text.UTF8Encoding $true))
$t2 = $null; $e2 = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t2, [ref]$e2)
Write-Output ("PARSE-ERRORS=" + $e2.Count)
Write-Output ("BOM=" + (([IO.File]::ReadAllBytes($f)[0..2] | ForEach-Object { '{0:X2}' -f $_ }) -join ''))
Write-Output ("NEW-SHORTCUT-OFF-WINDOWS=[" + (@(Install-AgendShortcuts 'Ubuntu-22.04' 'root') -join ',') + "]")`, bin));
    expect(out).toContain("PARSE-ERRORS=0");
    expect(out).toContain("BOM=EFBBBF");
    expect(out).toContain("NEW-SHORTCUT-OFF-WINDOWS=[]");
    // A fresh script scope with no product helper prelude; only boundary models and the actual generated text.
    const standalone=readFileSync(join(dir,'open-dashboard.ps1'),'utf8').replace(/^\uFEFF/,'');
    const alone=await batch.run('standalone',PROCESS_MODEL+"\nfunction Read-Host {param($p) Write-Host ('WAIT='+$p)}\n"+standalone,
      dir,{C2_MODEL:join(bin,'response.json'),C2_ARGS:join(bin,'args.txt')});
    expect(alone).toContain("儀表板登入碼：  K 7 Q M - 3 X R D");
    expect(alone).toContain("登入頁網址：http://localhost:19280/signin");
    expect(alone).toContain('WAIT=按 Enter 關閉');
    expect(readFileSync(join(bin, "args.txt"), "utf8")).toMatch(/^-d Ubuntu-22\.04 -u root --exec timeout --signal=TERM --kill-after=2s 25 bash -lc /);
  });
});
