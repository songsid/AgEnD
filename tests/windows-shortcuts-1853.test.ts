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
    expect(at).toBeLessThan(code.indexOf("if (-not (Test-WindowsNetwork))"));          // … before the network check, so before anything is installed
    expect(at).toBeLessThan(code.indexOf("Write-Step 1 $TOTAL"));
    const block = code.slice(at, code.indexOf("if (-not (Test-WindowsNetwork))"));
    expect(block).toMatch(/\$made = @\(Install-AgendShortcuts \$existing\.Distro \$existing\.User\)\n\s*\$null = Write-ShortcutResult \$made/);
    expect(block).toMatch(/Read-Host "按 Enter 結束"; exit 0/);
    expect(block).not.toMatch(/Invoke-WslStep|wsl --install|agend setup|Mark-Stage/);
  });
  it("no double quote in a command sent to WSL: Windows PowerShell 5.1 does not escape one inside a native argument", () => {
    // pwsh 7 (these tests) escapes it, so only this check sees it. Every literal the shortcuts hand to bash -lc / Invoke-AgendInWsl.
    const shared = text.slice(text.indexOf("$WSL_COMMAND_FN = @'"), text.indexOf("function Get-FileVersionString"));
    const sent = [...shared.matchAll(/(?:bash -lc \(?|Invoke-AgendInWsl \S+ \S+ |Get-WslAgendCommand |return \()'((?!Write-Host)[^']*)'/g)].map(m => m[1]);
    expect(sent.length).toBeGreaterThanOrEqual(5);
    for (const command of sent) expect(command).not.toContain('"');
  });
  it("the end of the install makes both shortcuts with the recorded user; the restart never shuts WSL down", () => {
    expect(code).toMatch(/\$shortcuts = @\(Install-AgendShortcuts \$UBUNTU_DISTRO \$AGEND_USER\)\n\$null = Write-ShortcutResult \$shortcuts/);
    expect(restartFn).not.toMatch(/--shutdown/);
    expect(restartFn).not.toMatch(/-u root/);
    const openerFn = text.slice(text.indexOf("$DASHBOARD_OPENER_FN = @'"), text.indexOf("\n'@", text.indexOf("$DASHBOARD_OPENER_FN = @'")));
    expect(openerFn).not.toMatch(/-u root/);
  });
});

/** agend may be an nvm install: a login shell need not load nvm, so every command gets this first (as the dashboard's does). */
/** The installer's probe of a Linux for AgEnD (found / broken / none), as it reaches bash. */
const PROBE = /^\$AGEND_PROBE = '((?:[^']|'')*)'$/m.exec(text)![1]!.replace(/''/g, "'");
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
  *"echo AGEND_FOUND"*) for d in ${(o.found ?? []).map(d => `'${d}'`).join(" ")}; do case "$2" in "$d") echo AGEND_FOUND; exit 0 ;; esac; done; exit 1 ;;
esac
exit 0
`);
  chmodSync(join(bin, "wsl.exe"), 0o755);
  return bin;
}
/**
 * Run a printed "start AgEnD" line the way a person would: pasted into PowerShell. Its wsl runs the bash command in a
 * clean environment whose home has only an nvm-provided agend (an inert one that says it ran).
 */
function runPrinted(line: string): string {
  const d = scratch("agend-1853paste-");
  const home = join(d, "home"), nvmBin = join(d, "nvmbin"), wslBin = join(d, "wslbin");
  for (const dir of [join(home, ".nvm"), nvmBin, wslBin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".nvm", "nvm.sh"), `export PATH=${nvmBin}:$PATH\n`);
  writeFileSync(join(nvmBin, "agend"), "#!/bin/sh\necho INERT_START_OK \"$@\"\n");
  chmodSync(join(nvmBin, "agend"), 0o755);
  for (const name of ["wsl", "wsl.exe"]) {
    writeFileSync(join(wslBin, name), `#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift\nexec env -i HOME='${home}' PATH=/usr/bin:/bin "$@"\n`);
    chmodSync(join(wslBin, name), 0o755);
  }
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", line], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${wslBin}:${process.env.PATH}` } });
  return r.stdout + r.stderr;
}
const calls = (bin: string) => existsSync(join(bin, "calls.txt")) ? readFileSync(join(bin, "calls.txt"), "utf8") : "";
function withHelpers(body: string, bin: string, input = "", env: Record<string, string> = {}) {
  const dir = scratch("agend-1853sc-");
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(WSL_COMMAND_FN|RESTART_FN|DASHBOARD_OPENER_FN|AGEND_PROBE)$' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
. ([scriptblock]::Create($WSL_COMMAND_FN)); . ([scriptblock]::Create($DASHBOARD_OPENER_FN)); . ([scriptblock]::Create($RESTART_FN))
$script:OnWindows = $false
$env:LOCALAPPDATA = Join-Path $env:TMPDIR 'localappdata'; $env:ProgramFiles = Join-Path $env:TMPDIR 'pf'
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, input, env: { ...process.env, TMPDIR: dir, PATH: `${bin}:${process.env.PATH}`, ...env } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return { out: r.stdout + r.stderr, dir };
}

