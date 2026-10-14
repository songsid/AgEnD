import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1806 `/backend`: backend → model → effort → confirm, then ONE config write and ONE relaunch through
 * update_instance_config's backend switch. Nothing here starts a CLI, a fleet or a probe: the relaunch, the binary
 * lookup and the vendor probe are stubbed, and every store a check reads is under a scratch dir.
 */
vi.mock("node:worker_threads", async () => ({ Worker: (await import("./helpers/probe-worker.js")).FakeProbeWorker }));
vi.mock("../src/logger.js", async () => ({
  createLogger: (await import("./helpers/probe-worker.js")).fakeProbeLogger,
  rotateLogIfNeeded: vi.fn(),
}));
vi.mock("../src/backend/factory.js", () => ({
  createBackend: () => { throw new Error("backend constructor on fleet thread"); },
}));

const { backendStep, planDisplay } = await import("../src/backend-command.js");
const { FleetManager } = await import("../src/fleet-manager.js");
const { runWebCommand } = await import("../src/web-commands.js");
const { t } = await import("../src/locale.js");
import type { BackendCommandDeps } from "../src/backend-command.js";

// ── The steps (pure) ─────────────────────────────────────────────────────────

const tk = (key: string, ...args: string[]) => [key, ...args].join("|");
function deps(over: Partial<BackendCommandDeps> = {}): BackendCommandDeps {
  return {
    currentBackend: () => "claude-code",
    currentDisplay: () => "claude-code · opus",
    installedBackends: () => ["claude-code", "codex", "opencode"],
    models: async b => b === "codex" ? [{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.5-mini", label: "mini", description: "fast" }] : [],
    modelKnown: () => false,
    effortLevels: b => b === "codex" || b === "claude-code" ? ["low", "medium", "high"] : [],
    inherited: () => undefined,
    modelCompatible: () => true,
    state: () => ({ running: true, busy: false, status: "running" }),
    t: tk,
    ...over,
  };
}

describe("the steps", () => {
  it("with nothing: the installed backends, the current one marked, and what it runs now", async () => {
    const step = await backendStep(deps(), "w", []);
    expect(step).toEqual({
      kind: "choose", step: "backend", args: [], current: "claude-code", text: "backend.menu|claude-code · opus",
      choices: [{ token: "claude-code", label: "✓ claude-code" }, { token: "codex", label: "codex" }, { token: "opencode", label: "opencode" }],
    });
  });

  it("a backend that is not installed here — or unknown, or removed — is refused with the installed list", async () => {
    for (const name of ["kiro-cli", "nope", "gemini-cli", "mock"]) {
      expect(await backendStep(deps(), "w", [name])).toEqual({ kind: "refuse", text: `backend.not_installed|${name}|claude-code, codex, opencode` });
    }
    // A name is matched without regard to case, and nothing else is looked at once it is refused.
    const models = vi.fn(async () => []);
    expect((await backendStep(deps({ models }), "w", ["CODEX"])).kind).toBe("choose");
    await backendStep(deps({ models }), "w", ["kiro-cli", "x", "high"]);
    expect(models).toHaveBeenCalledTimes(1);
  });

  it("the backend it already runs is not a switch: nothing to do, and /model and /effort named", async () => {
    expect(await backendStep(deps(), "w", ["claude-code"])).toEqual({ kind: "refuse", noop: true, text: "backend.same|w|claude-code" });
    expect(await backendStep(deps(), "w", ["claude-code", "sonnet", "high"])).toMatchObject({ kind: "refuse", noop: true });
  });

  it("then its models — /model's list — with the default first", async () => {
    expect(await backendStep(deps(), "w", ["codex"])).toEqual({
      kind: "choose", step: "model", args: ["codex"], current: null, text: "backend.model_menu|codex",
      choices: [
        { token: "default", label: "backend.default (backend.default_cli)" },
        { token: "gpt-5.5", label: "GPT-5.5" }, { token: "gpt-5.5-mini", label: "mini — fast" },
      ],
    });
    // No list known: only the default can be chosen, and the menu says why.
    const empty = await backendStep(deps(), "w", ["opencode"]);
    expect(empty).toMatchObject({ kind: "choose", step: "model", text: "backend.model_menu_empty|opencode" });
    expect(empty.kind === "choose" && empty.choices.map(c => c.token)).toEqual(["default"]);
    // The inherited model is named on the default.
    const inherited = await backendStep(deps({ inherited: k => k === "model" ? "gpt-5.5" : undefined }), "w", ["codex"]);
    expect(inherited.kind === "choose" && inherited.choices[0]!.label).toBe("backend.default (backend.default_inherited|gpt-5.5)");
  });

  it("a model it does not offer is refused before anything else, with its choices", async () => {
    expect(await backendStep(deps(), "w", ["codex", "opus"])).toEqual({ kind: "refuse", text: "backend.unknown_model|opus|codex|default, gpt-5.5, gpt-5.5-mini" });
    // Known another way (claude's aliases), it is taken — but never a name the launch line could not carry.
    expect((await backendStep(deps({ modelKnown: () => true }), "w", ["codex", "sonnet"])).kind).toBe("choose");
    expect((await backendStep(deps({ modelKnown: () => true }), "w", ["codex", "a;rm"])).kind).toBe("refuse");
    expect((await backendStep(deps({ modelKnown: () => true }), "w", ["codex", "a$(x)"])).kind).toBe("refuse");
  });

  it("then the NEW backend's effort levels, with the default first", async () => {
    expect(await backendStep(deps(), "w", ["codex", "gpt-5.5"])).toEqual({
      kind: "choose", step: "effort", args: ["codex", "gpt-5.5"], current: null, text: "backend.effort_menu|codex|gpt-5.5",
      choices: [{ token: "default", label: "backend.default (backend.default_cli)" }, { token: "low", label: "low" }, { token: "medium", label: "medium" }, { token: "high", label: "high" }],
    });
    // Levels of the backend switched TO, not of the one it runs.
    const levels = vi.fn((b: string) => b === "codex" ? ["high"] : ["low"]);
    const step = await backendStep(deps({ effortLevels: levels }), "w", ["codex", "default"]);
    expect(step.kind === "choose" && step.choices.map(c => c.token)).toEqual(["default", "high"]);
  });

  it("a backend with no effort setting skips that step, and refuses an effort given anyway", async () => {
    const step = await backendStep(deps({ models: async () => [{ id: "p/m", label: "m" }] }), "w", ["opencode", "p/m"]);
    expect(step).toMatchObject({ kind: "confirm", args: ["opencode", "p/m"], plan: { backend: "opencode", model: "p/m", effort: null } });
    expect(await backendStep(deps(), "w", ["opencode", "default", "high"])).toEqual({ kind: "refuse", text: "backend.no_effort|opencode" });
  });

  it("an effort that backend does not have is refused with its levels", async () => {
    expect(await backendStep(deps(), "w", ["codex", "gpt-5.5", "max"])).toEqual({ kind: "refuse", text: "backend.unknown_effort|max|codex|default, low, medium, high" });
  });

  it("the confirmation: the plan, a restart, a fresh session and the turn — every time", async () => {
    const step = await backendStep(deps(), "w", ["codex", "gpt-5.5", "HIGH"]);
    expect(step).toEqual({
      kind: "confirm", args: ["codex", "gpt-5.5", "high"], from: "claude-code",
      plan: { backend: "codex", model: "gpt-5.5", effort: "high" },
      text: [
        "backend.confirm_head|w|claude-code · opus|codex", "backend.confirm_model|gpt-5.5", "backend.confirm_effort|high", "",
        "backend.confirm_restart|w", "backend.confirm_fresh|codex", "backend.confirm_turn",
      ].join("\n"),
    });
    // The default: null in the plan, written out in the arguments a menu passes on.
    expect(await backendStep(deps(), "w", ["codex", "default", "default"])).toMatchObject({ args: ["codex", "default", "default"], plan: { model: null, effort: null } });
  });

  it("busy: the turn it is in is interrupted, said as such; not running: nothing restarts now", async () => {
    const busy = await backendStep(deps({ state: () => ({ running: true, busy: true, status: "running" }) }), "w", ["codex", "default", "default"]);
    expect(busy.kind === "confirm" && busy.text.split("\n").slice(-3)).toEqual(["backend.confirm_restart|w", "backend.confirm_fresh|codex", "backend.confirm_busy|w"]);
    const paused = await backendStep(deps({ state: () => ({ running: false, busy: false, status: "paused" }) }), "w", ["codex", "default", "default"]);
    expect(paused.kind === "confirm" && paused.text.split("\n").slice(-1)).toEqual(["backend.confirm_not_running|w|paused|codex"]);
  });

  it("an inherited model that does not look like the new backend's is warned about, as /model warns", async () => {
    const step = await backendStep(deps({ inherited: k => k === "model" ? "opus" : undefined, modelCompatible: (_b, m) => m !== "opus" }), "w", ["codex", "default", "default"]);
    expect(step.kind === "confirm" && step.text).toContain("model.pattern_warning|opus|codex");
  });

  it("more than backend, model and effort is the usage", async () => {
    expect(await backendStep(deps(), "w", ["codex", "a", "b", "c"])).toEqual({ kind: "refuse", text: "backend.usage" });
  });

  it("planDisplay names the defaults and says when there is no effort", () => {
    expect(planDisplay(deps({ inherited: k => k === "effort" ? "high" : undefined }), { backend: "codex", model: null, effort: null }))
      .toEqual({ model: "backend.default_cli", effort: "backend.default_inherited|high" });
    expect(planDisplay(deps(), { backend: "opencode", model: "p/m", effort: null })).toEqual({ model: "p/m", effort: "—" });
  });
});

// ── The fleet: one write, one relaunch, through update_instance_config ───────

const agendHome = process.env.AGEND_HOME as string;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(agendHome, "backend-1806-"));
  rmSync(join(agendHome, "cli-env"), { recursive: true, force: true });
  mkdirSync(join(agendHome, "cli-env"), { recursive: true });
  writeFileSync(join(agendHome, "cli-env", "codex.json"),
    JSON.stringify({ backend: "codex", models: [{ id: "gpt-5.5", label: "GPT-5.5" }], probedAt: Date.now() }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dataDir, { recursive: true, force: true }); });

