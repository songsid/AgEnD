/**
 * #2650 item 7 (Sentinel's Windows installer review): an accurate WSL preflight.
 * - Before it changes anything, stage 1 reads the Windows build (WSL 2 needs 19041+), the OS architecture (x64 or
 *   ARM64), both Windows features separately (Microsoft-Windows-Subsystem-Linux and VirtualMachinePlatform) and
 *   virtualization. A build too old or a 32-bit Windows stops with what to do; virtualization that is clearly off gets
 *   the BIOS/UEFI hint (a warning: detection is not certain, in a VM least of all).
 * - Only the missing feature is enabled. DISM must end 0 or 3010, and both features are read again before the
 *   installer says they are on. Before, both exit codes were discarded and VirtualMachinePlatform was enabled only
 *   when the WSL feature was off.
 * - The MSI fallback picks the machine's architecture (ARM64 got the x64 MSI before), and its download has a deadline.
 * - A fresh install whose `wsl --install --location` did not produce the distro falls back to the same image import
 *   the separate-distro path uses.
 * The functions are the installer's own, taken from its syntax tree and run in pwsh with DISM, CIM and WSL stubbed.
 * A real Windows run (old builds, ARM64, virtualization off) is the user's checklist.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const code = readFileSync(INSTALLER, "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("static", () => {
  const stage1 = code.slice(code.indexOf("if (Stage-Done 1) {"), code.indexOf("switch (Invoke-WslUpdateStage)"));
  it("stage 1a: preflight first, it can stop the install, and only then are missing features enabled", () => {
    expect(stage1.indexOf("$preflight = Get-WslPreflight")).toBeGreaterThan(0);
    expect(stage1).toMatch(/if \(-not \(Test-WslPreflight \$preflight\)\) \{ Read-Host "按 Enter 結束"; exit 1 \}/);
    expect(stage1.indexOf("Test-WslPreflight $preflight")).toBeLessThan(stage1.indexOf("Enable-WslFeatures $preflight.Features"));
    expect(stage1).toMatch(/'failed' \{ Read-Host "按 Enter 結束"; exit 1 \}/);
    expect(stage1).toMatch(/'reboot' \{\n[^\n]*\n\s+Mark-Stage "1a"\n\s+Request-Reboot /);
    expect(code).not.toMatch(/\$null = Invoke-Watched[^\n]*dism\.exe/);          // no discarded DISM exit code
  });
  it("a fresh install that did not produce the distro falls back to the image import", () => {
    const fresh = code.slice(code.indexOf('-Arguments @("--install", "-d", $UBUNTU_DISTRO, "--location", $wslPath, "--no-launch")'));
    expect(fresh).toMatch(/^[^\n]+\n\s+\$afterFresh = Get-WslDistroNames\n\s+if \(\$null -ne \$afterFresh -and \$afterFresh -notcontains \$UBUNTU_DISTRO\) \{\n[^\n]+\n\s+if \(-not \(Install-AgendDistro \$UBUNTU_DISTRO \$wslPath\)\) \{/);
  });
  it("the WSL MSI download has a deadline", () => {
    expect(code).toMatch(/Invoke-WebRequest -Uri \$msiAsset\.browser_download_url -OutFile \$wslMsi -UseBasicParsing -TimeoutSec \d+/);
  });
});

function run(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2650pre-")); dirs.push(dir);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$WSL_MIN_BUILD = 19041
$WSL_FEATURES = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: dir } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
}

describe.skipIf(!pwsh)("with pwsh: the preflight", { timeout: 90_000 }, () => {
  it("Test-WslPreflight: an old build and a 32-bit Windows stop; virtualization off warns; a good machine passes quietly", () => {
    const out = run(`
function P($b, $a, $v) { return @{ Build = $b; Arch = $a; Virtualization = $v } }
Write-Output ('OLD=' + (Test-WslPreflight (P 18363 'x64' $true)))
Write-Output ('X86=' + (Test-WslPreflight (P 22631 'x86' $true)))
Write-Output ('NOVT=' + (Test-WslPreflight (P 22631 'x64' $false)))
Write-Output 'QUIET-START'
Write-Output ('ARM=' + (Test-WslPreflight (P 26100 'arm64' $null)))
Write-Output ('OK=' + (Test-WslPreflight (P 19041 'x64' $true)))
Write-Output ('NOBUILD=' + (Test-WslPreflight (P $null 'x64' $true)))`);
    expect(out).toContain("這台電腦的 Windows 太舊（組建 18363）：WSL 2 需要 Windows 10 2004（組建 19041）以上，或 Windows 11。");
    expect(out).toContain("OLD=False");
    expect(out).toContain("這台電腦的 Windows 是 x86 版：WSL 2 只支援 64 位元（x64 或 ARM64）的 Windows。");
    expect(out).toContain("X86=False");
    expect(out).toContain("這台電腦的虛擬化看起來沒有開啟");
    expect(out).toContain("Intel VT-x");
    expect(out).toContain("NOVT=True");
    const quiet = out.slice(out.indexOf("QUIET-START"));
    expect(quiet).toMatch(/QUIET-START\nARM=True\nOK=True\nNOBUILD=True/);
  });

  it("Get-WslFeatureState and Test-Virtualization read what Windows says, and say Unknown/null when they cannot", () => {
    const out = run(`
$script:states = @{ 'A' = 'Enabled'; 'B' = 'EnablePending'; 'C' = 'Disabled'; 'D' = 'DisablePending' }
function Get-WindowsOptionalFeature { param([switch]$Online, $FeatureName, $ErrorAction)
  if ($FeatureName -eq 'X') { throw 'no DISM module' }; return [PSCustomObject]@{ State = $script:states[$FeatureName] } }
foreach ($n in 'A', 'B', 'C', 'D', 'X') { Write-Output ("F$n=" + (Get-WslFeatureState $n)) }
$script:cim = @{}
function Get-CimInstance { param($ClassName, $ErrorAction) $v = $script:cim[$ClassName]; if ($v -is [string] -and $v -eq 'throw') { throw 'no CIM' }; return $v }
function V($hv, $fw) { $script:cim = @{ Win32_ComputerSystem = $hv; Win32_Processor = $fw }; $r = Test-Virtualization; if ($null -eq $r) { 'null' } else { $r } }
Write-Output ('HV=' + (V ([PSCustomObject]@{ HypervisorPresent = $true }) ([PSCustomObject]@{ VirtualizationFirmwareEnabled = $false })))
Write-Output ('FW=' + (V ([PSCustomObject]@{ HypervisorPresent = $false }) @([PSCustomObject]@{ VirtualizationFirmwareEnabled = $true })))
Write-Output ('OFF=' + (V ([PSCustomObject]@{ HypervisorPresent = $false }) @([PSCustomObject]@{ VirtualizationFirmwareEnabled = $false })))
Write-Output ('NONE=' + (V 'throw' 'throw'))
Write-Output ('BLANK=' + (V ([PSCustomObject]@{ HypervisorPresent = $false }) @([PSCustomObject]@{ VirtualizationFirmwareEnabled = $null })))`);
    expect(out).toContain("FA=Enabled");
    expect(out).toContain("FB=EnablePending");
    expect(out).toContain("FC=Disabled");
    expect(out).toContain("FD=Disabled");
    expect(out).toContain("FX=Unknown");
    expect(out).toContain("HV=True");
    expect(out).toContain("FW=True");
    expect(out).toContain("OFF=False");
    expect(out).toContain("NONE=null");
    expect(out).toContain("BLANK=null");
  });

  /** Enable-WslFeatures with the given states, DISM codes per feature, and what a re-read says afterwards. */
  const enable = (states: [string, string], codes: Record<string, number>, reread: Record<string, string>) => run(`
$script:dism = @()
function Invoke-Watched { param($Label, $Usually, $File, [string[]]$Arguments, $UpperMinutes, $Encoding, $OnLine)
  $n = ($Arguments | Where-Object { $_ -like '/featurename:*' }) -replace '^/featurename:', ''
  $script:dism += "$Label=$n"
  $c = @{ ${Object.entries(codes).map(([k, v]) => `'${k}' = ${v}`).join("; ")} }[$n]; if ($null -eq $c) { $c = 0 }; return $c }
function Get-WslFeatureState([string]$name) { $r = @{ ${Object.entries(reread).map(([k, v]) => `'${k}' = '${v}'`).join("; ")} }[$name]; if ($r) { return $r }; return 'Enabled' }
$f = [ordered]@{ 'Microsoft-Windows-Subsystem-Linux' = '${states[0]}'; 'VirtualMachinePlatform' = '${states[1]}' }
$r = Enable-WslFeatures $f
Write-Output ('RESULT=' + $r + ' DISM=' + ($script:dism -join ','))`);

  it("only the missing feature is enabled; VirtualMachinePlatform is no longer skipped when WSL is already on", () => {
    expect(enable(["Enabled", "Enabled"], {}, {})).toContain("RESULT=ready DISM=\n");
    expect(enable(["Enabled", "Disabled"], {}, {})).toContain("RESULT=reboot DISM=啟用虛擬機器平台=VirtualMachinePlatform\n");
    expect(enable(["Disabled", "Enabled"], {}, {})).toContain("RESULT=reboot DISM=啟用 WSL 功能=Microsoft-Windows-Subsystem-Linux\n");
    expect(enable(["Disabled", "Disabled"], { VirtualMachinePlatform: 3010 }, {}))
      .toContain("RESULT=reboot DISM=啟用 WSL 功能=Microsoft-Windows-Subsystem-Linux,啟用虛擬機器平台=VirtualMachinePlatform\n");
  });
  it("already enabled and waiting for a restart: a reboot, no DISM", () => {
    expect(enable(["EnablePending", "Enabled"], {}, {})).toContain("RESULT=reboot DISM=\n");
  });
  it("a DISM failure stops with its code; the next feature is not tried", () => {
    const out = enable(["Disabled", "Disabled"], { "Microsoft-Windows-Subsystem-Linux": 50 }, {});
    expect(out).toContain("啟用 WSL 功能 沒有成功（DISM 結束碼 50）。");
    expect(out).toContain("RESULT=failed DISM=啟用 WSL 功能=Microsoft-Windows-Subsystem-Linux\n");
  });
  it("DISM said 0 but Windows still says Disabled: failed, not 'enabled'; an unreadable re-read trusts the code", () => {
    const out = enable(["Enabled", "Disabled"], {}, { VirtualMachinePlatform: "Disabled" });
    expect(out).toContain("VirtualMachinePlatform 還是沒有啟用。");
    expect(out).toContain("RESULT=failed");
    expect(enable(["Enabled", "Disabled"], {}, { VirtualMachinePlatform: "Unknown" })).toContain("RESULT=reboot");
  });

  it("the MSI fallback downloads the machine's architecture: arm64 on ARM64, x64 on x64, and says which when none matches", () => {
    const msi = (arch: string, assets: string[]) => run(`
$env:ProgramFiles = $env:TMPDIR; $env:TEMP = $env:TMPDIR
$script:urls = @()
function Get-WindowsArch { return '${arch}' }
function Get-FileVersionString { return $null }
function Invoke-Watched { param($Label, $Usually, $File, [string[]]$Arguments, $UpperMinutes, $Encoding, $OnLine) if ($File -eq 'msiexec.exe') { return 0 }; return 1 }
function Invoke-RestMethod { return [PSCustomObject]@{ tag_name = '2.6.1'; assets = @(${assets.map(a => `[PSCustomObject]@{ name = '${a}'; browser_download_url = 'https://example.invalid/${a}' }`).join(", ")}) } }
function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec) $script:urls += "$Uri timeout=$TimeoutSec" }
function wsl { $global:LASTEXITCODE = 0 }
$r = Invoke-WslUpdateStage
Write-Output ('RESULT=' + $r + ' URLS=' + ($script:urls -join ','))`);
    const both = ["wsl.2.6.1.0.x64.msi", "wsl.2.6.1.0.arm64.msi"];
    expect(msi("arm64", both)).toContain("RESULT=updated URLS=https://example.invalid/wsl.2.6.1.0.arm64.msi timeout=1800");
    expect(msi("x64", both)).toContain("RESULT=updated URLS=https://example.invalid/wsl.2.6.1.0.x64.msi timeout=1800");
    const none = msi("arm64", ["wsl.2.6.1.0.x64.msi"]);
    expect(none).toContain("找不到 arm64 的 MSI 下載連結");
    expect(none).toContain("RESULT=failed URLS=\n");
  });
});
