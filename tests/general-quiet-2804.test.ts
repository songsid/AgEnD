/**
 * #2804 (the user's decision): on a normal day General shows only tips and update notices. This file covers part 2:
 * the 21:00 daily report is off unless `daily_summary.enabled: true`, while the daily clock it shares with log and inbox
 * rotation keeps running; the task board's daily summary is gone, and an old `summary_at` is accepted and ignored.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DAILY_SUMMARY } from "../src/config.js";
import { DailySummary } from "../src/daily-summary.js";
import { validateFleetConfig } from "../src/config-validator.js";

afterEach(() => { vi.useRealTimers(); });

/** One firing of the daily clock, at 21:00 UTC. */
async function fireOnce(enabled: boolean) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T20:59:00Z"));
  const got: Array<string | null> = [];
  const text = vi.fn(() => "📊 Daily Report — test");
  const clock = new DailySummary({ enabled, hour: 21, minute: 0 }, "UTC", (t) => { got.push(t); }, text);
  clock.start();
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  clock.stop();
  return { got, built: text.mock.calls.length };
}

describe("#2804: the daily report is off by default; its clock still runs", () => {
  it("the default is off", () => {
    expect(DEFAULT_DAILY_SUMMARY.enabled).toBe(false);
  });
  it("off: the clock still fires (rotation rides on it) but builds and hands on no report", async () => {
    expect(await fireOnce(false)).toEqual({ got: [null], built: 0 });
  });
  it("on (explicit `daily_summary.enabled: true`): the report is built and handed on, as before", async () => {
    expect(await fireOnce(true)).toEqual({ got: ["📊 Daily Report — test"], built: 1 });
  });
  it("the fleet posts only a report and rotates logs and inboxes on every firing", () => {
    const src = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    const at = src.indexOf("this.dailySummary = new DailySummary(");
    const body = src.slice(at, src.indexOf("}, () => {", at));
    expect(body).toContain("if (text !== null) this.postDailySummary(text);");
    for (const call of ["this.classicChannels?.rotateLogs();", "this.rotateInboxes();", "this.rotateFleetLogs();", "this.rotateAllInstanceLogs();"]) {
      expect(body, call).toMatch(new RegExp(`\\n\\s*${call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  });
});

describe("#2804: the task board's daily summary is gone", () => {
  it("no clock, no post, no module", () => {
    const src = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/TaskBoardSummaryClock|postTaskBoardSummary|task-board-summary/);
    expect(() => readFileSync(new URL("../src/task-board-summary.ts", import.meta.url))).toThrow();
  });
  it.each([["09:00"], ["off"], ["not a time"], [7]])("an old defaults.task_board.summary_at of %j loads without an error", (value) => {
    const r = validateFleetConfig({ defaults: { task_board: { summary_at: value } }, instances: {} });
    expect(r.errors.filter((e) => /task_board/.test(JSON.stringify(e)))).toEqual([]);
    expect(r.warnings.filter((e) => /task_board/.test(JSON.stringify(e)))).toEqual([]);
  });
});

describe("#2804 (Prism P2): `agend init` keeps the report off unless asked", () => {
  const rl = (answer: string) => ({ question: async () => answer }) as never;
  it("Enter at \"Enable daily summary report?\" means no; an explicit yes still turns it on", async () => {
    const { confirm, buildFleetConfig } = await import("../src/setup-wizard.js");
    const src = readFileSync(new URL("../src/setup-wizard.ts", import.meta.url), "utf8");
    expect(src).toContain('confirm(rl, "Enable daily summary report?", DEFAULT_DAILY_SUMMARY.enabled)');
    expect(await confirm(rl(""), "Enable daily summary report?", DEFAULT_DAILY_SUMMARY.enabled)).toBe(false);
    expect(await confirm(rl("y"), "Enable daily summary report?", DEFAULT_DAILY_SUMMARY.enabled)).toBe(true);
    const off = buildFleetConfig({ channelType: "telegram", backend: "claude-code", botTokenEnv: "AGEND_BOT_TOKEN", groupId: -1,
      channelMode: "topic", accessMode: "locked", allowedUsers: [1], projectRoots: ["/tmp/p"], instances: [],
      costGuard: { enabled: false }, dailySummary: { enabled: false } });
    expect((off.defaults as Record<string, unknown> | undefined)?.daily_summary).toBeUndefined();
  });
});
