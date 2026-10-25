/**
 * #1853, after #2264 (the leader's adjudication follow-up): the Windows one-liner on a PC whose AgEnD is broken — an
 * update cut off half way, `agend: command not found` — repairs it and nothing else.
 * - The probe of a Linux says AGEND_FOUND (agend --version runs), AGEND_BROKEN (it does not, but AgEnD's files are
 *   there: fleet.yaml, or @songsid in npm's global root, a retired .agend-* included) with the version found on disk,
 *   or nothing. It carries no double quote (Windows PowerShell 5.1) and quotes its sed program (no glob expansion).
 * - Broken: the fast path re-runs the official install.sh in that Linux (pinned to the version on disk, so a beta is
 *   not swapped for the stable release), checks `agend --version`, then offers the shortcuts as usual. No WSL, backend
 *   or setup step is redone; a failed repair stops and says the data is kept.
 * The probe runs in real bash with a fake npm and agend; the PowerShell helpers in pwsh with a fake native wsl.exe.
 * A real broken host is the user's Windows checklist.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const PROBE = /^\$AGEND_PROBE = '((?:[^']|'')*)'$/m.exec(text)![1]!.replace(/''/g, "'");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

describe("the probe of a Linux, in real bash", () => {
  function host() {
    const d = scratch("agend-1853repair-");
    mkdirSync(join(d, "home", ".agend"), { recursive: true });
    mkdirSync(join(d, "bin"));
    mkdirSync(join(d, "root", "@songsid", ".agend-RmEK4vIL"), { recursive: true });
    writeFileSync(join(d, "root", "@songsid", ".agend-RmEK4vIL", "package.json"), '{\n  "name": "@songsid/agend",\n  "version": "2.3.0-beta.16",\n  "x": 1\n}\n');
    const tool = (name: string, body: string) => { writeFileSync(join(d, "bin", name), `#!/bin/sh\n${body}\n`); chmodSync(join(d, "bin", name), 0o755); };
    tool("npm", `echo '${join(d, "root")}'`);
    tool("agend", "exit 127");
    // Only this host: never the real AGEND_HOME of whoever runs the test.
    const env = { HOME: join(d, "home"), PATH: `${join(d, "bin")}:/usr/bin:/bin` };
    const probe = () => spawnSync("bash", ["-c", PROBE], { encoding: "utf8", env, cwd: d }).stdout;
    return { d, tool, probe };
  }
  it("an update cut off half way (only npm's retired copy left): broken, with that copy's version", () => {
    const { probe } = host();
    expect(probe()).toBe("AGEND_BROKEN\nAGEND_VERSION=2.3.0-beta.16\n");
  });
  it("agend runs: found, whatever else is there", () => {
    const { tool, probe } = host();
    tool("agend", "echo 2.3.0");
    expect(probe()).toBe("AGEND_FOUND\n");
  });
  it("a fleet's data but no npm at all (the command and Node gone): broken, version unknown", () => {
    const { d, probe } = host();
    writeFileSync(join(d, "home", ".agend", "fleet.yaml"), "instances: {}\n");
    renameSync(join(d, "bin", "npm"), join(d, "bin", "npm-gone"));
    expect(probe()).toBe("AGEND_BROKEN\n");
  });
  it("no AgEnD here (nothing of AgEnD's in npm, no fleet.yaml): nothing", () => {
    const { d, probe } = host();
    renameSync(join(d, "root", "@songsid"), join(d, "root", "not-agend"));
    expect(probe()).toBe("");
  });
  it("a glob in the cwd never changes the answer (the sed program is quoted)", () => {
    const { d, probe } = host();
    writeFileSync(join(d, "s"), "");                                             // a file a bare s/…/ could glob to
    expect(probe()).toBe("AGEND_BROKEN\nAGEND_VERSION=2.3.0-beta.16\n");
  });
  it("#2286 review: paths with a space are not split (AGEND_HOME, npm's root), and npm's scope alone is not AgEnD", () => {
    const spaced = scratch("agend-1853repair-sp-");
    const home = join(spaced, "home dir"), root = join(spaced, "npm root");
    mkdirSync(join(home, ".agend"), { recursive: true }); mkdirSync(join(spaced, "bin"));
    mkdirSync(join(root, "@songsid", ".agend-RmEK4vIL"), { recursive: true }); mkdirSync(join(root, "@songsid", "agend"));
    writeFileSync(join(root, "@songsid", ".agend-RmEK4vIL", "package.json"), '{\n  "name": "@songsid/agend",\n  "version": "2.3.0-beta.16"\n}\n');
    writeFileSync(join(root, "@songsid", "agend", "partial.tmp"), "");               // npm's half-written new copy
    for (const [n, b] of [["npm", `echo '${root}'`], ["agend", "exit 127"]]) { writeFileSync(join(spaced, "bin", n), `#!/bin/sh\n${b}\n`); chmodSync(join(spaced, "bin", n), 0o755); }
    const probe = () => spawnSync("bash", ["-c", PROBE], { encoding: "utf8", env: { HOME: home, PATH: `${join(spaced, "bin")}:/usr/bin:/bin` }, cwd: spaced });
    expect(probe().stdout).toBe("AGEND_BROKEN\nAGEND_VERSION=2.3.0-beta.16\n");   // npm's root with a space
    renameSync(join(root, "@songsid"), join(root, "moved"));
    writeFileSync(join(home, ".agend", "fleet.yaml"), "");
    const fleet = probe();
    expect([fleet.stdout, fleet.stderr]).toEqual(["AGEND_BROKEN\n", ""]);            // AGEND_HOME with a space; no "binary operator expected"
    rmSync(join(home, ".agend", "fleet.yaml"));
    mkdirSync(join(root, "@songsid", "agend-plugin-discord"), { recursive: true });
    expect(probe().stdout).toBe("");                                                   // the scope alone, no AgEnD package
  });
  it("no double quote reaches wsl.exe (Windows PowerShell 5.1 would split the command)", () => {
    expect(PROBE).not.toContain('"');
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
/** A native wsl.exe: answers the probe with `probeAnswer`, the repair with `repairExit`, agend --version with `versionExit`. */
function fakeWsl(o: { probeAnswer?: string; repairExit?: number; versionExit?: number } = {}) {
  const bin = scratch("agend-1853repair-bin-");
  writeFileSync(join(bin, "wsl.exe"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(bin, "calls.txt")}'
case "$*" in
  *"echo AGEND_FOUND"*) printf '${(o.probeAnswer ?? "").replace(/\n/g, "\\n")}'; exit 0 ;;
  *"install.sh"*) echo 'repairing'; exit ${o.repairExit ?? 0} ;;
  *"agend --version"*) echo 2.3.0-beta.16; exit ${o.versionExit ?? 0} ;;
