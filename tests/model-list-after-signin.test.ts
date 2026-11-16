import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A CLI's model list is discovered when something makes it answerable (a sign-in ended, the agent moved to the
// CLI, a menu opened on an empty list) — not only at startup or on the Refresh button. Same inert fixture as #3526: no host
// process, vendor or adapter; the probe worker is a fake whose answer the test chooses.
vi.mock("../src/logger.js", async () => ({ createLogger: (await import("./helpers/probe-worker.js")).fakeProbeLogger, rotateLogIfNeeded: vi.fn() }));
vi.mock("../src/backend/factory.js", () => ({ createBackend: () => { throw Error("no backend on fleet loop"); } }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const refuse = () => { throw Error("host child forbidden"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn(), setSdNotifyWarn: vi.fn(), startSdWatchdog: () => setInterval(() => {}, 10_000) }));
vi.mock("../src/tmux-exec-helper.js", () => ({ tmuxExecHelper: { reopen() {}, start() {}, maintain() {}, async stop() {} } }));
vi.mock("../src/stall-reporter.js", () => ({ startStallReporter: () => null }));
vi.mock("../src/binary-probe.js", async original => {
  const real = await original<typeof import("../src/binary-probe.js")>();
  const inert = { answer: Promise.resolve<string | null>(null), kill() {}, exited: Promise.resolve() };
  return { ...real, spawnProbeCommand: () => inert, spawnWhich: () => inert, binaryProbe: new real.BinaryProbe(() => inert) };
});

import { FakeProbeWorker } from "./helpers/probe-worker.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setUsageFetcherForTests } from "../src/usage/usage-api.js";

let dir: string, fm: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-models-signin-"));
  vi.stubEnv("AGEND_HOME", dir); vi.stubEnv("HOME", dir);
  FakeProbeWorker.reset();
  setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [] }));
  fm = new FleetManager(dir);
});
afterEach(async () => {
  await fm.stopAll(); fm.memoryPressure.stop(); fm.spawnGate.shutdown(); fm.stormWindow.shutdown();
  setUsageFetcherForTests(null);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** A fleet whose one agent `w` runs `backend` (default account unless `options` names a profile). */
function fleet(backend: string, options?: Record<string, unknown>) {
  const work = join(dir, "workspaces/w"); mkdirSync(work, { recursive: true });
  const path = join(dir, "fleet.yaml");
  const opts = options ? `    backend_options:\n      ${backend}:\n${Object.entries(options).map(([k, v]) => `        ${k}: ${v}`).join("\n")}\n` : "";
  writeFileSync(path, `defaults:\n  backend: ${backend}\n  locale: en\nweb:\n  preview: false\ninstances:\n  w:\n    working_directory: ${work}\n${opts}`);
  fm.loadConfig(path);
}
const ids = (backend: string, instance: string | null = "w") => fm.modelCatalogFor(backend, instance).map((m: any) => m.id);
async function settled() { await vi.waitFor(() => expect(fm.pendingCliEnvProbes.size + fm.pendingVendorCliEnvProbes.size + fm.webModelRefreshes.size).toBe(0)); }
/** An open stream: every frame the fleet writes to it. */
function stream() {
  const frames: string[] = [];
  fm.sseClients.add({ write: (text: string) => { frames.push(text); return true; }, end() {} });
  return { models: () => frames.filter(f => f.startsWith("event: models\n")).map(f => JSON.parse(f.split("data: ")[1]!)) };
}
const found = (id: string) => (input: any) => ({ models: [{ id: `${input.backend}-${id}`, label: id }] });
const signedOut = () => ({ models: [] });

describe("a sign-in re-reads the CLI's models", () => {
  it("Settings → Accounts: agy answered nothing at startup (signed out); once signed in the list is there, unprompted, and the page is told", async () => {
    fleet("antigravity");
    FakeProbeWorker.answer = signedOut;
    await fm.probeBackendBounded("antigravity");
    expect(ids("antigravity")).toEqual([]);
    const events = stream();
    FakeProbeWorker.answer = found("hydrogen");
    fm.browserBackendSignIns.deps.changed({ backend: "antigravity", phase: "done" }, {}, false);
    await settled();
    expect(ids("antigravity")).toEqual(["antigravity-hydrogen"]);
    expect(events.models()).toEqual([{ backend: "antigravity" }]);
  });

  it("a sign-in that did not finish discovers nothing", async () => {
    fleet("antigravity");
    for (const phase of ["starting", "failed"]) fm.browserBackendSignIns.deps.changed({ backend: "antigravity", phase }, {}, false);
    await settled();
    expect(FakeProbeWorker.workers).toHaveLength(0);
  });

  it("a named claude account is read through its own login store, never the default's", async () => {
    fleet("claude-code", { credential_profile: "work" });
    FakeProbeWorker.answer = found("opus");
    fm.profileSignIns.deps.changed({ backend: "claude-code", profile: "work", phase: "done" }, {}, false);
    await settled();
    expect(FakeProbeWorker.workers).toHaveLength(1);
    expect(FakeProbeWorker.workers[0].input.config.credentialStoreHome).toBe(join(dir, "credential-profiles", "claude-code", "work"));
    expect(ids("claude-code")).toEqual(["claude-code-opus"]);
    expect(ids("claude-code", null)).toEqual([]);
  });

  it("a named account of a CLI whose account is a variable of the process (codex's CODEX_HOME) is discovered for the agents on it, scoped to them", async () => {
    fleet("codex", { credential_profile: "work" });
    FakeProbeWorker.answer = found("gpt-6");
    fm.profileSignIns.deps.changed({ backend: "codex", profile: "work", phase: "done" }, {}, false);
    await settled();
    expect(FakeProbeWorker.workers).toHaveLength(1);
    expect(FakeProbeWorker.workers[0].input.config.credentialStoreHome).toBe(join(dir, "credential-profiles", "codex", "work"));
    expect(ids("codex")).toEqual(["codex-gpt-6"]);
    expect(ids("codex", null)).toEqual([]);                           // the default account's list is not this one's
  });

  it("a named Antigravity account never borrows the default account's list: nothing is probed for it", async () => {
    fleet("antigravity", { credential_profile: "work" });
    FakeProbeWorker.answer = found("ambient");
    fm.profileSignIns.deps.changed({ backend: "antigravity", profile: "work", phase: "done" }, {}, false);
    await settled();
    expect(FakeProbeWorker.workers).toHaveLength(0);
    expect(ids("antigravity")).toEqual([]);
  });

  it("chat /login and the dashboard's terminal sign-in (the login controller) read the list again", async () => {
    fleet("codex");
    FakeProbeWorker.answer = signedOut;
    await fm.probeBackendBounded("codex");
    expect(ids("codex")).toEqual([]);
    vi.spyOn(fm, "recoverBackendInstances").mockResolvedValue({ woken: [], restarted: [], pending: [] });
    vi.spyOn(fm.backendAvailability, "refresh").mockResolvedValue(undefined as never);
    FakeProbeWorker.answer = found("gpt");
    await fm.webLogin.deps.recoverBackendInstances("codex", undefined);
    await settled();
    expect(ids("codex")).toEqual(["codex-gpt"]);
  });

  it("a Windows Runtime's sign-in tells the open pages to read its inventory again; no host probe runs", async () => {
    fleet("codex");
    const events = stream();
    fm.machineSignIns.deps.changed({ machine: "00000000-0000-4000-8000-000000000001", backend: "codex", phase: "done" }, { handle: "a".repeat(16), label: "x" });
    expect(events.models()).toEqual([{ backend: "codex" }]);
    expect(FakeProbeWorker.workers).toHaveLength(0);
  });

  it("a Windows Runtime's sign-in also asks that Runtime once, as the admin who finished it; a failure never reaches the sign-in", async () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); vi.stubEnv("AGEND_WINDOWS_CLI", "0");
    fleet("codex");
    const machine = "00000000-0000-4000-8000-000000000001";
    fm.fleetConfig.instances.win = { runtime: "windows", working_directory: "C:\\w", backend: "claude-code", machine_id: machine, backend_options: { "claude-code": { credential_profile: "work" } } };
    const call = vi.fn(async (_id: string, _op: string, p: any) => ({ cli: p.cli, profile: p.profile, source: "account-api", models: [{ id: "claude-new", name: "New" }] }));
    const row = { id: machine, platform: "win32", status: "online", generation: 1, approvedAt: 1, bootId: "b", runtimeInfo: { capabilities: ["model-catalog-refresh"] }, inventory: { clis: [], credentialProfiles: { default: "work", profiles: [{ name: "work", loggedIn: true }] } } };
    vi.spyOn(fm, "runtimeCoordinator").mockReturnValue({ machine: () => row, callAccount: call } as never);
    vi.spyOn(fm, "browserSignInOwnerCurrent").mockReturnValue(true);
    const events = stream();
    const owner = { handle: "0123456789abcdef", label: "x" };
    fm.machineSignIns.deps.changed({ machine, backend: "claude-code", profile: "work", phase: "starting" }, owner);
    await new Promise(r => setImmediate(r));
    expect(call).not.toHaveBeenCalled();                              // only a finished sign-in
    fm.machineSignIns.deps.changed({ machine, backend: "claude-code", profile: "work", phase: "done" }, owner);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenCalledWith(machine, "models.refresh", { cli: "claude-code", profile: "work", actor: "admin:0123456789abcdef" }, 25000);
    await vi.waitFor(() => expect(events.models().length).toBe(2));   // the page is told at once, and again when the Runtime answered
    call.mockRejectedValue(new Error("runtime unreachable"));
    expect(() => fm.machineSignIns.deps.changed({ machine, backend: "claude-code", profile: "work", phase: "done" }, owner)).not.toThrow();
    await new Promise(r => setImmediate(r));
  });

  it("an attempt that found nothing before the sign-in does not hold the next open back", async () => {
    fleet("antigravity");
    FakeProbeWorker.answer = signedOut;
    await fm.ensureModelCatalog("antigravity", "w");                 // signed out: nothing, and remembered for a minute
    FakeProbeWorker.answer = found("hydrogen");
    await fm.ensureModelCatalog("antigravity", "w");
    expect(FakeProbeWorker.workers).toHaveLength(1);                 // inside the cooldown: not tried again…
    fm.browserBackendSignIns.deps.changed({ backend: "antigravity", phase: "done" }, {}, false);
    await settled();
    expect(ids("antigravity")).toEqual(["antigravity-hydrogen"]);    // …but the sign-in cleared it
  });
});

