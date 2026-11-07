import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { getUsageSnapshot, onUsageSnapshot, setUsageFetcherForTests } from "../src/usage/usage-api.js";

const dirs: string[] = [], stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(s => s()); setUsageFetcherForTests(null); vi.unstubAllEnvs(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "agend-quota-wire-")); dirs.push(dir); return dir; };

describe("quota reminder integration", () => {
  it("uses current agent bindings and shared-profile rules without requiring General to be running", () => {
    const fm = Object.create(FleetManager.prototype) as any;
    fm.fleetConfig = { defaults: { quota_notice: { thresholds: [10] } }, instances: {
      general: { general_topic: true, topic_id: 1 }, muted: { quota_notice: { enabled: false } }, worker: { quota_notice: { thresholds: [5] } },
    } };
    fm.activeBackendBindings = () => [["muted", "codex", "work"], ["worker", "codex", "work"]];
    fm.webOnlyPromptPlace = () => null;
    fm.getInstanceAdapterId = () => "fixture"; fm.getChannelConfig = () => ({ group_id: "fixture-group" }); fm.getAdapterForInstance = () => ({});
    const policy = fm.quotaNoticePolicy();
    expect(policy.target).toBe("general");
    expect(policy.subscriptions.map((s: any) => [s.account, s.providerId, s.rule.enabled, s.rule.thresholds])).toEqual([
      ["codex:host:work", "codex:work", false, [10]], ["codex:host:work", "codex:work", true, [5]],
    ]);
    fm.fleetConfig.defaults.quota_notice.target = "missing";
    expect(fm.quotaNoticePolicy().target).toBe("");
    fm.classicChannels = { getQuotaNoticeByInstance: () => ({ enabled: false }) };
    fm.activeBackendBindings = () => [["classic-one", "codex", "work"]];
    expect(fm.quotaNoticePolicy().subscriptions[0].rule.enabled).toBe(false);
    fm.shuttingDown = true;
    expect(fm.quotaNoticePolicy().subscriptions).toEqual([]);
  });
  it("does not treat Windows or paired-machine credentials as the local usage account", () => {
    const fm = Object.create(FleetManager.prototype) as any;
    fm.fleetConfig = { defaults: {}, instances: { general: { general_topic: true, topic_id: 1 },
      local: { backend: "codex", runtime: "windows" }, paired: { backend: "codex", runtime: "wsl", machine_id: "fixture-pc" }, host: { backend: "codex" } } };
    fm.getInstanceStatus = () => "running";
    fm.webOnlyPromptPlace = () => null; fm.getInstanceAdapterId = () => "fixture";
    fm.getChannelConfig = () => ({ group_id: "fixture-group" }); fm.getAdapterForInstance = () => ({});
    expect(fm.quotaNoticePolicy().subscriptions).toHaveLength(2); // General's Claude login plus host Codex.
    expect(fm.quotaNoticePolicy().subscriptions.map((s: any) => s.account)).toEqual(["claude-code:host:", "codex:host:"]);
  });
  it("feeds completed cache reads once, isolates observer failure, and does not refetch on cache hits", async () => {
    vi.stubEnv("AGEND_HOME", scratch());
    const observer = vi.fn(), fetch = vi.fn(async () => ({ fetchedAt: new Date().toISOString(), providers: [] }));
    setUsageFetcherForTests(fetch);
    stops.push(onUsageSnapshot(() => { throw new Error("isolated observer"); }), onUsageSnapshot(observer));
    await getUsageSnapshot(); await getUsageSnapshot();
    expect(observer).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not offer an in-flight reading to reminders after its config source changes", async () => {
    const home = scratch(); vi.stubEnv("AGEND_HOME", home);
    writeFileSync(join(home, "fleet.yaml"), "defaults: {}\n");
    let release!: (value: { fetchedAt: string; providers: [] }) => void;
    let calls = 0;
    setUsageFetcherForTests(() => ++calls === 1 ? new Promise(r => { release = r; }) : Promise.resolve({ fetchedAt: "2026-11-08T00:00:00Z", providers: [] }));
    const observer = vi.fn(); stops.push(onUsageSnapshot(observer));
    const pending = getUsageSnapshot();
    writeFileSync(join(home, "fleet.yaml"), "defaults: { backend: codex }\n");
    release({ fetchedAt: new Date().toISOString(), providers: [] }); await pending;
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0]![0].fetchedAt).toBe("2026-11-08T00:00:00Z");
  });
});
