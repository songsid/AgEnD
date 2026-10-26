/**
 * Stage 5 opened the setup page the instant WSL printed it; the browser on Windows showed ERR_CONNECTION_RESET (live,
 * 2026-10-26) — WSL's localhost relay had not picked up the new listener yet. The installer now waits, briefly, for any
 * HTTP answer from Windows' side before opening it. Run here against a real local server and a closed port.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
let hasPwsh = false;
beforeAll(() => { try { execFileSync("pwsh", ["-NoProfile", "-Command", "1"], { stdio: "ignore" }); hasPwsh = true; } catch { hasPwsh = false; } });
const dirs: string[] = [], servers: Server[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); for (const s of servers.splice(0)) s.close(); });

function reach(url: string, seconds: number): Promise<{ out: string; ms: number }> {
  const dir = mkdtempSync(join(tmpdir(), "agend-reach-")); dirs.push(dir);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Wait-SetupPageReachable' }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
Write-Output ('REACHABLE=' + (Wait-SetupPageReachable '${url}' ${seconds}))`);
  const started = Date.now();
  return new Promise(resolve => {
    const p = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `& '${script}'`]);
    let out = ""; p.stdout.on("data", d => { out += d; }); p.stderr.on("data", d => { out += d; });
    p.on("close", () => resolve({ out, ms: Date.now() - started }));
  });
}
const listen = (handler: RequestListener) => new Promise<number>(resolve => {
  const s = createServer(handler); servers.push(s); s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
});

describe("stage 5 opens the setup page only once Windows can reach it", () => {
  it("any HTTP answer counts, a 404 included (a page under a sid answers its own way)", async () => {
    if (!hasPwsh) return;
    const port = await listen((_req, res) => { res.writeHead(404); res.end(); });
    const r = await reach(`http://127.0.0.1:${port}/s/abc/`, 10);
    expect(r.out).toContain("REACHABLE=True");
  });

  it("a listener that appears a moment later is waited for", async () => {
    if (!hasPwsh) return;
    const probe = createServer(); await new Promise<void>(r => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as { port: number }).port; probe.close();
    const pending = reach(`http://127.0.0.1:${port}/s/abc/`, 15);
    await new Promise(r => setTimeout(r, 2500));
    const s = createServer((_req, res) => { res.writeHead(200); res.end("ok"); }); servers.push(s);
    await new Promise<void>(r => s.listen(port, "127.0.0.1", () => r()));
    const r = await pending;
    expect(r.out).toContain("REACHABLE=True");
  }, 30_000);

  it("never reachable: false after its bound, not before", async () => {
    if (!hasPwsh) return;
    const probe = createServer(); await new Promise<void>(r => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as { port: number }).port; probe.close();
    const r = await reach(`http://127.0.0.1:${port}/`, 3);
    expect(r.out).toContain("REACHABLE=False");
    expect(r.ms).toBeGreaterThanOrEqual(3000);
  }, 30_000);
});
