import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { EventLog } from "../src/event-log.js";

describe("Activity Log", () => {
  let tmpDir: string;
  let log: EventLog;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `activity-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    log = new EventLog(join(tmpDir, "events.db"));
  });

  afterEach(() => {
    log.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("logs and retrieves activity", () => {
    log.logActivity("message", "user", "Fix the bug", "agend-t5033");
    log.logActivity("tool_call", "agend-t5033", "list_decisions()");
    log.logActivity("message", "agend-t5033", "Bug fixed", "user");

    const rows = log.listActivity();
    expect(rows).toHaveLength(3);
    expect(rows[0].event).toBe("message");
    expect(rows[0].sender).toBe("user");
    expect(rows[0].receiver).toBe("agend-t5033");
    expect(rows[1].event).toBe("tool_call");
    expect(rows[1].receiver).toBeNull();
    expect(rows[2].sender).toBe("agend-t5033");
  });

  it("filters by since timestamp", () => {
    log.logActivity("message", "a", "old");
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const rows = log.listActivity({ since: futureIso });
    expect(rows).toHaveLength(0);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      log.logActivity("message", "a", `msg ${i}`);
    }
    const rows = log.listActivity({ limit: 3 });
    expect(rows).toHaveLength(3);
  });

  it("prune removes old activity", () => {
    log.logActivity("message", "a", "test");
    // Manually set timestamp to past
    log["db"].prepare("UPDATE activity SET timestamp = datetime('now', '-40 days')").run();
    log.prune(30);
    expect(log.listActivity()).toHaveLength(0);
  });
});
