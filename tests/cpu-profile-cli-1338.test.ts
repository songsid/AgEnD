import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// Production command callback; all process/IO/lifecycle seams are inert.
// Never import the self-executing CLI or construct the real FleetManager.
function harness() {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const prefix = "  .action(async (instance?: string) => {";
  const begin = source.indexOf(prefix, source.indexOf(".description(\"Start fleet or specific instance\")"));
  const end = source.indexOf("\n  });\n\nfleet\n  .command(\"stop\")", begin);
  if (begin < 0 || end < 0) throw new Error("CLI callback boundary changed; update the harness");
  const callback = source.slice(begin + "  .action(".length, end) + "\n  }";
  const script = ts.transpileModule(`const action = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('import("./fleet-manager.js")', "loadFleetManager()")
    .replaceAll('import("./config.js")', "loadConfigModule()");
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const order: string[] = [];
  let profileReady = false;
  const stop = vi.fn(async () => { order.push("profile.stop"); return null; });
  const startProfile = vi.fn(async () => { order.push("profile.start"); profileReady = true; return { stop }; });
  const manager = {
    startCpuProfileControl: vi.fn(async () => {}),
    startSettingsConfirmationControl: vi.fn(async () => {}),
    startEnvironmentCpuProfile: startProfile,
    startAll: vi.fn(async () => { order.push("fleet.start"); }),
    startInstance: vi.fn(async () => { order.push("instance.start"); }),
    // FleetManager owns env and runtime profiles; its shared shutdown stops
    // the active handle before resource disposal. The CLI must enter it first.
    stopAll: vi.fn(async () => { if (profileReady) { profileReady = false; await stop(); } order.push("fleet.stop"); }),
    loadConfig: vi.fn(() => ({ instances: { example: {} }, channel: { mode: "topic" } })),
    notifyFleetError: vi.fn(),
  };
  const process = { env: {}, getuid: () => 1000, on: (name: string, action: (...args: unknown[]) => unknown) => events.set(name, action), exit: vi.fn() };
  const context = createContext({
    process, console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, DATA_DIR: "/private-unused", FLEET_CONFIG_PATH: "/private-unused/fleet.yaml",
    claimFleetSingleton: vi.fn(() => true), startCpuProfileFromEnvironment: startProfile,
    loadFleetManager: async () => ({ FleetManager: class { constructor() { return manager; } } }),
    loadConfigModule: async () => ({ loadFleetConfig: () => ({ health_port: 1 }) }),
    fetch: vi.fn(async () => { throw new Error("No network (cold startup fixture)"); }), describeSignalSource: () => "test signal", Promise,
  });
  runInContext(script, context);
  const action = runInContext("action", context) as (instance?: string) => Promise<void>;
  return { action, events, order, startProfile, stop, manager, process, context };
}
afterEach(() => vi.restoreAllMocks());

describe("real fleet-start callback with fully stubbed effects", () => {
  it.each([undefined, "example"])("profiles the cold startup %s path and stops before fleet disposal", async instance => {
    const h = harness(); await h.action(instance);
    expect(h.manager.startCpuProfileControl).toHaveBeenCalledTimes(1);
    expect(h.startProfile).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["profile.start", instance ? "instance.start" : "fleet.start"]);
    await h.events.get("SIGINT")!();
    expect(h.order.slice(-2)).toEqual(["profile.stop", "fleet.stop"]); expect(h.process.exit).toHaveBeenCalledWith(0);
    await h.events.get("SIGINT")!(); expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it("does not start a fleet after shutdown supersedes an in-flight profile start", async () => {
    const h = harness(); let resolve!: (value: { stop: typeof h.stop }) => void;
    let markStarted!: () => void; const started = new Promise<void>(r => { markStarted = r; });
    h.startProfile.mockImplementation(() => new Promise(r => { resolve = r; markStarted(); }));
    const pending = h.action(); await started;
    expect(h.manager.startCpuProfileControl).toHaveBeenCalledTimes(1);
    expect(h.startProfile).toHaveBeenCalledTimes(1); await h.events.get("SIGINT")!();
    resolve({ stop: h.stop }); await pending;
    expect(h.stop).toHaveBeenCalledWith("startup superseded by shutdown");
    expect(h.manager.startAll).not.toHaveBeenCalled(); expect(h.manager.startInstance).not.toHaveBeenCalled();
  });

  it("the uncaught-exception handler uses the shared shutdown before disposing the fleet", async () => {
    const h = harness(); await h.action(); h.events.get("uncaughtException")!(new Error("fake"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.manager.stopAll).toHaveBeenCalledTimes(1); expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.order.slice(-2)).toEqual(["profile.stop", "fleet.stop"]);
  });
});
