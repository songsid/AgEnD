/**
 * #1490 P3b: instance lookups via user input must use Object.hasOwn.
 *
 * Tests call the real handlers (handlePauseWakeSlash, handleGeneralProfile)
 * with inert effects. Each test has a reverse-mutation note proving that
 * removing the production guard compiles and makes the assertion fail.
 */
import { describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

// ── minimal fleet manager ─────────────────────────────────────────────────────

function makeFm(instances: Record<string, object>) {
  const fm = Object.create(FleetManager.prototype) as FleetManager;
  (fm as any).fleetConfig = { defaults: {}, instances };
  (fm as any).logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  (fm as any).classicChannels = null; // no ClassicBot channel shortcut
  (fm as any).isFleetAdmin = () => true; // skip admin checks
  (fm as any).routing = {
    resolve: (channelId: string) => ({ kind: "general", name: "general-instance" }),
  };
  (fm as any).topicCommands = { runPauseWake: vi.fn().mockResolvedValue("ok") };
  (fm as any).getInstanceAdapterId = () => "adapter-1";
  (fm as any).worlds = new Map();
  (fm as any).getAdapterForInstance = () => undefined;
  (fm as any).getGroupIdForInstance = () => "";
  (fm as any).fleetAdminGate = () => "ok";
  (fm as any).startCpuProfile = vi.fn();
  (fm as any).shuttingDown = false;
  return fm;
}

function makeSlashData(instance: string, adapterId = "adapter-1") {
  const responses: string[] = [];
  return {
    data: {
      command: "pause",
      channelId: "ch-general",
      channelName: "general",
      userId: "user-1",
      options: { instance },
      respond: vi.fn(async (text: string) => { responses.push(text); return undefined; }),
    } as any,
    responses,
    adapterId,
  };
}

// ── P3b-1: handlePauseWakeSlash — __proto__ must be "not found" ──────────────
//
// Reverse mutation: changing `Object.hasOwn(this.fleetConfig?.instances ?? {}, requested)`
// back to `this.fleetConfig?.instances[requested]` causes test 1 to fail because
// instances['__proto__'] is the Object prototype (truthy), so the not_found
// branch is skipped, runPauseWake is called, and the response is "ok" not
// containing "not_found". (Test 2 ensures runPauseWake is NOT called at all.)

describe("handlePauseWakeSlash: prototype-key safety (#1490 P3b)", () => {
  it("__proto__ instance name → responds instance.not_found, runPauseWake not called", async () => {
    const fm = makeFm({ "real-dev": {} });
    const { data, responses } = makeSlashData("__proto__");

    await (fm as any).handlePauseWakeSlash(data, "adapter-1");

    // Must respond with the "not found" message, not proceed to runPauseWake
    expect(data.respond).toHaveBeenCalled();
    const replied = responses.join(" ");
    expect(replied).toMatch(/not_found|not found|找不到/i);
    expect((fm as any).topicCommands.runPauseWake).not.toHaveBeenCalled();
  });

  it("constructor instance name → responds instance.not_found, runPauseWake not called", async () => {
    const fm = makeFm({ "real-dev": {} });
    const { data } = makeSlashData("constructor");

    await (fm as any).handlePauseWakeSlash(data, "adapter-1");

    expect((fm as any).topicCommands.runPauseWake).not.toHaveBeenCalled();
  });

  it("own 'constructor' instance name IS found and reaches runPauseWake (positive control)", async () => {
    // If someone actually names their instance "constructor", it must work.
    const fm = makeFm({ "constructor": {} });
    const { data } = makeSlashData("constructor");
    // getInstanceAdapterId returns adapter-1 = adapterId, so it proceeds
    (fm as any).getInstanceAdapterId = () => "adapter-1";

    await (fm as any).handlePauseWakeSlash(data, "adapter-1");

    expect((fm as any).topicCommands.runPauseWake).toHaveBeenCalledWith("constructor", "pause");
  });
});

// ── P3b-2: handleGeneralProfile — inherited general_topic not treated as owned ─
//
// handleGeneralProfile's existing `general_topic` check would also reject
// __proto__ (Object.prototype has no general_topic), so the P3b fix here is
// defence-in-depth: it enforces own-key membership BEFORE the property lookup.
//
// Reverse mutation: removing `Object.hasOwn(this.fleetConfig?.instances ?? {}, general)`
// from the guard does NOT change the outcome for Object.prototype (no general_topic),
// but it does change the outcome for an inherited entry that HAS a general_topic.
// We test with an Object.create prototype chain that carries general_topic.
// Without the fix: `instances[general]` walks the prototype and finds the entry,
// ownerId lookup succeeds (mocked), and startCpuProfile is called.
// With the fix: Object.hasOwn returns false → profile.general_only, startCpuProfile not called.

describe("handleGeneralProfile: prototype-key safety (#1490 P3b)", () => {
  it("inherited general_topic not treated as an own instance → profile.general_only, no CPU profile", async () => {
    // Create instances object whose prototype has a 'general' key with general_topic
    const proto = { general: { general_topic: true, topic_id: "T" } };
    const instances = Object.create(proto) as Record<string, object>;
    const fm = makeFm(instances);
    const responses: string[] = [];
    const respond = vi.fn(async (text: string) => { responses.push(text); });

    await (fm as any).handleGeneralProfile("general", "user-1", "adapter-1", 60, respond);

    // Must return profile.general_only, not proceed to startCpuProfile
    expect(respond).toHaveBeenCalled();
    const replied = responses.join(" ");
    expect(replied).toMatch(/available only in General|general_only|不在/i);
    expect((fm as any).startCpuProfile).not.toHaveBeenCalled();
  });

  it("own 'general' instance with general_topic proceeds past the guard (positive control)", async () => {
    // An owned General entry should proceed past the own-key check.
    const fm = makeFm({ general: { general_topic: true, topic_id: "T" } });
    const responses: string[] = [];
    const respond = vi.fn(async (text: string) => { responses.push(text); });
    // Stub: ownerId matches, gate ok, but adapter/group are absent → profile.unavailable
    // The key assertion: the check does NOT return profile.general_only for own keys.
    (fm as any).fleetAdminGate = () => "ok";

    await (fm as any).handleGeneralProfile("general", "user-1", "adapter-1", 60, respond);

    // profile.general_only must NOT have been the response (own key passed the guard)
    const replied = responses.join(" ");
    expect(replied).not.toMatch(/general_only/);
  });
});
