/**
 * #1853: the Windows one-liner, `powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"`.
 * install.ps1 runs under `iex`, so it must be ASCII only (Windows PowerShell 5.1 may decode a download as the wrong
 * code page) and have no param block and no `exit` (under iex it closes the window). It downloads install-agend.ps1
 * to a temporary file, checks it, and runs it in its own PowerShell with -ExecutionPolicy Bypass (that process only).
 *
 * The static checks always run. With `pwsh` on PATH (GitHub's ubuntu runners have it), both scripts are parsed with
 * PowerShell's own parser, and the real one-liner (`irm … | iex`) is run against a local HTTP server serving a stub
 * install-agend.ps1: what it runs, with which arguments, what it refuses, and that the calling session goes on.
 * A real Windows run (UAC elevation, Windows PowerShell 5.1, WSL) is the user's acceptance: no Windows runner here.
 */
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BOOTSTRAP = join(ROOT, "website", "public", "install.ps1");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const code = (text: string) => text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");      // comment lines out

describe("install.ps1 is safe under iex (static)", () => {
  const raw = readFileSync(BOOTSTRAP);
  const text = raw.toString("utf8");
  it("ASCII only, no BOM", () => {
    const bad = [...raw].map((b, i) => [b, i] as const).filter(([b]) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
    expect(bad.slice(0, 5)).toEqual([]);
  });
  it("no param block and no exit", () => {
    expect(code(text)).not.toMatch(/\bparam\s*\(/i);
    expect(code(text)).not.toMatch(/(^|[^\w$-])exit\b/im);
  });
  it("never changes the execution policy for good: Bypass for the child only, no Set-ExecutionPolicy", () => {
    expect(code(text)).not.toMatch(/Set-ExecutionPolicy/i);
    expect(code(text)).toMatch(/'-ExecutionPolicy', 'Bypass', '-File'/);
  });
  it("the installer it fetches is still the UTF-8-with-BOM file it checks for", () => {
    const installer = readFileSync(INSTALLER);
    expect([...installer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(installer.toString("utf8")).toContain("function Check-Admin");
    expect(installer.length).toBeGreaterThan(1024);
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;

describe.skipIf(!pwsh)("with pwsh: both scripts parse; the one-liner downloads, checks and dispatches", { timeout: 90_000 }, () => {
  it("PowerShell's parser finds no errors, and no exit statement or param block in install.ps1", () => {
    const script = `
      foreach ($f in @('${BOOTSTRAP}', '${INSTALLER}')) {
        $t = $null; $e = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e)
        if ($e.Count) { Write-Output "ERR $f $($e[0].Message)" }
        if ($f -like '*install.ps1') {
          $exits = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ExitStatementAst] }, $true)
          $params = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ParamBlockAst] }, $true)
          Write-Output "BOOT exits=$($exits.Count) params=$($params.Count)"
        }
      }`;
    const r = spawnSync("pwsh", ["-NoProfile", "-c", script], { encoding: "utf8" });
    expect(r.stdout).not.toContain("ERR ");
    expect(r.stdout).toContain("BOOT exits=0 params=0");
  });

  // A stub install-agend.ps1: UTF-8 with BOM, over 1 KiB, with the installer's own marker; it records how it was run.
  const ZH = "AgEnD 一鍵安裝腳本";
  const stub = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([
    "param([switch]$Force, [string]$InstallVersion)",
    "function Check-Admin { $true }",
    `$zh = '${ZH}'`,
    "@{ args = @($args); force = [bool]$Force; version = $InstallVersion; file = $PSCommandPath; zh = $zh } | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $env:STUB_OUT",
    "exit 7",
    "#" + "x".repeat(1200),
    "",
  ].join("\n"), "utf8")]);
  let server: Server, port = 0, mode: "stub" | "html" | "404" = "stub";
  const dirs: string[] = [];
  beforeAll(async () => {
    const boot = readFileSync(BOOTSTRAP);
    server = createServer((req, res) => {
      if (req.url === "/install.ps1") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(boot); return; }
      if (req.url === "/install-agend.ps1" && mode === "stub") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(stub); return; }
      if (req.url === "/install-agend.ps1" && mode === "html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html><body>Rate limited</body></html>".repeat(60)); return; }
      res.writeHead(404); res.end("not found");
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server?.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  /** pwsh, asynchronously: the HTTP server it downloads from lives in this process (spawnSync would block it). */
  const run = (args: string[], env: Record<string, string>) => new Promise<{ stdout: string; stderr: string }>(resolve => {
    execFile("pwsh", args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } }, (_err, stdout, stderr) => resolve({ stdout, stderr }));
  });
  async function oneLiner(env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "agend-1853-")); dirs.push(dir);
    const out = join(dir, "stub.json");
    // The real one-liner's body, then a line after it: the calling session must still be running.
    const r = await run(["-NoProfile", "-ExecutionPolicy", "ByPass", "-c", `irm http://127.0.0.1:${port}/install.ps1 | iex; Write-Output "SESSION-GOES-ON"`],
      { AGEND_INSTALL_BASE: `http://127.0.0.1:${port}`, AGEND_INSTALL_SHELL: "pwsh", STUB_OUT: out, TMPDIR: dir, ...env });
    return { r, out, dir, ran: existsSync(out) ? JSON.parse(readFileSync(out, "utf8").replace(/^﻿/, "")) : null };
  }

  it.each(['beta', 'latest', '2.3.2-beta.5'])('passes validated AGEND_VERSION=%s explicitly to the downloaded installer', async version => {
    mode = "stub";
    const { ran } = await oneLiner({ AGEND_VERSION: version });
    expect(ran).toMatchObject({ version, force: false });
  });
  it('rejects an invalid version before downloading or dispatching the installer', async () => {
    const { ran, r } = await oneLiner({ AGEND_VERSION: 'beta; whoami' });
    expect(ran).toBeNull();
    expect(r.stderr).toContain('AGEND_VERSION must be');
    expect(r.stderr).not.toContain('beta; whoami');
  });

  it("downloads the installer, runs it in its own PowerShell (-ExecutionPolicy Bypass -File <temp>), then cleans up", async () => {
    mode = "stub";
    const { r, ran, dir } = await oneLiner();
    expect(r.stdout).toContain("SESSION-GOES-ON");                          // its exit 7 ended its own process only
    expect(ran).toMatchObject({ force: false, zh: ZH });                     // the BOM file read as UTF-8: the Chinese is intact
    expect(ran.file).toMatch(/install-agend-[0-9a-f]{32}\.ps1$/);
    expect(r.stdout).toContain("the installer ended with code 7");
    expect(readdirSync(dir).filter(f => f.startsWith("install-agend-"))).toEqual([]);   // the temporary copy is gone
  });

  it("AGEND_INSTALL_FORCE=1 passes -Force", async () => {
    mode = "stub";
    expect((await oneLiner({ AGEND_INSTALL_FORCE: "1" })).ran).toMatchObject({ force: true });
  });

  it("something that is not the installer (an error page) is never run", async () => {
    mode = "html";
    const { r, ran } = await oneLiner();
    expect(ran).toBeNull();
    expect(r.stdout).toContain("is not the AgEnD installer");
    expect(r.stdout).toContain("SESSION-GOES-ON");
  });

  it("a failed download says so and runs nothing", async () => {
    mode = "404";
    const { r, ran } = await oneLiner();
    expect(ran).toBeNull();
    expect(r.stdout).toContain("the download failed");
    expect(r.stdout).toContain("SESSION-GOES-ON");
  });

  it("an address that is not https (or this machine) is refused", async () => {
    mode = "stub";
    const dir = mkdtempSync(join(tmpdir(), "agend-1853-")); dirs.push(dir);
    const r = await run(["-NoProfile", "-c", `irm http://127.0.0.1:${port}/install.ps1 | iex; Write-Output "SESSION-GOES-ON"`],
      { AGEND_INSTALL_BASE: "http://example.com", AGEND_INSTALL_SHELL: "pwsh", STUB_OUT: join(dir, "x.json") });
    expect(r.stdout).toContain("refusing to download the installer from http://example.com");
    expect(existsSync(join(dir, "x.json"))).toBe(false);
    expect(r.stdout).toContain("SESSION-GOES-ON");
  });
});