const INSTALLED = new Set(["claude-code", "codex", "kiro-cli", "opencode"]);

function fleet(instance: Record<string, unknown> = {}, opts: { status?: string; busy?: boolean } = {}) {
  const fm = new FleetManager(dataDir);
  const any = fm as any;
  fm.fleetConfig = {
    channel: { type: "telegram", group_id: "chat", access: { mode: "locked", allowed_users: ["admin"] } },
    defaults: {},
    instances: { worker: { working_directory: join(dataDir, "w"), backend: "claude-code", model: "opus", effort: "max", topic_id: "chan", ...instance } },
  } as any;
  const saves: unknown[] = [];
  any.saveFleetConfig = vi.fn(() => { saves.push(structuredClone(fm.fleetConfig!.instances.worker)); });
  any.restartSingleInstance = vi.fn(async () => {});
  any.getInstanceStatus = vi.fn(() => opts.status ?? "running");
  any.getInstanceIdle = vi.fn(() => !opts.busy);
  any.backendInstalledHere = vi.fn((b: string) => INSTALLED.has(b));
  any.probeBackendBounded = vi.fn(async () => { throw new Error("no live probe in this test"); });
  // As readEffortMetadata answers, without reading a real ~/.codex: codex is given none here.
  any.backendEffortLevels = vi.fn((_i: string, b: string) => b === "codex" || b === "opencode" ? [] : ["low", "medium", "high", "xhigh", "max"]);
  const promptUser = vi.fn().mockImplementation(async () => `menu-${promptUser.mock.calls.length}`);
  const sendText = vi.fn().mockResolvedValue({ messageId: "sent" });
  const editMessage = vi.fn().mockResolvedValue(undefined);
  const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
  const adapter = { id: "telegram", type: "telegram", promptUser, sendText, editMessage, editMessageRemoveButtons } as any;
  return { fm, any, saves, adapter, promptUser, sendText, editMessage, editMessageRemoveButtons, worker: () => fm.fleetConfig!.instances.worker as any };
}

