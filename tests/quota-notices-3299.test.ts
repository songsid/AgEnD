import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaNotices, quotaPeriod, type QuotaNoticePolicy } from "../src/usage/quota-notices.js";
import { quotaNoticeProblem, quotaNoticeRule } from "../src/quota-notice-config.js";
import type { UsagePayload } from "../src/usage/usage-api.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { getEffectiveInstanceDefaults } from "../src/config.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const START = Date.parse("2026-11-07T00:00:00Z"), WEEK = 7 * 86_400_000;
async function rig() {
  const home = await mkdtemp(join(tmpdir(), "agend-quota-3299-")); dirs.push(home);
  let now = START;
  let policy: QuotaNoticePolicy = { target: "general", locale: "en", subscriptions: [{ account: "codex:host:", providerId: "codex", rule: quotaNoticeRule(undefined, "codex") }] };
  const send = vi.fn((_target: string, _text: string) => true), warn = vi.fn();
  const file = join(home, "notices.json");
  const service = (persist?: (file: string, state: string) => Promise<void>) => new QuotaNotices({ file, policy: () => policy, send, warn, now: () => now, persist });
  const payload = (used = 92, reset = START + WEEK): UsagePayload => ({ fetchedAt: new Date(now).toISOString(), providers: [{ id: "codex", name: "Codex", status: "ok", metrics: [{ label: "Weekly", type: "percent", used, windowMs: WEEK, resetsAt: new Date(reset).toISOString() }] }] });
  return { home, file, send, warn, service, payload, policy: () => policy, setPolicy: (v: QuotaNoticePolicy) => { policy = v; }, advance: (ms: number) => { now += ms; } };
}
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

