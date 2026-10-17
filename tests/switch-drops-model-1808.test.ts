import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1808: update_instance_config's backend switch kept the instance's model (and effort) — the old backend's. An agent
 * moving claude-code → codex relaunched codex with `--model opus`. Now a switch drops them unless given, and a given
 * one the new backend does not take is refused before anything is written. The rule is the one /backend applies.
 * A real FleetManager is the tool's context; the relaunch is stubbed, no CLI or probe runs.
 */
// This file's own AGEND_HOME (see backend-command-1806.test.ts): the cli-env cache must not race another file's.
process.env.AGEND_HOME = mkdtempSync(join(process.env.AGEND_HOME as string, "switch-1808-home-"));
vi.mock("node:worker_threads", async () => ({ Worker: (await import("./helpers/probe-worker.js")).FakeProbeWorker }));
vi.mock("../src/logger.js", async () => ({
  createLogger: (await import("./helpers/probe-worker.js")).fakeProbeLogger,
  rotateLogIfNeeded: vi.fn(),
}));
vi.mock("../src/backend/factory.js", () => ({
  createBackend: () => { throw new Error("backend constructor on fleet thread"); },
}));

const { FleetManager } = await import("../src/fleet-manager.js");
const { outboundHandlers } = await import("../src/outbound-handlers.js");

