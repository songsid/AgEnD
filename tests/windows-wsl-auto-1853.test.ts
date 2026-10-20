/**
 * #1853 step ② (the user's approved plan, 2026-10-20): the WSL part of the Windows installer asks nothing it can decide.
 * - A reboot registers a one-time resume (HKCU RunOnce: the same one-liner, never -Force) so the install carries on
 *   after the person logs back in. Every run clears it first and the finished install clears it again, so no stale
 *   entry is ever left; it is registered only right before the reboot exit.
 * - The Linux version is the fixed one and the disk is chosen (the system drive with 20 GB free, else the local disk
 *   with the most room, at least 5 GB), and both are shown; no numbers to type, no "got it?" prompt.
 * - Ubuntu's first-run window (a Linux user and a password that shows nothing as you type) is never opened: WSL is
 *   restarted (`wsl --shutdown`) and root init retried.
 * - An Ubuntu that is already there is still asked about, with what would change, and the default is no.
 * - The distro chosen is saved with the progress, so a resumed install keeps using it.
 * The helpers are the installer's own, run in pwsh (the registry, `wsl` and Restart-Computer stubbed). Real RunOnce,
 * reboot and WSL are the user's Windows checklist.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const body = code.slice(code.indexOf("Clear-Host"));                          // the run itself, after the helpers

describe("the WSL stage decides for itself (static)", () => {
  it("the resume is cleared at the start of every run and when the install finishes; registered only by a reboot", () => {
    const clears = [...body.matchAll(/^Clear-ResumeAtLogon$/gm)].map(m => m.index!);
    expect(clears).toHaveLength(2);
    expect(clears[0]).toBeLessThan(body.indexOf("Write-Step 1 $TOTAL"));
    expect(clears[1]).toBeGreaterThan(body.indexOf("全部安裝完成！"));
    expect(body).not.toMatch(/Register-ResumeAtLogon/);                         // only through Request-Reboot
    expect(body.match(/Request-Reboot "/g)).toHaveLength(3);                     // the feature, the MSI's 3010, wsl --version after it
    expect(body).not.toMatch(/Restart-Computer/);
    expect(code).toMatch(/\$RESUME_COMMAND = 'powershell -ExecutionPolicy ByPass -c "irm https:\/\/songsid\.github\.io\/AgEnD\/install\.ps1 \| iex"'/);
    expect(code).toMatch(/\$RESUME_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'/);
  });
  it("no version or disk to type, no 'got it?', and Ubuntu's first-run window is never opened", () => {
    expect(body).not.toMatch(/請輸入數字 \(預設 1\)|請輸入數字選擇|了解了嗎/);
    expect(body).not.toMatch(/Start-Process "wsl\.exe"/);
    expect(body).not.toMatch(/請完成後輸入 exit/);
    expect(body.match(/Wait-WslRoot \$UBUNTU_DISTRO/g)).toHaveLength(2);
    expect(body).toMatch(/Write-Ok "Linux 版本：\$UBUNTU_DISTRO"/);
    expect(body).toMatch(/安裝位置：\{0\}（可用 \{1\} GB）/);
  });
  it("an Ubuntu already there: what would change is said, and the default is no", () => {
    expect(body).toContain("安裝程式會修改它的設定：開啟 systemd、預設以 root 登入、不再把 Windows 的 PATH 帶進 Linux。");
    expect(body).toMatch(/\(y\/N\)"\n\s+if \(\$cont -notmatch '\^\\s\*\[yY\]'\) \{/);
  });
  it("the chosen distro is saved with the progress and read back on a resumed run", () => {
    expect(body).toMatch(/Add-Content -Path \$ProgressFile -Value "DISTRO=\$UBUNTU_DISTRO"\n\s+Mark-Stage 1\n/);
    expect(body).toMatch(/"DISTRO=\(\\S\+\)"\)\n\s+if \(\$savedDistro\.Success\) \{ \$UBUNTU_DISTRO = \$savedDistro\.Groups\[1\]\.Value \}/);
    expect(body.indexOf("$savedDistro")).toBeLessThan(body.indexOf("Write-Step 1 $TOTAL"));
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function withHelpers(script: string, input = "") {
  const dir = mkdtempSync(join(tmpdir(), "agend-1853wsl-")); dirs.push(dir);
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
# The installer's own constants, from the same file.
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$RESUME_' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
$script:OnWindows = $false
${script}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, input, env: { ...process.env, TMPDIR: dir } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return { out: r.stdout + r.stderr, dir };
}
const disk = (root: string, gb: number) => `[PSCustomObject]@{ Root = '${root}'; Free = ${gb}GB }`;

describe.skipIf(!pwsh)("with pwsh: the installer's WSL helpers", { timeout: 90_000 }, () => {
  it("the disk: the system drive when it has 20 GB free, else the roomiest local disk with 5 GB, else none", () => {
    const { out } = withHelpers(`
Write-Output ("A=" + (Select-InstallDrive @(${disk("C:\\", 120)}, ${disk("D:\\", 900)}) 'C:\\').Root)
Write-Output ("B=" + (Select-InstallDrive @(${disk("C:\\", 12)}, ${disk("D:\\", 300)}, ${disk("E:\\", 40)}) 'C:\\').Root)
Write-Output ("C=" + (Select-InstallDrive @(${disk("C:\\", 8)}, ${disk("D:\\", 3)}) 'c:\\').Root)
Write-Output ("D=" + ($null -eq (Select-InstallDrive @(${disk("C:\\", 2)}, ${disk("D:\\", 4)}) 'C:\\')))`);
    expect(out).toContain("A=C:\\\n");
    expect(out).toContain("B=D:\\\n");
    expect(out).toContain("C=C:\\\n");                                        // 8 GB on C: beats nothing elsewhere
    expect(out).toContain("D=True\n");
  });
  it("root init that fails is retried after wsl --shutdown — never a first-run window", () => {
    const { out } = withHelpers(`$script:calls = @()
function wsl { $script:calls += ($args -join ' '); if ($args[0] -eq '--shutdown') { return }; if (@($script:calls | Where-Object { $_ -like '-d *' }).Count -ge 2) { 'WSL_OK' } else { 'Error: 0x8007019e' } }
$ok = Wait-WslRoot 'Ubuntu-24.04' 3 0
Write-Output ("OK=" + $ok); Write-Output ("CALLS=" + ($script:calls -join ' | '))
$script:calls = @()
function wsl { $script:calls += ($args -join ' '); 'still failing' }
Write-Output ("FAIL=" + (Wait-WslRoot 'Ubuntu-24.04' 3 0)); Write-Output ("CALLS2=" + $script:calls.Count)`);
    expect(out).toContain("OK=True");
    // (A PowerShell function's $args drops the "--" that the real wsl.exe receives.)
    expect(out).toContain("CALLS=-d Ubuntu-24.04 -u root echo WSL_OK | --shutdown | -d Ubuntu-24.04 -u root echo WSL_OK\n");
    expect(out).toContain("WSL 還沒準備好，重新啟動 WSL 後再試一次（1/2）...");
    expect(out).toContain("FAIL=False");
    expect(out).toContain("CALLS2=5\n");                                       // three tries, two restarts between them
  });
  it("a reboot: the resume registered (the one-liner), Enter reboots, n doesn't — both exit for the reboot", () => {
    const stubs = `$script:reg = @{}
function Set-ItemProperty { param($Path, $Name, $Value) $script:reg[$Name] = $Value; Add-Content (Join-Path $env:TMPDIR 'reg.txt') "$Path|$Name|$Value" }
function Test-Path { param($Path) $true }
function Restart-Computer { param([switch]$Force) Add-Content (Join-Path $env:TMPDIR 'reboot.txt') 'reboot' }
Request-Reboot 'WSL 功能剛啟用，需要重新開機才能繼續'
Write-Output 'NOT-REACHED'`;
    const yes = withHelpers(stubs, "\n");
    expect(readFileSync(join(yes.dir, "reg.txt"), "utf8")).toBe('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce|AgEnDInstallResume|powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"\n');
    expect(readFileSync(join(yes.dir, "reboot.txt"), "utf8")).toBe("reboot\n");
    expect(yes.out).toContain("重新開機並登入 Windows 後，安裝會自動繼續（會先跳出一個 Windows 確認視窗，請選「是」）。");
    expect(yes.out).not.toContain("NOT-REACHED");
    const no = withHelpers(stubs, "n\n");
    expect(() => readFileSync(join(no.dir, "reboot.txt"), "utf8")).toThrow();
    expect(no.out).toContain("好的。之後你自己重新開機，登入後一樣會自動繼續。");
    expect(no.out).not.toContain("NOT-REACHED");
  });
  it("a resume that can't be registered says to run the line again instead", () => {
    const { out } = withHelpers(`function Set-ItemProperty { throw 'denied' }
function Test-Path { param($Path) $true }
function Restart-Computer { param([switch]$Force) }
Request-Reboot 'x'`, "n\n");
    expect(out).toContain("重新開機後，請再執行一次同一行安裝指令，會從中斷處繼續。");
    expect(out).not.toContain("登入後一樣會自動繼續");
  });
  it("clearing the resume when there is none is quiet", () => {
    const { out } = withHelpers(`function Remove-ItemProperty { param($Path, $Name, $ErrorAction) throw 'no such value' }
Clear-ResumeAtLogon; Write-Output 'CLEARED-OK'`);
    expect(out).toContain("CLEARED-OK");
  });
});
