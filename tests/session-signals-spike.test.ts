/** Detection-signal SPIKE (branch-only): per-backend fingerprints + snapshot-compare. Synthetic fixtures in tmp, no CLI. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  asInstant, claudeFingerprint, codexFingerprint, compareFingerprints,
  kiroKasFingerprint, museFingerprint, readinessFromStore, readJsonlTail,
  type TurnFingerprint,
} from "../src/backend/session-signals.js";

const T0 = Date.parse("2026-10-05T00:00:00.000Z");
const entry = (kind: string, ts: number) => JSON.stringify({ type: kind, timestamp: new Date(ts).toISOString() });

function tmp(): string { return mkdtempSync(join(tmpdir(), "agend-sig-spike-")); }

describe("snapshot-compare core (backend-agnostic)", () => {
  const fp = (over: Partial<TurnFingerprint> = {}): TurnFingerprint =>
    ({ sessionId: "s-1", storeMtimeMs: T0, tailTimestampMs: T0, tailKind: "assistant", ...over });

  it("quiet when nothing advanced", () => {
    expect(compareFingerprints(fp(), fp())).toBe("quiet");
  });
  it("reengaged when the store advanced past the daemon's own writes", () => {
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 60_000 }), T0 + 1_000)).toBe("reengaged");
    expect(compareFingerprints(fp(), fp({ tailTimestampMs: T0 + 60_000 }))).toBe("reengaged");
  });
  it("daemon-caused writes do not count as re-engagement", () => {
    expect(compareFingerprints(fp(), fp({ storeMtimeMs: T0 + 5_000 }), T0 + 5_000)).toBe("quiet");
  });
  it("a changed session id means a different conversation took over (#1217)", () => {
    expect(compareFingerprints(fp(), fp({ sessionId: "s-2" }))).toBe("reengaged");
  });
  it("unreadable either side is unknown, never a guess", () => {
    expect(compareFingerprints(null, fp())).toBe("unknown");
    expect(compareFingerprints(fp(), null)).toBe("unknown");
    expect(compareFingerprints(fp({ storeMtimeMs: -1 }), fp())).toBe("unknown");
  });
  it("store readiness is unknown by design; the pane stays authoritative", () => {
    expect(readinessFromStore(fp()).readiness).toBe("unknown");
    expect(readinessFromStore(null).readiness).toBe("unknown");
  });
});

describe("per-backend fingerprint readers", () => {
  it("claude: reads the session transcript tail; null without a session id", () => {
    const root = tmp();
    const dir = join(root, "projects", "-tmp-proj");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "sess-1.jsonl");
    writeFileSync(f, `${entry("user", T0)}\n${entry("assistant", T0 + 1_000)}\n`);
    const fp1 = claudeFingerprint({ configDir: root, cwd: "/tmp/proj", sessionId: "sess-1" });
    // Note: claudeProjectKey resolves the cwd; /tmp/proj -> "-tmp-proj".
    expect(fp1).toMatchObject({ sessionId: "sess-1", tailTimestampMs: T0 + 1_000, tailKind: "assistant" });
    expect(claudeFingerprint({ configDir: root, cwd: "/tmp/proj", sessionId: null })).toBeNull();
    expect(claudeFingerprint({ configDir: root, cwd: "/tmp/proj", sessionId: "nope" })).toBeNull();
  });

  it("codex: threads row timestamps + rollout tail via injected open", () => {
    const root = tmp();
    const dbPath = join(root, "state_5.sqlite");
    const rollout = join(root, "rollout.jsonl");
    writeFileSync(rollout, `${entry("task_started", T0)}\n${entry("response_item", T0 + 2_000)}\n`);
    const db = new Database(dbPath);
    db.exec("CREATE TABLE threads (id TEXT, updated_at_ms INTEGER, recency_at_ms INTEGER, rollout_path TEXT)");
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run("thr-1", T0, T0 + 500, rollout);
    db.close();
    const openDb = (p: string) => {
      try { return new Database(p, { readonly: true }); } catch { return null; }
    };
    const fp1 = codexFingerprint({
      stateDbPath: dbPath, sessionId: "thr-1", openDb, rolloutTail: readJsonlTail,
    });
    expect(fp1).toMatchObject({ sessionId: "thr-1", tailTimestampMs: T0 + 2_000, tailKind: "response_item" });
    expect(fp1!.storeMtimeMs).toBeGreaterThanOrEqual(T0 + 500);
    expect(codexFingerprint({
      stateDbPath: dbPath, sessionId: "missing", openDb, rolloutTail: () => null,
    })).toBeNull();
  });

  it("kiro KAS: session.json instants + messages.jsonl mtime", () => {
    const root = tmp();
    const dir = join(root, "sessions", "bucket1", "sess_abc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), JSON.stringify({
      createdAt: new Date(T0).toISOString(), lastModifiedAt: new Date(T0 + 3_000).toISOString(),
    }));
    writeFileSync(join(dir, "messages.jsonl"), `${entry("user", T0 + 3_000)}\n`);
    const fp1 = kiroKasFingerprint({ kiroHome: root, bucket: "bucket1", sessionId: "sess_abc" });
    expect(fp1).toMatchObject({ sessionId: "sess_abc", tailTimestampMs: T0 + 3_000 });
    expect(fp1!.storeMtimeMs).toBeGreaterThanOrEqual(T0 + 3_000);
    expect(kiroKasFingerprint({ kiroHome: root, bucket: "bucket1", sessionId: null })).toBeNull();
  });

  it("muse: newest inner-file mtime wins (mirrors getSessionId activity)", () => {
    const root = tmp();
    const dir = join(root, "2026", "10", "05", "uuid-1");
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "session.jsonl");
    writeFileSync(log, `${JSON.stringify({ route_facts: { cwd: "/w" } })}\n${entry("assistant", T0 + 4_000)}\n`);
    // A newer sidecar must outrank the log, per the getSessionId comment.
    const sidecar = join(dir, "other.json");
    writeFileSync(sidecar, "{}");
    const later = new Date(T0 + 9_000);
    utimesSync(sidecar, later, later);
    const fp1 = museFingerprint({ sessionsRoot: root, cwd: "/w", sessionId: "uuid-1" });
    expect(fp1).toMatchObject({ sessionId: "uuid-1", tailTimestampMs: T0 + 4_000 });
    expect(fp1!.storeMtimeMs).toBeGreaterThanOrEqual(T0 + 9_000);
    expect(museFingerprint({ sessionsRoot: root, cwd: "/w", sessionId: "nope" })).toBeNull();
  });

  it("asInstant accepts ISO and epoch, rejects the rest", () => {
    expect(asInstant(new Date(T0).toISOString())).toBe(T0);
    expect(asInstant(T0)).toBe(T0);
    expect(asInstant("not-a-time")).toBeNull();
    expect(asInstant(undefined)).toBeNull();
    expect(asInstant(NaN)).toBeNull();
  });
});
