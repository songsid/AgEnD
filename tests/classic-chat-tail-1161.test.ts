import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Count what is read through readSync (log-tail's only read path): the point is HOW MUCH, not just what.
const reads = vi.hoisted(() => ({ bytes: 0, calls: 0 }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, readSync: ((...args: Parameters<typeof real.readSync>) => {
    const n = (real.readSync as (...a: unknown[]) => number)(...args);
    reads.bytes += n; reads.calls++;
    return n;
  }) as typeof real.readSync };
});
import { FleetManager } from "../src/fleet-manager.js";

/** #1161 (D4): the Classic ingress context read is bounded, whatever size the day's log has grown to. */
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-chat-tail-"));
  vi.stubEnv("AGEND_HOME", home);
  vi.stubEnv("TZ", "UTC");
  reads.bytes = 0; reads.calls = 0;
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

function todaysLog(instance: string, text: string): void {
  const dir = join(home, "workspaces", instance, "chat-logs");
  mkdirSync(dir, { recursive: true });
  const today = new Date().toLocaleString("sv-SE", { timeZone: "UTC", hour12: false }).slice(0, 10);
  writeFileSync(join(dir, `${today}.log`), text);
}
const entry = (i: number) => `[2026-10-04T10:${String(i % 60).padStart(2, "0")}:00.000Z] <user${i}> message number ${i} ${"padding ".repeat(8)}`;

describe("getRecentChatLog", () => {
  it("a day's log of many megabytes costs one 64 KiB block, and yields the same context", () => {
    const entries = Array.from({ length: 30_000 }, (_, i) => entry(i));            // ≈ 2.5 MB
    todaysLog("classic-big", entries.join("\n") + "\n");
    const fm = new FleetManager(home) as any;
    const context = fm.getRecentChatLog("classic-big", 5) as string;
    // the newest entry is the triggering message and is left out; the five before it are the context
    expect(context.split("\n")).toEqual(entries.slice(-6, -1));
    expect(reads.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(reads.calls).toBeLessThanOrEqual(2);
  });

  it("a small log is still read whole and answers the same", () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(i));
    todaysLog("classic-small", entries.join("\n") + "\n");
    const fm = new FleetManager(home) as any;
    expect((fm.getRecentChatLog("classic-small", 10) as string).split("\n")).toEqual(entries.slice(0, -1));
  });

  it("a multi-line trigger message is excluded in full", () => {
    const entries = Array.from({ length: 200 }, (_, i) => entry(i));
    const trigger = `${entry(999)}\nsecond line of the trigger\nthird line`;
    todaysLog("classic-multi", [...entries, trigger].join("\n") + "\n");
    const fm = new FleetManager(home) as any;
    expect((fm.getRecentChatLog("classic-multi", 3) as string).split("\n")).toEqual(entries.slice(-3));
  });

  it("no log today, or only the trigger: nothing", () => {
    const fm = new FleetManager(home) as any;
    expect(fm.getRecentChatLog("classic-none", 5)).toBeUndefined();
    todaysLog("classic-one", entry(1) + "\n");
    expect(fm.getRecentChatLog("classic-one", 5)).toBeUndefined();
  });
});
