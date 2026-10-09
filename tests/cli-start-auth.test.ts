import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideWebGate } from "../src/web-auth.js";

describe("CLI instance start authentication (#1016)", () => {
  const token = "a".repeat(48);
  let dataDir: string;
  let server: Server;
  let healthStatus: number;
  let requests: Array<{ method: string; url: string; token: string | string[] | undefined; status: number }>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "agend-cli-start-auth-"));
    healthStatus = 200;
    requests = [];
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(healthStatus).end();
        return;
      }
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const decision = decideWebGate(req, url, token, null);   // the CLI uses the header token; no browser session store
      const status = decision.kind === "allow" ? 200 : decision.kind === "reject" ? decision.status : 400;
      requests.push({ method: req.method!, url: req.url!, token: req.headers["x-agend-token"], status });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(decision.kind === "allow" ? { ok: true } : {
        error: decision.kind === "reject" ? decision.message : "unexpected token exchange",
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server port");
    writeFileSync(join(dataDir, "fleet.yaml"), `health_port: ${address.port}\ninstances: {}\n`);
  });

  afterEach(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
        // The instance form against this test's own mock fleet (the test process guard refuses it otherwise: with no
        // fleet answering it would fall through to starting one).
        env: { ...process.env, AGEND_HOME: dataDir, NOTIFY_SOCKET: "", AGEND_TEST_ALLOW_INSTANCE_START: "1" },
        timeout: 8_000,
      }, (error, stdout, stderr) => {
        if (!error) resolve({ code: 0, stdout, stderr });
        else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
        else reject(error);
      });
    });
  }

  it.each([
    { command: ["fleet", "start"], health: 200 },
    { command: ["fleet", "start"], health: 503 },
  ])("authenticates $command against a running fleet with health=$health", async ({ command, health }) => {
    healthStatus = health;
    writeFileSync(join(dataDir, "web.token"), `${token}\n`, { mode: 0o600 });
    const instance = "worker / 測試";

    const result = await runCli([...command, instance]);

    // Use the production gate: removing the CLI header makes this a real 401.
    expect(requests.map(request => request.status)).toEqual([200]);
    expect(requests).toEqual([{
      method: "POST", url: `/api/instance/${encodeURIComponent(instance)}/start`, token, status: 200,
    }]);
    expect(result).toEqual({ code: 0, stdout: `Instance "${instance}" started via running fleet daemon\n`, stderr: "" });
    expect(existsSync(join(dataDir, "fleet.pid"))).toBe(false);
  });

  it.each(["missing", "invalid"])("reports the gate's 401 when the token is %s without starting another fleet", async state => {
    if (state === "invalid") writeFileSync(join(dataDir, "web.token"), "b".repeat(48), { mode: 0o600 });

    const result = await runCli(["fleet", "start", "worker"]);

    expect(requests.map(request => request.status)).toEqual([401]);
    expect(requests[0].token).toBe(state === "invalid" ? "b".repeat(48) : undefined);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Start failed:");
    expect(result.stdout).toBe("");
    expect(existsSync(join(dataDir, "fleet.pid"))).toBe(false);
    expect(existsSync(join(dataDir, "web.token"))).toBe(state === "invalid");
  });
});
