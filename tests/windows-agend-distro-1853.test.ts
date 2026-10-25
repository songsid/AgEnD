/**
 * #1853 (the user's real run, 2026-10-20): a PC that already has Ubuntu can install a separate one just for AgEnD —
 * the recommended choice — so the existing Ubuntu is never changed.
 * - [1] a separate AgEnD Ubuntu (recommended) / [2] the existing one (its settings change) / Enter quits. Only 1 or 2.
 * - The name is the first free one of AgEnD, AgEnD-2, …; an AgEnD Linux from an earlier install is reused, never a third.
 * - WSL 2.4.4+: `wsl --install Ubuntu-24.04 --name <name> --location <disk>\WSL\<name> --no-launch` (a tar-based
 *   distribution; Microsoft's build-custom-distro doc). Older WSL, or the name not there afterwards: Microsoft's
 *   distribution list's official .wsl, checked against its SHA256, then `wsl --import <name> <location> <file> --version 2`.
 * - The chosen name is what everything after uses: the progress, install.json, both shortcuts, the repair fast path.
 * The helpers are the installer's own, in pwsh, with a fake native wsl.exe (its distro list in a file) and the download
 * and the distribution list stubbed. A real install is the user's Windows checklist.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const body = code.slice(code.indexOf("Clear-Host"));

describe("the existing-Ubuntu choice (static)", () => {
  it("stage 1 reads the Linux list (starts none), reuses an AgEnD Linux, else asks when there is an Ubuntu", () => {
    const stage = body.slice(body.indexOf("$names = Get-WslDistroNames"), body.indexOf('Add-Content -Path $ProgressFile -Value "DISTRO=$UBUNTU_DISTRO"'));
    expect(stage).toMatch(/\$agendDistro = \$situation\.Agend/);
    // #2279 review: an unreadable list stops stage 1 before any choice, install or reuse.
    expect(stage).toMatch(/^\$names = Get-WslDistroNames\n\s*\$situation = Get-DistroSituation \$names\n\s*if \(\$situation\.State -eq 'unknown'\) \{\n[^\n]*讀不到這台電腦上的 Linux 清單[^\n]*\n[^\n]*\n\s*Read-Host "按 Enter 結束"; exit 1\n\s*\}\n\s*\$agendDistro/);
    expect(stage).toMatch(/if \(\$situation\.State -eq 'reuse'\) \{ \$choice = 'reuse' \} elseif \(\$situation\.State -eq 'ubuntu'\) \{ \$choice = Read-DistroChoice \$installedDistroName \}/);
    expect(stage).toMatch(/if \(\$choice -eq 'separate'\) \{ \$UBUNTU_DISTRO = Get-FreeAgendDistroName \$names \}/);
    expect(stage).toMatch(/if \(\$choice -eq 'separate'\) \{ "\$\(\$disk\.Root\)WSL\\\$UBUNTU_DISTRO" \}/);
    expect(stage).toMatch(/if \(-not \(Install-AgendDistro \$UBUNTU_DISTRO \$wslPath\)\) \{/);
    expect(stage).not.toMatch(/wsl -d \$name -u root -- echo/);                     // no more starting each Ubuntu to see if it is there
    // The chosen name is saved with the progress, and the end of the install records it (install.json) and makes the shortcuts.
    expect(body).toMatch(/Add-Content -Path \$ProgressFile -Value "DISTRO=\$UBUNTU_DISTRO"/);
    expect(body).toMatch(/\$shortcuts = @\(Install-AgendShortcuts \$UBUNTU_DISTRO \$AGEND_USER\)/);
  });
  it("the repair fast path also looks in AgEnD's own Linux; a record for another Linux is said, and asked about (no by default)", () => {
    expect(code).toMatch(/foreach \(\$d in @\(\$AGEND_DISTRO_BASE, 'Ubuntu-24\.04', 'Ubuntu-22\.04', 'Ubuntu'\)\)/);
    const fast = body.slice(body.indexOf("$existing = Find-ExistingAgend"), body.indexOf('Write-Info "檢查網路連線..."'));
    expect(fast).toMatch(/\$prior = Get-InstallRecordConflict \$existing\.Distro \$existing\.User/);
    expect(fast).toMatch(/\(y\/N\)"\n\s*\$update = \(\[string\]\$ans\) -match '\^\\s\*\[yY\]\\s\*\$'/);
    // #2279 review: what was asked about is read again before anything is written.
    expect(fast).toMatch(/if \(\$update -and -not \(Test-InstallRecordAsSeen \$prior \$existing\.Distro \$existing\.User\)\) \{/);
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
/** A fake native wsl.exe: `--list --quiet` prints the names file; `--install … --name X` and `--import X` add X (unless told not to). */
function fakeWsl(names: string[], o: { ignoreName?: boolean; listFails?: boolean; listFailsAfterInstall?: boolean } = {}) {
  const bin = scratch("agend-1853distro-bin-");
  writeFileSync(join(bin, "names.txt"), names.map(n => n + "\n").join(""));
  writeFileSync(join(bin, "wsl.exe"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(bin, "calls.txt")}'
case "$1" in
  --list) ${o.listFails ? "echo 'Error: 0x80070005'; exit 1" : o.listFailsAfterInstall ? `if [ -f '${join(bin, "installed")}' ]; then exit 1; fi; cat '${join(bin, "names.txt")}'` : `cat '${join(bin, "names.txt")}'`} ;;
  --install) touch '${join(bin, "installed")}'; ${o.ignoreName ? "echo 'Invalid command line option: --name'; exit 1" : `while [ "$#" -gt 0 ]; do if [ "$1" = "--name" ]; then echo "$2" >> '${join(bin, "names.txt")}'; fi; shift; done`} ;;
  --import) echo "$2" >> '${join(bin, "names.txt")}' ;;
