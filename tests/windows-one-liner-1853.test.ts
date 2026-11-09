/**
 * #1853: the Windows one-liner, `powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"`.
 * install.ps1 runs under `iex`, so it must be ASCII only (Windows PowerShell 5.1 may decode a download as the wrong
 * code page) and have no param block and no `exit` (under iex it closes the window). It downloads install-agend.ps1
 * to a temporary file, checks it, and runs it in its own PowerShell with -ExecutionPolicy Bypass (that process only).
 *
 * The static checks always run. With `pwsh` on PATH (GitHub's ubuntu runners have it), the real one-liner (`irm … | iex`)
 * is run for each case against a local HTTP server serving a stub install-agend.ps1: what it runs, with which arguments,
 * what it refuses, and that the calling session goes on. All cases run in ONE pwsh (installer-ps-batch-c.ts); the
 * installer's own child PowerShell (the dispatch under test: its exit 7 must end only that process) is still a real
 * process per dispatching case. The whole installer is never parsed here: the stub is what runs.
 * A real Windows run (UAC elevation, Windows PowerShell 5.1, WSL) is the user's acceptance: no Windows runner here.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BATCH_MARK, psq, runPwshBatch } from "./support/installer-ps-batch-c.js";

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

describe.skipIf(!pwsh)("with pwsh: install.ps1 parses; the one-liner downloads, checks and dispatches", { timeout: 90_000 }, () => {
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
  let server: Server, port = 0;
  const dirs: string[] = [];
  beforeAll(async () => {
    const boot = readFileSync(BOOTSTRAP);
    server = createServer((req, res) => {
      if (req.url === "/install.ps1") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(boot); return; }
      if (req.url === "/stub/install-agend.ps1") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(stub); return; }
      if (req.url === "/html/install-agend.ps1") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html><body>Rate limited</body></html>".repeat(60)); return; }
      res.writeHead(404); res.end("not found");
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server?.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  type Case = { id: string; out: string; err: string; dir: string; stubOut: string };
  type ParseRow = { id: "parse"; errors: string[]; exits: number; params: number };
  type Batch = { cases: Map<string, Case>; parse: ParseRow };
  let batch: Promise<Batch> | undefined;
  const run = () => (batch ??= runOneLiners());

  /** Every case in one pwsh: each is `irm … | iex` as the one-liner runs it, with its environment set just before. */
  async function runOneLiners(): Promise<Batch> {
    const base = `http://127.0.0.1:${port}`;
    const cases = [
      { id: "beta", env: { AGEND_VERSION: "beta" } },
      { id: "latest", env: { AGEND_VERSION: "latest" } },
      { id: "2.3.2-beta.5", env: { AGEND_VERSION: "2.3.2-beta.5" } },
      { id: "bad-version", env: { AGEND_VERSION: "beta; whoami" } },
      { id: "default", env: {} },
      { id: "force", env: { AGEND_INSTALL_FORCE: "1" } },
      { id: "html", env: { AGEND_INSTALL_BASE: `${base}/html` } },
      { id: "404", env: { AGEND_INSTALL_BASE: `${base}/404` } },
      { id: "not-https", env: { AGEND_INSTALL_BASE: "http://example.com" } },
    ].map(c => {
      const dir = mkdtempSync(join(tmpdir(), "agend-1853-")); dirs.push(dir);
      const stubOut = join(dir, "stub.json");
      // Every variable the cases touch is set or removed (null) before each case, so no case inherits another's.
      const vars: Record<string, string | null> = {
        AGEND_VERSION: null, AGEND_INSTALL_FORCE: null, AGEND_INSTALL_FALLBACK_BASE: null,
        AGEND_INSTALL_BASE: `${base}/stub`, AGEND_INSTALL_SHELL: "pwsh", STUB_OUT: stubOut, TMPDIR: dir,
        ...c.env,
      };
      return { id: c.id, dir, stubOut, vars };
    });
    const setEnv = (vars: Record<string, string | null>) => `Set-CaseEnv @{ ${Object.entries(vars).map(([k, v]) => `${k} = ${v === null ? "$null" : psq(v)}`).join("; ")} }`;
    const script = [
      "$ErrorActionPreference = 'Continue'",
      "$ProgressPreference = 'SilentlyContinue'",
      "$script:Rows = New-Object System.Collections.Generic.List[object]",
      "function Set-CaseEnv([hashtable]$vars) {",
      '  foreach ($k in $vars.Keys) { if ($null -eq $vars[$k]) { Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath "Env:$k" -Value ([string]$vars[$k]) } }',
      "}",
      "function Invoke-OneLiner([string]$id) {",
      "  $script:LineErr = ''",
      `  $out = [string](& { try { irm '${base}/install.ps1' | iex; Write-Output 'SESSION-GOES-ON' } catch { $script:LineErr = ($_ | Out-String) } } *>&1 | Out-String)`,
      "  $script:Rows.Add([pscustomobject]@{ id = $id; out = $out; err = $script:LineErr })",
      "}",
      ...cases.flatMap(c => [setEnv(c.vars), `Invoke-OneLiner ${psq(c.id)}`]),
      // The bootstrap (install.ps1) is parsed; the installer is not (see the header).
      "$t = $null; $e = $null",
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psq(BOOTSTRAP)}, [ref]$t, [ref]$e)`,
      "$exits = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ExitStatementAst] }, $true))",
      "$params = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ParamBlockAst] }, $true))",
      "$script:Rows.Add([pscustomobject]@{ id = 'parse'; errors = @($e | ForEach-Object { $_.Message }); exits = $exits.Count; params = $params.Count })",
      `Write-Output ("${BATCH_MARK}" + (ConvertTo-Json -InputObject $script:Rows.ToArray() -Depth 4 -Compress))`,
    ].join("\n");
    const workDir = mkdtempSync(join(tmpdir(), "agend-1853-batch-")); dirs.push(workDir);
    const rows = await runPwshBatch<({ id: string; out?: string; err?: string } | ParseRow)[]>(workDir, script, { ...process.env });
    const map = new Map<string, Case>();
    for (const c of cases) {
      const row = rows.find(r => r.id === c.id) as { out: string; err: string } | undefined;
      if (!row) throw new Error(`no result for case ${c.id}`);
      map.set(c.id, { id: c.id, out: row.out, err: row.err, dir: c.dir, stubOut: c.stubOut });
    }
    const parse = rows.find((r): r is ParseRow => r.id === "parse");
    if (!parse) throw new Error("no parse result");
    return { cases: map, parse };
  }
  const caseRun = async (id: string) => { const c = (await run()).cases.get(id); if (!c) throw new Error(`no case ${id}`); return c; };
  /** What the stub recorded when it ran (null: it did not run). */
  const ranOf = (c: Case) => existsSync(c.stubOut) ? JSON.parse(readFileSync(c.stubOut, "utf8").replace(/^﻿/, "")) : null;

  it("PowerShell's parser finds no errors in install.ps1, and no exit statement or param block in it", async () => {
    const { parse } = await run();
    expect(parse.errors).toEqual([]);
    expect(parse.exits).toBe(0);
    expect(parse.params).toBe(0);
  });

  it.each(["beta", "latest", "2.3.2-beta.5"])("passes validated AGEND_VERSION=%s explicitly to the downloaded installer", async version => {
    const c = await caseRun(version);
    expect(ranOf(c)).toMatchObject({ version, force: false });
  });
  it("rejects an invalid version before downloading or dispatching the installer", async () => {
    const c = await caseRun("bad-version");
    expect(ranOf(c)).toBeNull();
    expect(c.err).toContain("AGEND_VERSION must be");
    expect(c.err).not.toContain("beta; whoami");
  });

  it("downloads the installer, runs it in its own PowerShell (-ExecutionPolicy Bypass -File <temp>), then cleans up", async () => {
    const c = await caseRun("default");
    expect(c.out).toContain("SESSION-GOES-ON");                             // its exit 7 ended its own process only
    const ran = ranOf(c);
    expect(ran).toMatchObject({ force: false, zh: ZH });                     // the BOM file read as UTF-8: the Chinese is intact
    expect(ran.file).toMatch(/install-agend-[0-9a-f]{32}\.ps1$/);
    expect(c.out).toContain("the installer ended with code 7");
    expect(readdirSync(c.dir).filter(f => f.startsWith("install-agend-"))).toEqual([]);   // the temporary copy is gone
  });

  it("AGEND_INSTALL_FORCE=1 passes -Force", async () => {
    expect(ranOf(await caseRun("force"))).toMatchObject({ force: true });
  });

  it("something that is not the installer (an error page) is never run", async () => {
    const c = await caseRun("html");
    expect(ranOf(c)).toBeNull();
    expect(c.out).toContain("is not the AgEnD installer");
    expect(c.out).toContain("SESSION-GOES-ON");
  });

  it("a failed download says so and runs nothing", async () => {
    const c = await caseRun("404");
    expect(ranOf(c)).toBeNull();
    expect(c.out).toContain("the download failed");
    expect(c.out).toContain("SESSION-GOES-ON");
  });

  it("an address that is not https (or this machine) is refused", async () => {
    const c = await caseRun("not-https");
    expect(c.out).toContain("refusing to download the installer from http://example.com");
    expect(existsSync(c.stubOut)).toBe(false);
    expect(c.out).toContain("SESSION-GOES-ON");
  });
});
