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
 *   The functions are sliced in Node (installer-ps-extract.ts): no Parser::ParseFile of the installer. One pwsh runs
 *   every answer in both modes (installer-ps-batch-c.ts).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configuredConnectionCount } from "../src/config-validator.js";
import yaml from "js-yaml";
import { extractInstallerPrelude } from "./support/installer-ps-extract.js";
import { BATCH_MARK, psq, runPwshBatch } from "./support/installer-ps-batch-c.js";

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

/** What the fake agend prints and exits with, for one call of Get-FleetConnections. */
const ANSWERS = [
  { id: "web", printed: "CONNECTIONS=0", exit: 0 },
  { id: "chat", printed: "CONNECTIONS=2", exit: 0 },
  { id: "old", printed: "error: unknown option '--connections'", exit: 1 },
  { id: "unknown", printed: "CONNECTIONS=unknown", exit: 1 },
  { id: "silent", printed: "", exit: 0 },
] as const;
const MODES = ["Legacy", "Standard"] as const;
type Row = { mode: string; id: string; result: string };

/** Every answer in both argument-passing modes, in one pwsh. The shims are real executables on PATH (the native boundary). */
async function runConnections(): Promise<Row[]> {
  const dir = scratch(), bin = join(dir, "bin"); mkdirSync(bin);
  // wsl.exe: a real executable — the native boundary is PowerShell's argument passing, exactly as on Windows.
  writeFileSync(join(bin, "wsl.exe"), '#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n'); chmodSync(join(bin, "wsl.exe"), 0o755);
  // agend: prints and exits with what the script put in FAKE_AGEND_OUT / FAKE_AGEND_EXIT (the environment passes through wsl.exe).
  writeFileSync(join(bin, "agend"), '#!/bin/sh\n[ "$1 $2" = "validate --connections" ] || { echo "error: unexpected $*" >&2; exit 2; }\nprintf \'%s\\n\' "$FAKE_AGEND_OUT"\nexit "$FAKE_AGEND_EXIT"\n'); chmodSync(join(bin, "agend"), 0o755);
  const calls = MODES.flatMap(mode => [
    `$PSNativeCommandArgumentPassing = ${psq(mode)}`,
    ...ANSWERS.map(a => [
      `$env:FAKE_AGEND_OUT = ${psq(a.printed)}; $env:FAKE_AGEND_EXIT = ${psq(String(a.exit))}`,
      `$rows.Add([pscustomobject]@{ mode = [string]$PSNativeCommandArgumentPassing; id = ${psq(a.id)}; result = (@(Get-FleetConnections 'Ubuntu') -join ' ') })`,
    ].join("\n")),
  ]);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$env:HOME = ${psq(dir)}; $env:USERPROFILE = ${psq(dir)}`,
    `$env:PATH = ${psq(bin)} + [IO.Path]::PathSeparator + $env:PATH`,
    extractInstallerPrelude(text),
    "$rows = New-Object System.Collections.Generic.List[object]",
    ...calls,
    `Write-Output ("${BATCH_MARK}" + (ConvertTo-Json -InputObject $rows.ToArray() -Depth 4 -Compress))`,
  ].join("\n");
  return runPwshBatch<Row[]>(dir, script, { ...process.env });
}

describe.skipIf(!pwsh)("with pwsh: Get-FleetConnections across a real native-command boundary", { timeout: 120_000 }, () => {
  let rows: Promise<Row[]> | undefined;
  it.each(MODES)("%s argument passing: 0 → web, 2 → chat; an old agend, an error or no answer → unknown (never 'connected')", async mode => {
    rows ??= runConnections();
    const got = await rows;
    expect(got.filter(r => r.mode === mode).map(r => r.id)).toEqual(ANSWERS.map(a => a.id));
    const result = (id: string) => got.find(r => r.mode === mode && r.id === id)?.result;
    expect(result("web")).toBe("web");
    expect(result("chat")).toBe("chat");
    expect(result("old")).toBe("unknown");
    expect(result("unknown")).toBe("unknown");
    expect(result("silent")).toBe("unknown");
  });
});
