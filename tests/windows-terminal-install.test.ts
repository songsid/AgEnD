/**
 * The Windows installer in Windows Terminal (the user's request, 2026-10-24): the legacy blue console host renders
 * Chinese badly, so with wt.exe present the elevated installer opens in Windows Terminal.
 * - install.ps1's Start-ElevatedInstaller: wt.exe (its app alias) runs a small wrapper that writes the installer's exit
 *   code to <tmp>.code, because wt.exe returns at once. A declined UAC prompt is final; any other wt failure, or a tab
 *   that never starts, falls back to today's powershell.exe window, and the .started/.cancel pair keeps the installer
 *   from running twice. A tab closed before the end is reported as such. AGEND_INSTALL_TERMINAL=conhost, or no wt.exe:
 *   today's path, unchanged.
 * - The live status line (a real user's screenshot: one new row per second, mojibake): kept under the width even when
 *   every non-ASCII character takes two cells, written through the host's Unicode path, and redrawn from its own row.
 * - The desktop shortcuts open in Windows Terminal when it is there.
 * The functions are the scripts' own, taken from their syntax trees and run in pwsh with Start-Process, Get-Command and
 * the console stubbed. A real Windows run (UAC, Windows Terminal, the legacy console) is the user's checklist.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BOOTSTRAP = join(ROOT, "website", "public", "install.ps1");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const TEMPLATE = join(ROOT, "templates", "windows-shortcuts.ps1");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("static", () => {
  const boot = readFileSync(BOOTSTRAP, "utf8");
  it("install.ps1: Windows Terminal through its app alias, an opt-out, and today's RunAs path kept for the fallback", () => {
    expect(boot).toMatch(/Get-Command -Name 'wt\.exe' -CommandType Application/);
    expect(boot).toMatch(/AGEND_INSTALL_TERMINAL/);
    expect(boot).toMatch(/Start-Process -FilePath \$shell -ArgumentList \$quoted -Verb RunAs -Wait -PassThru/);
  });
  it("the shortcut code is still one copy: the template's Get-ShortcutCommand is the installer's", () => {
    const fn = (t: string) => t.slice(t.indexOf("function Get-ShortcutCommand"), t.indexOf("function New-AgendShortcut"));
    expect(fn(readFileSync(TEMPLATE, "utf8"))).toBe(fn(readFileSync(INSTALLER, "utf8")));
    expect(fn(readFileSync(INSTALLER, "utf8"))).toMatch(/AGEND_INSTALL_TERMINAL/);
  });
  it("the status line is no longer written with [Console]::Write (code page, mojibake in Windows PowerShell 5.1)", () => {
    const code = readFileSync(INSTALLER, "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/\[Console\]::Write\(/);
  });
});

/** A pwsh script with the functions of `file` loaded from its syntax tree (nested ones too); nothing else of it runs. */
function run(file: string, body: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-wt-")); dirs.push(dir);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: dir, ...env } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return { out: r.stdout + r.stderr, dir };
}

/**
 * The elevated launch with stubs. `wt`: what the stubbed Start-Process does for wt.exe —
 *   run: start the wrapper for real (pwsh), as Windows Terminal would; start-and-close: a process that claims the start
 *   and goes away without a code; nothing: never starts; declined / fail: throw (UAC cancelled, or anything else).
 * The installer is a stub that records how it was run and ends with code 7. The temporary directory has a space and a
 * semicolon in its name: the quoting and wt's own ';' are part of what is checked.
 */
