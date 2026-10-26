/**
 * The installer runs as a script FILE (install.ps1 starts install-agend.ps1 with `-File`), so its functions live in that
 * script's scope, not the global one. A scriptblock made with .GetNewClosure() runs in a new dynamic module whose scope
 * chain skips the script scope: a function call inside it fails there ("The term 'Protect-LogText' is not recognized"),
 * though it passes when the functions are global. A live run hit exactly that in Invoke-WslStep's line capture, right
 * after "正在設定 WSL 環境防護" (stage 1).
 *
 * These run the real Invoke-WslStep and Invoke-Watched under `pwsh -File`, with the installer's functions loaded at the
 * file's script scope as in production, and a fake wsl.exe on PATH that prints a line holding a secret.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
let hasPwsh = false;
beforeAll(() => { try { execFileSync("pwsh", ["-NoProfile", "-Command", "1"], { stdio: "ignore" }); hasPwsh = true; } catch { hasPwsh = false; } });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function runAsScriptFile(body: string): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "agend-wslstep-")); dirs.push(dir);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const wsl = join(bin, "wsl.exe");
  writeFileSync(wsl, "#!/bin/sh\necho 'linux says hello'\necho 'token=abc123def456'\nexit 0\n");
  chmodSync(wsl, 0o755);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$env:LOCALAPPDATA = Join-Path '${dir}' 'lad'; $env:ProgramData = Join-Path '${dir}' 'pd'
$script:InstallLog = $null; $script:InstallLogShown = $false; $script:InstallLogFull = $false
$script:InstallStage = 'start'; $script:InstallFailure = $null; $script:InstallRunId = ''; $ProgressFile = $null
$UBUNTU_DISTRO = 'AgEnD-Ubuntu-24.04'; $AGEND_USER = 'agend'
# The WSL plumbing around the step (paths inside Linux, its owner wrapper) is not what is tested here.
function New-WslScriptFile([string]$Script, [string]$Distro) { $f = Join-Path '${dir}' ('s-' + [Guid]::NewGuid().ToString('N') + '.sh'); [IO.File]::WriteAllText($f, $Script); return @($f, $f) }
function Get-OwnedWslStepScript([string]$ScriptPath, [string]$CancellationPath, [int]$Seconds) { return 'true' }
function Assert-NoPendingWslCancellation { }
${body}`);
  // `& '<file>'` from a command: the file's functions in its own script scope, which a GetNewClosure block cannot see
  // (the live failure; `pwsh -File` alone happens to hide it).
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `& '${script}'`], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("Invoke-WslStep under pwsh -File (the installer's functions in script scope, as in production)", () => {
  it("captures the step's output, redacted, and returns its exit code — no 'is not recognized' from the line callback", () => {
    if (!hasPwsh) return;
    const r = runAsScriptFile(`$code = Invoke-WslStep -Label 'guard' -Usually 'x' -Script 'echo hi'
Write-Output ('CODE=' + $code)
Write-Output ('TEXT=' + ($script:LastWslStepResult.Text -replace "\`n", '|'))`);
    expect(r.out).not.toMatch(/is not recognized/);
    expect(r.status).toBe(0);
    expect(r.out).toContain("CODE=0");
    expect(r.out).toContain("linux says hello");
    expect(r.out).toContain("token=[hidden]");
    const text = r.out.split("\n").find(l => l.startsWith("TEXT=")) ?? "";
    expect(text).toContain("token=[hidden]");
    expect(text).not.toContain("abc123def456");
  });

  it("a caller's OnLine hook still sees every raw line (the browser sign-in reads its URL this way)", () => {
    if (!hasPwsh) return;
    const r = runAsScriptFile(`$seen = New-Object System.Collections.ArrayList
$hook = { param($line) [void]$seen.Add([string]$line) }
$code = Invoke-WslStep -Label 'setup' -Usually 'x' -Script 'echo hi' -OnLine $hook
Write-Output ('CODE=' + $code)
Write-Output ('SEEN=' + ($seen -join '|'))`);
    expect(r.out).not.toMatch(/is not recognized/);
    expect(r.out).toContain("CODE=0");
    expect(r.out).toContain("SEEN=linux says hello|token=abc123def456");
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