/** Click the button labelled `label` on the newest Telegram menu. */
async function click(f: ReturnType<typeof fleet>, label: string): Promise<void> {
  const call = f.promptUser.mock.calls.at(-1)!;
  const button = (call[2] as Array<{ id: string; label: string }>).find(b => b.label === label || b.label.startsWith(`${label} `));
  expect(button, `a "${label}" button on "${call[1]}"`).toBeTruthy();
  expect(await f.any.handleBackendSelection({ callbackData: button!.id, userId: "admin", chatId: "chan", messageId: `menu-${f.promptUser.mock.calls.length}` }, "telegram")).toBe(true);
}
const settle = () => new Promise(r => setTimeout(r, 0));

describe("the Telegram flow", () => {
  it("backend → model → effort → confirm: one write of all three, one fresh relaunch, after the last click only", async () => {
    const f = fleet();
    await f.fm.runBackendCommand("worker", "/backend", "admin", "chan", f.adapter, "chat", "topic", "telegram");
    // Only CLIs installed here; never a removed or test-only backend.
    expect((f.promptUser.mock.calls[0][2] as Array<{ label: string }>).map(b => b.label)).toEqual(["✓ claude-code", "codex", "opencode", "kiro-cli"]);
    await click(f, "codex");
    await click(f, "GPT-5.5");
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
    expect(f.any.restartSingleInstance).not.toHaveBeenCalled();
    // codex has no effort levels in this test: the confirmation follows the model.
    const confirmText = f.promptUser.mock.calls.at(-1)![1] as string;
    expect(confirmText).toContain(t("backend.confirm_fresh", "codex"));
    expect(confirmText).toContain(t("backend.confirm_restart", "worker"));
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
    await click(f, t("backend.confirm_button"));
    await vi.waitFor(() => expect(f.editMessage).toHaveBeenCalled());
    expect(f.saves).toEqual([expect.objectContaining({ backend: "codex", model: "gpt-5.5" })]);
    expect(f.saves[0]).not.toHaveProperty("effort");
    expect(f.any.restartSingleInstance).toHaveBeenCalledTimes(1);
    expect(f.any.restartSingleInstance).toHaveBeenCalledWith("worker", { freshStart: true });
    expect(f.editMessage.mock.calls.at(-1)![2]).toBe(t("backend.switched", "worker", "codex", "gpt-5.5", "—"));
  });

  it("with an effort step (kiro-cli): the chosen level is written in the same write", async () => {
    const f = fleet();
    writeFileSync(join(agendHome, "cli-env", "kiro-cli.json"), JSON.stringify({ backend: "kiro-cli", models: [{ id: "claude-sonnet-4.5", label: "Sonnet" }], probedAt: Date.now() }));
    await f.fm.runBackendCommand("worker", "/backend kiro-cli", "admin", "chan", f.adapter, "chat", "topic", "telegram");
    await click(f, "Sonnet");
    expect(f.promptUser.mock.calls.at(-1)![1]).toBe(t("backend.effort_menu", "kiro-cli", "claude-sonnet-4.5"));
    await click(f, "high");
    await click(f, t("backend.confirm_button"));
    await vi.waitFor(() => expect(f.any.restartSingleInstance).toHaveBeenCalledTimes(1));
    expect(f.saves).toEqual([expect.objectContaining({ backend: "kiro-cli", model: "claude-sonnet-4.5", effort: "high" })]);
  });

  it("Cancel changes nothing; so does a click on an older step", async () => {
    const f = fleet();
    await f.fm.runBackendCommand("worker", "/backend codex gpt-5.5", "admin", "chan", f.adapter, "chat", "topic", "telegram");
    await click(f, t("backend.cancel_button"));
    expect(f.editMessageRemoveButtons.mock.calls.at(-1)![2]).toBe(t("backend.cancelled"));
    const consumed = f.promptUser.mock.calls[0][2][0].id;
    await f.any.handleBackendSelection({ callbackData: consumed, userId: "admin", chatId: "chan" }, "telegram");
    await settle();
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
    expect(f.any.restartSingleInstance).not.toHaveBeenCalled();
    expect(f.worker()).toMatchObject({ backend: "claude-code", model: "opus", effort: "max" });
  });

  it("another user's click — or a non-admin's — is refused, and the menu stays", async () => {
    const f = fleet();
    await f.fm.runBackendCommand("worker", "/backend", "admin", "chan", f.adapter, "chat", "topic", "telegram");
    const ack = vi.fn();
    const id = f.promptUser.mock.calls[0][2][1].id;
    await f.any.handleBackendSelection({ callbackData: id, userId: "stranger", chatId: "chan", ack }, "telegram");
    expect(ack).toHaveBeenCalledWith(t("buttons.admin_only"));
    expect(f.promptUser).toHaveBeenCalledTimes(1);
    await f.any.handleBackendSelection({ callbackData: id, userId: "admin", chatId: "chan" }, "telegram");
    expect(f.promptUser).toHaveBeenCalledTimes(2);
  });

  it("the direct form goes to the confirmation, and still waits for it", async () => {
    const f = fleet();
    await f.fm.runBackendCommand("worker", "/backend@bot codex gpt-5.5", "admin", "chan", f.adapter, "chat", "topic", "telegram");
    expect(f.promptUser).toHaveBeenCalledTimes(1);
    expect((f.promptUser.mock.calls[0][2] as Array<{ label: string }>).map(b => b.label)).toEqual([t("backend.confirm_button"), t("backend.cancel_button")]);
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
  });

  it("invalid input is refused with the choices, before anything is written", async () => {
    const f = fleet();
    for (const [text, reply] of [
      ["/backend antigravity", t("backend.not_installed", "antigravity", "claude-code, codex, opencode, kiro-cli")],
      ["/backend codex gpt-9", t("backend.unknown_model", "gpt-9", "codex", "default, gpt-5.5")],
      ["/backend opencode default high", t("backend.no_effort", "opencode")],
      ["/backend claude-code sonnet", t("backend.same", "worker", "claude-code")],
    ] as const) {
      await f.fm.runBackendCommand("worker", text, "admin", "chan", f.adapter, "chat", "topic", "telegram");
      expect(f.sendText.mock.calls.at(-1)![1], text).toBe(reply);
    }
    expect(f.promptUser).not.toHaveBeenCalled();
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
    expect(f.any.restartSingleInstance).not.toHaveBeenCalled();
  });

  it("into claude-code: the model the instance has now belongs to the backend it leaves, and is not taken as known", async () => {
    const f = fleet({ backend: "codex", model: "gpt-5.5" });
    await f.fm.runBackendCommand("worker", "/backend claude-code gpt-5.5", "admin", "chan", f.adapter, "chat", "topic", "telegram");
    expect(f.sendText.mock.calls.at(-1)![1]).toContain(t("backend.unknown_model", "gpt-5.5", "claude-code", "default").slice(0, 40));
    expect(f.promptUser).not.toHaveBeenCalled();
    // claude's own aliases are known without a list.
    await f.fm.runBackendCommand("worker", "/backend claude-code sonnet", "admin", "chan", f.adapter, "chat", "topic", "telegram");
    expect(f.promptUser).toHaveBeenCalledTimes(1);
  });

  it("a ClassicBot agent is not switched by it, and says so", async () => {
    const f = fleet();
    await f.fm.runBackendCommand("room-agent", "/backend codex", "admin", "chan", f.adapter, "chat", undefined, "telegram");
    expect(f.sendText.mock.calls.at(-1)![1]).toBe(t("backend.classic_unsupported", "room-agent"));
    expect(f.promptUser).not.toHaveBeenCalled();
  });
});

