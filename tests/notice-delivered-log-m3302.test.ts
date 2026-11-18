/**
 * M-3302 (#4146): a delivered notice leaves one log line. Before, only failures were logged, so after the 22-minute outage
 * nobody could tell from daemon.log whether the person had been told. The line names the instance (or "Fleet notice" for
 * the fallback channel) and the notice's first line, places as plain text, at most 100 characters.
 * Harness: tests/fleet-notice-target.test.ts's (real FleetManager, adapters with a stubbed sendText).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FleetManager, noticePreview } from "../src/fleet-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("M-3302: a delivered notice is logged", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-3302-notice-")); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  function makeFleet(instances: Record<string, any>, send: () => Promise<unknown>) {
    const fm = new FleetManager(dir) as any;
    const cfg = { id: "telegram", type: "telegram", mode: "topic", group_id: "-100777" };
    fm.fleetConfig = { defaults: {}, channels: [cfg], instances };
    fm.worlds.set(cfg.id, { id: cfg.id, adapter: { id: cfg.id, sendText: vi.fn(send) }, channelConfig: cfg, groupId: cfg.group_id });
    fm.adapter = fm.worlds.get(cfg.id).adapter;
    return fm;
  }
  const flush = () => new Promise(r => setImmediate(r));

  it("an instance topic notice: one info line once the platform took it, with the instance and the first line", async () => {
    const fm = makeFleet({ gen: { general_topic: true, topic_id: "42" } }, async () => ({}));
    const info = vi.spyOn(fm.logger, "info");
    expect(fm.notifyInstanceTopic("gen", "⚠️ 11 instance(s) cannot start: a, b\n`claude` is not installed")).toBe(true);
    await flush();
    const lines = info.mock.calls.filter(c => c[1] === "Notice delivered");
    expect(lines).toEqual([[{ instanceName: "gen", notice: "⚠️ 11 instance(s) cannot start: a, b" }, "Notice delivered"]]);
  });

  it("a fleet error through General is logged the same way", async () => {
    const fm = makeFleet({ gen: { general_topic: true, topic_id: "42" } }, async () => ({}));
    const info = vi.spyOn(fm.logger, "info");
    expect(fm.notifyFleetError("❌ Gave up automatic startup retries for 1 instance(s): a")).toBe(true);
    await flush();
    expect(info.mock.calls.some(c => c[1] === "Notice delivered" && c[0].instanceName === "gen")).toBe(true);
  });

  it("the fallback channel (no General): 'Fleet notice delivered'", async () => {
    const fm = makeFleet({}, async () => ({}));
    const info = vi.spyOn(fm.logger, "info");
    expect(fm.notifyFleetError("⚠️ something")).toBe(true);
    await flush();
    expect(info.mock.calls.filter(c => c[1] === "Fleet notice delivered")).toEqual([[{ notice: "⚠️ something" }, "Fleet notice delivered"]]);
  });

  it("control: a refused send logs the failure, never 'delivered'", async () => {
    const fm = makeFleet({ gen: { general_topic: true, topic_id: "42" } }, async () => { throw new Error("403"); });
    const info = vi.spyOn(fm.logger, "info"), warn = vi.spyOn(fm.logger, "warn");
    fm.notifyInstanceTopic("gen", "hello");
    await flush();
    expect(info.mock.calls.some(c => /delivered/.test(String(c[1])))).toBe(false);
    expect(warn.mock.calls.some(c => c[1] === "Failed to send instance topic notification")).toBe(true);
  });

  it("noticePreview: the first non-empty line, at most 100 characters", () => {
    expect(noticePreview("\n\n  first line  \nsecond")).toBe("first line");
    expect(noticePreview("x".repeat(150))).toBe(`${"x".repeat(99)}…`);
    expect(noticePreview("")).toBe("");
  });
});
