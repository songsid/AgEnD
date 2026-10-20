/**
 * #1853 (the user's approval, 2026-10-20): a second desktop shortcut, "AgEnD 重新啟動", and a fast path for people who
 * already have AgEnD.
 * - The restart shortcut asks first ("確定要重啟 AgEnD 嗎？…(y/N)", no by default); yes runs `agend restart` in the Linux
 *   and as the user recorded at install time (%LOCALAPPDATA%\AgEnD\install.json — never a hard-coded root), then shows
 *   `agend status` and waits for Enter. WSL or AgEnD missing is said plainly; it never runs `wsl --shutdown`.
 * - Re-running the one-liner on a machine that already has AgEnD (recorded, or in the default Ubuntu) only offers to
 *   update the two desktop shortcuts: no WSL, backend or setup step is redone. It asks wsl.exe only when there is a
 *   record or a Store/MSI WSL, so a clean Windows never meets wsl.exe's "press any key" prompt.
 * The helpers are the installer's own, in pwsh with a fake native wsl.exe on PATH. The real shortcuts are the user's
 * Windows checklist.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const restartFn = text.slice(text.indexOf("$RESTART_FN = @'"), text.indexOf("\n'@", text.indexOf("$RESTART_FN = @'")));

describe("shortcuts and the fast path (static)", () => {
  it("the fast path: only when not -Force and not resuming, before anything is installed; it updates shortcuts and ends", () => {
    const at = code.indexOf("$existing = Find-ExistingAgend");
    expect(code.slice(at - 120, at)).toMatch(/if \(-not \$Force -and -not \(Test-Path \$ProgressFile\)\) \{\n\s*$/);
    expect(at).toBeGreaterThan(code.indexOf("if (-not (Check-Admin))"));            // after the admin check …
    expect(at).toBeLessThan(code.indexOf('Write-Info "檢查網路連線..."'));          // … before the network check, so before anything is installed
    expect(at).toBeLessThan(code.indexOf("Write-Step 1 $TOTAL"));
    const block = code.slice(at, code.indexOf('Write-Info "檢查網路連線..."'));
    expect(block).toMatch(/Install-AgendShortcuts \$existing\.Distro \$existing\.User/);
    expect(block).toMatch(/Read-Host "按 Enter 結束"; exit 0/);
    expect(block).not.toMatch(/Invoke-WslStep|wsl --install|agend setup|Mark-Stage/);
  });
  it("no double quote in a command sent to WSL: Windows PowerShell 5.1 does not escape one inside a native argument", () => {
    // pwsh 7 (these tests) escapes it, so only this check sees it. Every literal the shortcuts hand to bash -lc / Invoke-AgendInWsl.
    const shared = text.slice(text.indexOf("$DASHBOARD_OPENER_FN = @'"), text.indexOf("function Get-FileVersionString"));
    const sent = [...shared.matchAll(/(?:bash -lc \(?|Invoke-AgendInWsl \S+ \S+ )'([^']*)'/g)].map(m => m[1]);
    expect(sent.length).toBeGreaterThanOrEqual(5);
    for (const command of sent) expect(command).not.toContain('"');
  });
  it("the end of the install makes both shortcuts with the recorded user; the restart never shuts WSL down", () => {
    expect(code).toMatch(/\$shortcuts = @\(Install-AgendShortcuts \$UBUNTU_DISTRO \$AGEND_USER\)/);
    expect(restartFn).not.toMatch(/--shutdown/);
    expect(restartFn).not.toMatch(/-u root/);
    const openerFn = text.slice(text.indexOf("$DASHBOARD_OPENER_FN = @'"), text.indexOf("\n'@", text.indexOf("$DASHBOARD_OPENER_FN = @'")));
    expect(openerFn).not.toMatch(/-u root/);
  });
});

/** agend may be an nvm install: a login shell need not load nvm, so every command gets this first (as the dashboard's does). */
const PRELUDE = "export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; ";
const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
/** A native wsl.exe that logs each call's argv and answers per command: restart / status / the agend probe. */
function fakeWsl(o: { restart?: [number, string]; status?: string; found?: string[] } = {}) {
  const bin = scratch("agend-1853sc-bin-");
  const [rc, rout] = o.restart ?? [0, "Fleet restarting in background."];
  writeFileSync(join(bin, "wsl.exe"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(bin, "calls.txt")}'
case "$*" in
  *"agend restart"*) echo '${rout}'; exit ${rc} ;;
  *"agend status"*) echo '${o.status ?? "worker  running"}'; exit 0 ;;
  *"command -v agend"*) for d in ${(o.found ?? []).map(d => `'${d}'`).join(" ")}; do case "$2" in "$d") echo AGEND_FOUND; exit 0 ;; esac; done; exit 1 ;;