describe("applying it: update_instance_config's write, whole or not at all", () => {
  it("the credential-profile login gate's refusal is shown as it is, and backend, model and effort stay as they were", async () => {
    // kiro-cli under a profile nobody has logged into (its store would be under the scratch data dir).
    const f = fleet({ backend_options: { "kiro-cli": { credential_profile: "personal" } } });
    const reply = await f.fm.applyBackendSwitch("worker", ["kiro-cli", "default", "default"], "claude-code");
    expect(reply).toContain(t("backend.refused", "worker", "").trim().split("\n")[0]!);
    expect(reply).toContain('credential profile "personal" has no kiro-cli login yet');
    expect(reply).toContain("kiro-cli login");
    expect(f.worker()).toMatchObject({ backend: "claude-code", model: "opus", effort: "max" });
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
    expect(f.any.restartSingleInstance).not.toHaveBeenCalled();
  });

  it("a save that fails leaves the instance as it was, and nothing restarts", async () => {
    const f = fleet();
    f.any.saveFleetConfig = vi.fn(() => { throw new Error("disk full"); });
    const reply = await f.fm.applyBackendSwitch("worker", ["codex", "gpt-5.5"], "claude-code");
    expect(reply).toBe(t("backend.refused", "worker", "Failed to save config: disk full"));
    expect(f.worker()).toMatchObject({ backend: "claude-code", model: "opus", effort: "max" });
    expect(f.any.restartSingleInstance).not.toHaveBeenCalled();
  });

  it("judged again when applied: a backend that moved meanwhile, or input that is no longer valid, writes nothing", async () => {
    const f = fleet();
    f.worker().backend = "opencode";
    expect(await f.fm.applyBackendSwitch("worker", ["codex", "gpt-5.5"], "claude-code")).toBe(t("backend.changed", "worker", "claude-code"));
    f.worker().backend = "claude-code";
    f.any.backendInstalledHere = vi.fn(() => false);
    expect(await f.fm.applyBackendSwitch("worker", ["codex", "gpt-5.5"], "claude-code")).toBe(t("backend.not_installed", "codex", "—"));
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
  });

  it("default: the inherited value, as loading fleet.yaml would give it", async () => {
    const f = fleet();
    (f.fm.fleetConfig!.defaults as any).effort = "high";
    await f.fm.applyBackendSwitch("worker", ["kiro-cli", "default", "default"], "claude-code");
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]).not.toHaveProperty("model");
    expect(f.saves[0]).toMatchObject({ backend: "kiro-cli", effort: "high" });
  });

  it("a stopped instance is saved and not started", async () => {
    const f = fleet({}, { status: "stopped" });
    const reply = await f.fm.applyBackendSwitch("worker", ["codex", "gpt-5.5"], "claude-code");
    expect(reply).toBe(t("backend.switched_not_running", "worker", "codex", "gpt-5.5", "—", "stopped"));
    expect(f.any.saveFleetConfig).toHaveBeenCalledTimes(1);
    expect(f.any.restartSingleInstance).not.toHaveBeenCalled();
  });
});

