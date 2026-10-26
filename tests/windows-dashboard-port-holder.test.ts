/**
 * Live (2026-10-26): the setup page answered inside WSL, yet Windows got "connection reset" on 127.0.0.1:19280 — the
 * PC's other Linux, where AgEnD had run before, still had its WSL localhost relay (wslrelay.exe) on that port. Stage 5
 * now looks before it starts: a relay held by another running Linux is stopped only on an explicit y, never all of WSL;
 * any other program holding the port stops the stage with its name.
 *
 * Windows' cmdlets are stubbed: Get-NetTCPConnection / Get-Process (who listens), Invoke-BoundedWsl (the running list,
 * --terminate), Read-Host (the answer). The installer's functions run from a script file.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
let hasPwsh = false;
beforeAll(() => { try { execFileSync("pwsh", ["-NoProfile", "-Command", "1"], { stdio: "ignore" }); hasPwsh = true; } catch { hasPwsh = false; } });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** `holder`: the process on the port ('' = none); it goes away after a --terminate of `holderDistro`. */
function resolve(o: { holder: string; running: string[]; answer?: string; holderDistro?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "agend-port-")); dirs.push(dir);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -match '^(Get-WindowsPortListener|Get-RunningOtherDistros|Resolve-DashboardPortHolder|Write-(Err|Warn|Info|Ok)|Write-InstallLog|Protect-LogText)$' }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$UBUNTU_DISTRO = 'AgEnD-Ubuntu-24.04'
$script:holder = '${o.holder}'; $script:calls = @(); $script:asked = 0
function Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction) if (-not $script:holder) { throw 'none' }; [PSCustomObject]@{ OwningProcess = 4242 } }
function Get-Process { param($Id, $ErrorAction) [PSCustomObject]@{ ProcessName = $script:holder } }
function Start-Sleep { }
function Read-Host { param($Prompt) $script:asked++; '${o.answer ?? ""}' }
function Invoke-BoundedWsl {
  param([string[]]$Arguments)
  $script:calls += ($Arguments -join ' ')
  if ($Arguments[0] -eq '--list') { return @{ Code = 0; Text = ((@(${o.running.map(d => `'${d}'`).join(",")}) + @('AgEnD-Ubuntu-24.04')) -join "\`n") } }
  if ($Arguments[0] -eq '--terminate' -and $Arguments[1] -eq '${o.holderDistro ?? ""}') { $script:holder = '' }
  return @{ Code = 0; Text = '' }
}
$r = Resolve-DashboardPortHolder 19280
Write-Output ('RESULT=' + $r)
Write-Output ('CALLS=' + ($script:calls -join ' | '))
Write-Output ('ASKED=' + $script:asked)`);
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `& '${script}'`], { encoding: "utf8", timeout: 60_000 });
  return `${r.stdout}${r.stderr}`;
}

describe("stage 5: who holds the dashboard port on Windows", () => {
  it("nobody: go on, nothing asked, nothing run", () => {
    if (!hasPwsh) return;
    const out = resolve({ holder: "", running: [] });
    expect(out).toContain("RESULT=True"); expect(out).toContain("CALLS=\n"); expect(out).toContain("ASKED=0");
  });

  it("another program: stop, naming it — never touching WSL", () => {
    if (!hasPwsh) return;
    const out = resolve({ holder: "node", running: ["Ubuntu"] });
    expect(out).toContain("RESULT=False"); expect(out).toContain("「node」（PID 4242）"); expect(out).toContain("CALLS=\n");
  });

  it("another Linux's relay, y: only that Linux is stopped (never --shutdown, never ours), and the port is free", () => {
    if (!hasPwsh) return;
    const out = resolve({ holder: "wslrelay", running: ["Ubuntu"], answer: "y", holderDistro: "Ubuntu" });
    expect(out).toContain("RESULT=True");
    expect(out).toContain("CALLS=--list --running --quiet | --terminate Ubuntu\n");
    expect(out).not.toMatch(/--shutdown|--terminate AgEnD/);
  });

  it("another Linux's relay, declined (or just Enter): nothing stopped, the stage stops with the command to run", () => {
    if (!hasPwsh) return;
    for (const answer of ["", "n", "yes"]) {
      const out = resolve({ holder: "wslrelay", running: ["Ubuntu"], answer, holderDistro: "Ubuntu" });
      expect(out, answer).toContain("RESULT=False");
      expect(out.match(/^CALLS=.*$/m)![0], answer).toBe("CALLS=--list --running --quiet");   // nothing stopped
      expect(out, answer).toContain("wsl --terminate <");                                      // the command to run later
    }
  });

  it("a relay with no other Linux running: most likely our own — go on (the reachability probe decides)", () => {
    if (!hasPwsh) return;
    const out = resolve({ holder: "wslrelay", running: [] });
    expect(out).toContain("RESULT=True"); expect(out).toContain("ASKED=0");
  });
});
