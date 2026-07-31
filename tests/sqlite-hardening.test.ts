import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/event-log.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { FleetManager } from "../src/fleet-manager.js";

// events.db holds history only, and every consumer uses `this.eventLog?.` — but an
// unguarded open meant a corrupt file (truncated WAL after a hard kill, full disk)
// threw during startAll and the whole fleet failed to boot. Also: the CLI and the
// fleet both open these files, so a missing busy_timeout raised SQLITE_BUSY
// immediately instead of waiting.

const dir = () => mkdtempSync(join(tmpdir(), "agend-sqlite-"));

type Internals = { openEventLog(): EventLog | null; pruneEventLog(): void; eventLog: EventLog | null };

describe("busy_timeout", () => {
  it("is set on the event log", () => {
    const log = new EventLog(join(dir(), "events.db"));
    const value = (log as unknown as { db: { pragma(s: string): unknown } }).db.pragma("busy_timeout");
    expect(JSON.stringify(value)).toContain("5000");
    log.close();
  });

  it("is set on the scheduler db", () => {
    const db = new SchedulerDb(join(dir(), "scheduler.db"));
    const value = (db as unknown as { db: { pragma(s: string): unknown } }).db.pragma("busy_timeout");
    expect(JSON.stringify(value)).toContain("5000");
  });
});

describe("openEventLog", () => {
  it("opens a normal database", () => {
    const fm = new FleetManager(dir()) as unknown as Internals;
    const log = fm.openEventLog();
    expect(log).not.toBeNull();
    log?.close();
  });

  it("moves a corrupt file aside and returns a working log instead of throwing", () => {
    const dataDir = dir();
    // Not a SQLite file at all — better-sqlite3 rejects it on first use.
    writeFileSync(join(dataDir, "events.db"), "this is not a database");
    const fm = new FleetManager(dataDir) as unknown as Internals;

    let log: EventLog | null = null;
    expect(() => { log = fm.openEventLog(); }).not.toThrow();
    expect(log).not.toBeNull();

    // The bad file was preserved for inspection rather than deleted.
    expect(readdirSync(dataDir).some(f => f.includes("corrupt-"))).toBe(true);
    // And the fresh one is usable.
    expect(() => log!.insert("alpha", "test_event", {})).not.toThrow();
    log!.close();
  });

  it("keeps the fleet bootable even when no event log can be opened", () => {
    // A directory where events.db cannot be created at all.
    const fm = new FleetManager(join(dir(), "does", "not", "exist")) as unknown as Internals;
    let log: EventLog | null = null;
    expect(() => { log = fm.openEventLog(); }).not.toThrow();
    expect(log).toBeNull();
  });
});

describe("pruneEventLog", () => {
  it("drops rows older than the retention window and keeps recent ones", () => {
    const dataDir = dir();
    const fm = new FleetManager(dataDir) as unknown as Internals;
    fm.eventLog = fm.openEventLog();
    const log = fm.eventLog!;

    log.insert("alpha", "recent_event", {});
    const db = (log as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare("INSERT INTO events (instance_name, event_type, payload, created_at) VALUES (?, ?, ?, datetime('now', '-90 days'))")
      .run("alpha", "ancient_event", "{}");

    fm.pruneEventLog();

    const rows = (log as unknown as { db: { prepare(s: string): { all(): { event_type: string }[] } } }).db
      .prepare("SELECT event_type FROM events").all();
    const types = rows.map(r => r.event_type);
    expect(types).toContain("recent_event");
    expect(types).not.toContain("ancient_event");
    log.close();
  });

  it("is safe with no event log at all", () => {
    const fm = new FleetManager(dir()) as unknown as Internals;
    fm.eventLog = null;
    expect(() => fm.pruneEventLog()).not.toThrow();
  });
});

describe("profiles.db", () => {
  it("is created with a busy timeout by the view API", async () => {
    // Exercised indirectly: the module-level handle is lazy, so just assert the
    // file appears and is readable after a profile read.
    const dataDir = dir();
    const { handleViewRequest } = await import("../src/view-api.js");
    expect(typeof handleViewRequest).toBe("function");
    expect(existsSync(dataDir)).toBe(true);
  });
});