const agendHome = process.env.AGEND_HOME as string;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(agendHome, "switch-1808-"));
  rmSync(join(agendHome, "cli-env"), { recursive: true, force: true });
  mkdirSync(join(agendHome, "cli-env"), { recursive: true });
  writeFileSync(join(agendHome, "cli-env", "codex.json"),
    JSON.stringify({ backend: "codex", models: [{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.5-mini", label: "mini" }], probedAt: Date.now() }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dataDir, { recursive: true, force: true }); });

function fleet(instance: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}) {
  const fm = new FleetManager(dataDir);
  const any = fm as any;
  fm.fleetConfig = {
    defaults,
    instances: { worker: { working_directory: join(dataDir, "w"), backend: "claude-code", model: "opus", effort: "max", ...instance } },
  } as any;
  const saves: unknown[] = [];
  any.saveFleetConfig = vi.fn(() => { saves.push(structuredClone(fm.fleetConfig!.instances.worker)); });
  any.restartSingleInstance = vi.fn(async () => {});
  any.getInstanceStatus = vi.fn(() => "running");
  any.probeBackendBounded = vi.fn(async () => { throw new Error("no live probe in this test"); });
  // As readEffortMetadata answers, without reading a real ~/.codex.
  // codex's levels depend on the model that will run (as readEffortMetadata answers per model).
  any.backendEffortLevels = vi.fn((_i: string, b: string, m: string | null) => b === "codex"
    ? (m === "gpt-5.5-mini" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"])
    : b === "opencode" ? [] : ["low", "medium", "high", "xhigh", "max"]);
  const call = (config: unknown) => new Promise<{ result: any; error?: string }>(resolve => {
    void outboundHandlers.get("update_instance_config")!(fm as never, { name: "worker", config } as never, (result, error) => resolve({ result, error }), {} as never);
  });
  return { fm, any, saves, call, worker: () => fm.fleetConfig!.instances.worker as any };
}

describe("update_instance_config: a backend switch", () => {
  it("with no model: the old backend's model and effort are dropped — one write, one fresh relaunch", async () => {
    const f = fleet();
    const { result, error } = await f.call({ backend: "codex" });
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true, restarted: true, backend_switched: true, applied: { backend: "codex", model: null, effort: null } });
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]).toMatchObject({ backend: "codex" });
    expect(f.saves[0]).not.toHaveProperty("model");
    expect(f.saves[0]).not.toHaveProperty("effort");
    expect(f.any.restartSingleInstance).toHaveBeenCalledTimes(1);
    expect(f.any.restartSingleInstance).toHaveBeenCalledWith("worker", { freshStart: true });
  });

  it("…to the fleet's defaults, when it has some (what loading fleet.yaml gives it)", async () => {
    const f = fleet({}, { model: "gpt-5.5", effort: "high" });
    await f.call({ backend: "codex" });
    expect(f.saves[0]).toMatchObject({ backend: "codex", model: "gpt-5.5", effort: "high" });
  });

  it("with a model the new backend takes: that model", async () => {
    const f = fleet();
    const { error } = await f.call({ backend: "codex", model: "gpt-5.5-mini" });
    expect(error).toBeUndefined();
    expect(f.saves).toEqual([expect.objectContaining({ backend: "codex", model: "gpt-5.5-mini" })]);
  });

  it("with a model the new backend does not take: refused before anything is written, its choices named", async () => {
    const f = fleet();
    const { error } = await f.call({ backend: "codex", model: "opus" });
    expect(error).toBe('Rejected: codex does not take the model "opus". Choose one of: gpt-5.5, gpt-5.5-mini — or leave model out for its default.');
    expect(f.worker()).toMatchObject({ backend: "claude-code", model: "opus", effort: "max" });
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
    expect(f.any.restartSingleInstance).not.toHaveBeenCalled();
  });

  it("an effort the new backend does not have is refused the same way (in-process callers can give one)", async () => {
    const { applyInstanceConfigPatch } = await import("../src/outbound-handlers.js");
    const run = (f: ReturnType<typeof fleet>, patch: Record<string, unknown>) =>
      new Promise<string | undefined>(resolve => applyInstanceConfigPatch(f.fm as never, "worker", patch as never, (_r, e) => resolve(e)));
    let f = fleet();
    expect(await run(f, { backend: "codex", model: "gpt-5.5", effort: "max" }))
      .toBe('Rejected: codex takes no effort "max" at launch on this host. Choose one of: low, medium, high — or leave effort out for its default.');
    // The model given decides: gpt-5.5-mini has max here.
    f = fleet();
    expect(await run(f, { backend: "codex", model: "gpt-5.5-mini", effort: "max" })).toBeUndefined();
    expect(f.saves).toEqual([expect.objectContaining({ backend: "codex", model: "gpt-5.5-mini", effort: "max" })]);
    f = fleet();
    writeFileSync(join(agendHome, "cli-env", "opencode.json"), JSON.stringify({ backend: "opencode", models: [{ id: "p/m", label: "m" }], probedAt: Date.now() }));
    expect(await run(f, { backend: "opencode", effort: "high" })).toBe("Rejected: opencode takes no effort at launch on this host — leave effort out.");
    expect(f.worker()).toMatchObject({ backend: "claude-code", model: "opus", effort: "max" });
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
  });

  it("not a switch — the same backend, or no backend at all — leaves model and effort as they were", async () => {
    const f = fleet();
    await f.call({ backend: "claude-code", display_name: "W" });
    await f.call({ display_name: "W2" });
    expect(f.worker()).toMatchObject({ backend: "claude-code", model: "opus", effort: "max", display_name: "W2" });
    expect(f.any.restartSingleInstance).not.toHaveBeenCalled();
  });

  it("a refused profile login still leaves everything, the old model included, as it was", async () => {
    const f = fleet({ backend_options: { "kiro-cli": { credential_profile: "personal" } } });
    const { error } = await f.call({ backend: "kiro-cli" });
    expect(error).toContain('credential profile "personal" has no kiro-cli login yet');
    expect(f.worker()).toMatchObject({ backend: "claude-code", model: "opus", effort: "max" });
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
  });
});

describe("backendModelVerdict: the one rule", () => {
  it("its offered list, by exact id", () => {
    const f = fleet();
    expect(f.fm.backendModelVerdict("worker", "codex", "gpt-5.5")).toEqual({ ok: true });
    expect(f.fm.backendModelVerdict("worker", "codex", "gpt-6")).toEqual({ ok: false, choices: ["gpt-5.5", "gpt-5.5-mini"] });
  });

  it("never a name a launch line could not carry, listed or not", () => {
    const f = fleet();
    writeFileSync(join(agendHome, "cli-env", "codex.json"), JSON.stringify({ backend: "codex", models: [{ id: "a;b", label: "x" }], probedAt: Date.now() }));
    expect(f.fm.backendModelVerdict("worker", "codex", "a;b").ok).toBe(false);
    expect(f.fm.backendModelVerdict("worker", "grok", "grok-4 --x").ok).toBe(false);
  });

  it("a name is judged by what that backend's launch line carries: antigravity's display names, never codex with a space", () => {
    const f = fleet();
    writeFileSync(join(process.env.AGEND_HOME as string, "cli-env", "antigravity.json"),
      JSON.stringify({ backend: "antigravity", models: [{ id: "Gemini 3.5 Flash (High)", label: "x" }], probedAt: Date.now() }));
    expect(f.fm.backendModelVerdict("worker", "antigravity", "Gemini 3.5 Flash (High)")).toEqual({ ok: true });
    expect(f.fm.backendModelVerdict("worker", "codex", "gpt 5.5").ok).toBe(false);
  });

  it("claude-code: its known names, never the model the instance has on the backend it leaves", () => {
    const f = fleet({ backend: "codex", model: "gpt-5.5" });
    expect(f.fm.backendModelVerdict("worker", "claude-code", "sonnet")).toEqual({ ok: true });
    expect(f.fm.backendModelVerdict("worker", "claude-code", "gpt-5.5").ok).toBe(false);
  });

  it("with no list known, the backend's usual pattern decides", async () => {
    const f = fleet();
    expect(f.fm.backendModelVerdict("worker", "grok", "grok-4.5")).toEqual({ ok: true });
    expect(f.fm.backendModelVerdict("worker", "grok", "opus")).toEqual({ ok: false, choices: [] });
    expect(await noListRefusal(f)).toBe('Rejected: grok does not take the model "opus". No grok model list is known yet — or leave model out for its default.');
  });

  it("/backend judges a typed model by it too", async () => {
    const f = fleet();
    const { backendStep } = await import("../src/backend-command.js");
    const any = f.any;
    any.backendAvailabilityRows = vi.fn(() => ["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"].map(backend => ({ backend, state: "usable" })));
    any.availabilityProbes = { resolve: async () => undefined, version: async () => null, auth: async () => "unknown", signature: async () => null };
    any.getInstanceIdle = vi.fn(() => true);
    const deps = any.backendCommandDeps("worker", { live: false });
    expect((await backendStep(deps, "worker", ["grok", "grok-4.5"])).kind).not.toBe("refuse");
    expect(await backendStep(deps, "worker", ["grok", "opus"])).toMatchObject({ kind: "refuse" });
  });
});

/** The refusal text for a list-less backend, through the tool. */
function noListRefusal(f: ReturnType<typeof fleet>): Promise<string | undefined> {
  return f.call({ backend: "grok", model: "opus" }).then(r => r.error);
}

describe("review r1: a custom provider's model is judged by the provider, not the account", () => {
  it("accepted on the provider — given in this patch, already the instance's, or inherited from the fleet; with no account list too", async () => {
    let f = fleet();
    expect((await f.call({ backend: "codex", model: "glm-4.6", backend_options: { codex: { provider: "glm" } } })).error).toBeUndefined();
    expect(f.saves).toEqual([expect.objectContaining({ backend: "codex", model: "glm-4.6", backend_options: { codex: { provider: "glm" } } })]);
    f = fleet({ backend_options: { codex: { provider: "glm" } } });
    expect((await f.call({ backend: "codex", model: "glm-4.6" })).error).toBeUndefined();
    f = fleet({}, { backend_options: { codex: { provider: "glm" } } });
    expect((await f.call({ backend: "codex", model: "glm-4.6" })).error).toBeUndefined();
    rmSync(join(agendHome, "cli-env", "codex.json"));
    f = fleet({ backend_options: { codex: { provider: "glm" } } });
    expect((await f.call({ backend: "codex", model: "glm-4.6" })).error).toBeUndefined();
  });

  it("controls: an unsafe name is refused on a provider too; without a provider, another backend's model still is; a provider removed in the patch is none", async () => {
    let f = fleet({ backend_options: { codex: { provider: "glm" } } });
    expect((await f.call({ backend: "codex", model: "glm 4.6" })).error).toMatch(/^Rejected: codex does not take the model "glm 4.6"/);
    f = fleet();
    expect((await f.call({ backend: "codex", model: "opus" })).error).toMatch(/^Rejected: codex does not take the model "opus"/);
    f = fleet({ backend_options: { codex: { provider: "glm" } } });
    expect((await f.call({ backend: "codex", model: "glm-4.6", backend_options: { codex: { provider: null } } })).error)
      .toMatch(/^Rejected: codex does not take the model "glm-4.6"/);
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
  });
});

describe("review r1: the backend an instance runs includes the fleet default it inherits", () => {
  /** An entry as Settings creates it: no `backend` of its own. */
  async function settingsEntry(defaults: Record<string, unknown>) {
    const { normalizeSettingsInstancePatch } = await import("../src/settings-instance-patch.js");
    const f = fleet({}, defaults);
    (f.fm.fleetConfig!.instances as any).worker = normalizeSettingsInstancePatch({}, { working_directory: join(dataDir, "w"), model: "gpt-5.5", effort: "high" });
    f.any.getInstanceStatus = vi.fn(() => "stopped");
    return f;
  }

  it("(a) inheriting codex, switched to claude-code: a switch — the codex model and effort go", async () => {
    const f = await settingsEntry({ backend: "codex" });
    expect(f.any.backendNameForInstance("worker")).toBe("codex");
    expect((await f.call({ backend: "claude-code" })).error).toBeUndefined();
    expect(f.worker()).toMatchObject({ backend: "claude-code" });
    expect(f.worker()).not.toHaveProperty("model");
    expect(f.worker()).not.toHaveProperty("effort");
  });

  it("(b) inheriting codex, given codex: not a switch — model and effort stay", async () => {
    const f = await settingsEntry({ backend: "codex" });
    expect((await f.call({ backend: "codex" })).error).toBeUndefined();
    expect(f.worker()).toMatchObject({ model: "gpt-5.5", effort: "high" });
  });

  it("controls: no fleet default (claude-code), given claude-code: not a switch; a display-name edit keeps both", async () => {
    let f = await settingsEntry({});
    await f.call({ backend: "claude-code" });
    expect(f.worker()).toMatchObject({ model: "gpt-5.5", effort: "high" });
    f = await settingsEntry({ backend: "codex" });
    f.any.getInstanceStatus = vi.fn(() => "running");                  // a running one: an edit must not relaunch it
    const r = await f.call({ display_name: "W" });
    expect(f.worker()).toMatchObject({ model: "gpt-5.5", effort: "high", display_name: "W" });
    expect(f.worker()).not.toHaveProperty("backend");
    expect(r.result).not.toHaveProperty("restarted");
    expect(f.any.restartSingleInstance).not.toHaveBeenCalled();
  });
});

describe("review r1: a backend name that is no backend is refused, never thrown on", () => {
  it("each guard on its own: unknown names never reach the model rule; the name pattern reads own keys only", async () => {
    const f = fleet();
    const verdict = vi.spyOn(f.fm, "backendModelVerdict");
    for (const name of ["__proto__", "toString", "nope"]) await f.call({ backend: name, model: "x" });
    expect(verdict).not.toHaveBeenCalled();
    const { isModelCompatible } = await import("../src/backend/types.js");
    expect(isModelCompatible("__proto__", "x")).toBe(true);                       // unknown backend: pass through
    expect(isModelCompatible("toString", "x")).toBe(true);
    expect(isModelCompatible("codex", "opus")).toBe(false);                        // control: a known one still decides
  });

  it.each(["__proto__", "toString", "constructor", "nope"])("%s", async (name) => {
    const f = fleet();
    const { error } = await f.call({ backend: name, model: "x" });
    expect(error).toMatch(/^Rejected: /);
    expect(f.worker()).toMatchObject({ backend: "claude-code", model: "opus" });
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
  });
});