describe("a menu opened on an empty list discovers it once", () => {
  it("web /model: the cache is empty, so the list is read first (bounded) and the menu has models, not 'not in this CLI's list'", async () => {
    fleet("antigravity");
    FakeProbeWorker.answer = found("hydrogen");
    const r = await fm.webCommand({ instance: "w", command: "model" }, { publicLink: false });
    expect(r.status).toBe(200);
    expect(r.body.choices.options.map((o: any) => o.id)).toEqual(["antigravity-hydrogen"]);
    expect(FakeProbeWorker.workers).toHaveLength(1);
    await fm.webCommand({ instance: "w", command: "model" }, { publicLink: false });
    expect(FakeProbeWorker.workers).toHaveLength(1);                 // a fresh list is read, never probed again
  });

  it("joins the discovery startup already has in flight instead of starting a second", async () => {
    fleet("antigravity");
    FakeProbeWorker.answer = undefined;
    fm.probeCliEnvs();
    await vi.waitFor(() => expect(FakeProbeWorker.workers).toHaveLength(1));
    const open = fm.webCommand({ instance: "w", command: "model" }, { publicLink: false });
    FakeProbeWorker.workers[0].reply({ models: [{ id: "antigravity-late", label: "Late" }] });
    expect((await open).body.choices.options.map((o: any) => o.id)).toEqual(["antigravity-late"]);
    expect(FakeProbeWorker.workers).toHaveLength(1);
  });

  it("a probe that never answers makes the menu wait only the bound, then answer with what there is; the late answer is announced", async () => {
    vi.useFakeTimers();
    fleet("antigravity");
    FakeProbeWorker.answer = undefined;
    const events = stream();
    const open = fm.webCommand({ instance: "w", command: "model" }, { publicLink: false });
    await vi.advanceTimersByTimeAsync(12_001);
    const r = await open;
    expect(r.body.choices.options).toEqual([]);
    FakeProbeWorker.workers[0].reply({ models: [{ id: "antigravity-late", label: "Late" }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(ids("antigravity")).toEqual(["antigravity-late"]);
    expect(events.models()).toEqual([{ backend: "antigravity" }]);
  });

  it("a CLI that finds nothing (signed out) is not probed on every open: one attempt, then a minute's rest", async () => {
    vi.useFakeTimers();
    fleet("antigravity");
    FakeProbeWorker.answer = signedOut;
    await fm.webCommand({ instance: "w", command: "model" }, { publicLink: false });
    await fm.webCommand({ instance: "w", command: "model" }, { publicLink: false });
    expect(FakeProbeWorker.workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await fm.webCommand({ instance: "w", command: "model" }, { publicLink: false });
    expect(FakeProbeWorker.workers).toHaveLength(2);
  });

  it("a list that is only stale is shown at once and refreshed behind the open", async () => {
    vi.useFakeTimers();
    fleet("antigravity");
    FakeProbeWorker.answer = found("one");
    await fm.probeBackendBounded("antigravity");
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    FakeProbeWorker.answer = found("two");
    const r = await fm.webCommand({ instance: "w", command: "model" }, { publicLink: false });
    expect(r.body.choices.options.map((o: any) => o.id)).toEqual(["antigravity-one"]);
    await settled();
    expect(ids("antigravity")).toEqual(["antigravity-two"]);
  });

  it("/backend: the model step of a CLI never read before discovers its list", async () => {
    fleet("codex");
    FakeProbeWorker.answer = found("hydrogen");
    const r = await fm.webCommand({ instance: "w", command: "backend", args: "antigravity" }, { publicLink: false });
    expect(r.status).toBe(200);
    expect(r.body.choices.step).toBe("model");
    expect(FakeProbeWorker.workers.map(w => w.input.backend)).toContain("antigravity");
    expect(r.body.choices.options.map((o: any) => o.id.split(" ").pop())).toContain("antigravity-hydrogen");
  });

  it("never discovers for a name the fleet does not know", async () => {
    fleet("codex");
    await fm.ensureModelCatalog("codex", "not-an-agent");
    await fm.ensureModelCatalog("mock", "w");
    expect(FakeProbeWorker.workers).toHaveLength(0);
  });
});

describe("the agent moved to another CLI", () => {
  it("a committed backend switch discovers the new CLI, and the page is told when it lands", async () => {
    fleet("codex");
    const events = stream();
    FakeProbeWorker.answer = found("hydrogen");
    fm.fleetConfig.instances.w.backend = "antigravity";
    fm.saveFleetConfig(); await settled();
    expect(ids("antigravity")).toEqual(["antigravity-hydrogen"]);
    expect(events.models()).toEqual([{ backend: "antigravity" }]);
  });

  it("a switch that lands before its probe is read joins that probe (the page's read right after the save)", async () => {
    fleet("codex");
    FakeProbeWorker.answer = undefined;
    fm.fleetConfig.instances.w.backend = "antigravity";
    fm.saveFleetConfig();
    await vi.waitFor(() => expect(FakeProbeWorker.workers).toHaveLength(1));
    const read = fm.ensureModelCatalog("antigravity", "w");
    FakeProbeWorker.workers[0].reply({ models: [{ id: "antigravity-new", label: "New" }] });
    await read;
    expect(ids("antigravity")).toEqual(["antigravity-new"]);
    expect(FakeProbeWorker.workers).toHaveLength(1);
  });
});
