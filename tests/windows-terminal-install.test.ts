/**
 * The Windows installer in Windows Terminal (the user's request, 2026-10-24): the legacy blue console host renders
 * Chinese badly, so with wt.exe present the elevated installer opens in Windows Terminal.
 * Functions are sliced in Node (no Parser::ParseFile of the whole AST). One pwsh per batch; Get-Date / Start-Sleep /
 * Get-Process / Start-Process are stubbed. A real Windows run (UAC, Windows Terminal, the legacy console) is the user's
 * checklist.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPsFunction } from "./support/installer-ps-extract.js";

const ROOT = join(import.meta.dirname, "..");
const BOOTSTRAP = join(ROOT, "website", "public", "install.ps1");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const TEMPLATE = join(ROOT, "templates", "windows-shortcuts.ps1");
const bootSrc = readFileSync(BOOTSTRAP, "utf8");
const installerSrc = readFileSync(INSTALLER, "utf8");
const elevatedFn = [
  extractPsFunction(bootSrc, "Resolve-AgendInstallVersion"),
  extractPsFunction(bootSrc, "Resolve-AgendWslDrive"),
  extractPsFunction(bootSrc, "Write-BootstrapLog"),
  extractPsFunction(bootSrc, "Get-LaunchFailure"),
  extractPsFunction(bootSrc, "Start-ElevatedInstaller"),
].join("\n");
const statusFn = [
  extractPsFunction(installerSrc, "Get-SafeWidth"),
  extractPsFunction(installerSrc, "Format-StatusLine"),
  extractPsFunction(installerSrc, "Write-StatusLine"),
].join("\n");
const shortcutFn = extractPsFunction(installerSrc, "Get-ShortcutCommand");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "1"], { timeout: 60000 }).status === 0;

function pwshFile(script: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-wt-"));
  try {
    const file = join(dir, "t.ps1");
    writeFileSync(file, script);
    const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", file], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, TMPDIR: dir, HOME: dir, USERPROFILE: dir, ...env },
    });
    if (r.error || r.signal || r.status !== 0) {
      throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
    }
    return { out: r.stdout + r.stderr, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("static", () => {
  const boot = bootSrc;
  it("install.ps1: Windows Terminal through its app alias, an opt-out, and today's RunAs path kept for the fallback", () => {
    expect(boot).toMatch(/Get-Command -Name 'wt\.exe' -CommandType Application/);
    expect(boot).toMatch(/AGEND_INSTALL_TERMINAL/);
    expect(boot).toMatch(/Start-Process -FilePath \$shell -ArgumentList \$quoted -Verb RunAs -Wait -PassThru/);
  });
  it("the shortcut code is still one copy: the template's Get-ShortcutCommand is the installer's", () => {
    const fn = (t: string) => t.slice(t.indexOf("function Get-ShortcutCommand"), t.indexOf("function New-AgendShortcut"));
    expect(fn(readFileSync(TEMPLATE, "utf8"))).toBe(fn(installerSrc));
    expect(fn(installerSrc)).toMatch(/AGEND_INSTALL_TERMINAL/);
  });
  it("the status line is no longer written with [Console]::Write (code page, mojibake in Windows PowerShell 5.1)", () => {
    const code = installerSrc.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/\[Console\]::Write\(/);
  });
});

it("installer functions are sliced in Node without ParseFile", () => {
  expect(elevatedFn).toContain("function Start-ElevatedInstaller");
  expect(elevatedFn).toContain("Start-Sleep -Milliseconds 500");
  expect(elevatedFn).toContain("Test-Path -LiteralPath $done");
  expect(elevatedFn).toContain("AlreadyElevated");
  expect(elevatedFn).not.toContain("Parser]::ParseFile");
  expect(statusFn).toContain("function Format-StatusLine");
  expect(statusFn).toContain("function Write-StatusLine");
  expect(shortcutFn).toContain("function Get-ShortcutCommand");
});

const CLOCK_AND_PROCESS = `
$script:Now = [datetime]'2026-01-01T00:00:00'
$script:LivePids = @()
$script:OwnerFinishAt = $null
$script:OwnerCodePath = $null
$script:OwnerCode = $null
function Get-Date { $script:Now }
function Start-Sleep { param([double]$Seconds, [int]$Milliseconds)
  $ms = 0
  if ($PSBoundParameters.ContainsKey('Milliseconds')) { $ms = [int]$Milliseconds }
  elseif ($PSBoundParameters.ContainsKey('Seconds')) { $ms = [int]($Seconds * 1000) }
  $script:Now = $script:Now.AddMilliseconds([Math]::Max($ms, 0))
  if ($script:OwnerFinishAt -and $script:Now -ge $script:OwnerFinishAt -and $script:OwnerCodePath) {
    if (-not (Test-Path -LiteralPath $script:OwnerCodePath)) {
      [IO.File]::WriteAllText($script:OwnerCodePath + '.tmp', [string]$script:OwnerCode)
      Move-Item -LiteralPath ($script:OwnerCodePath + '.tmp') -Destination $script:OwnerCodePath -Force
    }
  }
}
function Get-Process { [CmdletBinding()] param($Id)
  if ($script:LivePids -contains [int]$Id) { return [pscustomobject]@{ Id = $Id } }
  return $null
}
`;

describe.skipIf(!pwsh)("with pwsh: the elevated launch (install.ps1)", () => {
  it("already Administrator, outside Windows Terminal: the same Windows Terminal launch without RunAs, the code back", () => {
    const { out } = pwshFile(`
$ErrorActionPreference = 'Stop'
${elevatedFn}
${CLOCK_AND_PROCESS}
$base = Join-Path $env:TMPDIR 'a b;c'; New-Item -ItemType Directory -Path $base -Force | Out-Null
$tmp = Join-Path $base 'install-agend-x.ps1'
Set-Content -LiteralPath $tmp -Value 'param([switch]$Force); Set-Content -LiteralPath (Join-Path $env:TMPDIR "ran.txt") -Value ("force=" + [bool]$Force); $global:LASTEXITCODE = 7'
$script:calls = @()
function Get-Command { [CmdletBinding()] param($Name, $CommandType) $script:calls += "get-command"; return [pscustomobject]@{ Source = '/stub/wt.exe' } }
function Start-Process { param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
  $script:calls += ("start " + $FilePath + " | " + ($ArgumentList -join ' ') + " | " + $Verb + " | wait=" + [bool]$Wait)
  if ($FilePath -eq '/stub/wt.exe') {
    $w = ($ArgumentList[-1] -replace '^"|"$', '') -replace '\\\\;', ';'
    & $w
    return
  }
  return [pscustomobject]@{ ExitCode = 3 }
}
$r = Start-ElevatedInstaller 'pwsh' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp, '-Force') $tmp 'auto' 2 1 -AlreadyElevated
Write-Output ("OUTCOME=" + $r.Outcome + " CODE=" + $r.Code)
foreach ($c in $script:calls) { Write-Output ("CALL " + $c) }
`);
    expect(out).toContain("OUTCOME=done CODE=7");
    expect(out).toMatch(/CALL start \/stub\/wt\.exe \| -w new "pwsh" [^|]*\|  \| wait=False/);
  });

  it("elevated-launch cases: inline fallback, wt done/declined/fail/closed, claim grace, live owner, quoting, cancel, conhost (one pwsh)", () => {
    const { out } = pwshFile(`
$ErrorActionPreference = 'Stop'
${elevatedFn}
${CLOCK_AND_PROCESS}
function Invoke-Case([string]$mode, [string]$shell = 'pwsh', [switch]$AlreadyElevated, [string]$terminal = 'auto') {
  $script:Now = [datetime]'2026-01-01T00:00:00'
  $script:LivePids = @()
  $script:OwnerFinishAt = $null
  $script:OwnerCodePath = $null
  $script:OwnerCode = $null
  $base = Join-Path $env:TMPDIR ('case-' + $mode)
  if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
  $base = Join-Path $base 'a b;c'; New-Item -ItemType Directory -Path $base -Force | Out-Null
  $tmp = Join-Path $base 'install-agend-x.ps1'
  Set-Content -LiteralPath $tmp -Value 'param([switch]$Force); Set-Content -LiteralPath (Join-Path $env:TMPDIR "ran.txt") -Value ("force=" + [bool]$Force); $global:LASTEXITCODE = 7'
  $ran = Join-Path $env:TMPDIR 'ran.txt'
  if (Test-Path -LiteralPath $ran) { Remove-Item -LiteralPath $ran -Force }
  $script:calls = @()
  $script:mode = $mode
  function Get-Command { [CmdletBinding()] param($Name, $CommandType)
    $script:calls += "get-command"
    if ($script:mode -eq 'absent' -or $script:mode -eq 'admin-absent') { return $null }
    return [pscustomobject]@{ Source = '/stub/wt.exe' }
  }
  function Start-Process { param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
    $script:calls += ("start " + $FilePath + " | " + ($ArgumentList -join ' ') + " | " + $Verb + " | wait=" + [bool]$Wait)
    if ($FilePath -eq '/stub/wt.exe') {
      switch ($script:mode) {
        'declined' { throw (New-Object System.InvalidOperationException 'cancelled', (New-Object System.ComponentModel.Win32Exception 1223)) }
        { $_ -in 'fail','admin-fail','shell-spaces' } { throw 'wt.exe is broken' }
        { $_ -in 'run','admin-run' } {
          $w = ($ArgumentList[-1] -replace '^"|"$', '') -replace '\\\\;', ';'
          & $w
        }
        'start-and-close' { [IO.File]::WriteAllText("$tmp.started", '1') }
        'empty-claim' { [IO.File]::WriteAllText("$tmp.started", '') }
        'partial-code' { [IO.File]::WriteAllText("$tmp.started", '1'); [IO.File]::WriteAllText("$tmp.code", '') }
        'live-owner' {
          $script:LivePids = @(4242)
          [IO.File]::WriteAllText("$tmp.started", '4242')
          $script:OwnerCodePath = "$tmp.code"
          $script:OwnerCode = '5'
          $script:OwnerFinishAt = $script:Now.AddSeconds(2)
        }
        'nothing' { }
        'conhost' { }
      }
      return
    }
    return [pscustomobject]@{ ExitCode = 3 }
  }
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp, '-Force')
  if ($AlreadyElevated) { $r = Start-ElevatedInstaller $shell $args $tmp $terminal 2 1 -AlreadyElevated }
  else { $r = Start-ElevatedInstaller $shell $args $tmp $terminal 2 1 }
  Write-Output ("CASE=$mode OUTCOME=" + $r.Outcome + " CODE=" + $r.Code)
  foreach ($c in $script:calls) { Write-Output ("CASE=$mode CALL " + $c) }
  Write-Output ("CASE=$mode RAN=" + $(if (Test-Path -LiteralPath $ran) { (Get-Content -Raw $ran).Trim() } else { 'no' }))
  Write-Output ("CASE=$mode LEFT=" + ((Get-ChildItem -LiteralPath $base -Name | Sort-Object) -join ','))
  if ($mode -eq 'nothing') {
    $w = Join-Path $base 'install-agend-x.ps1.wt.ps1'
    $global:LASTEXITCODE = 0
    & $w
    Write-Output ("CASE=$mode LATE_EXIT=" + $LASTEXITCODE + " LATE_RAN=" + (Test-Path -LiteralPath $ran))
    $raw = [IO.File]::ReadAllBytes($w)
    Write-Output ("CASE=$mode BOM=" + (($raw[0..2] | ForEach-Object { $_.ToString('X2') }) -join ''))
    Write-Output ("CASE=$mode WRAPPER=" + (([Text.Encoding]::UTF8.GetString($raw) -replace [char]13,'' -replace [char]10,'|')))
  }
}
Invoke-Case 'admin-absent' -AlreadyElevated
Invoke-Case 'admin-fail' -AlreadyElevated
Invoke-Case 'run'
Invoke-Case 'declined'
Invoke-Case 'fail'
Invoke-Case 'start-and-close'
Invoke-Case 'empty-claim'
Invoke-Case 'partial-code'
Invoke-Case 'live-owner'
Invoke-Case 'shell-spaces' 'C:\\Program Files\\Power;Shell\\7\\pwsh.exe'
Invoke-Case 'nothing'
Invoke-Case 'absent'
Invoke-Case 'conhost' -terminal 'conhost'
`);

    const caseOut = (name: string) => out.split("\n").filter(l => l.startsWith("CASE=" + name + " ")).join("\n");

    const adminAbsent = caseOut("admin-absent");
    expect(adminAbsent, "admin-absent").toContain("OUTCOME=inline");
    expect(adminAbsent, "admin-absent").not.toMatch(/CALL start pwsh/);
    expect(adminAbsent, "admin-absent").toContain("RAN=no");

    const adminFail = caseOut("admin-fail");
    expect(adminFail, "admin-fail").toContain("OUTCOME=inline");
    expect(adminFail, "admin-fail").not.toMatch(/CALL start pwsh/);
    expect(adminFail, "admin-fail").toContain("RAN=no");

    expect(out).toContain("CASE=run OUTCOME=done CODE=7");
    expect(caseOut("run")).toMatch(/CALL start \/stub\/wt\.exe \| -w new "pwsh" -NoProfile -ExecutionPolicy Bypass -File "[^"]*a b\\;c\/install-agend-x\.ps1\.wt\.ps1" \| RunAs \| wait=False/);
    expect(caseOut("run")).not.toMatch(/CALL start pwsh/);
    expect(caseOut("run")).toContain("RAN=force=True");
    expect(caseOut("run")).toMatch(/LEFT=install-agend-x\.ps1,install-agend-x\.ps1\.wt\.ps1/);

    expect(out).toContain("CASE=declined OUTCOME=declined");
    expect(caseOut("declined").match(/CALL start /g)).toHaveLength(1);

    expect(out).toContain("CASE=fail OUTCOME=done CODE=3");
    expect(caseOut("fail")).toMatch(/CALL start pwsh \| -NoProfile -ExecutionPolicy Bypass -File "[^"]*a b;c\/install-agend-x\.ps1" -Force \| RunAs \| wait=True/);

    expect(out).toContain("CASE=start-and-close OUTCOME=closed");
    expect(caseOut("start-and-close")).not.toMatch(/CALL start pwsh/);

    expect(out).toContain("CASE=empty-claim OUTCOME=closed");
    expect(caseOut("empty-claim")).not.toMatch(/CALL start pwsh/);

    expect(out).toContain("CASE=partial-code OUTCOME=closed");

    expect(out).toContain("CASE=live-owner OUTCOME=done CODE=5");

    expect(caseOut("shell-spaces")).toMatch(/CALL start \/stub\/wt\.exe \| -w new "C:\\Program Files\\Power\\;Shell\\7\\pwsh\.exe" -NoProfile -ExecutionPolicy Bypass -File "/);

    expect(out).toContain("CASE=nothing OUTCOME=done CODE=3");
    expect(caseOut("nothing")).toMatch(/LEFT=.*install-agend-x\.ps1\.cancel/);
    expect(caseOut("nothing")).toContain("LATE_RAN=False");
    expect(caseOut("nothing")).toContain("BOM=EFBBBF");
    expect(caseOut("nothing")).toMatch(/& '[^']*a b;c\/install-agend-x\.ps1' -Force/);

    expect(out).toContain("CASE=absent OUTCOME=done CODE=3");
    expect(caseOut("absent").match(/CALL start /g)).toHaveLength(1);
    expect(caseOut("absent")).toMatch(/CALL start pwsh \| .* \| RunAs \| wait=True/);

    expect(caseOut("conhost")).not.toContain("CALL get-command");
    expect(caseOut("conhost")).toMatch(/CALL start pwsh \| .* \| RunAs \| wait=True/);
  });

  it("the bootstrap uses it only when already admin, outside Windows Terminal, and not asked for the old window", () => {
    const boot = bootSrc;
    const at = boot.indexOf("if (-not $onWindows -or $admin) {"), admin = boot.slice(at, boot.indexOf("Write-Host \"AgEnD: the installer needs Administrator rights", at));
    expect(admin).toContain("if ($onWindows -and -not $env:WT_SESSION -and $terminal -ne 'conhost') { $result = Start-ElevatedInstaller $shell $installerArgs $tmp $terminal -AlreadyElevated }");
    expect(admin).toMatch(/\} else \{\s*& \$shell @installerArgs/);
  });
});

describe.skipIf(!pwsh)("with pwsh: the live status line (install-agend.ps1)", () => {
  it("never wider than the window, even when every non-ASCII character takes two cells; redrawn in place (one pwsh)", () => {
    const { out } = pwshFile(`
$ErrorActionPreference = 'Stop'
${statusFn}
$line = '  | 安裝 OpenAI Codex：已經過 1 分 05 秒（通常需要 1–3 分鐘…）  正在下載 12/27 MB — 44%'
foreach ($w in 20, 39, 50, 79, 119) { $s = Format-StatusLine $line $w; Write-Output ("W$w=" + (Get-SafeWidth $s) + '|' + $s) }
Write-Output ("ASCII=" + (Format-StatusLine 'short ascii' 79))
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
}
`);
    for (const w of [20, 39, 50, 79, 119]) {
      const m = out.match(new RegExp(`W${w}=(\\d+)\\|`))!;
      expect(Number(m[1])).toBeLessThanOrEqual(w - 1);
    }
    expect(out).toContain("ASCII=short ascii\n");
    expect(out).toContain("CELLS40 start=10 maxRow=10 row=10");
    const narrow = out.match(/CELLS30 start=10 maxRow=(\d+) row=(\d+) rows-after-first=([\d,]+)/)!;
    expect(narrow[3]).toBe(narrow[2]);
    expect(Number(narrow[1])).toBeLessThanOrEqual(13);
  });
});

describe.skipIf(!pwsh)("with pwsh: the desktop shortcuts", () => {
  it("with Windows Terminal, without it, and AGEND_INSTALL_TERMINAL=conhost (one pwsh)", () => {
    const { out } = pwshFile(`
$ErrorActionPreference = 'Stop'
${shortcutFn}
function Invoke-Shortcut([string]$mode) {
  function Get-Command { [CmdletBinding()] param($Name, $CommandType)
    if ($mode -eq 'wt') { return [pscustomobject]@{ Source = 'C:\\Users\\han\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' } }
    return $null
  }
  $env:SystemRoot = '/win'
  $c = Get-ShortcutCommand 'C:\\Users\\a b;c\\AppData\\Local\\AgEnD\\open-dashboard.ps1'
  Write-Output ("MODE=$mode TARGET=" + $c.Target)
  Write-Output ("MODE=$mode ARGS=" + $c.Arguments)
}
Invoke-Shortcut 'wt'
Invoke-Shortcut 'none'
$env:AGEND_INSTALL_TERMINAL = 'conhost'
function Get-Command { [CmdletBinding()] param($Name, $CommandType) return [pscustomobject]@{ Source = 'C:\\Users\\han\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' } }
$env:SystemRoot = '/win'
$c = Get-ShortcutCommand 'C:\\Users\\a b;c\\AppData\\Local\\AgEnD\\open-dashboard.ps1'
Write-Output ("MODE=conhost TARGET=" + $c.Target)
Write-Output ("MODE=conhost ARGS=" + $c.Arguments)
`);
    expect(out).toContain("MODE=wt TARGET=C:\\Users\\han\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe");
    expect(out).toMatch(/MODE=wt ARGS=-w new "\/win[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\a b\\;c\\AppData\\Local\\AgEnD\\open-dashboard\.ps1"/);
    expect(out).toMatch(/MODE=none TARGET=\/win[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe/);
    expect(out).toContain('MODE=none ARGS=-NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\a b;c\\AppData\\Local\\AgEnD\\open-dashboard.ps1"');
    expect(out).toMatch(/MODE=conhost TARGET=\/win[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe/);
    expect(out).toContain('MODE=conhost ARGS=-NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\a b;c\\AppData\\Local\\AgEnD\\open-dashboard.ps1"');
  });
});
