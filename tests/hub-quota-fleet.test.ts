import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("../src/usage/usage-api.js", async original => ({ ...await original<typeof import("../src/usage/usage-api.js")>(), getUsageSnapshot: vi.fn() }));
import { getUsageSnapshot } from "../src/usage/usage-api.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { readPauseReason, writePausedMarker } from "../src/pause-marker.js";

const snapshot = vi.mocked(getUsageSnapshot), homes: string[] = [];
afterEach(() => { homes.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); vi.restoreAllMocks(); snapshot.mockReset(); });
function manager() {
  const home = mkdtempSync(join(tmpdir(), "agend-hub-quota-")); homes.push(home);
  const fm = Object.create(FleetManager.prototype) as any;
  fm.fleetConfig = { defaults: {}, instances: { agent: { backend: "codex", backend_options: { codex: { credential_profile: "work" } } } } };
  fm.lifecycle = { isPaused: () => false, daemons: new Map() }; fm.getInstanceDir = () => home;
  return { fm, home };
}
describe("fleet quota uses the representative's provider and login", () => {
  it("uses the exact CLI/profile row and keeps other accounts' usage private", async () => {
    const { fm } = manager();
    snapshot.mockResolvedValue({ fetchedAt: new Date().toISOString(), providers: [
      { id: "codex", name: "host", status: "ok", metrics: [{ type: "percent", label: "5h", used: 100 }] },
      { id: "codex:work", name: "private name", status: "ok", metrics: [{ type: "percent", label: "5h", used: 81 }] },
      { id: "claude:work", name: "other CLI", status: "ok", metrics: [{ type: "percent", label: "5h", used: 1 }] },
    ] });
    expect(await fm.hubAgentQuota("agent")).toEqual({ band: "near_limit" });
    expect(snapshot).toHaveBeenCalledWith(false, new Set(["codex:work"]));
    snapshot.mockResolvedValue({ fetchedAt: "now", providers: [] });
    expect(await fm.hubAgentQuota("agent")).toEqual({ band: "unknown" });
  });
  it("never reads Linux usage for a Windows runner or removed representative", async () => {
    const { fm } = manager();
    fm.fleetConfig.instances.agent.runtime = "windows";
    expect(await fm.hubAgentQuota("agent")).toEqual({ band: "unknown" });
    expect(await fm.hubAgentQuota("missing")).toEqual({ band: "unknown" });
    delete fm.fleetConfig.instances.agent;
    expect(await fm.hubAgentQuota("agent")).toEqual({ band: "unknown" });
    expect(snapshot).not.toHaveBeenCalled();
  });
  it("rechecks the binding across a usage read", async () => {
    const { fm } = manager();
    snapshot.mockImplementationOnce(async () => {
      fm.fleetConfig.instances.agent.backend_options.codex.credential_profile = "personal";
      return { fetchedAt: "now", providers: [{ id: "codex:work", name: "private", status: "ok", metrics: [{ type: "percent", label: "5h", used: 91 }] }] };
    });
    expect(await fm.hubAgentQuota("agent")).toEqual({ band: "unknown" });
  });
  it("a durable quota pause wins when the usage provider fails; a model error pause does not", async () => {
    const { fm, home } = manager(); fm.lifecycle.isPaused = () => true;
    snapshot.mockRejectedValue(new Error("unreadable"));
    writePausedMarker(home, Date.now(), "quota"); expect(readPauseReason(home)).toBe("quota");
    expect(await fm.hubAgentQuota("agent")).toEqual({ band: "exhausted" });
    writePausedMarker(home, Date.now(), "error");
    expect(await fm.hubAgentQuota("agent")).toEqual({ band: "unknown" });
  });
  it("reads the daemon's current quota pause and clears it at a reset", () => {
    const daemon = Object.create(Daemon.prototype) as any;
    daemon.usagePauseNotice = { at: performance.now(), when: "private", resetAt: Date.now() + 60_000 };
    expect(daemon.quotaPaused()).toBe(true);
    daemon.usagePauseNotice.resetAt = Date.now() - 1;
    expect(daemon.quotaPaused()).toBe(false);
    daemon.usageLimitHold = { model: "private", since: Date.now() };
    expect(daemon.quotaPaused()).toBe(true);
    daemon.usageLimitHold = null; daemon.usagePauseNotice = null;
    expect(daemon.quotaPaused()).toBe(false);
  });
});