function elevated(wt: "run" | "start-and-close" | "empty-claim" | "partial-code" | "live-owner" | "nothing" | "declined" | "fail" | "absent", extra = "", env: Record<string, string> = {}, shell = "pwsh") {
  return run(BOOTSTRAP, `
$base = Join-Path $env:TMPDIR 'a b;c'; New-Item -ItemType Directory -Path $base -Force | Out-Null
$tmp = Join-Path $base 'install-agend-x.ps1'
Set-Content -LiteralPath $tmp -Value 'param([switch]$Force); Set-Content -LiteralPath (Join-Path $env:TMPDIR "ran.txt") -Value ("force=" + [bool]$Force); exit 7'
$script:calls = @()
function Get-Command { [CmdletBinding()] param($Name, $CommandType) $script:calls += "get-command"; if ('${wt}' -eq 'absent') { return $null }; return [pscustomobject]@{ Source = '/stub/wt.exe' } }
function Start-Process { param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
  $script:calls += ("start " + $FilePath + " | " + ($ArgumentList -join ' ') + " | " + $Verb + " | wait=" + [bool]$Wait)
  if ($FilePath -eq '/stub/wt.exe') {
    switch ('${wt}') {
      'declined' { throw (New-Object System.InvalidOperationException 'cancelled', (New-Object System.ComponentModel.Win32Exception 1223)) }
      'fail' { throw 'wt.exe is broken' }
      'run' { $w = ($ArgumentList[-1] -replace '^"|"$', '') -replace '\\\\;', ';'; $psi = New-Object Diagnostics.ProcessStartInfo 'pwsh'; foreach ($a in @('-NoProfile', '-File', $w)) { $psi.ArgumentList.Add($a) }; $null = [Diagnostics.Process]::Start($psi) }
      'start-and-close' { $s = "$tmp.started"; $null = [Diagnostics.Process]::Start('pwsh', @('-NoProfile', '-c', "[IO.File]::WriteAllText('$s', [string]\`$PID)")) }
      'empty-claim' { [IO.File]::WriteAllText("$tmp.started", '') }
      'partial-code' { $s = "$tmp.started"; $p = [Diagnostics.Process]::Start('pwsh', @('-NoProfile', '-c', "[IO.File]::WriteAllText('$s', [string]\`$PID)")); $p.WaitForExit(); [IO.File]::WriteAllText("$tmp.code", '') }
      'live-owner' { $s = "$tmp.started"; $d = "$tmp.code"; $null = [Diagnostics.Process]::Start('pwsh', @('-NoProfile', '-c', "[IO.File]::WriteAllText('$s', [string]\`$PID); Start-Sleep 2; [IO.File]::WriteAllText('$d.tmp', '5'); Move-Item -LiteralPath '$d.tmp' -Destination '$d' -Force")) }
    }
    return
  }
  return [pscustomobject]@{ ExitCode = 3 }
}
${extra}
$r = Start-ElevatedInstaller '${shell}' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp, '-Force') $tmp $env:TERMINAL_MODE 2 1
Write-Output ("OUTCOME=" + $r.Outcome + " CODE=" + $r.Code)
foreach ($c in $script:calls) { Write-Output ("CALL " + $c) }
Write-Output ("RAN=" + $(if (Test-Path (Join-Path $env:TMPDIR 'ran.txt')) { (Get-Content -Raw (Join-Path $env:TMPDIR 'ran.txt')).Trim() } else { 'no' }))
Write-Output ("LEFT=" + ((Get-ChildItem -LiteralPath $base -Name | Sort-Object) -join ','))`, { TERMINAL_MODE: "auto", ...env });
}