esac
exit 0
`);
  chmodSync(join(bin, "wsl.exe"), 0o755);
  return bin;
}
const calls = (bin: string) => existsSync(join(bin, "calls.txt")) ? readFileSync(join(bin, "calls.txt"), "utf8") : "";
function withHelpers(body: string, bin: string, input = "") {
  const dir = scratch("agend-1853distro-");
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(AGEND_DISTRO_BASE|WSL_NAME_MIN|DISTRO_LIST_URL|WSL_COMMAND_FN|RESTART_FN|DASHBOARD_OPENER_FN)$' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
. ([scriptblock]::Create($WSL_COMMAND_FN))
$script:OnWindows = $false
$env:LOCALAPPDATA = Join-Path $env:TMPDIR 'localappdata'
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, input, env: { ...process.env, TMPDIR: dir, PATH: `${bin}:${process.env.PATH}` } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return { out: r.stdout + r.stderr, dir };
}
/** The official image, stubbed: a download writes IMAGE; the list names its SHA256 (or `badHash`), or fails (`noList`). */
const IMAGE = "pretend ubuntu rootfs";
const imageHash = createHash("sha256").update(IMAGE).digest("hex");
const imageStubs = (o: { badHash?: boolean; noList?: boolean } = {}) => `
function Invoke-RestMethod { param($Uri, $TimeoutSec, [switch]$UseBasicParsing)
  ${o.noList ? "throw 'offline'" : ""}
  return [pscustomobject]@{ ModernDistributions = [pscustomobject]@{ Ubuntu = @([pscustomobject]@{ Name = 'Ubuntu-24.04'; Amd64Url = [pscustomobject]@{ Url = 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl'; Sha256 = '0x${o.badHash ? "00" + imageHash.slice(2) : imageHash.toUpperCase()}' } }) } } }
function Invoke-InstallDownload { param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec) Add-Content (Join-Path $env:TMPDIR 'downloads.txt') $Uri; [IO.File]::WriteAllText($OutFile, '${IMAGE}') }
`;

describe.skipIf(!pwsh)("with pwsh: choosing and installing AgEnD's own Ubuntu", { timeout: 90_000 }, () => {
  it.each([["1", "separate"], [" 1 ", "separate"], ["2", "existing"], ["", "quit"], ["y", "quit"], ["12", "quit"], ["no input", "quit"]])("the choice: %j → %s (only 1 or 2 count)", (answer, want) => {
    const { out } = withHelpers(`Write-Output ("CHOICE=" + (Read-DistroChoice 'Ubuntu-24.04'))`, fakeWsl([]), answer === "no input" ? "" : `${answer}\n`);
    expect(out).toContain(`CHOICE=${want}\n`);
    expect(out).toContain("[1] 另外安裝一個 AgEnD 專用的 Ubuntu（建議，不動你原本的）");
    expect(out).toContain("[Enter] 結束，不動任何東西");
  });
  it("the Linux list comes from wsl --list --quiet (nothing started); the free name is AgEnD, AgEnD-2, … (case-insensitive)", () => {
    const bin = fakeWsl(["Ubuntu-24.04", "agend", "AgEnD-2"]);
    const { out } = withHelpers(`$n = Get-WslDistroNames
Write-Output ("NAMES=" + ($n -join ','))
Write-Output ("FREE=" + (Get-FreeAgendDistroName $n))
Write-Output ("FREE0=" + (Get-FreeAgendDistroName @('Ubuntu')))`, bin);
    expect(out).toContain("NAMES=Ubuntu-24.04,agend,AgEnD-2\n");
    expect(out).toContain("FREE=AgEnD-3\n");
    expect(out).toContain("FREE0=AgEnD\n");
    expect(calls(bin)).toBe("--list --quiet\n");
  });
  it("#2279 review: a list that cannot be read is unknown ($null), never 'no Linux'; an empty list is empty", () => {
    const failing = withHelpers(`$n = Get-WslDistroNames; Write-Output ("NULL=" + ($null -eq $n))`, fakeWsl(["Ubuntu-24.04"], { listFails: true })).out;
    expect(failing).toContain("NULL=True");                                         // and no registry to fall back on here
    const empty = withHelpers(`$n = Get-WslDistroNames; Write-Output ("NULL=" + ($null -eq $n) + " COUNT=" + @($n).Count)`, fakeWsl([])).out;
    expect(empty).toContain("NULL=False COUNT=0");
  });
  // #2279 R1: `wsl --list` failing (some WSL versions do when there is no Linux at all) falls back to WSL's own records.
  // The registry commands are modeled by functions of the same name (they come before the cmdlets).
  const registry = (o: { drive?: boolean; key?: boolean | "throws"; items?: string[] | "throws" }) => `
${o.drive === false ? "" : "function Get-PSDrive { param($Name, $ErrorAction) return [pscustomobject]@{ Name = 'HKCU' } }"}
function Test-Path { param([string]$LiteralPath, $ErrorAction) ${o.key === "throws" ? "throw 'access denied'" : `return $${o.key !== false}`} }
function Get-ChildItem { param([string]$LiteralPath, $ErrorAction) ${o.items === "throws" ? "throw 'access denied'" : `return @(${(o.items ?? []).map(n => `[pscustomobject]@{ PSPath = '${n}' }`).join(", ")})`} }
function Get-ItemProperty { param([string]$LiteralPath, $ErrorAction) return [pscustomobject]@{ DistributionName = $LiteralPath } }`;
  it.each([
    ["two Linux registered", { items: ["Ubuntu-24.04", "AgEnD"] }, "NULL=False COUNT=2 NAMES=Ubuntu-24.04,AgEnD STATE=reuse"],
    ["the key there, nothing in it", { items: [] }, "NULL=False COUNT=0 NAMES= STATE=none"],
    ["no key at all (known: none)", { key: false }, "NULL=False COUNT=0 NAMES= STATE=none"],
    ["reading the key throws", { items: "throws" as const }, "NULL=True COUNT=n/a NAMES= STATE=unknown"],
    ["checking for the key throws", { key: "throws" as const }, "NULL=True COUNT=n/a NAMES= STATE=unknown"],
    ["no registry (not Windows)", { drive: false }, "NULL=True COUNT=n/a NAMES= STATE=unknown"],
  ])("#2279 R1: wsl --list fails, the records say: %s", (_n, reg, want) => {
    const { out } = withHelpers(`${registry(reg)}
$n = Get-WslDistroNames
Write-Output ("NULL=" + ($null -eq $n) + " COUNT=" + $(if ($null -eq $n) { 'n/a' } else { @($n).Count }) + " NAMES=" + (@($n) -join ',') + " STATE=" + (Get-DistroSituation $n).State)`, fakeWsl([], { listFails: true }));
    expect(out).toContain(want);
  });
  it("#2279 R1: what stage 1 does with each answer: unknown stops, none installs, an Ubuntu asks, AgEnD's own is reused", () => {
    const { out } = withHelpers(`Write-Output ("S=" + (Get-DistroSituation $null).State + "," + (Get-DistroSituation @()).State + "," + (Get-DistroSituation @('Ubuntu-22.04')).State + "," + (Get-DistroSituation @('Ubuntu-22.04', 'AgEnD')).State)
Write-Output ("U=" + (Get-DistroSituation @('Debian', 'Ubuntu')).Ubuntu)`, fakeWsl([]));
    expect(out).toContain("S=unknown,none,ubuntu,reuse\n");
    expect(out).toContain("U=Ubuntu\n");
  });
  it("#2279 review: the list unreadable after --install: unknown, so no import and no 'installed'", () => {
    const bin = fakeWsl(["Ubuntu-24.04"], { listFailsAfterInstall: true });
    const { out, dir } = withHelpers(`${imageStubs()}
function Get-InstalledWslVersion { return [version]'2.6.3.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD' 'D:\\WSL\\AgEnD'))`, bin);
    expect(out).toContain("OK=False");
    expect(out).toContain("裝完之後讀不到 Linux 清單，無法確認 AgEnD 有沒有裝好；沒有再做任何事。");
    expect(calls(bin)).not.toMatch(/--import/);
    expect(existsSync(join(dir, "downloads.txt"))).toBe(false);
  });
  it("an AgEnD Linux from an earlier install is reused: the recorded one, else the one named AgEnD; an Ubuntu record is not AgEnD's own", () => {
    const { out } = withHelpers(`New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'AgEnD') -Force | Out-Null
$rec = Join-Path $env:LOCALAPPDATA 'AgEnD/install.json'
Set-Content -LiteralPath $rec -Value '{"distro":"AgEnD-2","user":"root"}'
Write-Output ("A=" + (Get-ExistingAgendDistro @('Ubuntu-24.04', 'AgEnD', 'AgEnD-2')))
Set-Content -LiteralPath $rec -Value '{"distro":"Ubuntu-24.04","user":"root"}'
Write-Output ("B=" + (Get-ExistingAgendDistro @('Ubuntu-24.04', 'AgEnD')))
Write-Output ("C=[" + (Get-ExistingAgendDistro @('Ubuntu-24.04')) + "]")
Remove-Item $rec
Write-Output ("D=" + (Get-ExistingAgendDistro @('AGEND')))`, fakeWsl([]));
    expect(out).toContain("A=AgEnD-2\n");
    expect(out).toContain("B=AgEnD\n");
    expect(out).toContain("C=[]\n");
    expect(out).toContain("D=AGEND\n");
  });
  it("WSL 2.4.4 or later: one wsl --install with --name and --location, nothing downloaded by us", () => {
    const bin = fakeWsl(["Ubuntu-24.04"]);
    const { out, dir } = withHelpers(`${imageStubs()}
function Get-InstalledWslVersion { return [version]'2.6.3.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD' 'D:\\WSL\\AgEnD'))`, bin);
    expect(out).toContain("OK=True");
    expect(calls(bin)).toBe("--install Ubuntu-24.04 --name AgEnD --location D:\\WSL\\AgEnD --no-launch\n--list --quiet\n");
    expect(existsSync(join(dir, "downloads.txt"))).toBe(false);
  });
  it("--name not supported (the name never appears): the official image, its SHA256 checked, then wsl --import; the download is removed", () => {
    const bin = fakeWsl(["Ubuntu-24.04"], { ignoreName: true });
    const loc = join(scratch("agend-1853distro-loc-"), "AgEnD");
    const { out, dir } = withHelpers(`${imageStubs()}
function Get-InstalledWslVersion { return [version]'2.6.3.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD' '${loc}'))
Write-Output ("LEFT=" + @(Get-ChildItem ([IO.Path]::GetTempPath()) -Filter 'agend-ubuntu-*.wsl').Count)`, bin);
    expect(out).toContain("WSL 沒有用 AgEnD 這個名稱裝好，改用官方的 Ubuntu 映像檔匯入...");
    expect(out).toContain("OK=True");
    expect(readFileSync(join(dir, "downloads.txt"), "utf8")).toBe("https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl\n");
    const log = calls(bin).trim().split("\n");
    expect(log[0]).toMatch(/^--install Ubuntu-24\.04 --name AgEnD /);
    expect(log.find(l => l.startsWith("--import"))).toMatch(new RegExp(`^--import AgEnD ${loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\S+agend-ubuntu-[0-9a-f]{32}\\.wsl --version 2$`));
    expect(out).toContain("LEFT=0");
  });
  it("an older WSL (before 2.4.4): straight to the official image and wsl --import, no --install --name", () => {
    const bin = fakeWsl([]);
    const { out } = withHelpers(`${imageStubs()}
function Get-InstalledWslVersion { return [version]'2.3.26.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD-2' '${join(scratch("agend-1853distro-loc-"), "AgEnD-2")}'))`, bin);
    expect(out).toContain("OK=True");
    expect(calls(bin)).not.toMatch(/--install/);
    expect(calls(bin)).toMatch(/^--import AgEnD-2 /m);
  });
  it.each([["a download whose SHA256 is not the official one", { badHash: true }, "下載的 Ubuntu 和官方的檢查碼不符，沒有安裝。"],
    ["no distribution list (offline)", { noList: true }, "拿不到官方 Ubuntu 映像檔的清單（可能是網路問題），沒有安裝。"]])("%s: nothing imported, said plainly", (_n, stub, said) => {
    const bin = fakeWsl([]);
    const { out } = withHelpers(`${imageStubs(stub)}
function Get-InstalledWslVersion { return [version]'2.3.26.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD' '${join(scratch("agend-1853distro-loc-"), "AgEnD")}'))`, bin);
    expect(out).toContain("OK=False");
    expect(out).toContain(said);
    expect(calls(bin)).not.toMatch(/--import/);
  });
  it("the shortcuts and install.json follow the chosen Linux; a record for another one is reported", () => {
    const { out } = withHelpers(`New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'AgEnD') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgEnD/install.json') -Value '{"distro":"Ubuntu-24.04","user":"root"}'
$c = Get-InstallRecordConflict 'AgEnD' 'root'; Write-Output ("CONFLICT=" + $c.Distro + "/" + $c.User)
Write-Output ("NONE=[" + (Get-InstallRecordConflict 'Ubuntu-24.04' 'root') + "]")
Write-Output ("RESTART=" + ((Get-RestartScript 'AgEnD' 'root') -split "\`n")[1])
Write-Output ("DASH=" + ((Get-DashboardOpenerScript 'AgEnD' 'root') -split "\`n")[1])`, fakeWsl([]));
    expect(out).toContain("CONFLICT=Ubuntu-24.04/root\n");
    expect(out).toContain("NONE=[]\n");
    expect(out).toContain(`RESTART=Write-Host ("AgEnD（Linux：{0}，使用者：{1}）" -f 'AgEnD', 'root')\n`);
    expect(out).toContain(`DASH=Write-Host ("AgEnD（Linux：{0}，使用者：{1}）" -f 'AgEnD', 'root')\n`);
  });
});