esac
exit 0
`);
  chmodSync(join(bin, "wsl.exe"), 0o755);
  return bin;
}
const calls = (bin: string) => existsSync(join(bin, "calls.txt")) ? readFileSync(join(bin, "calls.txt"), "utf8") : "";
function withHelpers(body: string, bin: string) {
  const dir = scratch("agend-1853repair-ps-");
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(WSL_COMMAND_FN|RESTART_FN|AGEND_PROBE|AGEND_DISTRO_BASE)$' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
. ([scriptblock]::Create($WSL_COMMAND_FN)); . ([scriptblock]::Create($RESTART_FN))
$script:OnWindows = $false
$env:LOCALAPPDATA = Join-Path $env:TMPDIR 'localappdata'
function Get-InstalledWslVersion { return [version]'2.6.3.0' }
# Exercise repair decisions while keeping the owned-step transport inert.
function Invoke-WslStep { param($Label,$Usually,$UpperMinutes,$Distro,$User,$Script)
    & wsl.exe -d $Distro -u $User -- bash -lc $Script | Out-Host
    return $LASTEXITCODE
}
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: dir, PATH: `${bin}:${process.env.PATH}` } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
}
const PRELUDE = "export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; ";

describe.skipIf(!pwsh)("with pwsh: finding and repairing a broken AgEnD", { timeout: 90_000 }, () => {
  it("the probe's broken answer: that Linux, broken, with the version on disk; found is not broken", () => {
    const broken = withHelpers(`$r = Find-ExistingAgend; Write-Output ("R=" + $r.Distro + "|" + $r.User + "|" + $r.Broken + "|" + $r.Version)`,
      fakeWsl({ probeAnswer: "AGEND_BROKEN\nAGEND_VERSION=2.3.0-beta.16\n" }));
    expect(broken).toContain("R=AgEnD|root|True|2.3.0-beta.16");
    const found = withHelpers(`$r = Find-ExistingAgend; Write-Output ("R=" + $r.Distro + "|" + $r.Broken)`, fakeWsl({ probeAnswer: "AGEND_FOUND\n" }));
    expect(found).toContain("R=AgEnD|False");
  });
  it("the repair: the official installer in that Linux, on the channel of the version on disk (a beta stays on beta), then agend --version", () => {
    const bin = fakeWsl();
    const out = withHelpers(`Write-Output ("OK=" + (Invoke-AgendRepair 'AgEnD' 'root' '2.3.0-beta.16'))`, bin);
    expect(out).toContain("OK=True");
    const log = calls(bin).trim().split("\n");
    // #2286 review: never the old version itself — it may predate the installer that repairs (#2264).
    expect(log[0]).toBe(`-d AgEnD -u root -- bash -lc ${PRELUDE}set -o pipefail; curl -fsSL https://songsid.github.io/AgEnD/install.sh | AGEND_VERSION=beta bash`);
    expect(log[1]).toBe(`-d AgEnD -u root -- timeout --signal=TERM --kill-after=2s 25 bash -lc ${PRELUDE}agend --version`);
    expect(log[0]).not.toContain('"');
  });
  it("a stable version, no version found, or one that is not a version: the installer's default (latest), never the text pasted in", () => {
    for (const v of ["2.2.7", "", "1.0; rm -rf ~", "$(id)", "2.3.0-beta.16; id"]) {
      const bin = fakeWsl();
      withHelpers(`$null = Invoke-AgendRepair 'AgEnD' 'root' '${v.replace(/'/g, "''")}'`, bin);
      expect(calls(bin).split("\n")[0], v).toMatch(/\| bash$/);
      expect(calls(bin).split("\n")[0], v).not.toMatch(/AGEND_VERSION/);
    }
  });
  it.each([["the installer fails", { repairExit: 1 }], ["agend still does not run afterwards", { versionExit: 127 }]])("%s: not repaired", (_n, o) => {
    expect(withHelpers(`Write-Output ("OK=" + (Invoke-AgendRepair 'AgEnD' 'root' '2.3.0'))`, fakeWsl(o))).toContain("OK=False");
  });
});

describe("the fast path repairs first, then only offers the shortcuts (static)", () => {
  it("broken: the repair before anything else; a failed one stops, saying the data is kept", () => {
    const fast = code.slice(code.indexOf("$existing = Find-ExistingAgend"), code.indexOf("if (-not (Test-WindowsNetwork))"));
    const repair = fast.indexOf("if ($existing.Broken) {");
    expect(repair).toBeGreaterThan(-1);
    expect(repair).toBeLessThan(fast.indexOf("$prior = Get-InstallRecordConflict"));
    expect(fast).toMatch(/if \(-not \(Invoke-AgendRepair \$existing\.Distro \$existing\.User \$existing\.Version\)\) \{\n[^\n]*你的資料和設定都還在[^\n]*\n\s*Read-Host "按 Enter 結束"; exit 1/);
    expect(fast).not.toMatch(/Invoke-WslStep|wsl --install|agend setup|agend quickstart|Mark-Stage/);
  });
});