describe.skipIf(!pwsh)("with pwsh: the restart shortcut", { timeout: 90_000 }, () => {
  it("N, just Enter, or no input to read at all: nothing runs", () => {
    for (const answer of ["n\n", "\n", "", "y/N\n", "yes\n", "yesterday\n"]) {     // only a lone y agrees (#2265 review)                                 // "": Read-Host gets $null (#2264-era review of the y/N checks)
      const bin = fakeWsl();
      const { out } = withHelpers(`Write-Output ("RESULT=" + (Invoke-RestartAgend 'Ubuntu-22.04' 'han' -SettleSeconds 0))`, bin, answer);
      expect(out).toContain("沒有重啟。");
      expect(out).toContain("RESULT=cancelled");
      expect(calls(bin)).toBe("");
    }
  });
  it("a lone Y with spaces around it is a yes too", () => {
    const bin = fakeWsl();
    const { out } = withHelpers(`Write-Output ("RESULT=" + (Invoke-RestartAgend 'Ubuntu-22.04' 'han' -SettleSeconds 0))`, bin, "  Y \n");
    expect(out).toContain("RESULT=restarted");
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
    expect(out).toContain("AgEnD 沒有在執行，所以沒有可以重啟的。要啟動它：wsl -d Ubuntu-24.04 -u root -- bash -lc '");
    // #2252 review: the line it prints is one a person can paste — with nvm loaded, so an nvm-only agend is found.
    expect(runPrinted(out.match(/要啟動它：(wsl .*)$/m)![1]!)).toContain("INERT_START_OK start");
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
function Get-InstalledWslVersion { return [version]'2.6.1.0' }
$r = Find-ExistingAgend
Write-Output ("FOUND=" + $r.Distro + "/" + $r.User)`, bin);
    expect(out).toContain("FOUND=Debian-AgEnD/han");
    expect(calls(bin).split("\n")[0]).toBe(`-d Debian-AgEnD -u han -- bash -lc ${PRELUDE}${PROBE}`);
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
  it("#2252 review: an old record with no WSL there now (removed since): nothing found, and wsl.exe never asked", () => {
    const bin = fakeWsl({ found: ["Debian-AgEnD", "Ubuntu-24.04"] });
    const { out } = withHelpers(`New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'AgEnD') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgEnD/install.json') -Value '{"distro":"Debian-AgEnD","user":"han"}'
Write-Output ("FOUND=[" + ((Find-ExistingAgend) -ne $null) + "]")`, bin);
    expect(out).toContain("FOUND=[False]");
    expect(calls(bin)).toBe("");
  });
  it("installed nowhere: nothing found", () => {
    const bin = fakeWsl({ found: [] });
    const { out } = withHelpers(`New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'AgEnD') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgEnD/install.json') -Value '{"distro":"Gone","user":"han"}'
function Get-InstalledWslVersion { return [version]'2.6.1.0' }
Write-Output ("FOUND=[" + ((Find-ExistingAgend) -ne $null) + "]")`, bin);
    expect(out).toContain("FOUND=[False]");
    expect(calls(bin).trim().split("\n")).toHaveLength(5);                       // the record, then AgEnD's own and the three default Ubuntus
  });
});

describe.skipIf(!pwsh)("with pwsh: making the two shortcuts (#2252 review)", { timeout: 90_000 }, () => {
  const fakeShortcut = (failing: string) => `$script:OnWindows = $true
function New-AgendShortcut([string]$name, [string]$scriptName, [string]$scriptText, [string]$description) {
  if ($name -eq '${failing}') { throw 'COM failed' }
  return ('/Desktop/' + $name + '.lnk')
}
$made = @(Install-AgendShortcuts 'Ubuntu-22.04' 'han')
Write-Output ("COUNT=" + $made.Count)
Write-Output ("BOTH=" + (Write-ShortcutResult $made))
Write-Output ("RECORD=" + (Get-Content -Raw -LiteralPath (Join-Path (Get-AgendShortcutDir) 'install.json')))`;
  it("both made: says both, and leaves the WSL marker", () => {
    const bin = fakeWsl();
    const { out } = withHelpers(fakeShortcut("none"), bin);
    expect(out).toContain("COUNT=2");
    expect(out).toContain("[OK] 桌面上已建立「AgEnD 儀表板」和「AgEnD 重新啟動」捷徑");
    expect(out).toContain("BOTH=True");
    expect(calls(bin)).toMatch(/windows-shortcuts\n$/);
  });
  it("the second one fails: the first is still made, it says which one is missing, and no marker (the update hint stays)", () => {
    const bin = fakeWsl();
    const { out } = withHelpers(fakeShortcut("AgEnD 重新啟動"), bin);
    expect(out).toContain("COUNT=1");
    expect(out).toContain("只建立了「AgEnD 儀表板」捷徑，另一個沒有建立成功。");
    expect(out).toContain("BOTH=False");
    expect(out).not.toContain("[OK] 桌面上已建立");
    expect(calls(bin)).toBe("");
    // The record still names this Linux and user (as an object: a hashtable's ConvertTo-Json has no fixed key order).
    expect(JSON.parse(out.match(/^RECORD=(.*)$/m)![1]!)).toEqual({ distro: "Ubuntu-22.04", user: "han" });
  });
  it("the first one fails: the second is still made", () => {
    const { out } = withHelpers(fakeShortcut("AgEnD 儀表板"), fakeWsl());
    expect(out).toContain("COUNT=1");
    expect(out).toContain("只建立了「AgEnD 重新啟動」捷徑");
  });
  it("the dashboard's 'not running' line can be pasted as it is: nvm loaded, the recorded user", () => {
    const bin = scratch("agend-1853dash-down-");
    writeFileSync(join(bin, "wsl.exe"), "#!/bin/sh\necho 'Web token not found. Is the fleet running?' >&2\nexit 1\n");
    chmodSync(join(bin, "wsl.exe"), 0o755);
    const { out } = withHelpers(`$null = Invoke-OpenDashboard 'Ubuntu-22.04' 'han'`, bin);
    const line = out.match(/執行：(wsl .*)$/m)![1]!;
    expect(line.startsWith("wsl -d Ubuntu-22.04 -u han -- bash -lc '")).toBe(true);
    expect(line).not.toContain('"');                                          // Windows PowerShell 5.1 would split it
    expect(runPrinted(line)).toContain("INERT_START_OK start");
  });
});

describe.skipIf(!pwsh)("with pwsh: a name with a quote in it (#2260 review)", { timeout: 90_000 }, () => {
  /** Parse a generated text as PowerShell: its error count, and the arguments of its last command (as values). */
  const parsed = (expr: string, name: string) => withHelpers(`$text = ${expr}
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$t, [ref]$e)
$cmd = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq '${name}' }, $true))[-1]
$values = @($cmd.CommandElements | Select-Object -Skip 1 | ForEach-Object { if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value } else { $_.Extent.Text } })
Write-Output ("PARSED=" + (@{ errors = $e.Count; command = $cmd.GetCommandName(); args = $values } | ConvertTo-Json -Compress))`, fakeWsl()).out;
  const result = (out: string) => JSON.parse(out.match(/^PARSED=(.*)$/m)![1]!);
  it.each([["Get-RestartScript", "Invoke-RestartAgend"], ["Get-DashboardOpenerScript", "Invoke-OpenDashboard"]])("%s: the saved script parses and calls with the exact names", (builder, command) => {
    const r = result(parsed(`(${builder} "Ubuntu's" "o'neil")`, command));
    expect(r.errors).toBe(0);
    expect(r.command).toBe(command);
    expect(r.args.slice(0, 2)).toEqual(["Ubuntu's", "o'neil"]);
  });
  it("the printed start command, pasted, passes the exact names to wsl; a plain name stays unquoted", () => {
    const r = result(parsed(`(Get-AgendStartHint "Ubuntu's" "o'neil")`, "wsl"));
    expect(r.errors).toBe(0);
    expect(r.command).toBe("wsl");
    expect(r.args.slice(0, 4)).toEqual(["-d", "Ubuntu's", "-u", "o'neil"]);
    expect(withHelpers(`Write-Output ("HINT=" + (Get-AgendStartHint 'Ubuntu-24.04' 'han'))`, fakeWsl()).out).toContain("HINT=wsl -d Ubuntu-24.04 -u han -- bash -lc '");
  });
});

describe("the shortcut's agend status is a real command (#2359)", () => {
  it("src/cli.ts implements status as a hidden alias of ls", () => {
    const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(), encoding: "utf8", timeout: 8000,
      env: { ...process.env, AGEND_HOME: join(process.cwd(), "tests"), NOTIFY_SOCKET: "" },
    });
    const help = cli(["--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).not.toMatch(/^\s+status\b/m);
    const statusHelp = cli(["status", "--help"]);
    expect(statusHelp.status, statusHelp.stderr).toBe(0);
    expect(statusHelp.stdout).toMatch(/Alias of `agend ls`|List all instances/);
  });
});