describe.skipIf(!pwsh)("with pwsh: the elevated launch (install.ps1)", { timeout: 90_000 }, () => {
  it("Windows Terminal present: wt.exe -w new <shell> … -File \"<wrapper>\" (';' escaped), and the installer's exit code comes back through <tmp>.code", () => {
    const { out } = elevated("run");
    expect(out).toContain("OUTCOME=done CODE=7");
    expect(out).toMatch(/CALL start \/stub\/wt\.exe \| -w new "pwsh" -NoProfile -ExecutionPolicy Bypass -File "[^"]*a b\\;c\/install-agend-x\.ps1\.wt\.ps1" \| RunAs \| wait=False/);
    expect(out).not.toMatch(/CALL start pwsh/);                                         // no second window
    expect(out).toContain("RAN=force=True");                                             // the arguments carried, -Force too
    expect(out).toMatch(/LEFT=install-agend-x\.ps1,install-agend-x\.ps1\.wt\.ps1\n/);  // .code/.started cleaned up
  });
  it("the UAC prompt declined for Windows Terminal: final, no second prompt", () => {
    const { out } = elevated("declined");
    expect(out).toContain("OUTCOME=declined");
    expect(out.match(/CALL start /g)).toHaveLength(1);
  });
  it("Windows Terminal fails any other way: today's powershell.exe window (RunAs, -Wait), its exit code", () => {
    const { out } = elevated("fail");
    expect(out).toContain("OUTCOME=done CODE=3");
    expect(out).toMatch(/CALL start pwsh \| -NoProfile -ExecutionPolicy Bypass -File "[^"]*a b;c\/install-agend-x\.ps1" -Force \| RunAs \| wait=True/);
  });
  it("the tab closed before the installer finished: reported as closed, not as a result", () => {
    const { out } = elevated("start-and-close");
    expect(out).toContain("OUTCOME=closed");
    expect(out).not.toMatch(/CALL start pwsh/);
  });
  it("an interrupted claim (.started created, no PID written) ends as closed after the claim grace, never a wait forever", () => {
    const { out } = elevated("empty-claim");
    expect(out).toContain("OUTCOME=closed");
    expect(out).not.toMatch(/CALL start pwsh/);                                         // .started still blocks a second run
  });
  it("an unreadable .code with a dead owner ends as closed (it does not shadow the owner check)", () => {
    const { out } = elevated("partial-code");
    expect(out).toContain("OUTCOME=closed");
  });
  it("control: a live owner that finishes later publishes its code whole, and that code comes back", () => {
    const { out } = elevated("live-owner");
    expect(out).toContain("OUTCOME=done CODE=5");
  });
  it("AGEND_INSTALL_SHELL with spaces: quoted in wt's command line too (with wt's ';' escaped)", () => {
    const { out } = elevated("fail", "", {}, "C:\\Program Files\\Power;Shell\\7\\pwsh.exe");
    expect(out).toMatch(/CALL start \/stub\/wt\.exe \| -w new "C:\\Program Files\\Power\\;Shell\\7\\pwsh\.exe" -NoProfile -ExecutionPolicy Bypass -File "/);
  });
  it("the tab never starts: the late wrapper is cancelled first, then the old window runs it — never twice", () => {
    const { out, dir } = elevated("nothing");
    expect(out).toContain("OUTCOME=done CODE=3");                                      // the fallback's code
    expect(out).toMatch(/LEFT=.*install-agend-x\.ps1\.cancel/);
    // The wrapper turning up late finds the cancel mark and runs nothing.
    const w = join(dir, "a b;c", "install-agend-x.ps1.wt.ps1");
    const late = spawnSync("pwsh", ["-NoProfile", "-File", w], { encoding: "utf8", env: { ...process.env, TMPDIR: dir } });
    expect(late.status).toBe(0);
    expect(existsSync(join(dir, "ran.txt"))).toBe(false);
  });
  it("no Windows Terminal: today's path exactly", () => {
    const { out } = elevated("absent");
    expect(out).toContain("OUTCOME=done CODE=3");
    expect(out.match(/CALL start /g)).toHaveLength(1);
    expect(out).toMatch(/CALL start pwsh \| .* \| RunAs \| wait=True/);
  });
  it("AGEND_INSTALL_TERMINAL=conhost: wt.exe is not even looked for", () => {
    const { out } = elevated("run", "", { TERMINAL_MODE: "conhost" });
    expect(out).not.toContain("CALL get-command");
    expect(out).toMatch(/CALL start pwsh \| .* \| RunAs \| wait=True/);
  });
  it("the wrapper is UTF-8 with a BOM (a non-ASCII user name in the temporary path) and quotes paths as literals", () => {
    const { dir } = elevated("nothing");
    const raw = readFileSync(join(dir, "a b;c", "install-agend-x.ps1.wt.ps1"));
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.toString("utf8")).toMatch(/& '[^']*a b;c\/install-agend-x\.ps1' -Force/);
  });
});

