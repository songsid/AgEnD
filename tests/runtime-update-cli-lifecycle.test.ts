import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeMain } from "../src/runtime-cli.js";
import { RuntimeClient } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
afterEach(() => vi.restoreAllMocks());
it("owns its stop handler before asynchronous client startup and removes it on completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "agend-update-cli-start-")), profile = join(home, "profile");
  const before = new Set(process.listeners("SIGTERM")); let release!: () => void;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const starting = new Promise<void>(done => { release = done; });
  const start = vi.spyOn(RuntimeClient.prototype, "start").mockReturnValue(starting);
  const stop = vi.spyOn(RuntimeClient.prototype, "stop").mockImplementation(async () => { release(); });
  vi.spyOn(RuntimeClient.prototype, "waitUntilStopped").mockResolvedValue();
  new RuntimeClientStore(profile).saveCredentials({ server: "http://127.0.0.1:19280", name: "Fixture", machineId: "12345678-1234-4321-abcd-123456789012", credential: "a".repeat(64) });
  // Only the CLI platform dispatch is stubbed; start/stop are inert methods, never Windows execution.
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  const running = runtimeMain(["run", "--profile", profile], { home, programDirectory: home }); void running.catch(() => {});
  try {
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const handlers = process.listeners("SIGTERM").filter(handler => !before.has(handler));
    expect(handlers).toHaveLength(1); handlers[0]("SIGTERM");
    await running; expect(stop).toHaveBeenCalledOnce();
    expect(process.listeners("SIGTERM").filter(handler => !before.has(handler))).toEqual([]);
  } finally { release(); try { await running; } finally { Object.defineProperty(process, "platform", platform); rmSync(home, { recursive: true, force: true }); } }
});