describe("Discord", () => {
  function slash(f: ReturnType<typeof fleet>, options: Record<string, string> = {}) {
    const respond = vi.fn().mockResolvedValue("reply");
    const respondChoices = vi.fn().mockResolvedValue("reply");
    const respondButtons = vi.fn().mockResolvedValue("reply");
    const retireButtons = vi.fn().mockResolvedValue(undefined);
    f.any.isModelAdmin = vi.fn((user: string) => user === "admin");
    f.any.resolveSlashTarget = vi.fn(() => "worker");
    f.any.menuClickStillCurrent = vi.fn(() => true);
    const data = { command: "backend", channelId: "chan", channelName: "c", userId: "admin", options, respond, respondChoices, respondButtons, retireButtons };
    return { data, respond, respondChoices, respondButtons, retireButtons };
  }

  it("a non-admin is refused as /model refuses", async () => {
    const f = fleet();
    const s = slash(f);
    await f.any.handleBackendSlash({ ...s.data, userId: "guest" }, "discord");
    expect(s.respond).toHaveBeenCalledWith(t("permission.denied"));
    expect(s.respondChoices).not.toHaveBeenCalled();
  });

  it("menus as a select, the confirmation as two buttons; the buttons go when it is answered", async () => {
    const f = fleet();
    const s = slash(f);
    await f.any.handleBackendSlash(s.data, "discord");
    const pick = async (from: ReturnType<typeof vi.fn>, label: string) => {
      const buttons = from.mock.calls.at(-1)![1] as Array<{ id: string; label: string }>;
      const id = buttons.find(b => b.label === label || b.label.startsWith(`${label} `))!.id;
      await f.any.handleBackendSelection({ callbackData: id, userId: "admin", chatId: "chan" }, "discord");
    };
    await pick(s.respondChoices, "codex");
    await pick(s.respondChoices, "GPT-5.5");
    expect(s.respondButtons).toHaveBeenCalledTimes(1);
    expect(s.respondButtons.mock.calls[0][0]).toContain(t("backend.confirm_fresh", "codex"));
    await pick(s.respondButtons, t("backend.confirm_button"));
    expect(s.retireButtons).toHaveBeenCalledWith(t("backend.switching", "worker", "codex"));
    await vi.waitFor(() => expect(s.respond).toHaveBeenCalledWith(t("backend.switched", "worker", "codex", "gpt-5.5", "—")));
    expect(f.any.restartSingleInstance).toHaveBeenCalledTimes(1);
  });

  it("options give the direct form; one given without the one before it is the usage", async () => {
    const f = fleet();
    const s = slash(f, { backend: "codex", model: "gpt-5.5" });
    await f.any.handleBackendSlash(s.data, "discord");
    expect(s.respondButtons).toHaveBeenCalledTimes(1);
    const s2 = slash(f, { model: "gpt-5.5" });
    await f.any.handleBackendSlash(s2.data, "discord");
    expect(s2.respond).toHaveBeenCalledWith(t("backend.usage"));
  });
});

