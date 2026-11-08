/** #3212: FleetManager builds a named account's transport with its backend and this host's data dir — what makes a profile launch land in that profile's folder. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => vi.fn((_options?: unknown) => ({ start: async () => {}, capture: async () => "", status: async () => ({ alive: false }), write: async () => {}, close: async () => {} })));
vi.mock("../src/structured-signin-transport.js", async (original) => ({ ...(await original<typeof import("../src/structured-signin-transport.js")>()), createStructuredSignInTransport: factory }));
import { FleetManager } from "../src/fleet-manager.js";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; factory.mockClear(); });
it("a named account's transport is created for its backend and this host's data dir; the default account's is not given either", () => {
  dir = mkdtempSync(join(tmpdir(), "agend-profile-wiring-"));
  const fm = new FleetManager(dir) as any;
  fm.profileSignIns.deps.transport({ backend: "claude-code", profile: "CHY" });
  expect(factory).toHaveBeenCalledTimes(1); expect(factory.mock.calls[0]![0]).toEqual({ backend: "claude-code", dataDir: dir });
  fm.browserBackendSignIns.deps.transport("claude-code");
  expect(factory).toHaveBeenCalledTimes(2); expect(factory.mock.calls[1]![0]).toBeUndefined();
});