esac
exit 0
`);
  chmodSync(join(bin, "wsl.exe"), 0o755);
  return bin;
}
const calls = (bin: string) => existsSync(join(bin, "calls.txt")) ? readFileSync(join(bin, "calls.txt"), "utf8") : "";
function withHelpers(body: string, bin: string, input = "", env: Record<string, string> = {}) {
  const dir = scratch("agend-1853sc-");
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(RESTART_FN|DASHBOARD_OPENER_FN)$' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
. ([scriptblock]::Create($RESTART_FN))
$script:OnWindows = $false
$env:LOCALAPPDATA = Join-Path $env:TMPDIR 'localappdata'; $env:ProgramFiles = Join-Path $env:TMPDIR 'pf'
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, input, env: { ...process.env, TMPDIR: dir, PATH: `${bin}:${process.env.PATH}`, ...env } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return { out: r.stdout + r.stderr, dir };
}

describe.skipIf(!pwsh)("with pwsh: the restart shortcut", { timeout: 90_000 }, () => {
  it("N (or just Enter): nothing runs", () => {
    for (const answer of ["n\n", "\n"]) {
      const bin = fakeWsl();
      const { out } = withHelpers(`Write-Output ("RESULT=" + (Invoke-RestartAgend 'Ubuntu-22.04' 'han' -SettleSeconds 0))`, bin, answer);
      expect(out).toContain("沒有重啟。");
      expect(out).toContain("RESULT=cancelled");
      expect(calls(bin)).toBe("");
    }
  });
  it("y: exactly agend restart, then agend status, in the given Linux as the given user", () => {
    const bin = fakeWsl({ status: "worker  running  claude-code" });
    const { out } = withHelpers(`Write-Output ("RESULT=" + (Invoke-RestartAgend 'Ubuntu-22.04' 'han' -SettleSeconds 0))`, bin, "y\n");
    expect(calls(bin)).toBe(`-d Ubuntu-22.04 -u han -- bash -lc ${PRELUDE}agend restart\n-d Ubuntu-22.04 -u han -- bash -lc ${PRELUDE}agend status\n`);
    expect(out).toContain("AgEnD 正在重新啟動。");
    expect(out).toContain("worker  running  claude-code");
    expect(out).toContain("RESULT=restarted");
  });
  it("AgEnD not running: says so and how to start it; no status", () => {
    const bin = fakeWsl({ restart: [1, "Fleet not running. Start with: agend start"] });
    const { out } = withHelpers(`Write-Output ("RESULT=" + (Invoke-RestartAgend 'Ubuntu-24.04' 'root' -SettleSeconds 0))`, bin, "y\n");
    expect(out).toContain("AgEnD 沒有在執行，所以沒有可以重啟的。要啟動它：wsl -d Ubuntu-24.04 -u root -- bash -lc 'agend start'");
    expect(out).toContain("RESULT=failed");
    expect(calls(bin)).not.toMatch(/agend status/);
  });
  it("no wsl.exe at all: says so, no crash", () => {
    const { out } = withHelpers(`$env:PATH = '/nonexistent'
