/**
 * #2233 part 3: the Windows installer with the setup page's "Web only (no bot)". The page itself is tested with the
 * setup host (setup-web-only-2233.test.ts); here, what the installer says. Its summary asks AgEnD how many chat
 * connections fleet.yaml has (`agend validate --connections`: parsed as the fleet reads it, never grepped — #2261
 * review), and says web only, connected, or that it could not tell.
 * - static checks always;
 * - `agend validate --connections` on real files (the CLI, in a scratch AGEND_HOME);
 * - with pwsh: the installer's own Get-FleetConnections across a REAL native-command boundary — `wsl.exe` is an
 *   executable shim on PATH (not a PowerShell function), run under both $PSNativeCommandArgumentPassing modes
 *   (Windows PowerShell 5.1 passes arguments the Legacy way), and `agend` a fake that answers as told.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configuredConnectionCount } from "../src/config-validator.js";
import yaml from "js-yaml";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-2233win-")); dirs.push(d); return d; };

describe("#2233 the installer names Web only and says what was set up (static)", () => {
  it("both setup prompts offer Web only next to Discord or Telegram", () => {
    expect(text.match(/或選「Web only \(no bot\)」/g)).toHaveLength(2);
  });
  it("the summary asks AgEnD, then says web only, connected, or that it could not tell — daily use follows", () => {
    expect(text).toMatch(/\$connections = Get-FleetConnections \$UBUNTU_DISTRO\nif \(\$connections -eq 'web'\) \{ Write-Info "  \[OK\] 只用網頁儀表板[^\n]*\}\nelseif \(\$connections -eq 'chat'\) \{ Write-Info "  \[OK\] 通訊軟體已串接" \}\nelse \{ Write-Warn "  \[!!\] 無法確認通訊軟體是否已串接[^\n]*\}/);
  });
  it("the command handed to wsl has no double quote (Windows PowerShell 5.1 drops embedded quotes from native arguments)", () => {
    const fn = text.slice(text.indexOf("function Get-FleetConnections"), text.indexOf("function Test-WslLogin"));
    expect(fn).toContain("Invoke-AgendInWsl $distro 'root' 'agend validate --connections'");
    const prelude = /return \('([^']*)' \+ \$command\)/.exec(text)?.[1];
    expect(prelude).toBe('export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; ');
    const script = prelude + 'agend validate --connections';
    expect(script).not.toContain('"');
  });
  it("stays UTF-8 with a BOM (Windows PowerShell 5.1 reads it as ANSI otherwise)", () => {
    expect(readFileSync(INSTALLER).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

describe("#2233 how many connections fleet.yaml configures (as the fleet reads it)", () => {
  const count = (src: string) => configuredConnectionCount(yaml.load(src));
  it("channels when present (even empty), else the singular channel; quoted keys and flow style are the same YAML", () => {
    expect(count("instances: {}\n")).toBe(0);
    expect(count("channels: []\ninstances: {}\n")).toBe(0);
    expect(count("channels:\n  - type: discord\n  - type: telegram\n")).toBe(2);
    expect(count('"channel": {"type": "telegram"}\n')).toBe(1);
    expect(count("{channels: [{type: discord}]}")).toBe(1);
    expect(count("channels: []\nchannel: {type: telegram}\n"), "channels wins, as in fleet-manager").toBe(0);
    expect(count("- not a mapping\n")).toBeNull();
    expect(count("channels: nope\n")).toBeNull();
  });
  it("agend validate --connections: CONNECTIONS=<n>, or CONNECTIONS=unknown and exit 1 without a readable fleet.yaml", () => {
    const run = (home: string) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "validate", "--connections"], { cwd: process.cwd(), env: { ...process.env, AGEND_HOME: home }, encoding: "utf8", timeout: 60_000 });
    const answer = (home: string) => { const r = run(home); return [r.stdout, r.status]; };   // one CLI start per case
    const web = scratch(); writeFileSync(join(web, "fleet.yaml"), "instances:\n  a: {working_directory: /w, backend: claude-code}\n");
    expect(answer(web)).toEqual(["CONNECTIONS=0\n", 0]);
    const chat = scratch(); writeFileSync(join(chat, "fleet.yaml"), '"channel": {"type": "telegram", "bot_token_env": "T"}\n');
    expect(answer(chat)).toEqual(["CONNECTIONS=1\n", 0]);
    expect(answer(scratch())).toEqual(["CONNECTIONS=unknown\n", 1]);
    const broken = scratch(); writeFileSync(join(broken, "fleet.yaml"), "channels: [\n");
    expect(answer(broken)).toEqual(["CONNECTIONS=unknown\n", 1]);
  }, 120_000);                                                  // four CLI starts (tsx): seconds each under a loaded runner
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
function connections(mode: "Legacy" | "Standard", agendOut: string, agendExit = 0): string {
  const dir = scratch(), bin = join(dir, "bin"); mkdirSync(bin);
  // wsl.exe: a real executable — the native boundary is PowerShell's argument passing, exactly as on Windows.
  writeFileSync(join(bin, "wsl.exe"), '#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n'); chmodSync(join(bin, "wsl.exe"), 0o755);
  writeFileSync(join(bin, "agend"), `#!/bin/sh\n[ "$1 $2" = "validate --connections" ] || { echo "error: unexpected $*" >&2; exit 2; }\nprintf '%s\\n' ${JSON.stringify(agendOut)}\nexit ${agendExit}\n`); chmodSync(join(bin, "agend"), 0o755);
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$PSNativeCommandArgumentPassing = '${mode}'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(WSL_COMMAND_FN|RESTART_FN)$'},$false)){. ([scriptblock]::Create($a.Extent.Text))}
. ([scriptblock]::Create($WSL_COMMAND_FN)); . ([scriptblock]::Create($RESTART_FN))
Write-Output ("R=" + (Get-FleetConnections 'Ubuntu'))`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: dir, USERPROFILE: dir, PATH: `${bin}:${process.env.PATH}` } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return /R=(\S+)/.exec(r.stdout)?.[1] ?? `?${r.stdout}${r.stderr}`;
}
describe.skipIf(!pwsh)("with pwsh: Get-FleetConnections across a real native-command boundary", { timeout: 120_000 }, () => {
  it.each(["Legacy", "Standard"] as const)("%s argument passing: 0 → web, 2 → chat; an old agend, an error or no answer → unknown (never 'connected')", mode => {
    expect(connections(mode, "CONNECTIONS=0")).toBe("web");
    expect(connections(mode, "CONNECTIONS=2")).toBe("chat");
    expect(connections(mode, "error: unknown option '--connections'", 1)).toBe("unknown");
    expect(connections(mode, "CONNECTIONS=unknown", 1)).toBe("unknown");
    expect(connections(mode, "")).toBe("unknown");
  });
});