describe.skipIf(!pwsh)("with pwsh: the live status line (install-agend.ps1)", { timeout: 90_000 }, () => {
  it("never wider than the window, even when every non-ASCII character takes two cells", () => {
    const { out } = run(INSTALLER, `
$line = '  | 安裝 OpenAI Codex：已經過 1 分 05 秒（通常需要 1–3 分鐘…）  正在下載 12/27 MB — 44%'
foreach ($w in 20, 39, 50, 79, 119) { $s = Format-StatusLine $line $w; Write-Output ("W$w=" + (Get-SafeWidth $s) + '|' + $s) }
Write-Output ("ASCII=" + (Format-StatusLine 'short ascii' 79))`);
    for (const w of [20, 39, 50, 79, 119]) {
      const m = out.match(new RegExp(`W${w}=(\\d+)\\|`))!;
      expect(Number(m[1])).toBeLessThanOrEqual(w - 1);
    }
    expect(out).toContain("ASCII=short ascii\n");
  });
  it("redrawn in place: 45 ticks on a narrow console that draws every non-ASCII character two cells wide add no rows", () => {
    // A fake console: a cursor that wraps by cells, \\r back to column 0. The width the installer reads is the real one
    // (40), and the console is 40 cells; then a console narrower than the width it reports (30 of 40), where a line
    // still wraps: the redraw goes back to its own row each time.
    const { out } = run(INSTALLER, `
function New-Fake([int]$cells) {
  $f = @{ Row = 10; Col = 0; Cells = $cells; MaxRow = 10 }
  $f.Console = @{
    Top = { $f.Row }.GetNewClosure(); Height = { 300 }.GetNewClosure()
    Move = { $f.Row = $args[0]; $f.Col = 0 }.GetNewClosure()
    Write = { foreach ($ch in ([string]$args[0]).ToCharArray()) { if ($ch -eq [char]13) { $f.Col = 0; continue }; $cw = $(if ([int]$ch -lt 0x80) { 1 } else { 2 }); if ($f.Col + $cw -gt $f.Cells) { $f.Row++; $f.Col = 0 }; $f.Col += $cw; if ($f.Row -gt $f.MaxRow) { $f.MaxRow = $f.Row } } }.GetNewClosure()
  }
  return $f
}
foreach ($case in @(@{ Cells = 40; Width = 39 }, @{ Cells = 30; Width = 39 })) {
  $f = New-Fake $case.Cells; $row = $null
  $rows = @()
  for ($i = 1; $i -le 45; $i++) { $row = Write-StatusLine ("  | 安裝 OpenAI Codex：已經過 $i 秒（通常需要 1–3 分鐘…）  " + ('#' * ($i % 30))) $case.Width $row $f.Console; $rows += $row }
  Write-Output ("CELLS" + $case.Cells + " start=10 maxRow=" + $f.MaxRow + " row=" + $row + " rows-after-first=" + (($rows[1..44] | Sort-Object -Unique) -join ','))
}`);
    expect(out).toContain("CELLS40 start=10 maxRow=10 row=10");             // fits: never leaves its row
    // Narrower than it says: the first clear itself wraps once, then every redraw starts from that same row.
    const narrow = out.match(/CELLS30 start=10 maxRow=(\d+) row=(\d+) rows-after-first=([\d,]+)/)!;
    expect(narrow[3]).toBe(narrow[2]);                                       // one row for all 44 later ticks
    expect(Number(narrow[1])).toBeLessThanOrEqual(13);                       // bounded: not 10 + 45
  });
});

describe.skipIf(!pwsh)("with pwsh: the desktop shortcuts", { timeout: 90_000 }, () => {
  const shortcut = (wt: boolean, env: Record<string, string> = {}) => run(INSTALLER, `
function Get-Command { [CmdletBinding()] param($Name, $CommandType) if ('${wt}' -eq 'True') { return [pscustomobject]@{ Source = 'C:\\Users\\han\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' } }; return $null }
$env:SystemRoot = '/win'
$c = Get-ShortcutCommand 'C:\\Users\\a b;c\\AppData\\Local\\AgEnD\\open-dashboard.ps1'
Write-Output ("TARGET=" + $c.Target); Write-Output ("ARGS=" + $c.Arguments)`, env).out;
  it("with Windows Terminal: wt.exe -w new \"<powershell.exe>\" … -File \"<script>\", ';' escaped", () => {
    const out = shortcut(true);
    expect(out).toContain("TARGET=C:\\Users\\han\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe");
    expect(out).toMatch(/ARGS=-w new "\/win[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\a b\\;c\\AppData\\Local\\AgEnD\\open-dashboard\.ps1"/);
  });
  it("without it, or with AGEND_INSTALL_TERMINAL=conhost: powershell.exe as before", () => {
    for (const out of [shortcut(false), shortcut(true, { AGEND_INSTALL_TERMINAL: "conhost" })]) {
      expect(out).toMatch(/TARGET=\/win[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe/);
      expect(out).toContain('ARGS=-NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\a b;c\\AppData\\Local\\AgEnD\\open-dashboard.ps1"');
    }
  });
});