Write-Output ("RESULT=" + (Invoke-RestartAgend 'Ubuntu-24.04' 'root' -SettleSeconds 0))`, fakeWsl(), "y\n");
    expect(out).toContain("找不到 WSL（wsl.exe），所以沒有重啟。");
    expect(out).toContain("RESULT=failed");
  });
  it("the shortcut's script carries the recorded Linux and user, and run on its own it asks, restarts and waits", () => {
    const bin = fakeWsl();
    const { dir } = withHelpers(`$f = Join-Path $env:TMPDIR 'restart-agend.ps1'
[IO.File]::WriteAllText($f, (Get-RestartScript 'Ubuntu-22.04' 'han'), (New-Object System.Text.UTF8Encoding $true))
$t2 = $null; $e2 = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t2, [ref]$e2)
if ($e2.Count) { throw "parse errors" }`, bin);
    const r = spawnSync("pwsh", ["-NoProfile", "-File", join(dir, "restart-agend.ps1")], { encoding: "utf8", timeout: 60_000, input: "y\n\n", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("確定要重啟 AgEnD 嗎？所有 agent 會重新啟動，正在進行的工作會中斷。(y/N)");
    expect(calls(bin)).toBe(`-d Ubuntu-22.04 -u han -- bash -lc ${PRELUDE}agend restart\n-d Ubuntu-22.04 -u han -- bash -lc ${PRELUDE}agend status\n`);
  });
});

describe.skipIf(!pwsh)("with pwsh: finding an existing install", { timeout: 90_000 }, () => {
  it("the recorded Linux and user first", () => {
    const bin = fakeWsl({ found: ["Debian-AgEnD"] });
    const { out } = withHelpers(`New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'AgEnD') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgEnD/install.json') -Value '{"distro":"Debian-AgEnD","user":"han"}'
$r = Find-ExistingAgend
Write-Output ("FOUND=" + $r.Distro + "/" + $r.User)`, bin);
    expect(out).toContain("FOUND=Debian-AgEnD/han");
    expect(calls(bin).split("\n")[0]).toBe(`-d Debian-AgEnD -u han -- bash -lc ${PRELUDE}command -v agend >/dev/null 2>&1 && echo AGEND_FOUND`);
  });
  it("a clean Windows (no record, no Store WSL): nothing found, and wsl.exe never asked", () => {
    const bin = fakeWsl({ found: ["Ubuntu-24.04"] });
    const { out } = withHelpers(`Write-Output ("FOUND=[" + ((Find-ExistingAgend) -ne $null) + "]")`, bin);
    expect(out).toContain("FOUND=[False]");
    expect(calls(bin)).toBe("");
  });
  it("no record, but the Store WSL is there and the default Ubuntu has agend: found as root (the installer's user)", () => {
    const bin = fakeWsl({ found: ["Ubuntu-24.04"] });
    const { out } = withHelpers(`New-Item -ItemType Directory -Path (Join-Path $env:ProgramFiles 'WSL') -Force | Out-Null
New-Item -ItemType File -Path (Join-Path (Join-Path $env:ProgramFiles 'WSL') 'wsl.exe') -Force | Out-Null
function Get-FileVersionString([string]$path) { return '2.6.1.0' }
$r = Find-ExistingAgend
Write-Output ("FOUND=" + $r.Distro + "/" + $r.User)`, bin);
    expect(out).toContain("FOUND=Ubuntu-24.04/root");
  });
  it("installed nowhere: nothing found", () => {
    const bin = fakeWsl({ found: [] });
    const { out } = withHelpers(`New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'AgEnD') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgEnD/install.json') -Value '{"distro":"Gone","user":"han"}'
Write-Output ("FOUND=[" + ((Find-ExistingAgend) -ne $null) + "]")`, bin);
    expect(out).toContain("FOUND=[False]");
    expect(calls(bin).trim().split("\n")).toHaveLength(4);                       // the record, then the three default Ubuntus
  });
});
