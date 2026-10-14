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
  any.backendEffortLevels = vi.fn((_i: string, b: string) => b === "codex" ? ["low", "medium", "high"] : b === "opencode" ? [] : ["low", "medium", "high", "xhigh", "max"]);
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
      .toBe('Rejected: codex has no effort "max". Choose one of: low, medium, high — or leave effort out for its default.');
    f = fleet();
    writeFileSync(join(agendHome, "cli-env", "opencode.json"), JSON.stringify({ backend: "opencode", models: [{ id: "p/m", label: "m" }], probedAt: Date.now() }));
    expect(await run(f, { backend: "opencode", effort: "high" })).toBe("Rejected: opencode has no effort setting — leave effort out.");
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
    any.backendInstalledHere = vi.fn(() => true);
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
