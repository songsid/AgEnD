/**
 * #1853 (the user's real run, 2026-10-20): a PC that already has Ubuntu can install a separate one just for AgEnD —
 * the recommended choice — so the existing Ubuntu is never changed.
 * - [1] a separate AgEnD Ubuntu (recommended) / [2] the existing one (its settings change) / Enter quits. Only 1 or 2.
 * - The name is the first free one of AgEnD, AgEnD-2, …; an AgEnD Linux from an earlier install is reused, never a third.
 * - WSL 2.4.4+: `wsl --install Ubuntu-26.04 --name <name> --location <disk>\WSL\<name> --no-launch` (a tar-based
 *   distribution; Microsoft's build-custom-distro doc). Older WSL, or the name not there afterwards: Microsoft's
 *   distribution list's official .wsl, checked against its SHA256, then `wsl --import <name> <location> <file> --version 2`.
 * - The chosen name is what everything after uses: the progress, install.json, both shortcuts, the repair fast path.
 * The helpers are the installer's own, in pwsh, with a fake native wsl.exe (its distro list in a file) and the download
 * and the distribution list stubbed. A real install is the user's Windows checklist.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InstallerPsBatch, hasPwsh } from "./support/installer-ps-batch.js";
import { extractPsFunction, extractPsAssignments } from "./support/installer-ps-extract.js";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const body = code.slice(code.indexOf("Clear-Host"));

describe("the existing-Ubuntu choice (static)", () => {
  it("stage 1 reads the Linux list (starts none), reuses an AgEnD Linux, else asks when there is an Ubuntu", () => {
    const stage = body.slice(body.indexOf("$names = Get-WslDistroNames"), body.indexOf('Add-Content -Path $ProgressFile -Value "DISTRO=$UBUNTU_DISTRO"'));
    expect(stage).toMatch(/\$agendDistro = \$situation\.Agend/);
    // #2279 review: an unreadable list stops stage 1 before any choice, install or reuse.
    expect(stage).toMatch(/^\$names = Get-WslDistroNames\n\s*if \(Clear-MissingWslTarget \$names\) \{ \$UBUNTU_DISTRO = 'Ubuntu-26\.04'; \$AgendWslDrive = Resolve-AgendWslDrive \$WslDrive; Save-WslDrive \$AgendWslDrive \}\n\s*\$situation = Get-DistroSituation \$names\n\s*if \(\$situation\.State -eq 'unknown'\) \{\n[^\n]*讀不到這台電腦上的 Linux 清單[^\n]*\n[^\n]*\n\s*Read-Host "按 Enter 結束"; exit 1\n\s*\}\n\s*\$agendDistro/);
    expect(stage).toMatch(/if \(\$situation\.State -eq 'reuse'\) \{ \$choice = 'reuse' \} elseif \(\$situation\.State -eq 'ubuntu'\) \{ \$choice = Read-DistroChoice \$installedDistroName \}/);
    expect(stage).toMatch(/if \(\$choice -eq 'separate'\) \{ \$UBUNTU_DISTRO = Get-FreeAgendDistroName \$names \}/);
    expect(stage).toMatch(/\$leaf = if \(\$choice -eq 'separate' -or \$UBUNTU_DISTRO -like 'AgEnD\*'\) \{ \$UBUNTU_DISTRO \} else \{ 'Ubuntu' \}/);
    expect(stage).toMatch(/\$location = Get-WslInstallLocation \(Get-LocalDisks\) \(\$env:SystemDrive \+ '\\'\) \$UBUNTU_DISTRO \$leaf \$AgendWslDrive/);
    expect(stage).toMatch(/\$disk = \$location\.Disk; \$wslPath = \$location\.Path/);
    expect(stage).toMatch(/Install-AgendDistro \$UBUNTU_DISTRO \$wslPath -UseVersionName:\$useVersionName -InstalledName \(\[ref\]\$UBUNTU_DISTRO\)/);
    expect(stage).not.toMatch(/wsl -d \$name -u root --exec echo/);                     // no more starting each Ubuntu to see if it is there
    // The chosen name is saved with the progress, and the end of the install records it (install.json) and makes the shortcuts.
    expect(body).toMatch(/Add-Content -Path \$ProgressFile -Value "DISTRO=\$UBUNTU_DISTRO"/);
    expect(body).toMatch(/\$shortcuts = @\(Install-AgendShortcuts \$UBUNTU_DISTRO \$AGEND_USER\)/);
  });
  it("the repair fast path also looks in AgEnD's own Linux; a record for another Linux is said, and asked about (no by default)", () => {
    expect(code).toMatch(/foreach \(\$d in @\(\$AGEND_DISTRO_BASE, 'Ubuntu-26\.04', 'Ubuntu-24\.04', 'Ubuntu-22\.04', 'Ubuntu'\)\)/);
    const fast = body.slice(body.indexOf("$existing = Find-ExistingAgend"), body.indexOf('Write-Info "檢查網路連線..."'));
    expect(fast).toMatch(/\$prior = Get-InstallRecordConflict \$existing\.Distro \$existing\.User/);
    expect(fast).toMatch(/\(y\/N\)"\n\s*\$update = \(\[string\]\$ans\) -match '\^\\s\*\[yY\]\\s\*\$'/);
    // #2279 review: what was asked about is read again before anything is written.
    expect(fast).toMatch(/if \(\$update -and -not \(Test-InstallRecordAsSeen \$prior \$existing\.Distro \$existing\.User\)\) \{/);
  });
});

const pwsh = hasPwsh;
// Only this suite's call closure. Retain the real native-process/watched runner,
// file hashing and script builders; unrelated login/network/bootstrap code is never compiled.
const helperNames = [
  "Write-Ok", "Write-Warn", "Write-Err", "Write-Info", "Write-InstallLog", "Protect-LogText",
  "Get-WslDistroNames", "Get-WslRegisteredNames", "Get-DistroSituation", "Get-FreeAgendDistroName",
  "Get-ExistingAgendDistro", "Read-DistroChoice", "Get-UbuntuWslImage", "Install-AgendDistro",
  "Get-InstalledWslVersion", "Read-InstallRecord", "Get-AgendShortcutDir", "Get-InstallRecordConflict",
  "Get-RestartScript", "Get-DashboardOpenerScript", "Get-ShortcutTargetLine", "ConvertTo-PsLiteral", "Invoke-BoundedWsl",
  "Invoke-Watched", "Join-ProcessArguments", "Test-LiveConsole", "Enter-StepConsole", "Restore-StepConsole",
  "New-OutputTail", "Read-OutputTail", "Split-ToolOutput", "Get-LastSegment", "Format-Elapsed",
  "Get-StatusWidth", "New-StatusConsole", "Write-StatusLine", "Format-StatusLine", "Limit-Width", "Get-SafeWidth", "Get-DisplayWidth",
  "Confirm-StopInstall", "Read-StepKey", "Test-CtrlC", "Stop-InstallChild",
];
const prelude = helperNames.map(name => extractPsFunction(text, name)).join("\n") + "\n" +
  extractPsAssignments(text, ["AGEND_DISTRO_BASE", "WSL_NAME_MIN", "DISTRO_LIST_URL", "WSL_COMMAND_FN", "RESTART_FN", "DASHBOARD_OPENER_FN"]);
const batch = new InstallerPsBatch({ installer: prelude });
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
async function withHelpers(body: string, bin: string, input = "") {
  const dir = scratch("agend-1853distro-");
  const out = await batch.run("installer", `Remove-Item Function:wsl.exe
$env:LOCALAPPDATA = Join-Path $env:TMPDIR 'localappdata'
${body}`, { input, env: { TMPDIR: dir, PATH: `${bin}:${process.env.PATH}` } });
  return { out, dir };
}
/** The official image, stubbed: a download writes IMAGE; the list names its SHA256 (or `badHash`), or fails (`noList`). */
const IMAGE = "pretend ubuntu rootfs";
const imageHash = createHash("sha256").update(IMAGE).digest("hex");
const imageStubs = (o: { badHash?: boolean; noList?: boolean } = {}) => `
function Invoke-RestMethod { param($Uri, $TimeoutSec, [switch]$UseBasicParsing)
  ${o.noList ? "throw 'offline'" : ""}
  return [pscustomobject]@{ ModernDistributions = [pscustomobject]@{ Ubuntu = @([pscustomobject]@{ Name = 'Ubuntu-26.04'; Amd64Url = [pscustomobject]@{ Url = 'https://releases.ubuntu.com/26.04.1/ubuntu-26.04.1-wsl-amd64.wsl'; Sha256 = '0x${o.badHash ? "00" + imageHash.slice(2) : imageHash.toUpperCase()}' } }) } } }
function Invoke-InstallDownload { param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec) Add-Content (Join-Path $env:TMPDIR 'downloads.txt') $Uri; [IO.File]::WriteAllText($OutFile, '${IMAGE}') }
`;

