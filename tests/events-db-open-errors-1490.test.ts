import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/event-log.js";
import { FleetManager } from "../src/fleet-manager.js";
import { classifySqliteOpenError } from "../src/sqlite-open-errors.js";

/**
 * #1490 (2.2 audit): openEventLog renamed events.db away on ANY open error. A lock held by `agend events`, a driver
 * built for another Node (ABI), or a permission problem therefore discarded a healthy history file. Only a file SQLite
 * proved corrupt may be moved aside; everything else is left in place and reported.
 *
 * Real better-sqlite3 against scratch files; the busy timeout is shortened through the fleet's own field.
 */

type Internals = { openEventLog(): EventLog | null; eventLogBusyTimeoutMs: number; notifyFleetError(text: string): boolean };

const dir = () => mkdtempSync(join(tmpdir(), "agend-eventsdb-1490-"));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const moved = (d: string) => readdirSync(d).filter(f => f.includes(".corrupt-"));

/** A real, healthy events.db with one row of history. */
function healthyEventsDb(d: string): string {
  const path = join(d, "events.db");
  const log = new EventLog(path);
  log.insert("alpha", "history_row", { keep: true });
  log.close();
  return path;
}

function fleet(d: string) {
  const fm = new FleetManager(d) as unknown as Internals;
  fm.eventLogBusyTimeoutMs = 50;
  const notices: string[] = [];
  fm.notifyFleetError = (text: string) => { notices.push(text); return true; };
  return { fm, notices };
}

const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const o of opened.splice(0)) { try { o.close(); } catch { /* already closed */ } } });

describe("events.db open errors that are not corruption leave the file in place", () => {
  it("a lock held past the busy timeout: not moved, null, reported", () => {
    const d = dir();
    const path = healthyEventsDb(d);
    const holder = new Database(path);
    opened.push(holder);
    // Another connection mid-write with an exclusive lock: in WAL mode only locking_mode=EXCLUSIVE plus a write keeps
    // a second connection out entirely (a plain BEGIN EXCLUSIVE still lets readers and no-op DDL through).
    holder.pragma("locking_mode = EXCLUSIVE");
    holder.exec("BEGIN EXCLUSIVE; INSERT INTO events (instance_name, event_type) VALUES ('holder', 'pending');");
    const before = sha(path);
    const { fm, notices } = fleet(d);

    const log = fm.openEventLog();

    expect(log, "no event log while the file is locked").toBeNull();
    expect(moved(d), "nothing moved aside").toEqual([]);
    holder.exec("ROLLBACK");
    holder.close();
    expect(sha(path), "the history file is byte-identical").toBe(before);
    expect(notices.join("\n")).toContain("locked");
  });

  it("an error that is not about the file's contents (SQLITE_CANTOPEN): not moved, null, reported", () => {
    const d = dir();
    mkdirSync(join(d, "events.db"));                 // something SQLite cannot open, but that is not a corrupt database
    writeFileSync(join(d, "events.db", "keep.txt"), "operator data");
    const { fm, notices } = fleet(d);

    expect(fm.openEventLog()).toBeNull();
    expect(moved(d), "nothing moved aside").toEqual([]);
    expect(readFileSync(join(d, "events.db", "keep.txt"), "utf8")).toBe("operator data");
    expect(notices.join("\n")).toContain("could not be opened");
  });
});

describe("a lock that clears within the busy timeout is not a failure (positive control, #1490)", () => {
  it("waits out a lock another process releases within the timeout and opens normally", async () => {
    const d = dir();
    const path = healthyEventsDb(d);
    // A separate process (a lock held in this one could not be released while the synchronous open waits).
    const holder = spawn(process.execPath, ["-e", `
      const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
      const db = new Database(${JSON.stringify(path)});
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE; INSERT INTO events (instance_name, event_type) VALUES ('holder', 'pending');");
      process.stdout.write("locked\\n");
      setTimeout(() => { db.exec("ROLLBACK"); db.close(); process.exit(0); }, 400);
    `], { stdio: ["ignore", "pipe", "inherit"] });
    await once(holder.stdout!, "data");
    const { fm } = fleet(d);
    fm.eventLogBusyTimeoutMs = 5_000;

    const log = fm.openEventLog();
    expect(log, "opened once the other process let go").not.toBeNull();
    opened.push(log!);
    await once(holder, "exit");
  });
});

describe("a file SQLite proves corrupt is still moved aside (positive control)", () => {
  it("SQLITE_CORRUPT (a truncated database): moved aside, a fresh log works", () => {
    const d = dir();
    const path = healthyEventsDb(d);
    const big = new Database(path);
    big.exec("CREATE TABLE filler(x); INSERT INTO filler SELECT randomblob(4096) FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 50) SELECT n FROM c);");
    big.pragma("wal_checkpoint(TRUNCATE)");
    big.close();
    writeFileSync(path, readFileSync(path).subarray(0, 6000));
    const { fm } = fleet(d);

    const log = fm.openEventLog();
    expect(log).not.toBeNull();
    opened.push(log!);
    expect(moved(d).some(f => f.startsWith("events.db.corrupt-")), "the corrupt file is kept for inspection").toBe(true);
    expect(() => log!.insert("alpha", "after", {})).not.toThrow();
  });

  it("SQLITE_NOTADB (not a database at all): moved aside", () => {
    const d = dir();
    writeFileSync(join(d, "events.db"), "this is not a sqlite database ".repeat(100));
    const { fm } = fleet(d);
    const log = fm.openEventLog();
    expect(log).not.toBeNull();
    opened.push(log!);
    expect(moved(d).some(f => f.startsWith("events.db.corrupt-"))).toBe(true);
  });
});

describe("classifySqliteOpenError", () => {
  const coded = (code: string, message = "x") => Object.assign(new Error(message), { code });
  it.each([
    ["SQLITE_NOTADB", "corrupt"], ["SQLITE_CORRUPT", "corrupt"], ["SQLITE_CORRUPT_INDEX", "corrupt"],
    ["SQLITE_BUSY", "busy"], ["SQLITE_BUSY_SNAPSHOT", "busy"], ["SQLITE_LOCKED", "busy"],
    ["SQLITE_READONLY", "other"], ["SQLITE_CANTOPEN", "other"], ["SQLITE_IOERR", "other"], ["SQLITE_FULL", "other"], ["EACCES", "other"],
  ])("%s → %s", (code, kind) => {
    expect(classifySqliteOpenError(coded(code))).toBe(kind);
  });
  it("recognises a native module built for another Node.js as abi", () => {
    expect(classifySqliteOpenError(coded("ERR_DLOPEN_FAILED"))).toBe("abi");
    expect(classifySqliteOpenError(new Error("The module '/x/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127."))).toBe("abi");
  });
  it("treats a non-error as other", () => {
    expect(classifySqliteOpenError(undefined)).toBe("other");
  });
});
