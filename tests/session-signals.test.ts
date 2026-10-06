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
 *   `payload_type` + inner `payload.kind`; `retained_frame` first line;
 *   `route_facts` head naming the cwd).
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
  isTurnKind,
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
/** Outside the 10 s flush grace of a daemon write at T0+5000. */
const LATE = T0 + 5_000 + 10_001;

describe("snapshot-compare core (backend-agnostic)", () => {
  it("quiet when nothing advanced", () => {
    expect(compareFingerprints(fp(), fp(), { nowMs: LATE })).toBe("quiet");
  });

  it("reengaged when the turn tail advanced past the daemon's own writes", () => {
    expect(compareFingerprints(fp(), fp({ tailTimestampMs: T0 + 60_000 }), {
      daemonCausedMtimeMs: T0 + 1_000, nowMs: LATE,
    })).toBe("reengaged");
  });

  it("a first turn tail with no checkpoint tail still counts past the daemon", () => {
    expect(compareFingerprints(fp({ tailTimestampMs: null }), fp({ tailTimestampMs: T0 + 60_000 }), {
      daemonCausedMtimeMs: T0 + 1_000, nowMs: LATE,
    })).toBe("reengaged");
  });

  it("plain mtime movement without a turn tail is bookkeeping, not re-engagement", () => {
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 60_000 }), {
      daemonCausedMtimeMs: T0 + 1_000, nowMs: LATE,
    })).toBe("quiet");
  });

  it("P1: a daemon-caused tail advance is not re-engagement", () => {
    // before mtime/tail T0; daemon resume writes through T0+5000, tail T0+4900.
    const before = fp();
    const after = fp({ storeMtimeMs: T0 + 5_000, tailTimestampMs: T0 + 4_900 });
    expect(compareFingerprints(before, after, { daemonCausedMtimeMs: T0 + 5_000, nowMs: LATE }))
      .toBe("quiet");
  });

  it("P1: tail skew keeps a daemon tail newer than its mtime excluded", () => {
    // Live codex wrote a tail 2ms AFTER its row mtime; strict mtime
    // comparison would still self-block on the daemon's own write.
    const after = fp({ storeMtimeMs: T0 + 5_000, tailTimestampMs: T0 + 5_002 });
    expect(compareFingerprints(fp(), after, { daemonCausedMtimeMs: T0 + 5_000, nowMs: LATE }))
      .toBe("quiet");
    expect(compareFingerprints(fp(), fp({ tailTimestampMs: T0 + 5_000 + 2_001 }), {
      daemonCausedMtimeMs: T0 + 5_000, nowMs: LATE,
    })).toBe("reengaged");
  });

  it("an advance exactly at the daemon cutoff is not re-engagement", () => {
    expect(compareFingerprints(fp(), fp({ tailTimestampMs: T0 + 5_000 }), {
      daemonCausedMtimeMs: T0 + 5_000, nowMs: LATE,
    })).toBe("quiet");
    expect(compareFingerprints(fp(), fp({ tailTimestampMs: T0 }), { nowMs: LATE })).toBe("quiet");
  });

  it("a changed session id means a different conversation took over (#1217a)", () => {
    expect(compareFingerprints(fp(), fp({ sessionId: "s-2" }), { nowMs: LATE })).toBe("reengaged");
  });

  it("a null session id on either side is not an id change", () => {
    expect(compareFingerprints(fp({ sessionId: null }), fp(), { nowMs: LATE })).toBe("quiet");
    expect(compareFingerprints(fp(), fp({ sessionId: null }), { nowMs: LATE })).toBe("quiet");
    expect(compareFingerprints(fp({ sessionId: null }), fp({ sessionId: null }), { nowMs: LATE }))
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
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 5_000 }), { ...quiet, nowMs: LATE }))
      .toBe("quiet");
  });

  it("flush grace never hides a real turn advance", () => {
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

describe("timestamp, kind, and turn parsing", () => {
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
    expect(entryKind({ payload_type: "tool_batch.effect.started" })).toBe("tool_batch.effect.started");
    expect(entryKind({ payload_type: "runtime.session", payload: { kind: "task" } }))
      .toBe("runtime.session:task");
    expect(entryKind({ type: "cost-state" })).toBe("cost-state");
    expect(entryKind({})).toBeNull();
  });

  it("isTurnKind admits turns and refuses bookkeeping", () => {
    expect(isTurnKind("claude", "user")).toBe(true);
    expect(isTurnKind("claude", "assistant")).toBe(true);
    expect(isTurnKind("claude", "system:turn_duration")).toBe(false);
    expect(isTurnKind("claude", "cost-state")).toBe(false);
    expect(isTurnKind("codex", "response_item:message")).toBe(true);
    expect(isTurnKind("codex", "response_item")).toBe(true);
    expect(isTurnKind("codex", "event_msg:task_started")).toBe(true);
    expect(isTurnKind("codex", "event_msg:token_count")).toBe(false);
    expect(isTurnKind("codex", "token_usage_record")).toBe(false);
    expect(isTurnKind("codex", "turn_context")).toBe(false);
    expect(isTurnKind("muse", "runtime.session:task")).toBe(true);
    expect(isTurnKind("muse", "runtime.session:run")).toBe(true);
    expect(isTurnKind("muse", "tool_batch.effect.terminal")).toBe(true);
    expect(isTurnKind("muse", "runtime.user_intent.accepted")).toBe(true);
    expect(isTurnKind("muse", "session.resumed")).toBe(true);
    expect(isTurnKind("muse", "session.workspace_branch.observed")).toBe(false);
    expect(isTurnKind("muse", "session.end")).toBe(false);
    expect(isTurnKind("muse", "runtime.session:security_mode")).toBe(false);
    expect(isTurnKind("muse", "some-future-kind")).toBe(false);
    expect(isTurnKind("muse", null)).toBe(false);
  });

  it("tailEvidence takes the newest turn entry, skipping timed bookkeeping", () => {
    expect(tailEvidence([
      { type: "event_msg", timestamp: iso(T0 + 9_000), payload: { type: "token_count" } },
      { type: "cost-state", sessionId: "s" },
      { type: "assistant", timestamp: iso(T0) },
    ], "claude")).toMatchObject({ timestampMs: T0, kind: "assistant" });
    expect(tailEvidence([
      { type: "response_item", timestamp: iso(T0), payload: { type: "reasoning" } },
      { type: "event_msg", timestamp: iso(T0 - 1_000), payload: { type: "task_started" } },
    ], "codex")).toMatchObject({ timestampMs: T0, kind: "response_item:reasoning" });
    expect(tailEvidence([{ type: "cost-state" }], "claude")).toBeNull();
    expect(tailEvidence([
      { type: "event_msg", timestamp: iso(T0), payload: { type: "token_count" } },
    ], "codex")).toBeNull();
    expect(tailEvidence([], "muse")).toBeNull();
  });

  it("readJsonlTailEntries returns mtime with an empty list when the tail is unparseable", () => {
    const dir = tempDir();
    expect(readJsonlTailEntries(join(dir, "nope.jsonl"))).toBeNull();
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(readJsonlTailEntries(empty)?.entries).toEqual([]);
    const corrupt = join(dir, "corrupt.jsonl");
    writeFileSync(corrupt, "not json\n{broken\n");
    const got = readJsonlTailEntries(corrupt);
    expect(got?.entries).toEqual([]);
    expect(got!.mtimeMs).toBeGreaterThan(0);
    const blanks = join(dir, "blanks.jsonl");
    writeFileSync(blanks, `\n${JSON.stringify({ type: "user", timestamp: iso(T0) })}\n\n`);
    expect(readJsonlTailEntries(blanks)?.entries).toHaveLength(1);
  });

  it("P3: a single tail entry larger than the scan window keeps mtime, drops tail", () => {
    const dir = tempDir();
    const big = join(dir, "big.jsonl");
    writeFileSync(big, JSON.stringify({ type: "assistant", timestamp: iso(T0), pad: "x".repeat(1_200_000) }) + "\n");
    const got = readJsonlTailEntries(big);
    expect(got?.entries).toEqual([]);
    expect(got!.mtimeMs).toBeGreaterThan(0);
    const mixed = join(dir, "mixed.jsonl");
    writeFileSync(mixed, [
      JSON.stringify({ type: "user", timestamp: iso(T0) }),
      JSON.stringify({ type: "assistant", timestamp: iso(T0 + 1_000) }).slice(0, 30),
    ].join("\n") + "\n");
    // A truncated newest line is skipped; the older turn entry still reads.
    expect(readJsonlTailEntries(mixed)?.entries).toHaveLength(1);
  });
});