describe.skipIf(!pwsh)("with pwsh: choosing and installing AgEnD's own Ubuntu", () => {
  beforeAll(async () => {
    expect(await batch.run("installer", "Write-Output 'DISTRO_WORKER_READY'")).toContain("DISTRO_WORKER_READY");
  });
  it.each([["1", "separate"], [" 1 ", "separate"], ["2", "existing"], ["", "quit"], ["y", "quit"], ["12", "quit"], ["no input", "quit"]])("the choice: %j → %s (only 1 or 2 count)", async (answer, want) => {
    const { out } = (await withHelpers(`Write-Output ("CHOICE=" + (Read-DistroChoice 'Ubuntu-24.04'))`, fakeWsl([]), answer === "no input" ? "" : `${answer}\n`));
    expect(out).toContain(`CHOICE=${want}\n`);
    expect(out).toContain("[1] 另外安裝一個 AgEnD 專用的 Ubuntu（建議，不動你原本的）");
    expect(out).toContain("[Enter] 結束，不動任何東西");
  });
  it("the Linux list comes from wsl --list --quiet (nothing started); the free name is AgEnD, AgEnD-2, … (case-insensitive)", async () => {
    const bin = fakeWsl(["Ubuntu-24.04", "agend", "AgEnD-2"]);
    const { out } = (await withHelpers(`$n = Get-WslDistroNames
Write-Output ("NAMES=" + ($n -join ','))
Write-Output ("FREE=" + (Get-FreeAgendDistroName $n))
Write-Output ("FREE0=" + (Get-FreeAgendDistroName @('Ubuntu')))`, bin));
    expect(out).toContain("NAMES=Ubuntu-24.04,agend,AgEnD-2\n");
    expect(out).toContain("FREE=AgEnD-3\n");
    expect(out).toContain("FREE0=AgEnD\n");
    expect(calls(bin)).toBe("--list --quiet\n");
  });
  it("#2279 review: a list that cannot be read is unknown ($null), never 'no Linux'; an empty list is empty", async () => {
    const failing = (await withHelpers(`$n = Get-WslDistroNames; Write-Output ("NULL=" + ($null -eq $n))`, fakeWsl(["Ubuntu-24.04"], { listFails: true }))).out;
    expect(failing).toContain("NULL=True");                                         // and no registry to fall back on here
    const empty = (await withHelpers(`$n = Get-WslDistroNames; Write-Output ("NULL=" + ($null -eq $n) + " COUNT=" + @($n).Count)`, fakeWsl([]))).out;
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
  ])("#2279 R1: wsl --list fails, the records say: %s", async (_n, reg, want) => {
    const { out } = (await withHelpers(`${registry(reg)}
$n = Get-WslDistroNames
Write-Output ("NULL=" + ($null -eq $n) + " COUNT=" + $(if ($null -eq $n) { 'n/a' } else { @($n).Count }) + " NAMES=" + (@($n) -join ',') + " STATE=" + (Get-DistroSituation $n).State)`, fakeWsl([], { listFails: true })));
    expect(out).toContain(want);
  });
  it("#2279 R1: what stage 1 does with each answer: unknown stops, none installs, an Ubuntu asks, AgEnD's own is reused", async () => {
    const { out } = (await withHelpers(`Write-Output ("S=" + (Get-DistroSituation $null).State + "," + (Get-DistroSituation @()).State + "," + (Get-DistroSituation @('Ubuntu-22.04')).State + "," + (Get-DistroSituation @('Ubuntu-22.04', 'AgEnD')).State)
Write-Output ("U=" + (Get-DistroSituation @('Debian', 'Ubuntu')).Ubuntu)`, fakeWsl([])));
    expect(out).toContain("S=unknown,none,ubuntu,reuse\n");
    expect(out).toContain("U=Ubuntu\n");
  });
  it("#2279 review: the list unreadable after --install: unknown, so no import and no 'installed'", async () => {
    const bin = fakeWsl(["Ubuntu-24.04"], { listFailsAfterInstall: true });
    const { out, dir } = (await withHelpers(`${imageStubs()}
function Get-InstalledWslVersion { return [version]'2.6.3.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD' 'D:\\WSL\\AgEnD'))`, bin));
    expect(out).toContain("OK=False");
    expect(out).toContain("裝完之後讀不到 Linux 清單，無法確認 AgEnD 有沒有裝好；沒有再做任何事。");
    expect(calls(bin)).not.toMatch(/--import/);
    expect(existsSync(join(dir, "downloads.txt"))).toBe(false);
  });
  it("an AgEnD Linux from an earlier install is reused: the recorded one, else the one named AgEnD; an Ubuntu record is not AgEnD's own", async () => {
    const { out } = (await withHelpers(`New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'AgEnD') -Force | Out-Null
$rec = Join-Path $env:LOCALAPPDATA 'AgEnD/install.json'
Set-Content -LiteralPath $rec -Value '{"distro":"AgEnD-2","user":"root"}'
Write-Output ("A=" + (Get-ExistingAgendDistro @('Ubuntu-24.04', 'AgEnD', 'AgEnD-2')))
Set-Content -LiteralPath $rec -Value '{"distro":"Ubuntu-24.04","user":"root"}'
Write-Output ("B=" + (Get-ExistingAgendDistro @('Ubuntu-24.04', 'AgEnD')))
Write-Output ("C=[" + (Get-ExistingAgendDistro @('Ubuntu-24.04')) + "]")
Remove-Item $rec
Write-Output ("D=" + (Get-ExistingAgendDistro @('AGEND')))`, fakeWsl([])));
    expect(out).toContain("A=AgEnD-2\n");
    expect(out).toContain("B=AgEnD\n");
    expect(out).toContain("C=[]\n");
    expect(out).toContain("D=AGEND\n");
  });
  it("WSL 2.4.4 or later: one wsl --install with --name and --location, nothing downloaded by us", async () => {
    const bin = fakeWsl(["Ubuntu-24.04"]);
    const { out, dir } = (await withHelpers(`${imageStubs()}
function Get-InstalledWslVersion { return [version]'2.6.3.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD' 'D:\\WSL\\AgEnD'))`, bin));
    expect(out).toContain("OK=True");
    expect(calls(bin)).toBe("--install Ubuntu-26.04 --name AgEnD --location D:\\WSL\\AgEnD --no-launch\n--list --quiet\n");
    expect(existsSync(join(dir, "downloads.txt"))).toBe(false);
  });
  it("--name not supported (the name never appears): the official image, its SHA256 checked, then wsl --import; the download is removed", async () => {
    const bin = fakeWsl(["Ubuntu-24.04"], { ignoreName: true });
    const loc = join(scratch("agend-1853distro-loc-"), "AgEnD");
    const { out, dir } = (await withHelpers(`${imageStubs()}
function Get-InstalledWslVersion { return [version]'2.6.3.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD' '${loc}'))
Write-Output ("LEFT=" + @(Get-ChildItem ([IO.Path]::GetTempPath()) -Filter 'agend-ubuntu-*.wsl').Count)`, bin));
    expect(out).toContain("Ubuntu-26.04 未透過 WSL 安裝，改試官方映像檔（AgEnD）。");
    expect(out).toContain("OK=True");
    expect(readFileSync(join(dir, "downloads.txt"), "utf8")).toBe("https://releases.ubuntu.com/26.04.1/ubuntu-26.04.1-wsl-amd64.wsl\n");
    const log = calls(bin).trim().split("\n");
    expect(log[0]).toMatch(/^--install Ubuntu-26\.04 --name AgEnD /);
    expect(log.find(l => l.startsWith("--import"))).toMatch(new RegExp(`^--import AgEnD ${loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\S+agend-ubuntu-[0-9a-f]{32}\\.wsl --version 2$`));
    expect(out).toContain("LEFT=0");
  });
  it("an older WSL (before 2.4.4): straight to the official image and wsl --import, no --install --name", async () => {
    const bin = fakeWsl([]);
    const { out } = (await withHelpers(`${imageStubs()}
function Get-InstalledWslVersion { return [version]'2.3.26.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD-2' '${join(scratch("agend-1853distro-loc-"), "AgEnD-2")}'))`, bin));
    expect(out).toContain("OK=True");
    expect(calls(bin)).not.toMatch(/--install/);
    expect(calls(bin)).toMatch(/^--import AgEnD-2 /m);
  });
  it.each([["a download whose SHA256 is not the official one", { badHash: true }, "下載的 Ubuntu 和官方的檢查碼不符，沒有安裝。"],
    ["no distribution list (offline)", { noList: true }, "Ubuntu-26.04、Ubuntu-24.04 都沒有安裝成功"]])("%s: nothing imported, said plainly", async (_n, stub, said) => {
    const bin = fakeWsl([]);
    const { out } = (await withHelpers(`${imageStubs(stub)}
function Get-InstalledWslVersion { return [version]'2.3.26.0' }
Write-Output ("OK=" + (Install-AgendDistro 'AgEnD' '${join(scratch("agend-1853distro-loc-"), "AgEnD")}'))`, bin));
    expect(out).toContain("OK=False");
    expect(out).toContain(said);
    expect(calls(bin)).not.toMatch(/--import/);
    if ('badHash' in stub && stub.badHash) expect(out).not.toContain('trying Ubuntu-24.04');
  });

  it("the default image and both architectures use 26.04 with the official hash", async () => {
    const { out } = await withHelpers(`
function Invoke-RestMethod { return @{ModernDistributions=@{Ubuntu=@(
 @{Name='Ubuntu-26.04'; Amd64Url=@{Url='https://example.test/26-amd.wsl';Sha256='0xABC'};Arm64Url=@{Url='https://example.test/26-arm.wsl';Sha256='DEF'}},
 @{Name='Ubuntu-24.04'; Amd64Url=@{Url='wrong';Sha256='000'}})}} }
$env:PROCESSOR_ARCHITECTURE='AMD64';$a=Get-UbuntuWslImage
$env:PROCESSOR_ARCHITECTURE='ARM64';$b=Get-UbuntuWslImage
Write-Output ('AMD='+$a.Url+'/'+$a.Sha256+' ARM='+$b.Url+'/'+$b.Sha256)`, fakeWsl([]));
    expect(out).toContain('AMD=https://example.test/26-amd.wsl/ABC ARM=https://example.test/26-arm.wsl/DEF');
  });
  const fallbackHarness = (opts: { direct?: string; images?: string; downloadFails?: string; importCode?: number; unknown?: boolean; occupied?: boolean; timeout?: boolean } = {}) => `
${imageStubs()}
$script:present=@();$script:operations=@();$script:images=@();$script:downloads=@()
function Get-InstalledWslVersion { return [version]'2.6.3' }
function Get-WslDistroNames { ${opts.unknown ? 'return $null' : 'return ,$script:present'} }
function Get-UbuntuWslImage { param($version);$script:images+= $version; if (${opts.images ?? '$false'}) { return @{Url=$version;Sha256='${imageHash}'} };return $null }
function Invoke-InstallDownload { param($Uri,$OutFile,$TimeoutSec);$script:downloads+=$Uri; ${opts.downloadFails ? `if($Uri -eq '${opts.downloadFails}') {throw 'download unavailable'}` : ''};[IO.File]::WriteAllText($OutFile,'${IMAGE}') }
function Invoke-Watched { param($Arguments)
 $script:operations+=($Arguments -join ' ')
 if($Arguments[0] -eq '--install') {
  if(${opts.occupied ? '$true' : opts.direct ?? '$false'}) {$script:present=@($Arguments[3]);return ${opts.occupied ? 1 : 0}}
  return ${opts.timeout ? 124 : 1}
 }
 ${opts.importCode ? `return ${opts.importCode}` : '$script:present=@($Arguments[1]);return 0'}
}
$selected='Ubuntu-26.04'
$ok=Install-AgendDistro 'Ubuntu-26.04' (Join-Path $env:TMPDIR 'linux') -UseVersionName -InstalledName ([ref]$selected)
Write-Output ('OK='+$ok+' SELECTED='+$selected)
Write-Output ('OPS='+($script:operations -join '|'))
Write-Output ('IMAGES='+($script:images -join ','))
Write-Output ('DOWNLOADS='+($script:downloads -join ','))
`;
  it('unsupported 26.04, with no image: falls back to 24.04 and reports the actual saved name', async () => {
    const { out } = await withHelpers(fallbackHarness({direct:"$Arguments[1] -eq 'Ubuntu-24.04'"}), fakeWsl([]));
    expect(out).toContain('OK=True SELECTED=Ubuntu-24.04');
    expect(out).toContain('Ubuntu-26.04 無法安裝，改試 Ubuntu-24.04');
    expect(out).toContain('trying Ubuntu-24.04');
    expect(out).toContain('IMAGES=Ubuntu-26.04');
    expect(out).not.toContain('--install Ubuntu-22.04');
  });
  it('failed 26.04 download and unavailable 24.04 stop without trying 22.04', async () => {
    const { out } = await withHelpers(fallbackHarness({images:"$version -eq 'Ubuntu-26.04'",downloadFails:'Ubuntu-26.04',direct:"$Arguments[1] -eq 'Ubuntu-22.04'"}), fakeWsl([]));
    expect(out).toContain('OK=False SELECTED=Ubuntu-26.04');
    expect(out).not.toContain('--install Ubuntu-22.04');
    expect(out).toContain('IMAGES=Ubuntu-26.04,Ubuntu-24.04');
    expect(out).toContain('DOWNLOADS=Ubuntu-26.04');
    expect(out).toMatch(/OPS=--install Ubuntu-26\.04 .*\|--install Ubuntu-24\.04 /);
    expect(out).toContain('Ubuntu-26.04、Ubuntu-24.04 都沒有安裝成功');
  });
  it.each(['Ubuntu-24.04','Ubuntu-22.04'])('a saved %s plan starts at that version instead of being upgraded', async version => {
    const bin=fakeWsl([]);
    const {out}=await withHelpers(`function Get-InstalledWslVersion {return [version]'2.6.3'}
$selected='${version}';$ok=Install-AgendDistro $selected (Join-Path $env:TMPDIR 'linux') -UseVersionName -InstalledName ([ref]$selected)
Write-Output ('OK='+$ok+' SELECTED='+$selected)`,bin);
    expect(out).toContain('OK=True SELECTED='+version);
    expect(calls(bin)).toMatch(new RegExp('^--install '+version.replaceAll('.','\\.')+' --name '+version));
    expect(calls(bin)).not.toContain('--install Ubuntu-26.04');
  });
  it('an old WSL imports the first available 24.04 image, checks its hash, and keeps a custom name', async () => {
    const {out} = await withHelpers(`${imageStubs()}
function Get-InstalledWslVersion { return [version]'2.3.26' }
function Invoke-RestMethod {return @{ModernDistributions=@{Ubuntu=@(@{Name='Ubuntu-24.04';Amd64Url=@{Url='https://example.test/24.wsl';Sha256='${imageHash}'}})}}}
$selected='AgEnD-2';$ok=Install-AgendDistro 'AgEnD-2' (Join-Path $env:TMPDIR 'linux') -InstalledName ([ref]$selected)
Write-Output ('OK='+$ok+' SELECTED='+$selected)
Write-Output ('LEFT='+@(Get-ChildItem ([IO.Path]::GetTempPath()) -Filter 'agend-ubuntu-*.wsl').Count)`, fakeWsl([]));
    expect(out).toContain('OK=True SELECTED=AgEnD-2');
    expect(out).toContain('已安裝 Ubuntu-24.04');
    expect(out).toContain('LEFT=0');
  });
  it('an unsupported direct install can import the 26.04 image before downgrading', async () => {
    const { out } = await withHelpers(fallbackHarness({images:'$true'}), fakeWsl([]));
    expect(out).toContain('OK=True SELECTED=Ubuntu-26.04');
    expect(out).toContain('DOWNLOADS=Ubuntu-26.04');
    expect(out).not.toContain('--install Ubuntu-24.04');
  });
  it.each([
    ['unreadable post-install inventory', {unknown:true}],
    ['a failed command that nevertheless created the target', {occupied:true}],
    ['an installation timeout', {timeout:true}],
    ['an import timeout', {images:'$true',importCode:124}],
  ])('%s stops without another install', async (_label, options) => {
    const { out } = await withHelpers(fallbackHarness(options), fakeWsl([]));
    expect(out).toContain('OK=False SELECTED=Ubuntu-26.04');
    expect(out).not.toContain('--install Ubuntu-24.04');
    expect(out).not.toContain('--install Ubuntu-22.04');
  });

  it("the shortcuts and install.json follow the chosen Linux; a record for another one is reported", async () => {
    const { out } = (await withHelpers(`New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'AgEnD') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgEnD/install.json') -Value '{"distro":"Ubuntu-24.04","user":"root"}'
$c = Get-InstallRecordConflict 'AgEnD' 'root'; Write-Output ("CONFLICT=" + $c.Distro + "/" + $c.User)
Write-Output ("NONE=[" + (Get-InstallRecordConflict 'Ubuntu-24.04' 'root') + "]")
Write-Output ("RESTART=" + ((Get-RestartScript 'AgEnD' 'root') -split "\`n")[1])
Write-Output ("DASH=" + ((Get-DashboardOpenerScript 'AgEnD' 'root') -split "\`n")[1])`, fakeWsl([])));
    expect(out).toContain("CONFLICT=Ubuntu-24.04/root\n");
    expect(out).toContain("NONE=[]\n");
    expect(out).toContain(`RESTART=Write-Host ("AgEnD（Linux：{0}，使用者：{1}）" -f 'AgEnD', 'root')\n`);
    expect(out).toContain(`DASH=Write-Host ("AgEnD（Linux：{0}，使用者：{1}）" -f 'AgEnD', 'root')\n`);
  });
});
