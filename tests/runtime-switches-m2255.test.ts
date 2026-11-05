/**
 * M-2255 (the user, hmsg-71c25c9b; user story #2953 1.1 / 1.8 / 2.1): the Windows runtimes are switched on in Settings →
 * Runtime — "Use this PC's Windows CLIs" (runtimes.windows_cli) and "Allow other Windows PCs to pair"
 * (runtimes.remote_runtime) — and the per-PC limit (runtimes.max_agents_per_machine, 1..16, default 4) is set there.
 *  - fleet.yaml keys with the validator and loader; off by default;
 *  - the environment stays an override ("1" on, "0" off) and Settings says so; it cannot be changed there then;
 *  - the save model of the other access settings: on waits for a fleet admin's confirmation, off applies at once, the
 *    limit applies at once either way; never over the public link;
 *  - every gate reads the switch in force: this PC's Windows process starts only while its switch is on, a local
 *    Windows agent follows this PC's switch and a paired PC's agent the other switch; the fleet applies a saved change
 *    without a restart (paired PCs disconnected, this PC's Windows process closed, agents registered when turned on).
 * The real classifier, effect projection, confirmation gate, handler, loader, validator and FleetManager save.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { loadFleetConfigSource } from "../src/config.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { RUNTIME_READ_FLEET_KEYS } from "../src/fleet-level-config.js";
import { FleetManager } from "../src/fleet-manager.js";
import {
  localWindowsCliEnabled, maxAgentsPerMachine, parseRuntimesSettingsBody, remoteRuntimeEnabled, runtimeSettingsView, runtimeSwitchState,
  setConfiguredRuntimeSwitches,
} from "../src/runtime-switches.js";
import { LOCAL_WINDOWS_CLI_OFF, windowsBridgeFor, windowsCliEnabled } from "../src/windows-cli.js";
import { handleRuntimeRequest, type RuntimeApiContext } from "../src/runtime-api.js";
import { RUNTIME_BUNDLE_MODULES } from "../src/runtime-bundle.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { guestRouteDecision } from "../src/web-guest-access.js";
import { FleetWindowsRuntime } from "../src/fleet-windows-runtime.js";
import { WindowsAgents } from "../src/windows-agents.js";
import { WebChatHistory } from "../src/web-chat-history.js";
import type { FleetConfig } from "../src/types.js";
import type { WindowsCliBridge } from "../src/windows-cli.js";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
  rotateLogIfNeeded: () => { throw new Error("log rotation is outside this harness"); },
  rotateLogIfNeededAsync: async () => { throw new Error("log rotation is outside this harness"); },
}));
// Nothing here may start a process: a Windows launch reaching spawn fails the test.
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("process execution is outside this harness"); };
  return { ...original, spawn: blocked, spawnSync: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked };
});

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
const scratch = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir; };
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); setConfiguredRuntimeSwitches(undefined);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("unsafe cleanup"); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
const RUNTIMES = "/api/settings/fleet/runtimes";
const judge = (body: unknown, fleet: Record<string, unknown> = {}) =>
  prepareSettingsEffect("PUT", RUNTIMES, body, { config: { defaults: {}, instances: {}, ...fleet } as any, classic: {} }).diff;

describe("the switches: fleet.yaml, the environment's override, the limit", () => {
  it("off by default; fleet.yaml turns each on; only `true` counts", () => {
    vi.stubEnv("AGEND_WINDOWS_CLI", ""); vi.stubEnv("AGEND_REMOTE_RUNTIME", "");
    expect([localWindowsCliEnabled(), remoteRuntimeEnabled(), windowsCliEnabled(), maxAgentsPerMachine()]).toEqual([false, false, false, 4]);
    setConfiguredRuntimeSwitches({ windows_cli: true });
    expect([localWindowsCliEnabled(), remoteRuntimeEnabled(), windowsCliEnabled()]).toEqual([true, false, true]);
    setConfiguredRuntimeSwitches({ remote_runtime: true, max_agents_per_machine: 7 });
    expect([localWindowsCliEnabled(), remoteRuntimeEnabled(), windowsCliEnabled(), maxAgentsPerMachine()]).toEqual([false, true, true, 7]);
    setConfiguredRuntimeSwitches({ windows_cli: "true", remote_runtime: 1, max_agents_per_machine: 17 });
    expect([localWindowsCliEnabled(), remoteRuntimeEnabled(), maxAgentsPerMachine()]).toEqual([false, false, 4]);
  });
  it("the environment overrides fleet.yaml both ways ('1' on, '0' off) and says so; any other value leaves it to fleet.yaml", () => {
    setConfiguredRuntimeSwitches({ windows_cli: true, remote_runtime: false });
    vi.stubEnv("AGEND_WINDOWS_CLI", "0"); vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
    expect(runtimeSwitchState("windows_cli")).toEqual({ on: false, configured: true, environment: "off" });
    expect(runtimeSwitchState("remote_runtime")).toEqual({ on: true, configured: false, environment: "on" });
    vi.stubEnv("AGEND_WINDOWS_CLI", "true"); vi.stubEnv("AGEND_REMOTE_RUNTIME", "yes");
    expect([runtimeSwitchState("windows_cli"), runtimeSwitchState("remote_runtime")])
      .toEqual([{ on: true, configured: true, environment: null }, { on: false, configured: false, environment: null }]);
  });
  it("the validator and the loader: a mapping of two booleans and a whole number 1..16; anything else is refused and not loaded", () => {
    expect(validateFleetConfig({ defaults: {}, instances: {}, runtimes: { windows_cli: true, remote_runtime: false, max_agents_per_machine: 16 } }).errors).toEqual([]);
    const errors = (runtimes: unknown) => validateFleetConfig({ defaults: {}, instances: {}, runtimes }).errors.map(e => e.path);
    expect(errors({ windows_cli: "yes" })).toEqual(["runtimes.windows_cli"]);
    expect(errors({ max_agents_per_machine: 0 })).toEqual(["runtimes.max_agents_per_machine"]);
    expect(errors({ max_agents_per_machine: 2.5 })).toEqual(["runtimes.max_agents_per_machine"]);
    expect(errors({ max_agents_per_machine: 17 })).toEqual(["runtimes.max_agents_per_machine"]);
    expect(errors({ remote: true })).toEqual(["runtimes.remote"]);
    expect(errors([true])).toEqual(["runtimes"]);
    expect(loadFleetConfigSource("runtimes:\n  windows_cli: true\n  remote_runtime: \"true\"\n  max_agents_per_machine: 6\ninstances: {}\n").runtimes)
      .toEqual({ windows_cli: true, max_agents_per_machine: 6 });
    expect(loadFleetConfigSource("instances: {}\n").runtimes).toBeUndefined();
  });
  it("applied when saved — never a pending restart; each key's impact says so", () => {
    expect(RUNTIME_READ_FLEET_KEYS).toContain("runtimes");
    const fields = JSON.stringify(buildSettingsImpactSchema());
    for (const key of ["runtimes.windows_cli", "runtimes.remote_runtime", "runtimes.max_agents_per_machine"]) expect(fields).toContain(`"${key}":"now"`);
  });
  it("the Windows Runtime ZIP carries the module windows-cli.js now reads", () => {
    expect(RUNTIME_BUNDLE_MODULES).toContain("runtime-switches.js");
    // scripts/build-runtime.mjs takes the same list from runtime-build-info.js (the one place that names the modules), so the portable folder cannot drift from the ZIP.
    expect(readFileSync("scripts/build-runtime.mjs", "utf8")).toContain("RUNTIME_BUNDLE_MODULES");
    expect(readFileSync("src/runtime-build-info.ts", "utf8")).toContain('"runtime-switches.js"');
  });
});

describe("the save model: on is confirmed, off and the limit apply at once", () => {
  it("switching on waits for a fleet admin, each switch named; off applies directly", () => {
    for (const name of ["windows_cli", "remote_runtime"]) {
      const diff = judge({ [name]: true });
      expect([diff?.section, diff?.summary.slice(1)], name).toEqual(["access", [`fleet.runtimes.${name.replace("_", "\\_")}: default → true`]]);
      expect(judge({ [name]: false }, { runtimes: { [name]: true } }), name).toBeNull();
      expect(judge({ [name]: true }, { runtimes: { [name]: true } }), name).toBeNull();
    }
  });
  it("the limit applies at once up or down (it is load, not reach); one loosening in a batch is still confirmed", () => {
    expect(judge({ max_agents_per_machine: 16 })).toBeNull();
    expect(judge({ max_agents_per_machine: 1 }, { runtimes: { max_agents_per_machine: 8 } })).toBeNull();
    expect(judge({ max_agents_per_machine: 2, remote_runtime: true })?.summary.slice(1)).toEqual(["fleet.runtimes.remote\\_runtime: default → true"]);
  });
  it("one parser for the gate and the handler: unknown keys, wrong kinds and out-of-range limits are refused; a switch the environment sets is 409", () => {
    for (const body of [{ windows: true }, { windows_cli: "true" }, { windows_cli: null }, { max_agents_per_machine: 0 }, { max_agents_per_machine: 17 }, { max_agents_per_machine: "4" }, [], null]) {
      expect(parseRuntimesSettingsBody(body), JSON.stringify(body)).toEqual({ error: "invalid_runtimes_settings", status: 400 });
      expect(() => judge(body), JSON.stringify(body)).toThrow();
    }
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
    expect(parseRuntimesSettingsBody({ remote_runtime: false })).toEqual({ error: "runtime_switch_set_by_environment", status: 409 });
    expect(parseRuntimesSettingsBody({ windows_cli: true, max_agents_per_machine: 3 })).toEqual({ patch: { windows_cli: true, max_agents_per_machine: 3 } });
  });
});

function harness(initial: Record<string, unknown> = {}) {
  const root = scratch("agend-m2255-"), path = join(root, "fleet.yaml");
  writeFileSync(path, yaml.dump({ instances: {}, ...initial }));
  const fm = new FleetManager(root) as any;
  fm.loadConfig(path);
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => fm.configPath, config: () => fm.fleetConfig, current: () => 0 });
  const gate = new SettingsHttpConfirmation(store, {
    principal: () => ({ id: "session-a", label: "browser", source: "web_session", current: () => true }),
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  let key = 0;
  async function request(method: "GET" | "PUT", url: string, body?: unknown, opts: { publicLink?: boolean } = {}) {
    return new Promise<{ status: number; body: any }>((done, fail) => {
      const req = new EventEmitter() as any;
      req.method = method; req.url = url; req.headers = { "idempotency-key": `k-${++key}`, cookie: "opaque" }; req.destroy = () => undefined;
      if (opts.publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.example", isCurrent: () => true });
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { done({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, fm);
      try {
        expect(gate.handle(req, res, new URL(url, "http://localhost"), next) || next(req, res, new URL(url, "http://localhost"))).toBe(true);
        queueMicrotask(() => { if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (err) { fail(err); }
    });
  }
  const raw = () => yaml.load(readFileSync(path, "utf8")) as any;
  return { fm, store, request, raw };
}
const admin = () => ({ label: "F", current: () => true });

describe("through the gate and the real handler, on a fleet.yaml on disk", () => {
  it("GET: each switch as saved and in force, the limit with its bounds, and this fleet's local address for the guide", async () => {
    const h = harness({ health_port: 19555, runtimes: { remote_runtime: true, max_agents_per_machine: 2 } });
    vi.stubEnv("AGEND_WINDOWS_CLI", "1");
    const r = await h.request("GET", "/api/settings/runtimes");
    expect([r.status, r.body]).toEqual([200, {
      switches: { windows_cli: { on: true, configured: false, environment: "on" }, remote_runtime: { on: true, configured: true, environment: null } },
      max_agents_per_machine: { value: 2, min: 1, max: 16, default: 4 }, local_origin: "http://127.0.0.1:19555",
    }]);
  });
  it("on: proposed, written to fleet.yaml and in force only once a fleet admin confirms it", async () => {
    const h = harness();
    const r = await h.request("PUT", RUNTIMES, { remote_runtime: true });
    expect([r.status, r.body.result]).toEqual([202, "pending_confirmation"]);
    expect([h.raw().runtimes, remoteRuntimeEnabled()]).toEqual([undefined, false]);
    const outcome = await h.store.decide(r.body.pending_change.id, "confirm", admin());
    expect(outcome.state).toBe("applied");
    expect([h.raw().runtimes, h.fm.fleetConfig.runtimes, remoteRuntimeEnabled()]).toEqual([{ remote_runtime: true }, { remote_runtime: true }, true]);
  });
  it("off and the limit: written at once, in force at once", async () => {
    const h = harness({ runtimes: { windows_cli: true, remote_runtime: true } });
    expect([localWindowsCliEnabled(), remoteRuntimeEnabled()]).toEqual([true, true]);
    const r = await h.request("PUT", RUNTIMES, { windows_cli: false, max_agents_per_machine: 6 });
    expect(r.status).toBe(200);
    expect(r.body.switches.windows_cli).toEqual({ on: false, configured: false, environment: null });
    expect([h.raw().runtimes, localWindowsCliEnabled(), remoteRuntimeEnabled(), maxAgentsPerMachine()])
      .toEqual([{ windows_cli: false, remote_runtime: true, max_agents_per_machine: 6 }, false, true, 6]);
  });
  it("a refused body writes nothing; a switch the environment sets cannot be changed here", async () => {
    const h = harness({ runtimes: { remote_runtime: true } });
    for (const body of [{ remote_runtime: "off" }, { max_agents_per_machine: 99 }, { other: true }]) {
      expect((await h.request("PUT", RUNTIMES, body)).status, JSON.stringify(body)).toBe(400);
    }
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
    expect((await h.request("PUT", RUNTIMES, { remote_runtime: false })).status).toBe(409);
    expect(h.raw().runtimes).toEqual({ remote_runtime: true });
  });
  it("never over the public link: neither the read nor the write (on or off)", async () => {
    const h = harness({ runtimes: { remote_runtime: true } });
    expect((await h.request("GET", "/api/settings/runtimes", undefined, { publicLink: true })).status).toBe(403);
    for (const body of [{ remote_runtime: false }, { windows_cli: true }, { max_agents_per_machine: 2 }]) {
      expect((await h.request("PUT", RUNTIMES, body, { publicLink: true })).status, JSON.stringify(body)).toBe(403);
    }
    expect(h.raw().runtimes).toEqual({ remote_runtime: true });
  });
  it("…and the public link's own manifest never forwards them; a guest is refused both", () => {
    for (const [method, path] of [["GET", "/api/settings/runtimes"], ["PUT", RUNTIMES]]) {
      expect(isPublicWebRoute(method, path), `${method} ${path}`).toBe(false);
      expect(guestRouteDecision(method, new URL(path, "http://localhost"), new Set(["any"])), `${method} ${path}`).toMatchObject({ kind: "deny", status: 403 });
    }
  });
});

describe("every gate reads the switch in force", () => {
  it("this PC's Windows process starts only while its switch is on — whatever else is on — and never reaches spawn", async () => {
    setConfiguredRuntimeSwitches({ remote_runtime: true });
    const owner = { dataDir: scratch("agend-m2255-bridge-") };
    await expect(windowsBridgeFor(owner).probe({ force: true })).rejects.toThrow(LOCAL_WINDOWS_CLI_OFF);
    await expect(windowsBridgeFor(owner).prepareWorkspace("12345678-1234-4321-abcd-123456789012")).rejects.toThrow(LOCAL_WINDOWS_CLI_OFF);
    // A read starts nothing either way (M-2239 P1-2): the last detection, as it was.
    await expect(windowsBridgeFor(owner).probe()).resolves.toMatchObject({ clis: [], probedAt: null });
  });
  it("paired PCs: the runtime API is enabled with the switch on (Settings or environment) and answers 'not enabled' with it off", () => {
    const ctx = { webToken: "t".repeat(48), runtimeCoordinator: () => ({ listMachines: () => [] }) } as unknown as RuntimeApiContext;
    const call = () => {
      const req = new EventEmitter() as any; req.method = "GET"; req.url = "/ui/runtimes"; req.headers = { host: "localhost", "x-agend-token": "t".repeat(48) };
      req.socket = { remoteAddress: "127.0.0.1" };
      let status = 0, text = "";
      const res = { writableEnded: false, destroyed: false, writeHead(code: number) { status = code; }, end(chunk: string) { text = chunk; } } as any;
      handleRuntimeRequest(req, res, new URL("/ui/runtimes", "http://localhost"), ctx);
      return [status, JSON.parse(text).enabled];
    };
    expect(call()).toEqual([200, false]);
    setConfiguredRuntimeSwitches({ remote_runtime: true });
    expect(call()).toEqual([200, true]);
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "0");
    expect(call()).toEqual([200, false]);
  });
  it("a Windows agent on this PC follows this PC's switch, not the other one: stopped, unavailable, its turn refused", async () => {
    setConfiguredRuntimeSwitches({ windows_cli: true });
    const home = scratch("agend-m2255-agents-");
    const start = vi.fn();
    const bridge = { start, get: () => null, hasActiveTask: () => false, prepareWorkspace: async (id: string) => `C:\\Users\\Test\\.agend\\workspaces\\${id}`,
      cancel: vi.fn(), releaseUnknown: vi.fn() } as unknown as WindowsCliBridge;
    const fleet = { defaults: {}, instances: {}, teams: {} } as unknown as FleetConfig;
    const runtime = new FleetWindowsRuntime({ owner: { dataDir: home }, fleet: () => fleet, save: vi.fn(), warn: vi.fn(), removed: vi.fn(), stopping: () => false,
      history: new WebChatHistory(), emit: () => {} }, { store: new WindowsAgents(home, bridge), bridge });
    const { name } = await runtime.create({ name: "Windows helper", cli: "codex", sandbox: "read-only" }, () => true);
    expect([runtime.status(name), runtime.available(name)]).toEqual(["running", true]);
    setConfiguredRuntimeSwitches({ remote_runtime: true });               // this PC off, paired PCs on
    expect([runtime.status(name), runtime.execution(name), runtime.available(name)]).toEqual(["stopped", null, false]);
    await expect(runtime.execute(name, { requestId: "12345678-1234-4321-abcd-123456789012", content: "Hi" })).rejects.toThrow(LOCAL_WINDOWS_CLI_OFF);
    await expect(runtime.create({ name: "Another", cli: "codex", sandbox: "read-only" }, () => true)).rejects.toThrow(LOCAL_WINDOWS_CLI_OFF);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("the fleet applies a saved change without a restart", () => {
  function started(initial: Record<string, unknown>) {
    const h = harness(initial);
    const fm = h.fm;
    fm.runtimeEffects = { windows_cli: localWindowsCliEnabled(), remote_runtime: remoteRuntimeEnabled() };   // as startAll leaves it
    const hub = { close: vi.fn() }; fm.runtimeHub = hub;
    const bridgeClose = vi.spyOn(windowsBridgeFor(fm), "close");
    const init = vi.spyOn(fm, "initializeNativeInstances").mockImplementation(() => {});
    const status = vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});
    return { ...h, hub, bridgeClose, init, status };
  }
  const save = (fm: any, runtimes: Record<string, unknown>) => {
    fm.fleetConfig.runtimes = { ...fm.fleetConfig.runtimes, ...runtimes };
    fm.saveFleetConfig(Object.entries(runtimes).map(([key, value]) => ({ path: ["runtimes", key], value })));
  };
  const tick = () => new Promise<void>(done => setTimeout(done, 0));
  it("paired PCs off: their connections end (the hub closes) — this PC's Windows process is left alone; the page hears it", async () => {
    const s = started({ runtimes: { windows_cli: true, remote_runtime: true } });
    save(s.fm, { remote_runtime: false }); await tick();
    expect([s.hub.close.mock.calls.length, s.fm.runtimeHub, s.bridgeClose.mock.calls.length, s.init.mock.calls.length]).toEqual([1, null, 0, 0]);
    expect(s.status).toHaveBeenCalledWith("status", expect.anything());
  });
  it("this PC off: its Windows process closes (a turn in progress is cancelled) — paired PCs stay connected", async () => {
    const s = started({ runtimes: { windows_cli: true, remote_runtime: true } });
    save(s.fm, { windows_cli: false }); await tick();
    expect([s.bridgeClose.mock.calls.length, s.hub.close.mock.calls.length, s.fm.runtimeHub]).toEqual([1, 0, s.hub]);
  });
  it("on from all off: the Windows agents are registered and their history read, as at start-up; a second save changes nothing", async () => {
    const s = started({});
    save(s.fm, { windows_cli: true }); await tick();
    expect(s.init.mock.calls).toEqual([[], [true]]);
    save(s.fm, { max_agents_per_machine: 3 }); await tick();
    expect([s.init.mock.calls.length, s.hub.close.mock.calls.length, s.bridgeClose.mock.calls.length, maxAgentsPerMachine()]).toEqual([2, 0, 0, 3]);
  });
  it("before the start-up has applied them, a load only sets what the gates read (no effects)", async () => {
    const h = harness({ runtimes: { windows_cli: true } });
    const init = vi.spyOn(h.fm, "initializeNativeInstances").mockImplementation(() => {});
    const bridgeClose = vi.spyOn(windowsBridgeFor(h.fm), "close");
    await tick();                                                        // the load's own observation settles first
    expect([localWindowsCliEnabled(), init.mock.calls.length]).toEqual([true, 0]);
    save(h.fm, { windows_cli: false }); await tick();
    expect([localWindowsCliEnabled(), init.mock.calls.length, bridgeClose.mock.calls.length, h.fm.runtimeEffects]).toEqual([false, 0, 0, null]);
  });
  it("the view the page reads matches what is in force", () => {
    setConfiguredRuntimeSwitches({ remote_runtime: true, max_agents_per_machine: 5 });
    expect(runtimeSettingsView({ runtimes: { remote_runtime: true, max_agents_per_machine: 5 } })).toMatchObject({
      switches: { remote_runtime: { on: true } }, max_agents_per_machine: { value: 5 }, local_origin: "http://127.0.0.1:19280" });
  });
});
