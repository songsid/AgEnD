/**
 * Detection-signal seam (#1209/#1217a/#1210/#1215 shared base): unified
 * per-backend fingerprints + snapshot-compare.
 *
 * Every case runs against fixture session stores in tmp — no live CLI, no
 * fleet, no tmux. Fixture shapes replicate live stores (verified read-only
 * during development, never read by the test):
 * - claude transcript: claude-code 2.1.289 (`timestamp` ISO on
 *   user/assistant/system; timestamp-less bookkeeping tail).
 * - codex threads: tests/fixtures/codex-0157-state5-schema.sql, the real
 *   0.157.0 schema in WAL mode; rollout lines carry top-level ISO
 *   `timestamp` with `type` + `payload.type`.
 * - muse session dir: 1.4.x frames (`recorded_at` epoch micros,
 *   `payload_type`; `retained_frame` first line).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  asTimestampMs,
  claudeFingerprint,
  codexFingerprint,
  compareFingerprints,
  entryKind,
  museFingerprint,
  readinessFromStore,
  readJsonlTailEntries,
  tailEvidence,
  type TurnFingerprint,
} from "../src/backend/session-signals.js";

const SCHEMA = readFileSync(fileURLToPath(new URL("./fixtures/codex-0157-state5-schema.sql", import.meta.url)), "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = "agend-signal-seam-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const T0 = Date.parse("2026-10-05T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const fp = (over: Partial<TurnFingerprint> = {}): TurnFingerprint => ({
  sessionId: "s-1", storeMtimeMs: T0, tailTimestampMs: T0, tailKind: "assistant", ...over,
});

describe("snapshot-compare core (backend-agnostic)", () => {
  it("quiet when nothing advanced", () => {
    expect(compareFingerprints(fp(), fp(), { nowMs: T0 + 60_000 })).toBe("quiet");
  });

  it("reengaged when the store advanced past the daemon's own writes", () => {
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 60_000 }), {
      daemonCausedMtimeMs: T0 + 1_000, nowMs: T0 + 120_000,
    })).toBe("reengaged");
    expect(compareFingerprints(fp(), fp({ tailTimestampMs: T0 + 60_000 }), { nowMs: T0 + 120_000 }))
      .toBe("reengaged");
  });

  it("an advance exactly at the daemon cutoff is not re-engagement", () => {
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 5_000 }), {
      daemonCausedMtimeMs: T0 + 5_000, nowMs: T0 + 120_000,
    })).toBe("quiet");
    expect(compareFingerprints(fp(), fp({ tailTimestampMs: T0 }), { nowMs: T0 + 120_000 })).toBe("quiet");
  });

  it("daemon-caused writes do not count as re-engagement", () => {
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 5_000 }), {
      daemonCausedMtimeMs: T0 + 5_000, nowMs: T0 + 120_000,
    })).toBe("quiet");
  });

  it("a changed session id means a different conversation took over (#1217a)", () => {
    expect(compareFingerprints(fp(), fp({ sessionId: "s-2" }), { nowMs: T0 + 120_000 })).toBe("reengaged");
  });

  it("a null session id on either side is not an id change", () => {
    expect(compareFingerprints(fp({ sessionId: null }), fp(), { nowMs: T0 + 120_000 })).toBe("quiet");
    expect(compareFingerprints(fp(), fp({ sessionId: null }), { nowMs: T0 + 120_000 })).toBe("quiet");
    expect(compareFingerprints(fp({ sessionId: null }), fp({ sessionId: null }), { nowMs: T0 + 120_000 }))
      .toBe("quiet");
  });

  it("unreadable either side is unknown, never a guess", () => {
    expect(compareFingerprints(null, fp())).toBe("unknown");
    expect(compareFingerprints(fp(), null)).toBe("unknown");
    expect(compareFingerprints(fp({ storeMtimeMs: -1 }), fp())).toBe("unknown");
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: -1 }))).toBe("unknown");
  });

  it("flush grace: quiet inside the window after a daemon write is unknown", () => {
    const quiet = { daemonCausedMtimeMs: T0 + 5_000 };
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 5_000 }), { ...quiet, nowMs: T0 + 8_000 }))
      .toBe("unknown");
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 5_000 }), { ...quiet, nowMs: T0 + 5_000 + 10_000 }))
      .toBe("unknown");
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 5_000 }), { ...quiet, nowMs: T0 + 5_000 + 10_001 }))
      .toBe("quiet");
  });

  it("flush grace never hides a real advance", () => {
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 60_000 }), {
      daemonCausedMtimeMs: T0 + 1_000, nowMs: T0 + 2_000,
    })).toBe("reengaged");
    expect(compareFingerprints(fp(), fp({ tailTimestampMs: T0 + 60_000 }), {
      daemonCausedMtimeMs: T0 + 1_000, nowMs: T0 + 2_000,
    })).toBe("reengaged");
  });

  it("without a daemon write there is no grace window", () => {
    expect(compareFingerprints(fp(), fp(), { nowMs: T0 + 1_000 })).toBe("quiet");
  });

  it("store readiness is unknown by design; the pane stays authoritative", () => {
    expect(readinessFromStore(fp()).readiness).toBe("unknown");
    expect(readinessFromStore(null).readiness).toBe("unknown");
    expect(readinessFromStore(fp()).reason).toMatch(/pane stays authoritative/);
  });
});

describe("timestamp and kind parsing", () => {
  it("asTimestampMs accepts ISO, epoch millis, and muse epoch micros", () => {
    expect(asTimestampMs(iso(T0))).toBe(T0);
    expect(asTimestampMs(T0)).toBe(T0);
    expect(asTimestampMs(T0 * 1000)).toBe(T0);
    expect(asTimestampMs("not-a-time")).toBeNull();
    expect(asTimestampMs(undefined)).toBeNull();
    expect(asTimestampMs(NaN)).toBeNull();
    expect(asTimestampMs({})).toBeNull();
  });

  it("entryKind names kinds across the three store shapes", () => {
    expect(entryKind({ type: "assistant" })).toBe("assistant");
    expect(entryKind({ type: "system", subtype: "turn_duration" })).toBe("system:turn_duration");
    expect(entryKind({ type: "response_item", payload: { type: "message" } })).toBe("response_item:message");
    expect(entryKind({ type: "session_meta", payload: { id: "x" } })).toBe("session_meta");
    expect(entryKind({ payload_type: "runtime.session" })).toBe("runtime.session");
    expect(entryKind({ type: "cost-state" })).toBe("cost-state");
    expect(entryKind({})).toBeNull();
  });

  it("tailEvidence skips timestamp-less bookkeeping for the newest timed entry", () => {
    expect(tailEvidence([
      { type: "cost-state", sessionId: "s" },
      { type: "assistant", timestamp: iso(T0) },
    ])).toMatchObject({ timestampMs: T0, kind: "assistant" });
    expect(tailEvidence([{ type: "cost-state" }])).toBeNull();
    expect(tailEvidence([])).toBeNull();
  });

  it("readJsonlTailEntries is newest-first and null on empty/missing/corrupt", () => {
    const dir = tempDir();
    const missing = readJsonlTailEntries(join(dir, "nope.jsonl"));
    expect(missing).toBeNull();
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(readJsonlTailEntries(empty)).toBeNull();
    const corrupt = join(dir, "corrupt.jsonl");
    writeFileSync(corrupt, "not json\n{broken\n");
    expect(readJsonlTailEntries(corrupt)).toBeNull();
    const blanks = join(dir, "blanks.jsonl");
    writeFileSync(blanks, `\n${JSON.stringify({ type: "user", timestamp: iso(T0) })}\n\n`);
    expect(readJsonlTailEntries(blanks)?.entries).toHaveLength(1);
  });
});

describe("per-backend fingerprint readers", () => {
  it("claude: skips the timestamp-less bookkeeping tail for the last timed entry", () => {
    const root = tempDir();
    const dir = join(root, "projects", "-tmp-my-proj");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", timestamp: iso(T0), sessionId: "sess-1" }),
      JSON.stringify({ type: "assistant", timestamp: iso(T0 + 1_000), sessionId: "sess-1" }),
      JSON.stringify({ type: "cost-state", sessionId: "sess-1", totalCostUSD: 0.5 }),
      JSON.stringify({ type: "last-prompt", sessionId: "sess-1", lastPrompt: "hi" }),
    ].join("\n") + "\n";
    writeFileSync(join(dir, "sess-1.jsonl"), lines);
    const got = claudeFingerprint({ configDir: root, cwd: "/tmp/my.proj", sessionId: "sess-1" });
    expect(got).toMatchObject({ sessionId: "sess-1", tailTimestampMs: T0 + 1_000, tailKind: "assistant" });
    expect(got!.storeMtimeMs).toBeGreaterThan(0);
    expect(claudeFingerprint({ configDir: root, cwd: "/tmp/my.proj", sessionId: null })).toBeNull();
    expect(claudeFingerprint({ configDir: root, cwd: "/tmp/my.proj", sessionId: "nope" })).toBeNull();
  });

  it("codex: threads row timestamps + rollout tail via injected open", () => {
    const root = tempDir();
    const dbPath = join(root, "state_5.sqlite");
    const rollout = join(root, "rollout-019fa7a4.jsonl");
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: iso(T0), type: "session_meta", payload: { id: "thr-1" } }),
      JSON.stringify({ timestamp: iso(T0), type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ timestamp: iso(T0 + 2_000), type: "response_item", payload: { type: "message" } }),
    ].join("\n") + "\n");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    db.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, has_user_event, first_user_message, archived, recency_at_ms, updated_at_ms)
      VALUES ('thr-1', ?, 1, 1, 'cli', 'openai', '/w', 't', 'disabled', 'never', 0, 'q', 0, ?, ?)
    `).run(rollout, T0 + 500, T0);
    db.close();
    const openDb = (p: string) => {
      try { return new Database(p, { readonly: true }); } catch { return null; }
    };
    const got = codexFingerprint({ stateDbPath: dbPath, sessionId: "thr-1", openDb });
    expect(got).toMatchObject({
      sessionId: "thr-1", tailTimestampMs: T0 + 2_000, tailKind: "response_item:message",
    });
    expect(got!.storeMtimeMs).toBeGreaterThanOrEqual(T0 + 500);
    expect(codexFingerprint({ stateDbPath: dbPath, sessionId: "missing", openDb })).toBeNull();
    expect(codexFingerprint({ stateDbPath: dbPath, sessionId: "thr-1", openDb: () => null })).toBeNull();
    expect(codexFingerprint({ stateDbPath: join(root, "absent.sqlite"), sessionId: "thr-1", openDb }))
      .toBeNull();
    expect(codexFingerprint({ stateDbPath: dbPath, sessionId: null, openDb })).toBeNull();
  });

  it("codex: a threads schema that no longer matches is unknown, never a guess", () => {
    const root = tempDir();
    const dbPath = join(root, "state_5.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE threads (id TEXT)");
    db.close();
    const openDb = (p: string) => {
      try { return new Database(p, { readonly: true }); } catch { return null; }
    };
    expect(codexFingerprint({ stateDbPath: dbPath, sessionId: "thr-1", openDb })).toBeNull();
  });

  it("muse: newest inner-file mtime wins; time comes from recorded_at micros", () => {
    const root = tempDir();
    const dir = join(root, "2026", "10", "05", "uuid-1");
    mkdirSync(dir, { recursive: true });
    const frame = (sequence: number, recordedAtMicros: number, payloadType: string) => JSON.stringify({
      schema_version: 1, id: `e-${sequence}`, stream: { kind: "session", id: "uuid-1" }, sequence,
      recorded_at: recordedAtMicros, record_type: "event", payload_type: payloadType,
    });
    writeFileSync(join(dir, "session.jsonl"), [
      JSON.stringify({ retained_frame: "session_permission_transaction", transaction_id: "t-1" }),
      frame(3, T0 * 1000, "runtime.session.metadata"),
      frame(4, (T0 + 4_000) * 1000, "runtime.session"),
    ].join("\n") + "\n");
    // A newer sidecar must outrank the log, per the getSessionId comment.
    const sidecar = join(dir, "other.json");
    writeFileSync(sidecar, "{}");
    const later = new Date(T0 + 9_000);
    utimesSync(sidecar, later, later);
    const got = museFingerprint({ sessionsRoot: root, sessionId: "uuid-1" });
    expect(got).toMatchObject({
      sessionId: "uuid-1", tailTimestampMs: T0 + 4_000, tailKind: "runtime.session",
    });
    expect(got!.storeMtimeMs).toBeGreaterThanOrEqual(T0 + 9_000);
    expect(museFingerprint({ sessionsRoot: root, sessionId: "nope" })).toBeNull();
    expect(museFingerprint({ sessionsRoot: root, sessionId: null })).toBeNull();
  });
});
