/**
 * #1854 rank 10: `agend web` (and `agend view`) open a browser with an optional opener — xdg-open on Linux, which a
 * server or WSL may not have. The spawn failure arrives as an `error` event; unhandled, it crashed the command right
 * after it printed the sign-in page and code. The printed link and code must stay usable: exit 0, one hint line.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "linux")("agend web / view without a browser opener (#1854)", () => {
  let home: string;
  let bin: string;
  let server: Server;
  const deliveries: Array<string | undefined> = [];

  beforeEach(async () => {
    deliveries.length = 0;
    home = mkdtempSync(join(tmpdir(), "agend-web-opener-"));
    bin = mkdtempSync(join(tmpdir(), "agend-web-opener-bin-"));
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/auth/issue-code") {
        deliveries.push(req.headers["x-agend-code-delivery"] as string | undefined);
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
  function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
        env: { ...process.env, AGEND_HOME: home, PATH: bin, NOTIFY_SOCKET: "", WSL_DISTRO_NAME: "", WSL_INTEROP: "", AGEND_WSL: "0", ...env },
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

  // The opener's whole argv goes to a file, and the launch file it was given is copied while it still exists.
  function recordingOpener(): { argv: string; copy: string } {
    const argv = join(home, "opened.txt"), copy = join(home, "launch-copy.html");
    writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s' "$*" > '${argv}'\n/bin/cat "\${1#file://}" > '${copy}'\n`);
    chmodSync(join(bin, "xdg-open"), 0o755);
    return { argv, copy };
  }
  const read = (path: string) => () => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

  it("agend web: the browser is opened on a 0600 launch file — the code is in the file, in no command line (#3270)", async () => {
    const { argv, copy } = recordingOpener();
    const { code, stdout, stderr } = await runCli(["web"]);
    expect(code).toBe(0);
    expect(stdout).toContain("ABCD-2345");
    expect(stderr).not.toContain("Could not open a browser");
    await expect.poll(read(argv)).toMatch(/^file:\/\/\/.+\/signin-launch\/agend-signin-[0-9a-f]+\.html$/);
    const opened = readFileSync(argv, "utf8");
    expect(opened).not.toMatch(/ABCD|2345|code=|#/);
    await expect.poll(read(copy)).toContain('location.replace("http://localhost:');
    expect(readFileSync(copy, "utf8")).toMatch(/\/signin#code=ABCD-2345"\);<\/script>/);
    // The terminal still gets the clean address; only the launch file carries the code.
    expect(stdout).toMatch(/Sign-in page: http:\/\/localhost:\d+\/signin\n/);
    expect(stdout).not.toContain("#code=");
    // A code that goes into a URL is asked for as one: the ordinary lifetime, never the first-install one.
    expect(deliveries).toEqual(["url"]);
    // …and the file is a 0600 one that a detached helper deletes after SIGNIN_LAUNCH_FILE_TTL_MS (the delay and the helper
    // are covered in signin-launch-cleanup-3270.test.ts; waiting out a real 45 s here would only slow the suite).
    const file = decodeURIComponent(new URL(opened).pathname);
    if (process.platform !== "win32") expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(existsSync(file)).toBe(true);
  }, 20_000);

  it("agend web on WSL: the clean address is opened (the code never reaches a Windows command line) and the code is printed", async () => {
    const { argv } = recordingOpener();
    const { code, stdout } = await runCli(["web"], { AGEND_WSL: "1" });
    expect(code).toBe(0);
    expect(stdout).toContain("ABCD-2345");
    await expect.poll(read(argv)).toMatch(/^http:\/\/localhost:\d+\/signin$/);
    expect(existsSync(join(home, "signin-launch"))).toBe(false);
    // Nothing goes into a URL on WSL — the person types the printed code — so it may be the 24 h first-install one: no `url` header.
    expect(deliveries).toEqual([undefined]);
  });

  it("agend web --code: prints the page and code, opens nothing", async () => {
    const seen = join(home, "opened.txt");
    writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s' "$1" > '${seen}'\n`);
    chmodSync(join(bin, "xdg-open"), 0o755);
    const { code, stdout } = await runCli(["web", "--code"]);
    expect([code, stdout.includes("ABCD-2345"), stdout.includes("#code=")]).toEqual([0, true, false]);
    await new Promise(r => setTimeout(r, 300));
    expect(() => readFileSync(seen, "utf8")).toThrow();
    expect(deliveries).toEqual([undefined]);                       // a printed code may be the first-install one
    expect(existsSync(join(home, "signin-launch"))).toBe(false);
  });

  it("agend web: a 24 h first-install code is described in hours", async () => {
    server.removeAllListeners("request");
    server.on("request", (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: "ABCD-2345", expiresAt: Date.now() + 24 * 3_600_000, bootstrap: true })); });
    const { stdout } = await runCli(["web", "--code"]);
    expect(stdout).toContain("(works once, valid ~24 h)");
  });
});