describe("the web chat", () => {
  it("one call per step, each choice carrying the arguments so far; the last asks to confirm; the token switches once", async () => {
    const f = fleet();
    const run = (args: string, confirm?: string) => f.fm.webCommand({ instance: "worker", command: "backend", args, ...(confirm ? { confirm } : {}) }, { publicLink: true });
    const first = await run("");
    expect(first.body.choices).toMatchObject({ current: "claude-code", options: [{ id: "claude-code" }, { id: "codex" }, { id: "opencode" }, { id: "kiro-cli" }] });
    expect(first.body.choices!.prompt).toBe(t("backend.menu", "claude-code · opus"));
    const second = await run("codex");
    expect(second.body.choices!.options.map(o => o.id)).toEqual(["codex default", "codex gpt-5.5"]);
    const third = await run("codex gpt-5.5");
    expect(third.body.confirm!.message).toContain(t("backend.confirm_fresh", "codex"));
    expect(f.any.saveFleetConfig).not.toHaveBeenCalled();
    // A token answers only the arguments it was asked for.
    expect((await run("codex default", third.body.confirm!.token)).status).toBe(409);
    const again = await run("codex gpt-5.5");
    const done = await run("codex gpt-5.5", again.body.confirm!.token);
    expect(done).toEqual({ status: 200, body: { text: t("backend.switched", "worker", "codex", "gpt-5.5", "—") } });
    expect(f.any.restartSingleInstance).toHaveBeenCalledTimes(1);
    expect((await run("codex gpt-5.5", again.body.confirm!.token)).status).toBe(409);
    expect(f.any.restartSingleInstance).toHaveBeenCalledTimes(1);
  });

  it("refusals are errors; the backend it runs is a word, not an error", async () => {
    const f = fleet();
    expect((await f.fm.webCommand({ instance: "worker", command: "backend", args: "codex nope" }, { publicLink: false })).status).toBe(400);
    expect(await f.fm.webCommand({ instance: "worker", command: "backend", args: "claude-code" }, { publicLink: false }))
      .toEqual({ status: 200, body: { text: t("backend.same", "worker", "claude-code") } });
  });

  it("the web never probes for a model list", async () => {
    const f = fleet();
    rmSync(join(agendHome, "cli-env", "codex.json"));
    const r = await f.fm.webCommand({ instance: "worker", command: "backend", args: "codex" }, { publicLink: false });
    expect(r.body.choices!.options.map(o => o.id)).toEqual(["codex default"]);
    expect(f.any.probeBackendBounded).not.toHaveBeenCalled();
  });

  it("runWebCommand: /backend is allowed where /model is, the public link included", async () => {
    const base = {
      scope: () => "fleet" as const, t: (k: string) => k,
      backendStep: vi.fn(async () => ({ text: "ok" })), backendConfirm: vi.fn(async () => ({ status: 200, text: "done" })),
    } as any;
    expect((await runWebCommand(base, { instance: "w", command: "backend" }, { publicLink: true })).status).toBe(200);
    expect((await runWebCommand(base, { instance: "w", command: "backend", args: "x", confirm: "t" }, { publicLink: true })).body).toEqual({ text: "done" });
    expect(base.backendConfirm).toHaveBeenCalledWith("w", "x", "t");
    expect((await runWebCommand({ ...base, scope: () => "none" }, { instance: "w", command: "backend" }, { publicLink: false })).status).toBe(403);
  });
});

describe("the MCP tool is unchanged", () => {
  it("an agent's update_instance_config can neither set an effort nor clear a model: that is /backend's, in-process", async () => {
    const { outboundHandlers } = await import("../src/outbound-handlers.js");
    const f = fleet();
    const call = (config: unknown) => new Promise<{ result: unknown; error?: string }>(resolve => {
      void outboundHandlers.get("update_instance_config")!(f.fm as never, { name: "worker", config } as never, (result, error) => resolve({ result, error }), {} as never);
    });
    expect((await call({ model: null })).error).toBeTruthy();
    await call({ effort: "low", display_name: "W" });
    expect(f.worker()).toMatchObject({ model: "opus", effort: "max", display_name: "W" });
  });
});