describe("account quota reminders", () => {
  it("defaults to enabled, 10 percent remaining weekly; no daemon-wide inherited field", () => {
    expect(quotaNoticeRule(undefined, "codex")).toEqual({ enabled: true, thresholds: [10], periods: ["weekly"] });
    expect(getEffectiveInstanceDefaults({ quota_notice: { enabled: false, target: "general" } })).not.toHaveProperty("quota_notice");
    expect(buildSettingsImpactSchema().impacts["instance.quota_notice"]).toBe("now");
  });
  it("validates defaults and narrower overrides without hidden control/secret fields", () => {
    const settings = { enabled: true, thresholds: [50, 10], periods: ["weekly"], target: "general", backends: { "kiro-cli": { periods: ["monthly"] } } };
    expect(quotaNoticeProblem(settings, true)).toBeNull();
    expect(quotaNoticeProblem(settings)).not.toBeNull();
    for (const v of [{ thresholds: [NaN] }, { thresholds: [0] }, { thresholds: [100] }, { thresholds: [10, 10] }, { periods: ["week"] }, { periods: ["weekly", "weekly"] }, { enabled: "false" }, { password: "private" }, { backends: { unknown: {} } }]) expect(quotaNoticeProblem(v, true)).not.toBeNull();
    expect(validateFleetConfig({ defaults: { quota_notice: settings }, instances: { worker: { working_directory: "/tmp", quota_notice: { enabled: false } } } }).errors).toEqual([]);
    expect(validateFleetConfig({ instances: { worker: { working_directory: "/tmp", quota_notice: { target: "other" } } } }).errors).toContainEqual(expect.objectContaining({ path: "instances.worker.quota_notice" }));
  });
  it("accepts only the exact validated Settings preference subtree as immediate", () => {
    const before = { fleet: { defaults: {}, instances: { worker: { working_directory: "/tmp" } } } };
    expect(settingsChangeDiff(before, { fleet: { ...before.fleet, defaults: { quota_notice: { enabled: false, backends: { codex: { thresholds: [5] } } } } } }, { operation: "quota" })).toBeNull();
    expect(() => settingsChangeDiff(before, { fleet: { ...before.fleet, defaults: { quota_notice: { password: "secret" } } } }, { operation: "quota" })).toThrow();
  });
  it("replaces backend/agent arrays rather than intersecting or muting sibling agents", () => {
    expect(quotaNoticeRule({ enabled: false, periods: ["weekly"], backends: { codex: { periods: ["session"], thresholds: [25] } } }, "codex", { enabled: true, thresholds: [5] })).toEqual({ enabled: true, thresholds: [5], periods: ["session"] });
    expect(quotaNoticeRule({ thresholds: "10" } as never, "codex")).toEqual({ enabled: false, thresholds: [], periods: [] });
  });
  it("serializes shared-account observations, persists before send, and dedups across restart and target changes", async () => {
    const r = await rig();
    r.setPolicy({ ...r.policy(), subscriptions: [r.policy().subscriptions[0]!, r.policy().subscriptions[0]!] });
    const service = r.service();
    await Promise.all([service.observe(r.payload()), service.observe(r.payload())]);
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.send).toHaveBeenCalledWith("general", expect.stringContaining("Weekly: 8% remaining"));
    expect((await stat(r.file)).mode & 0o777).toBe(0o600);
    await service.stop();
    r.setPolicy({ ...r.policy(), target: "another" });
    await r.service().observe(r.payload());
    expect(r.send).toHaveBeenCalledTimes(1);
  });
  it("enabled agents union only their own period/threshold pairs", async () => {
    const r = await rig(), first = r.policy().subscriptions[0]!;
    r.setPolicy({ ...r.policy(), subscriptions: [
      { ...first, rule: { enabled: false, thresholds: [99], periods: ["weekly"] } },
      { ...first, rule: { enabled: true, thresholds: [25], periods: ["session"] } },
      { ...first, rule: { enabled: true, thresholds: [5], periods: ["weekly"] } },
    ] });
    const service = r.service(); await service.observe(r.payload(90));
    expect(r.send).not.toHaveBeenCalled();
    await service.observe(r.payload(96)); expect(r.send).toHaveBeenCalledTimes(1);
  });
  it("bundles pools/model windows; consumes higher thresholds and only announces a lower crossing", async () => {
    const r = await rig(); r.policy().subscriptions[0]!.rule.thresholds = [50, 25, 10, 5];
    const p = r.payload(); p.providers[0]!.metrics.push({ ...p.providers[0]!.metrics[0]!, label: "Model weekly", scope: "model" });
    const service = r.service(); await service.observe(p);
    expect(r.send).toHaveBeenCalledTimes(1); expect(r.send.mock.calls[0]![1]).toContain("Model weekly");
    await service.observe(r.payload(80)); await service.observe(r.payload(92)); expect(r.send).toHaveBeenCalledTimes(1);
    await service.observe(r.payload(96)); expect(r.send).toHaveBeenCalledTimes(2);
  });
  it("separates profiles and machine sources", async () => {
    const r = await rig(), first = r.policy().subscriptions[0]!;
    r.setPolicy({ ...r.policy(), subscriptions: [first, { ...first, account: "codex:pc2:", providerId: "codex:other" }] });
    const p = r.payload(); p.providers.push({ ...p.providers[0]!, id: "codex:other", name: "Other profile" });
    await r.service().observe(p); expect(r.send).toHaveBeenCalledTimes(2);
  });
  it("does not replay for reset drift or a premature forward reset; announces after an actual reset", async () => {
    const r = await rig(), s = r.service(); await s.observe(r.payload());
    await s.observe(r.payload(92, START + WEEK + 5 * 60_000));
    await s.observe(r.payload(92, START + 2 * WEEK)); expect(r.send).toHaveBeenCalledTimes(1);
    r.advance(WEEK + 1000); await s.observe(r.payload(92, START + 2 * WEEK)); expect(r.send).toHaveBeenCalledTimes(2);
  });
  it.each(["stale", "error", "unlimited", "expired", "expiry", "unknown-window", "non-percent", "stale-local", "future-local", "bad-number", "old-fetch"])("ignores %s evidence", async mode => {
    const r = await rig(), p = r.payload(), row = p.providers[0]!, m = row.metrics[0]!;
    if (mode === "stale") row.stale = true;
    if (mode === "error") row.status = "error";
    if (mode === "unlimited") row.unlimited = true;
    if (mode === "expired") m.resetsAt = new Date(START - 1).toISOString();
    if (mode === "expiry") m.resetKind = "expiry";
    if (mode === "unknown-window") m.windowMs = null;
    if (mode === "non-percent") m.type = "count";
    if (mode === "stale-local") row.observedAt = new Date(START - 11 * 60_000).toISOString();
    if (mode === "future-local") row.observedAt = new Date(START + 120_000).toISOString();
    if (mode === "bad-number") m.used = NaN;
    if (mode === "old-fetch") p.fetchedAt = new Date(START - 11 * 60_000).toISOString();
    await r.service().observe(p); expect(r.send).not.toHaveBeenCalled();
  });
  it("keeps session separate from hourly and supports explicit monthly semantic metadata", () => {
    expect(quotaPeriod({ label: "Hourly", type: "percent", windowMs: 5 * 3_600_000 })).toBe("session");
    expect(quotaPeriod({ label: "Credits", type: "percent", quotaPeriod: "monthly" })).toBe("monthly");
  });
  it.each(["policy", "stop"])("fences %s changes while dispatch reservation is writing", async mode => {
    const r = await rig(), entered = gate(), held = gate();
    const s = r.service(async (file, state) => { entered.release(); await held.promise; await writeFile(file, state); });
    const work = s.observe(r.payload()); await entered.promise;
    if (mode === "policy") r.setPolicy({ ...r.policy(), subscriptions: [] }); else void s.stop();
    held.release(); await work; expect(r.send).not.toHaveBeenCalled();
  });
  it("does not dispatch evidence that ages out while durable storage is pending", async () => {
    const r = await rig(), entered = gate(), held = gate();
    const s = r.service(async (file, state) => { entered.release(); await held.promise; await writeFile(file, state); });
    const work = s.observe(r.payload()); await entered.promise;
    r.advance(11 * 60_000); held.release(); await work;
    expect(r.send).not.toHaveBeenCalled();
  });
  it("holds storage failures and corrupt state, without resetting to empty", async () => {
    const r = await rig(); await r.service(async () => { throw new Error("disk full"); }).observe(r.payload());
    expect(r.send).not.toHaveBeenCalled(); expect(r.warn).toHaveBeenCalledTimes(1);
    await writeFile(r.file, "broken"); await r.service().observe(r.payload()); expect(r.send).not.toHaveBeenCalled();
  });
  it("does not retry an unknown external dispatch outcome", async () => {
    const r = await rig(); r.send.mockImplementation(() => { throw new Error("unknown"); });
    await r.service().observe(r.payload());
    expect(Object.keys(JSON.parse(await readFile(r.file, "utf8")).entries)).toHaveLength(1);
    await r.service().observe(r.payload()); expect(r.send).toHaveBeenCalledTimes(1);
  });
});
