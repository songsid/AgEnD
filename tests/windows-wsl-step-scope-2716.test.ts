/**
 * The installer runs as a script FILE (install.ps1 starts install-agend.ps1 with `-File`), so its functions live in that
 * script's scope, not the global one. A scriptblock made with .GetNewClosure() runs in a new dynamic module whose scope
 * chain skips the script scope: a function call inside it fails there ("The term 'Protect-LogText' is not recognized"),
 * though it passes when the functions are global. A live run hit exactly that in Invoke-WslStep's line capture, right
 * after "正在設定 WSL 環境防護" (stage 1).
 *
 * These run the real Invoke-WslStep and Invoke-Watched through `& case.ps1` in one worker. Functions live in that
 * case's script scope. A stub process writes private output files; the real tail readers and callbacks consume them
 * using an injected clock, without a native WSL process or physical polling sleeps.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPsFunction } from "./support/installer-ps-extract.js";
import { withInstallerClock } from "./support/installer-pwsh-fixture.js";
import { InstallerC3Batch, hasPwsh } from "./support/installer-pwsh-c3.js";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const source = readFileSync(INSTALLER,'utf8');
const names = ['Invoke-WslStep','Invoke-Watched','Protect-LogText','Write-InstallLog','Write-Warn','Write-Err',
  'Join-ProcessArguments','Format-Elapsed','New-OutputTail','Read-OutputTail','Get-LastSegment','Split-ToolOutput','Restore-StepConsole'];
const batch = new InstallerC3Batch({ installer: withInstallerClock(names.map(n => extractPsFunction(source,n)).join('\n')) });
const dirs: string[] = [];
/** A secret-shaped value built at run time, so no secret-like literal sits in the source (gitleaks). */
const SECRET = "c".repeat(24);
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function runAsScriptFile(body: string): Promise<{ out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "agend-wslstep-")); dirs.push(dir);
  // The batch invokes this file with &, retaining the script-scope boundary that -File alone can hide.
  const out = await batch.run('installer', `$env:ProgramData = Join-Path $env:TMPDIR 'pd'
$script:InstallLogShown = $false; $script:InstallLogFull = $false
$script:InstallStage = 'start'; $script:InstallFailure = $null; $script:InstallRunId = ''; $ProgressFile = $null
$UBUNTU_DISTRO = 'AgEnD-Ubuntu-24.04'; $AGEND_USER = 'agend'
# The owned-script and cancellation plumbing is outside this scope/callback proof.
function New-WslScriptFile([string]$Script, [string]$Distro) { $f = Join-Path $env:TMPDIR ('s-' + [Guid]::NewGuid().ToString('N') + '.sh'); [IO.File]::WriteAllText($f, $Script); return @($f, $f) }
function Get-OwnedWslStepScript([string]$ScriptPath, [string]$CancellationPath, [int]$Seconds) { return 'true' }
function Assert-NoPendingWslCancellation { }
function Test-LiveConsole { return $false }
function Start-Process {
 param($FilePath,$ArgumentList,[switch]$NoNewWindow,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError,$RedirectStandardInput)
 if($FilePath -ne 'wsl.exe'){throw 'Unexpected process'}
 [IO.File]::WriteAllText($RedirectStandardOutput,"linux says hello"+[char]10+"token=${SECRET}"+[char]10)
 [IO.File]::WriteAllText($RedirectStandardError,'')
 $script:FixtureProcess = [pscustomobject]@{HasExited=$false;Handle=1;ExitCode=0}
 $script:FixtureProcess | Add-Member ScriptMethod WaitForExit {param([int]$Milliseconds) if($Milliseconds){return $true}}
 return $script:FixtureProcess
}
$script:FixtureTick = { $script:FixtureProcess.HasExited=$true }
${body}
Write-Output ('CLOCK=' + $script:FixtureMilliseconds)
Write-Output 'CASE-OK'`, dir);
  return { out };
}

describe("Invoke-WslStep in its own script scope, as in production", () => {
  it.skipIf(!hasPwsh)("captures the step's output, redacted, and returns its exit code — no 'is not recognized' from the line callback", async () => {
    const r = await runAsScriptFile(`$code = Invoke-WslStep -Label 'guard' -Usually 'x' -Script 'echo hi'
Write-Output ('CODE=' + $code)
Write-Output ('TEXT=' + ($script:LastWslStepResult.Text -replace "\`n", '|'))`);
    expect(r.out).not.toMatch(/is not recognized/);
    expect(r.out).toContain("CASE-OK");
    expect(r.out).toContain("CLOCK=250");
    expect(r.out).toContain("CODE=0");
    expect(r.out).toContain("linux says hello");
    expect(r.out).toContain("token=[hidden]");
    const text = r.out.split("\n").find(l => l.startsWith("TEXT=")) ?? "";
    expect(text).toContain("token=[hidden]");
    expect(text).not.toContain(SECRET);
  });

  it.skipIf(!hasPwsh)("a caller's OnLine hook still sees every raw line (the browser sign-in reads its URL this way)", async () => {
    const r = await runAsScriptFile(`$seen = New-Object System.Collections.ArrayList
$hook = { param($line) [void]$seen.Add([string]$line) }
$code = Invoke-WslStep -Label 'setup' -Usually 'x' -Script 'echo hi' -OnLine $hook
Write-Output ('CODE=' + $code)
Write-Output ('SEEN=' + ($seen -join '|'))`);
    expect(r.out).not.toMatch(/is not recognized/);
    expect(r.out).toContain("CODE=0");
    expect(r.out).toContain(`SEEN=linux says hello|token=${SECRET}`);
  });

  it("no scriptblock in the installers is made with .GetNewClosure() over a call to one of their own functions", () => {
    for (const file of [INSTALLER, join(import.meta.dirname, "..", "website", "public", "install.ps1")]) {
      const text = readFileSync(file, "utf8");
      const names = [...text.matchAll(/^\s*function\s+([A-Za-z][\w-]*)/gm)].map(m => m[1]!);
      for (const m of text.matchAll(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\.GetNewClosure\(\)/g)) {
        const called = names.filter(n => new RegExp(`(?<![\\w$-])${n}(?![\\w-])`).test(m[1]!));
        expect(called, `${file}: a GetNewClosure block calls ${called.join(", ")}`).toEqual([]);
      }
    }
  });
});
