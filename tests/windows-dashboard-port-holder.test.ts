/**
 * Live (2026-10-26): the setup page answered inside WSL, yet Windows got "connection reset" on 127.0.0.1:19280 — the
 * PC's other Linux, where AgEnD had run before, still had its WSL localhost relay (wslrelay.exe) on that port. Stage 5
 * now picks a port pair (health_port P: dashboard, /health and the setup page; P+1: the web preview's default) that is
 * free on Windows (no listener, not reserved) and in Linux, writes it as fleet.yaml's health_port, and records it.
 *
 * Windows is stubbed (Get-NetTCPConnection / Get-Process: who listens; netsh: reserved ranges). The Linux side runs the
 * installer's own bash under a scratch HOME, except the /dev/tcp port probe, answered from a list. Script-file run.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
let hasPwsh = false;
beforeAll(() => { try { execFileSync("pwsh", ["-NoProfile", "-Command", "1"], { stdio: "ignore" }); hasPwsh = true; } catch { hasPwsh = false; } });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function select(o: { windows?: Record<number, string>; excluded?: Array<[number, number]>; linuxBusy?: number[]; fleet?: string; progress?: string; portproxy?: Array<[string, number, string, number]>; race?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "agend-ports-")); dirs.push(dir);
  const home = join(dir, "root"); mkdirSync(join(home, ".agend"), { recursive: true });
  if (o.fleet !== undefined) writeFileSync(join(home, ".agend", "fleet.yaml"), o.fleet);
  const progress = join(dir, "progress"); writeFileSync(progress, o.progress ?? "");
  const listeners = Object.entries(o.windows ?? {}).map(([p, n]) => `${p} = '${n}'`).join("; ");
  const netsh = (o.excluded ?? []).map(([a, b]) => `     ${a}     ${b}`).join("`n");
  const proxy = (o.portproxy ?? []).map(([la, lp, ca, cp]) => `${la}         ${lp}        ${ca}     ${cp}`).join("`n");
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -match '^(Get-PortProxyRule|Get-WindowsPortListener|Get-ExcludedPortRanges|Test-PortExcluded|Test-WslPortFree|Get-AgendPortConfig|Select-AgendPorts|Get-ProgressValue|Write-(Err|Warn|Info|Ok)|Write-InstallLog|Protect-LogText)$' }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$AGEND_PORT_(FIRST|TRIES)$' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
$UBUNTU_DISTRO = 'AgEnD-Ubuntu-24.04'; $ProgressFile = '${progress}'
$script:listeners = @{ ${listeners} }; $script:wsl = @(); $script:race = ${o.race === undefined ? "$null" : `'${o.race.replace(/'/g, "''")}'`}
function Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction) if (-not $script:listeners.ContainsKey([int]$LocalPort)) { throw 'none' }; [PSCustomObject]@{ OwningProcess = [int]$LocalPort } }
function Get-Process { param($Id, $ErrorAction) [PSCustomObject]@{ ProcessName = $script:listeners[[int]$Id] } }
$script:netshCalls = @()
function netsh.exe { $script:netshCalls += ($args -join ' '); if ($args[0] -eq 'interface') { "Listen on ipv4:             Connect to ipv4:\`n\`nAddress         Port        Address         Port\`n--------------- ----------  --------------- ----------\`n${proxy}" } else { "Start Port    End Port\`n----------    --------\`n${netsh}" } }
function Invoke-BoundedWsl {
  param([string[]]$Arguments)
  $s = $Arguments[-1]; $script:wsl += $s
  if ($Arguments[4] -ne '--exec') { throw ('not --exec: ' + ($Arguments -join ' ')) }
  # A config that appears (or changes) after the installer looked at it, before it writes: written by the last port probe.
  if ($script:race -and $s -match '/dev/tcp/') { [IO.File]::WriteAllText('${home}/.agend/fleet.yaml', $script:race); $script:race = $null }
  if ($s -match '/dev/tcp/127\\.0\\.0\\.1/(\\d+)') { if (@(${(o.linuxBusy ?? []).join(",")}) -contains [int]$Matches[1]) { return @{ Code = 0; Text = 'PORT_BUSY' } } else { return @{ Code = 0; Text = 'PORT_FREE' } } }
  # Only the scratch Linux: never this host's own AGEND_HOME.
  $out = (& env -i "HOME=${home}" "PATH=/usr/bin:/bin" bash -c $s 2>&1) -join "\`n"; return @{ Code = $LASTEXITCODE; Text = $out }
}
$p = Select-AgendPorts
Write-Output ('PORT=' + $p)
Write-Output ('PROBES=' + @($script:wsl | Where-Object { $_ -match '/dev/tcp' }).Count)
Write-Output ('NETSH=' + ($script:netshCalls -join ' | '))`);
  const env = { ...process.env }; delete env.AGEND_HOME;
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `& '${script}'`], { encoding: "utf8", timeout: 60_000, env });
  const fleet = join(home, ".agend", "fleet.yaml");
  return { out: `${r.stdout}${r.stderr}`, fleet: existsSync(fleet) ? readFileSync(fleet, "utf8") : null, progress: readFileSync(progress, "utf8") };
}

describe("stage 5 picks a port pair free on Windows and in Linux, and gives it to AgEnD", () => {
  it("all free: 19280, written as fleet.yaml's health_port (the setup page and the fleet both read it) and recorded", () => {
    if (!hasPwsh) return;
    const r = select({});
    expect(r.out).toContain("PORT=19280");
    expect(r.fleet).toBe("health_port: 19280\n");
    expect(r.progress).toContain("AGEND_PORT=19280");
  });

  it("another Linux's relay on Windows' 19280 (the live case): the next pair, 19282, and it says why", () => {
    if (!hasPwsh) return;
    const r = select({ windows: { 19280: "wslrelay" } });
    expect(r.out).toContain("PORT=19282");
    expect(r.out).toContain("「wslrelay」");
    expect(r.fleet).toBe("health_port: 19282\n");
  });

  it("P+1 counts too: a reserved range over 19281, or a program in Linux on 19283, skips that pair", () => {
    if (!hasPwsh) return;
    expect(select({ excluded: [[19281, 19281]] }).out).toContain("PORT=19282");
    expect(select({ windows: { 19280: "wslrelay" }, linuxBusy: [19283] }).out).toContain("PORT=19284");
  });

  it("a configured fleet.yaml keeps its port: nothing probed, nothing rewritten", () => {
    if (!hasPwsh) return;
    const fleet = "health_port: 19300\ndefaults: {}\ninstances: {}\n";
    const r = select({ fleet, windows: { 19280: "wslrelay" } });
    expect(r.out).toContain("PORT=19300"); expect(r.out).toContain("PROBES=0");
    expect(r.fleet).toBe(fleet);
  });

  it("a resume: the pair this installer wrote before is kept while it is free, and replaced when it is not", () => {
    if (!hasPwsh) return;
    expect(select({ fleet: "health_port: 19284\n", progress: "AGEND_PORT=19284\n" }).out).toContain("PORT=19284");
    const moved = select({ fleet: "health_port: 19280\n", progress: "AGEND_PORT=19280\n", windows: { 19280: "wslrelay" } });
    expect(moved.out).toContain("PORT=19282");
    expect(moved.fleet).toBe("health_port: 19282\n");
  });

  it("an old Windows port forwarding rule (portproxy, svchost) on 19280: named with its target, the delete command shown, never run — the next pair is used", () => {
    if (!hasPwsh) return;
    const r = select({ windows: { 19280: "svchost" }, portproxy: [["0.0.0.0", 19280, "172.20.64.3", 19280]] });
    expect(r.out).toContain("PORT=19282");
    expect(r.out).toContain("portproxy）把 19280 轉到 172.20.64.3:19280");
    expect(r.out).toContain("netsh interface portproxy delete v4tov4 listenport=19280 listenaddress=0.0.0.0");
    expect(r.out).not.toMatch(/NETSH=.*delete/);                     // shown to the person, never run
    expect(r.fleet).toBe("health_port: 19282\n");
  });

  it("svchost without a matching rule: named as it is", () => {
    if (!hasPwsh) return;
    const r = select({ windows: { 19280: "svchost" }, portproxy: [["0.0.0.0", 8080, "172.20.64.3", 8080]] });
    expect(r.out).toContain("PORT=19282"); expect(r.out).toContain("被「svchost」佔用");
  });

  it("a configured fleet.yaml that appears after the check, before the write, is never overwritten (#2723 review): its port is used", () => {
    if (!hasPwsh) return;
    const configured = "health_port: 19400\ndefaults: {}\ninstances:\n  general: {}\n";
    const r = select({ race: configured });
    expect(r.fleet).toBe(configured);
    expect(r.out).toContain("PORT=19400");
  });

  it("an earlier seed edited after the check: never overwritten — it is a configured fleet now, so its own port stands", () => {
    if (!hasPwsh) return;
    const edited = "health_port: 19280\nweb: { preview: false }\n";
    const r = select({ fleet: "health_port: 19280\n", windows: { 19280: "wslrelay" }, race: edited });
    expect(r.fleet).toBe(edited);
    expect(r.out).toContain("PORT=19280");
  });

  it("nothing free in the whole range: stops (no port), with how to find who holds it", () => {
    if (!hasPwsh) return;
    const r = select({ excluded: [[19000, 19999]] });
    expect(r.out).toMatch(/PORT=\s*$/m);
    expect(r.out).toContain("netstat -ano");
  });
});
