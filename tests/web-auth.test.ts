import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { loadOrCreateWebToken } from "../src/web-auth.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-web-auth-"));
  tempDirs.push(dir);
  return dir;
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("missing TCP address"));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistent dashboard token", () => {
  it("creates a 0600 token once and reuses it across restarts", () => {
    const dir = tempDir();
    const first = loadOrCreateWebToken(dir);
    const second = loadOrCreateWebToken(dir);

    expect(first).toMatch(/^[0-9a-f]{48}$/);
    expect(second).toBe(first);
    expect(readFileSync(join(dir, "web.token"), "utf8")).toBe(first);
    expect(statSync(join(dir, "web.token")).mode & 0o777).toBe(0o600);
  });

  it("replaces an invalid persisted token", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "web.token"), "not-a-token", { mode: 0o644 });

    const token = loadOrCreateWebToken(dir);

    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(token).not.toBe("not-a-token");
    expect(statSync(join(dir, "web.token")).mode & 0o777).toBe(0o600);
  });

  it("uses live readiness and token state instead of reading a stale file", () => {
    const access = { ready: false, token: "a".repeat(48) };
    const commands = new TopicCommands({
      fleetConfig: { health_port: 19280, hostname: "fleet.example" },
      getDashboardAccess: () => access,
    } as any);

    expect(commands.getDashboardText()).toContain("Dashboard starting");
    expect(commands.getDashboardText()).not.toContain(access.token);

    access.ready = true;
    expect(commands.getDashboardText()).toContain(`http://fleet.example:19280/ui?token=${access.token}`);
  });

  it("stays unavailable and notifies General when the health port remains occupied", async () => {
    const blocker = createServer();
    const port = await listen(blocker);
    const fm = new FleetManager(tempDir());
    const notifyFleetError = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});

    (fm as any).initializeWebAuthTokens();
    (fm as any).startHealthServer(port);

    expect(fm.getDashboardAccess().ready).toBe(false);
    await vi.waitFor(() => expect(notifyFleetError).toHaveBeenCalledWith(
      expect.stringContaining("Dashboard unavailable"),
    ), { timeout: 4_000, interval: 25 });
    expect(fm.getDashboardAccess().ready).toBe(false);
    expect(fm.topicCommands.getDashboardText()).toContain("Dashboard starting");

    const failedServer = (fm as any).healthServer as Server | null;
    failedServer?.removeAllListeners();
    (fm as any).healthServer = null;
    await close(blocker);
  });
});
