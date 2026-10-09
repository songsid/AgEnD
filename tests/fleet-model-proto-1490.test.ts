/**
 * #1490 P3a: applyModel must reject model names with newlines / control chars.
 * #1490 P3b: instance lookups via user input must use Object.hasOwn so that
 *            '__proto__' and 'constructor' return "not found" or "general_only",
 *            not a hit.
 *
 * Each test has a reverse-mutation note.
 */
import { describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeFm(instances: Record<string, object> = {}): FleetManager {
  const fm = Object.create(FleetManager.prototype) as FleetManager;
  (fm as any).fleetConfig = { defaults: {}, instances };
  (fm as any).logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  (fm as any).instanceIpcClients = new Map();
  (fm as any).classicChannels = null;
  // Stub downstream dependencies
  (fm as any).backendNameForInstance = () => "claude-code";
  (fm as any).getInstanceDir = () => "/tmp/dev";
  (fm as any).saveFleetConfig = vi.fn();
  (fm as any).restartSingleInstance = vi.fn().mockResolvedValue(undefined);
  (fm as any).effortSuffix = () => "";
  // For pause/wake
  (fm as any).isFleetAdmin = () => true;
  (fm as any).routing = {
    resolve: () => ({ kind: "general", name: "general-instance" }),
  };
  (fm as any).topicCommands = { runPauseWake: vi.fn().mockResolvedValue("ok") };
  (fm as any).getInstanceAdapterId = () => "adapter-1";
  // For profile
  (fm as any).worlds = new Map();
  (fm as any).getAdapterForInstance = () => undefined;
  (fm as any).getGroupIdForInstance = () => "";
  (fm as any).fleetAdminGate = () => "ok";
  (fm as any).startCpuProfile = vi.fn();
  (fm as any).shuttingDown = false;
  return fm;
}

// ── P3a: /model newline / control-char rejection ─────────────────────────────
//
// Reverse mutation: removing `if (/[\x00-\x1f\x7f]/.test(model))` from
// applyModel makes tests 1-3 fail because applyModel proceeds to the
// "not running" path instead of returning the error string.
// (claude-code uses runtime strategy + empty instanceIpcClients → "not running")

describe("applyModel — newline / control-char rejection (#1490 P3a)", () => {
  it("rejects a model name containing a newline (returns error, does not persist)", async () => {
    const fm = makeFm({ dev: {} });
    const saved = (fm as any).saveFleetConfig as ReturnType<typeof vi.fn>;

    const result = await (fm as any).applyModel("dev", "claude-sonnet\nmalicious");

    expect(result).toContain("❌");
    expect(result).not.toMatch(/not running|未在執行/);
    expect(saved).not.toHaveBeenCalled();
  });

  it("rejects a model name containing a carriage return", async () => {
    const fm = makeFm({ dev: {} });
    const saved = (fm as any).saveFleetConfig as ReturnType<typeof vi.fn>;

    const result = await (fm as any).applyModel("dev", "claude-sonnet\rmalicious");

    expect(result).toContain("❌");
    expect(result).not.toMatch(/not running|未在執行/);
    expect(saved).not.toHaveBeenCalled();
  });

  it("rejects a model name containing a NUL byte", async () => {
    const fm = makeFm({ dev: {} });
    const saved = (fm as any).saveFleetConfig as ReturnType<typeof vi.fn>;

    const result = await (fm as any).applyModel("dev", "model\x00name");

    expect(result).toContain("❌");
    expect(result).not.toMatch(/not running|未在執行/);
    expect(saved).not.toHaveBeenCalled();
  });

  it("a clean model name passes the guard and proceeds normally (regression)", async () => {
    const fm = makeFm({ dev: {} });
    const saved = (fm as any).saveFleetConfig as ReturnType<typeof vi.fn>;
    // Simulate a running instance so strategy=runtime proceeds to persist
    (fm as any).instanceIpcClients.set("dev", { connected: true });
    (fm as any).pasteRawToClassicInstance = vi.fn();

    const result = await (fm as any).applyModel("dev", "claude-sonnet-4-5");

    // Guard did NOT fire — result is a success, not the chars error
    expect(result).not.toMatch(/must not contain|不得包含/);
    // The persist path WAS reached (model saved to config)
    expect(saved).toHaveBeenCalled();
  });
});

// ── P3b: handlePauseWakeSlash — prototype-key safety ─────────────────────────
//
// Reverse mutation: changing `Object.hasOwn(this.fleetConfig?.instances ?? {}, requested)`
// back to `this.fleetConfig?.instances[requested]` makes tests 1-2 fail because
// `__proto__`/`constructor` become truthy and runPauseWake is called.

describe("handlePauseWakeSlash: prototype-key safety (#1490 P3b)", () => {
  it("__proto__ instance name → responds instance.not_found, runPauseWake not called", async () => {
    const fm = makeFm({ "real-dev": {} });
    const responses: string[] = [];
    const data = {
      command: "pause",
      channelId: "ch-general",
      channelName: "general",
      userId: "user-1",
      options: { instance: "__proto__" },
      respond: vi.fn(async (text: string) => { responses.push(text); return undefined; }),
    } as any;

    await (fm as any).handlePauseWakeSlash(data, "adapter-1");

    expect(data.respond).toHaveBeenCalled();
    const replied = responses.join(" ");
    expect(replied).toMatch(/not_found|not found|找不到/i);
    expect((fm as any).topicCommands.runPauseWake).not.toHaveBeenCalled();
  });

  it("constructor instance name → responds instance.not_found, runPauseWake not called", async () => {
    const fm = makeFm({ "real-dev": {} });
    const data = {
      command: "pause",
      channelId: "ch-general",
      channelName: "general",
      userId: "user-1",
      options: { instance: "constructor" },
      respond: vi.fn(async () => undefined),
    } as any;

    await (fm as any).handlePauseWakeSlash(data, "adapter-1");

    expect((fm as any).topicCommands.runPauseWake).not.toHaveBeenCalled();
  });

  it("own 'constructor' instance IS found and reaches runPauseWake (positive control)", async () => {
    const fm = makeFm({ "constructor": {} });
    const data = {
      command: "pause",
      channelId: "ch-general",
      channelName: "general",
      userId: "user-1",
      options: { instance: "constructor" },
      respond: vi.fn(async () => undefined),
    } as any;
    (fm as any).getInstanceAdapterId = () => "adapter-1";

    await (fm as any).handlePauseWakeSlash(data, "adapter-1");

    expect((fm as any).topicCommands.runPauseWake).toHaveBeenCalledWith("constructor", "pause");
  });
});

// ── P3b: handleGeneralProfile — prototype-key safety ─────────────────────────
//
// Reverse mutation: removing `Object.hasOwn(this.fleetConfig?.instances ?? {}, general)`
// from the guard makes test 4 fail because the inherited entry is found,
// ownerId lookup returns "adapter-1", and the handler proceeds past the guard —
// reaching profile.unavailable instead of profile.general_only.
// With the fix, Object.hasOwn returns false for inherited keys → profile.general_only.

describe("handleGeneralProfile: prototype-key safety (#1490 P3b)", () => {
  it("inherited general_topic not treated as an own instance → profile.general_only, no CPU profile", async () => {
    const proto = { general: { general_topic: true, topic_id: "T" } };
    const instances = Object.create(proto) as Record<string, object>;
    const fm = makeFm(instances);
    const responses: string[] = [];
    const respond = vi.fn(async (text: string) => { responses.push(text); });

    await (fm as any).handleGeneralProfile("general", "user-1", "adapter-1", 60, respond);

    expect(respond).toHaveBeenCalled();
    // The actual localised string from t("profile.general_only")
    expect(responses.join(" ")).toMatch(/available only in General|僅限 General/i);
    expect((fm as any).startCpuProfile).not.toHaveBeenCalled();
  });

  // Positive control: own 'general' instance passes the own-key guard.
  //
  // The inert rig has getAdapterForInstance → undefined and getGroupIdForInstance → "".
  // After the own-key guard passes, the handler checks ownerId, gate, adapter,
  // and group. With no adapter/group, it returns profile.unavailable — confirming
  // the handler advanced PAST profile.general_only (the guard was not overreached).
  //
  // Reverse mutation: change `Object.hasOwn(…, general)` to always return false
  // (overreject) → own 'general' also hits profile.general_only instead of
  // profile.unavailable → this assertion fails.

  it("own 'general' instance passes the guard → response is profile.unavailable, NOT profile.general_only", async () => {
    const fm = makeFm({ general: { general_topic: true, topic_id: "T" } });
    const responses: string[] = [];
    const respond = vi.fn(async (text: string) => { responses.push(text); });

    await (fm as any).handleGeneralProfile("general", "user-1", "adapter-1", 60, respond);

    const replied = responses.join(" ");
    // The guard did NOT fire — handler reached the adapter/group check and returned
    // profile.unavailable (not the ownership error)
    expect(replied).toMatch(/unavailable|無法/i);
    expect(replied).not.toMatch(/available only in General|僅限 General/i);
  });
});
