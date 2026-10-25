/**
 * #1853 step ② (the user's approved plan, 2026-10-20): the WSL part of the Windows installer asks nothing it can decide.
 * - A reboot registers a one-time resume (HKCU RunOnce: the same one-liner, never -Force) so the install carries on
 *   after the person logs back in. Every run clears it first and the finished install clears it again, so no stale
 *   entry is ever left; it is registered only right before the reboot exit.
 * - The Linux version is the fixed one and the disk is chosen (the system drive with 20 GB free, else the local disk
 *   with the most room, at least 5 GB), and both are shown; no numbers to type, no "got it?" prompt.
 * - Ubuntu's first-run window (a Linux user and a password that shows nothing as you type) is never opened: root init
 *   is retried after restarting only that Linux (`wsl --terminate <distro>`). Restarting all of WSL (`wsl --shutdown`,
 *   which stops every Linux on the PC) is asked first, no by default, and runs only on an explicit y (the leader,
 *   2026-10-20); a no stops cleanly, saying how to carry on.
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
    expect(body.match(/\$wslState = Wait-WslRoot \$UBUNTU_DISTRO\n\s*if \(\$wslState -eq 'ready'\) \{/g)).toHaveLength(2);
    expect(body.match(/\} elseif \(\$wslState -eq 'declined'\) \{\n\s*Write-WslDeclined\n\s*Read-Host "按 Enter 結束"; exit 1/g)).toHaveLength(2);
  });
  it("wsl --shutdown runs in one place only, after an explicit y (the installer's rule)", () => {
    expect(code.match(/Invoke-BoundedWsl -Arguments @\('--shutdown'\)/g)).toHaveLength(1);
    const fn = code.slice(code.indexOf("function Wait-WslRoot"), code.indexOf("function Write-WslDeclined"));
    expect(fn).toMatch(/if \(\(\[string\]\$answer\) -notmatch '\^\\s\*\[yY\]\\s\*\$'\) \{ return 'declined' \}\n[^\n]*\n\s*\$null = Invoke-BoundedWsl -Arguments @\('--shutdown'\)/);
    expect(body).toMatch(/Write-Ok "Linux 版本：\$UBUNTU_DISTRO"/);
    expect(body).toMatch(/安裝位置：\{0\}（可用 \{1\} GB）/);
  });
  it("an Ubuntu already there: a separate AgEnD Ubuntu is offered first (recommended); using it says what changes; Enter quits", () => {
    expect(code).toContain('Write-Info "  [1] 另外安裝一個 AgEnD 專用的 Ubuntu（建議，不動你原本的）"');
    expect(code).toContain("[2] 用原本的 $existing（會修改它的設定：開啟 systemd、預設以 root 登入、不再把 Windows 的 PATH 帶進 Linux；裡面的檔案不會被刪除）");
    expect(code).toContain('Write-Info "  [Enter] 結束，不動任何東西"');
    expect(body).toMatch(/if \(\$choice -eq 'quit'\) \{\n\s*Write-Info "已取消，沒有改動任何東西。"\n\s*Read-Host "按 Enter 結束"; exit 0/);
  });
  it("the chosen distro is saved with the progress and read back on a resumed run", () => {
    expect(body).toMatch(/Add-Content -Path \$ProgressFile -Value "DISTRO=\$UBUNTU_DISTRO"\n\s+Mark-Stage 1\n/);
    expect(body).toMatch(/\$savedDistro = Get-ProgressValue 'DISTRO'\n\s+if \(\$savedDistro\) \{ \$UBUNTU_DISTRO = \$savedDistro \}/);
    expect(body.match(/^Start-FreshProgress \$Force\.IsPresent$/gm)).toHaveLength(1);                     // -Force starts fresh …
    expect(body.indexOf("Start-FreshProgress $Force.IsPresent")).toBeLessThan(body.indexOf("$savedDistro"));   // … before anything is read
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
  // A wsl stub: answers root's echo with WSL_OK once `okAfter` echo calls have failed (Infinity: never), logs every call.
  const wslStub = (okAfter: number) => `$script:calls = @(); $script:echoes = 0
function Invoke-BoundedWsl {param($Arguments); $script:calls += (($Arguments | Where-Object {$_ -ne '--'}) -join ' '); if ($Arguments[0] -like '--*') { return @{Code=0;Text=''} }; $script:echoes++; if ($script:echoes -gt ${okAfter === Infinity ? 999 : okAfter}) { return @{Code=0;Text='WSL_OK'} } else { return @{Code=1;Text='Error: 0x8007019e'} } }`;
  const ASK = "要重新啟動整個 WSL 嗎？這會停掉這台電腦上所有的 Linux（包括其他發行版和裡面正在跑的程式）。(y/N)";
  it("root init that fails is retried after restarting only this Linux — never a first-run window, nothing asked", () => {
    const { out } = withHelpers(`${wslStub(1)}
Write-Output ("STATE=" + (Wait-WslRoot 'Ubuntu-24.04' 3 0)); Write-Output ("CALLS=" + ($script:calls -join ' | '))`);
    expect(out).toContain("STATE=ready");
    // (A PowerShell function's $args drops the "--" that the real wsl.exe receives.)
    expect(out).toContain("CALLS=-d Ubuntu-24.04 -u root echo WSL_OK | --terminate Ubuntu-24.04 | -d Ubuntu-24.04 -u root echo WSL_OK\n");
    expect(out).toContain("Ubuntu-24.04 還沒準備好，只重新啟動這個 Linux 後再試一次（1/2）...");
    expect(out).not.toContain(ASK);
  });
  it.each([["Enter", "\n"], ["n", "n\n"], ["N", "N\n"], ["no answer at all", ""], ["the prompt's own y/N", "y/N\n"], ["yes", "yes\n"], ["yesterday", "yesterday\n"], ["no", "no\n"]])("still not ready: it asks before restarting all of WSL; %s → no wsl --shutdown, a clean stop", (_n, answer) => {
    const { out } = withHelpers(`${wslStub(Infinity)}
Write-Output ("STATE=" + (Wait-WslRoot 'Ubuntu-24.04' 3 0)); Write-Output ("CALLS=" + ($script:calls -join ' | '))
Write-WslDeclined`, answer);
    expect(out).toContain(ASK);
    expect(out).toContain("STATE=declined");
    expect(out).not.toMatch(/--shutdown/);
    expect(out.match(/--terminate Ubuntu-24\.04/g)).toHaveLength(2);                // the two retries on our own Linux only
    expect(out).toContain("沒有重新啟動 WSL，所以先停在這裡；你的其他 Linux 都沒有被動到。");
    expect(out).toContain("晚一點再貼一次同一行安裝指令，它會從這一步繼續。");
  });
  it.each([["y", "y\n"], ["Y", "Y\n"], ["y with spaces", "  y \n"]])("an explicit y (%s) restarts all of WSL once and tries again: ready, or failed", (_n, yes) => {
    const ok = withHelpers(`${wslStub(3)}
Write-Output ("STATE=" + (Wait-WslRoot 'Ubuntu-24.04' 3 0)); Write-Output ("CALLS=" + ($script:calls -join ' | '))`, yes).out;
    expect(ok).toContain("STATE=ready");
    expect(ok).toMatch(/CALLS=(?:[^|]*\| ){5}--shutdown \| -d Ubuntu-24\.04 -u root echo WSL_OK\n/);
    const bad = withHelpers(`${wslStub(Infinity)}
Write-Output ("STATE=" + (Wait-WslRoot 'Ubuntu-24.04' 3 0)); Write-Output ("SHUTDOWNS=" + @($script:calls | Where-Object { $_ -eq '--shutdown' }).Count)`, yes).out;
    expect(bad).toContain("STATE=failed");
    expect(bad).toContain("SHUTDOWNS=1\n");
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
    expect(yes.out).toMatch(/重新開機後，請用 Windows 帳號「[^」]+」登入，安裝會自動繼續（會先跳出一個 Windows 確認視窗，請選「是」）。/);   // the account to log in with (#2650 item 5)
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
    expect(out).toMatch(/重新開機後，請用 Windows 帳號「[^」]+」登入，再執行一次同一行安裝指令，會從中斷處繼續。/);
    expect(out).not.toContain("登入後一樣會自動繼續");
  });
  it("progress: -Force starts fresh, so a -Force run that changed the distro and was interrupted resumes on the new one (#2238 review)", () => {
    const { out } = withHelpers(`$ProgressFile = Join-Path $env:TMPDIR 'progress'
# An old install left Ubuntu-22.04 and its backends behind.
Set-Content -LiteralPath $ProgressFile -Value "STAGE_1_DONE\`nDISTRO=Ubuntu-22.04\`nBACKENDS=3\`nSTAGE_2_DONE"
# The person runs with -Force, keeps the Ubuntu-24.04 already there, and the run stops after stage 1.
$Force = $true
Start-FreshProgress $true
$UBUNTU_DISTRO = 'Ubuntu-24.04'
Add-Content -Path $ProgressFile -Value "DISTRO=$UBUNTU_DISTRO"
Mark-Stage 1
# The same line again, without -Force: what does the resumed run read?
$Force = $false
Start-FreshProgress $false
Write-Output ("RESUMED=" + (Get-ProgressValue 'DISTRO') + " STAGE1=" + (Stage-Done 1) + " STAGE2=" + (Stage-Done 2) + " BACKENDS=" + (Get-SavedBackends))
# Two entries for one key (any older file): the last one is this run's.
Set-Content -LiteralPath $ProgressFile -Value "DISTRO=Ubuntu-22.04\`nBACKENDS=1\`nDISTRO=Ubuntu-24.04\`nBACKENDS=1,4"
Write-Output ("LAST=" + (Get-ProgressValue 'DISTRO') + " " + (Get-SavedBackends))
Remove-Item -LiteralPath $ProgressFile
Write-Output ("NONE=[" + (Get-ProgressValue 'DISTRO') + "] " + (Get-SavedBackends))`);
    expect(out).toContain("RESUMED=Ubuntu-24.04 STAGE1=True STAGE2=False BACKENDS=1\n");     // stage 2 runs again, its old choice gone
    expect(out).toContain("LAST=Ubuntu-24.04 1,4\n");
    expect(out).toContain("NONE=[] 1\n");
  });
  it("clearing the resume when there is none is quiet", () => {
    const { out } = withHelpers(`function Remove-ItemProperty { param($Path, $Name, $ErrorAction) throw 'no such value' }
Clear-ResumeAtLogon; Write-Output 'CLEARED-OK'`);
    expect(out).toContain("CLEARED-OK");
  });
});