describe("per-backend fingerprint readers (store-side discovery)", () => {
  it("claude: discovers the newest session; skips timestamp-less bookkeeping tail", () => {
    const root = tempDir();
    const dir = join(root, "projects", "-tmp-my-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old-sess.jsonl"),
      `${JSON.stringify({ type: "assistant", timestamp: iso(T0 - 60_000) })}\n`);
    const older = new Date(T0 - 120_000);
    utimesSync(join(dir, "old-sess.jsonl"), older, older);
    const lines = [
      JSON.stringify({ type: "user", timestamp: iso(T0), sessionId: "sess-1" }),
      JSON.stringify({ type: "assistant", timestamp: iso(T0 + 1_000), sessionId: "sess-1" }),
      JSON.stringify({ type: "cost-state", sessionId: "sess-1", totalCostUSD: 0.5 }),
      JSON.stringify({ type: "last-prompt", sessionId: "sess-1", lastPrompt: "hi" }),
    ].join("\n") + "\n";
    writeFileSync(join(dir, "sess-1.jsonl"), lines);
    const got = claudeFingerprint({ configDir: root, cwd: "/tmp/my.proj" });
    expect(got).toMatchObject({ sessionId: "sess-1", tailTimestampMs: T0 + 1_000, tailKind: "assistant" });
    expect(got!.storeMtimeMs).toBeGreaterThan(0);
    expect(claudeFingerprint({ configDir: root, cwd: "/tmp/elsewhere" })).toBeNull();
  });

  it("claude: a bookkeeping-only transcript has mtime but no turn tail", () => {
    const root = tempDir();
    const dir = join(root, "projects", "-tmp-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess-b.jsonl"),
      `${JSON.stringify({ type: "cost-state", totalCostUSD: 1 })}\n`);
    const got = claudeFingerprint({ configDir: root, cwd: "/tmp/proj" });
    expect(got).toMatchObject({ sessionId: "sess-b", tailTimestampMs: null, tailKind: null });
    expect(got!.storeMtimeMs).toBeGreaterThan(0);
  });

  it("codex: discovers the exact-cwd session; threads row + rollout turn tail", () => {
    const root = tempDir();
    const dbPath = join(root, "state_5.sqlite");
    const rollout = join(root, "rollout-019fa7a4.jsonl");
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: iso(T0), type: "session_meta", payload: { id: "019fa7a4-1632-7693-a160-ea92d168a15b" } }),
      JSON.stringify({ timestamp: iso(T0), type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ timestamp: iso(T0 + 2_000), type: "response_item", payload: { type: "message" } }),
    ].join("\n") + "\n");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    db.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, has_user_event, first_user_message, archived, recency_at_ms, updated_at_ms)
      VALUES ('019fa7a4-1632-7693-a160-ea92d168a15b', ?, 1, 1, 'cli', 'openai', '/w', 't', 'disabled', 'never', 0, 'q', 0, ?, ?)
    `).run(rollout, T0 + 500, T0);
    db.close();
    const openDb = (p: string) => {
      try { return new Database(p, { readonly: true }); } catch { return null; }
    };
    const got = codexFingerprint({ stateDbPath: dbPath, cwd: "/w", openDb });
    expect(got).toMatchObject({
      sessionId: "019fa7a4-1632-7693-a160-ea92d168a15b", tailTimestampMs: T0 + 2_000, tailKind: "response_item:message",
    });
    expect(got!.storeMtimeMs).toBeGreaterThanOrEqual(T0 + 500);
    expect(codexFingerprint({ stateDbPath: dbPath, cwd: "/other", openDb })).toBeNull();
    expect(codexFingerprint({ stateDbPath: dbPath, cwd: "/w", openDb: () => null })).toBeNull();
    expect(codexFingerprint({ stateDbPath: join(root, "absent.sqlite"), cwd: "/w", openDb })).toBeNull();
  });

  it("codex: a token-count-only rollout has mtime but no turn tail", () => {
    const root = tempDir();
    const dbPath = join(root, "state_5.sqlite");
    const rollout = join(root, "rollout-quiet.jsonl");
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: iso(T0), type: "session_meta", payload: { id: "01a07c12-f160-7320-97d3-67ba74ef2f96" } }),
      JSON.stringify({ timestamp: iso(T0 + 1_000), type: "event_msg", payload: { type: "token_count" } }),
    ].join("\n") + "\n");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    db.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, has_user_event, first_user_message, archived, recency_at_ms, updated_at_ms)
      VALUES ('01a07c12-f160-7320-97d3-67ba74ef2f96', ?, 1, 1, 'cli', 'openai', '/w', 't', 'disabled', 'never', 0, 'q', 0, ?, ?)
    `).run(rollout, T0 + 500, T0);
    db.close();
    const openDb = (p: string) => {
      try { return new Database(p, { readonly: true }); } catch { return null; }
    };
    const got = codexFingerprint({ stateDbPath: dbPath, cwd: "/w", openDb });
    expect(got).toMatchObject({ sessionId: "01a07c12-f160-7320-97d3-67ba74ef2f96", tailTimestampMs: null, tailKind: null });
    expect(got!.storeMtimeMs).toBeGreaterThanOrEqual(T0 + 500);
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
    expect(codexFingerprint({ stateDbPath: dbPath, cwd: "/w", openDb })).toBeNull();
  });

  it("muse: discovers the cwd session; newest inner-file mtime wins; recorded_at micros turn tail", () => {
    const root = tempDir();
    const dir = join(root, "2026", "10", "05", "01a0d0de-3dbb-7330-ad0a-9458f13f6b9a");
    mkdirSync(dir, { recursive: true });
    const frame = (sequence: number, recordedAtMicros: number, payloadType: string, kind?: string) => JSON.stringify({
      schema_version: 1, id: `e-${sequence}`, stream: { kind: "session", id: "01a0d0de-3dbb-7330-ad0a-9458f13f6b9a" }, sequence,
      recorded_at: recordedAtMicros, record_type: "event", payload_type: payloadType,
      payload: kind ? { kind } : {},
    });
    writeFileSync(join(dir, "session.jsonl"), [
      JSON.stringify({ retained_frame: "session_permission_transaction", transaction_id: "t-1" }),
      JSON.stringify({ schema_version: 1, route_facts: { cwd: "/w" } }),
      frame(3, T0 * 1000, "runtime.session.metadata"),
      frame(4, (T0 + 4_000) * 1000, "runtime.session", "task"),
      frame(5, (T0 + 5_000) * 1000, "session.workspace_branch.observed"),
    ].join("\n") + "\n");
    // A newer sidecar must outrank the log, per the getSessionId comment.
    const sidecar = join(dir, "other.json");
    writeFileSync(sidecar, "{}");
    const later = new Date(T0 + 9_000);
    utimesSync(sidecar, later, later);
    const got = museFingerprint({ sessionsRoot: root, cwd: "/w" });
    expect(got).toMatchObject({
      sessionId: "01a0d0de-3dbb-7330-ad0a-9458f13f6b9a", tailTimestampMs: T0 + 4_000, tailKind: "runtime.session:task",
    });
    expect(got!.storeMtimeMs).toBeGreaterThanOrEqual(T0 + 9_000);
    expect(museFingerprint({ sessionsRoot: root, cwd: "/elsewhere" })).toBeNull();
    expect(museFingerprint({ sessionsRoot: root, cwd: "" })).toBeNull();
  });
});
