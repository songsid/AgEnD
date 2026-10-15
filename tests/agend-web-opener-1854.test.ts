/**
 * #1854 rank 10: `agend web` (and `agend view`) open a browser with an optional opener — xdg-open on Linux, which a
 * server or WSL may not have. The spawn failure arrives as an `error` event; unhandled, it crashed the command right
 * after it printed the sign-in page and code. The printed link and code must stay usable: exit 0, one hint line.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "linux")("agend web / view without a browser opener (#1854)", () => {
  let home: string;
  let bin: string;
  let server: Server;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "agend-web-opener-"));
    bin = mkdtempSync(join(tmpdir(), "agend-web-opener-bin-"));
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/auth/issue-code") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "ABCD-2345", expiresAt: Date.now() + 5 * 60_000 }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server port");
    writeFileSync(join(home, "fleet.yaml"), `health_port: ${address.port}\ninstances: {}\n`);
    writeFileSync(join(home, "web.token"), "a".repeat(48));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  // PATH is only `bin`: no xdg-open unless a test puts one there.
  function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
        env: { ...process.env, AGEND_HOME: home, PATH: bin, NOTIFY_SOCKET: "" },
        timeout: 8_000,
      }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
      });
    });
  }

  it("agend web: no opener → the page and code are printed, one hint, exit 0", async () => {
    const { code, stdout, stderr } = await runCli(["web"]);
    expect(stdout).toMatch(/Sign-in page: http:\/\/localhost:\d+\/signin/);
    expect(stdout).toContain("ABCD-2345");
    expect(stderr).toContain("Could not open a browser (xdg-open: ENOENT). Open the link above yourself.");
    expect(stderr).not.toMatch(/Unhandled|at ChildProcess/);
    expect(code).toBe(0);
  });

  it("agend view: no opener → the URL is printed, one hint, exit 0", async () => {
    const { code, stdout, stderr } = await runCli(["view"]);
    expect(stdout).toMatch(/Opening http:\/\/localhost:\d+\/view/);
    expect(stderr).toContain("Could not open a browser (xdg-open: ENOENT).");
    expect(code).toBe(0);
  });

  it("agend web: an opener that exists still gets the sign-in page, and no hint is printed", async () => {
    const seen = join(home, "opened.txt");
    writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s' "$1" > '${seen}'\n`);
    chmodSync(join(bin, "xdg-open"), 0o755);
    const { code, stdout, stderr } = await runCli(["web"]);
    expect(code).toBe(0);
    expect(stdout).toContain("ABCD-2345");
    expect(stderr).not.toContain("Could not open a browser");
    await expect.poll(() => { try { return readFileSync(seen, "utf8"); } catch { return ""; } })
      .toMatch(/^http:\/\/localhost:\d+\/signin$/);
  });
});
