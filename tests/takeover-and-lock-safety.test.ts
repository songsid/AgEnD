import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFleetLock, isFleetStartCommandLine, readProcessCommandLine } from "../src/fleet-lock.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
const servers: Server[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-takeover-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(r => server.close(() => r()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end("holder"); });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

describe("the health-port takeover", () => {
  it("does not signal a pid whose command line is not an AgEnD fleet", async () => {
    // fleet.pid is a claim, not proof. A stale entry names whatever now holds
    // that pid — and this used to SIGTERM it because a port was busy.
    const dir = tempDir();
    const { port } = await listen();
    writeFileSync(join(dir, "fleet.yaml"), "instances: {}\n");
    writeFileSync(join(dir, "fleet.pid"), String(process.pid === 1 ? 2 : 1));
    const fm = new FleetManager(dir);
    fm.loadConfig(join(dir, "fleet.yaml"));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const warn = vi.fn();
    fm.logger = { info: () => {}, warn, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}, child: () => fm.logger } as never;
    (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();

    (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(port);
    await vi.waitFor(() => expect(warn.mock.calls.flat().join(" ")).toContain("not signalling it"), { timeout: 4_000 });

    // Only the liveness probe (signal 0) is allowed; nothing may be terminated.
    for (const call of kill.mock.calls) expect(call[1]).not.toBe("SIGTERM");
    const server = (fm as unknown as { healthServer: Server | null }).healthServer;
    server?.removeAllListeners();
    (fm as unknown as { healthServer: Server | null }).healthServer = null;
  }, 10_000);

  it("still takes over from a real fleet process", async () => {
    const dir = tempDir();
    const { port } = await listen();
    writeFileSync(join(dir, "fleet.yaml"), "instances: {}\n");
    writeFileSync(join(dir, "fleet.pid"), "424242");
    const fm = new FleetManager(dir);
    fm.loadConfig(join(dir, "fleet.yaml"));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const info = vi.fn();
    fm.logger = { info, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}, child: () => fm.logger } as never;
    (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
    // The pid really is a fleet.
    vi.spyOn(await import("../src/fleet-lock.js"), "readProcessCommandLine")
      .mockReturnValue("node /usr/lib/agend/cli.js fleet start");

    (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(port);
    await vi.waitFor(() => expect(info.mock.calls.flat().join(" ")).toContain("Killed old fleet process"), { timeout: 4_000 });

    expect(kill.mock.calls.some(call => call[0] === 424242 && call[1] === "SIGTERM")).toBe(true);
    const server = (fm as unknown as { healthServer: Server | null }).healthServer;
    server?.removeAllListeners();
    (fm as unknown as { healthServer: Server | null }).healthServer = null;
  }, 10_000);

  it("reads a real command line, and says nothing when it cannot", () => {
    expect(readProcessCommandLine(process.pid)).toContain("node");
    // A pid that cannot exist: an empty answer is "cannot confirm".
    expect(readProcessCommandLine(0)).toBe("");
    expect(isFleetStartCommandLine("")).toBe(false);
  });
});

describe("fleet.lock keeps the two kinds of process apart", () => {
  const alive = () => true;

  it("refuses a setup host while a fleet holds the lock", () => {
    const dir = tempDir();
    acquireFleetLock(dir, { pid: 4242, nonce: "fleet", isProcessAlive: alive, readCommandLine: () => "node cli.js fleet start" });

    expect(() => acquireFleetLock(dir, {
      pid: 4243, role: "setup-host", isProcessAlive: alive,
      readCommandLine: () => "node cli.js fleet start",
    })).toThrow(/already running/);
  });

  it("refuses a fleet while a setup host holds the lock", () => {
    // The direction that was missing: a host's command line is not `fleet
    // start`, so a starting fleet read the lock as stale and took it — then
    // collided with the host on the health port.
    const dir = tempDir();
    acquireFleetLock(dir, { pid: 5555, role: "setup-host", isProcessAlive: alive, readCommandLine: () => "node setup-host.js" });

    expect(() => acquireFleetLock(dir, {
      pid: 6666, isProcessAlive: alive,
      readCommandLine: pid => pid === 5555 ? "node setup-host.js" : "node cli.js fleet start",
    })).toThrow(/Setup is already running/);
  });

  it("records the role, defaulting to fleet", () => {
    const dir = tempDir();
    acquireFleetLock(dir, { pid: 1234 });

    expect(JSON.parse(readFileSync(join(dir, "fleet.lock"), "utf8"))).toMatchObject({ role: "fleet" });
  });

  it("treats a record written before the field existed as a fleet", () => {
    // Backward compatibility, in the safe direction: an old lock keeps being
    // protected by the command-line check rather than becoming takeable.
    const dir = tempDir();
    writeFileSync(join(dir, "fleet.lock"), JSON.stringify({ pid: 7777, nonce: "old", createdAt: "2026-01-01" }) + "\n");

    expect(() => acquireFleetLock(dir, {
      pid: 8888, isProcessAlive: alive, readCommandLine: () => "node cli.js fleet start",
    })).toThrow(/Fleet is already running/);
  });

  it("still reclaims a lock whose owner is gone", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "fleet.lock"), JSON.stringify({ pid: 9999, nonce: "dead", role: "setup-host", createdAt: "2026-01-01" }) + "\n");

    const handle = acquireFleetLock(dir, { pid: 1010, isProcessAlive: () => false, readCommandLine: () => "" });

    expect(handle.record.pid).toBe(1010);
  });
});
