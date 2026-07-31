import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

// The inbound dedup set is what makes it safe for the Telegram adapter to stop
// dropping pending updates (drop_pending_updates: false). If it did not survive a
// restart, every update Telegram replays after downtime would be handled twice.
// These tests pin the persistence contract without booting a fleet.

type Internals = {
  recentMessageIds: Set<string>;
  recentMessageIdsDirty: boolean;
  loadRecentMessageIds(): void;
  saveRecentMessageIds(): void;
  recentInboundPath(): string;
};

function fm(dataDir: string) {
  return new FleetManager(dataDir) as unknown as Internals;
}

describe("inbound dedup persistence", () => {
  it("round-trips keys through the state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-dedup-"));
    const a = fm(dir);
    a.recentMessageIds.add("telegram:123:456");
    a.recentMessageIds.add("discord:9:8");
    a.recentMessageIdsDirty = true;
    a.saveRecentMessageIds();

    expect(existsSync(join(dir, "recent-inbound.json"))).toBe(true);

    const b = fm(dir);
    b.loadRecentMessageIds();
    expect(b.recentMessageIds.has("telegram:123:456")).toBe(true);
    expect(b.recentMessageIds.has("discord:9:8")).toBe(true);
  });

  it("skips the write when nothing changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-dedup-"));
    const a = fm(dir);
    a.recentMessageIds.add("telegram:1:1");
    a.recentMessageIdsDirty = false;
    a.saveRecentMessageIds();
    expect(existsSync(join(dir, "recent-inbound.json"))).toBe(false);
  });

  it("survives a corrupt state file instead of throwing", () => {
    // Losing dedup for one restart is acceptable; failing to boot is not.
    const dir = mkdtempSync(join(tmpdir(), "agend-dedup-"));
    writeFileSync(join(dir, "recent-inbound.json"), "{not json");
    const a = fm(dir);
    expect(() => a.loadRecentMessageIds()).not.toThrow();
    expect(a.recentMessageIds.size).toBe(0);
  });

  it("ignores a well-formed file of the wrong shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-dedup-"));
    writeFileSync(join(dir, "recent-inbound.json"), JSON.stringify({ nope: true }));
    const a = fm(dir);
    expect(() => a.loadRecentMessageIds()).not.toThrow();
    expect(a.recentMessageIds.size).toBe(0);
  });

  it("keeps only string keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-dedup-"));
    writeFileSync(join(dir, "recent-inbound.json"), JSON.stringify(["ok:1:2", 42, null, { a: 1 }]));
    const a = fm(dir);
    a.loadRecentMessageIds();
    expect([...a.recentMessageIds]).toEqual(["ok:1:2"]);
  });

  it("writes a bounded array (the FIFO cap is respected by the caller)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-dedup-"));
    const a = fm(dir);
    for (let i = 0; i < 50; i++) a.recentMessageIds.add(`telegram:1:${i}`);
    a.recentMessageIdsDirty = true;
    a.saveRecentMessageIds();
    const parsed = JSON.parse(readFileSync(join(dir, "recent-inbound.json"), "utf-8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(50);
  });
});
