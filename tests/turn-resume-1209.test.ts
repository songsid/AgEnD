/**
 * #1209 ACP-resume-like cross-restart turn resume: scenario matrix.
 *
 * Every case drives the pure gate in src/turn-resume.ts with stub seam
 * fingerprints (plain TurnFingerprint literals — no CLI, no fleet, no tmux,
 * no net) plus tmp instance dirs for the one-shot marker file.
 *
 * Matrix rows (boot kind): clean restart / single crash (both: marker
 * present, no flags — the gate cannot tell them apart and continues either
 * when idle) / crash-loop / cancel (no marker: cancel deletes it, #1199).
 * Matrix columns (CLI-resume vs seam): reengaged → skip; quiet → continue;
 * unknown → hold through the flush grace, deny after it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildResumeContinuation,
  clearInFlightTurnMarker,
  consumeInFlightTurnMarker,
  decideTurnResume,
  normalizeResumeBackend,
  RESUME_GRACE_SETTLE_MS,
  writeInFlightTurnMarker,
  type InFlightTurnMarker,
  type ResumeGateInput,
} from "../src/turn-resume.js";
import type { TurnFingerprint } from "../src/backend/session-signals.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = "agend-turn-resume-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const T0 = Date.parse("2026-10-05T00:00:00.000Z");
/** This boot's CLI spawn: the daemon-caused boundary. */
const S0 = T0 + 60_000;
const GRACE = 10_000;
const LATE = S0 + GRACE + RESUME_GRACE_SETTLE_MS + 1;

const fp = (over: Partial<TurnFingerprint> = {}): TurnFingerprint => ({
  sessionId: "s-1", storeMtimeMs: T0, tailTimestampMs: T0, tailKind: "assistant", ...over,
});
const marker = (over: Partial<InFlightTurnMarker> = {}): InFlightTurnMarker => ({
  version: 1,
  deliveryId: "d-1",
  correlationId: "c-1",
  messageId: "m-1",
  chatId: "chat-1",
  threadId: "thread-1",
  adapterId: "adapter-1",
  backend: "claude-code",
  cwd: "/w",
  armedAt: T0,
  before: fp(),
  ...over,
});
const gate = (over: Partial<ResumeGateInput>): ReturnType<typeof decideTurnResume> =>
  decideTurnResume({
    marker: marker(),
    before: fp(),
    after: fp(),
    daemonCausedMtimeMs: S0,
    nowMs: LATE,
    crashLoopBoot: false,
    deliveryPending: false,
    ...over,
  });

describe("scenario matrix: boot kind × seam verdict", () => {
  it("clean restart, CLI idle (quiet) → inject one continuation", () => {
    const d = gate({ after: fp({ tailTimestampMs: T0 }) });
    expect(d).toMatchObject({ action: "inject" });
  });

  it("single crash, CLI idle (quiet) → inject (indistinguishable from clean restart at the gate)", () => {
    const d = gate({ after: fp({ tailTimestampMs: T0 }) });
    expect(d.action).toBe("inject");
  });

  it("CLI already re-engaged → skip, never double-drive", () => {
    const d = gate({ after: fp({ tailTimestampMs: S0 + 30_000 }) });
    expect(d).toMatchObject({ action: "skip", reason: "cli-reengaged" });
  });

  it("store unreadable after the grace (unknown) → skip, default-deny", () => {
    const d = gate({ after: null });
    expect(d).toMatchObject({ action: "skip", reason: "unobservable" });
  });

  it("unsupported backend (no fingerprints at all) → skip, default-deny", () => {
    const d = gate({ before: null, after: null });
    expect(d).toMatchObject({ action: "skip", reason: "unobservable" });
  });

  it("crash-loop boot → skip even when the CLI is idle", () => {
    const d = gate({ crashLoopBoot: true, after: fp({ tailTimestampMs: T0 }) });
    expect(d).toMatchObject({ action: "skip", reason: "crash-loop" });
  });

  it("crash-loop is checked before the seam (order matters)", () => {
    const d = gate({ crashLoopBoot: true, after: fp({ tailTimestampMs: S0 + 30_000 }) });
    expect(d).toMatchObject({ action: "skip", reason: "crash-loop" });
  });

  it("cancel leaves no marker → none (never resume a cancelled turn, #1199)", () => {
    const d = gate({ marker: null });
    expect(d).toMatchObject({ action: "skip", reason: "none" });
  });

  it("marker delivery still pending in the outbox → skip, durable path owns it", () => {
    const d = gate({ deliveryPending: true, after: fp({ tailTimestampMs: T0 }) });
    expect(d).toMatchObject({ action: "skip", reason: "delivery-pending" });
  });

  it("delivery-pending is checked before the seam (order matters)", () => {
    const d = gate({ deliveryPending: true, after: fp({ tailTimestampMs: S0 + 30_000 }) });
    expect(d).toMatchObject({ action: "skip", reason: "delivery-pending" });
  });

  it("store session changed → skip (conversation is gone, feeds #1217a)", () => {
    const d = gate({ after: fp({ sessionId: "s-2", tailTimestampMs: T0 }) });
    expect(d).toMatchObject({ action: "skip", reason: "session-changed" });
  });

  it("null session ids are not a change", () => {
    const d = gate({
      before: fp({ sessionId: null }),
      after: fp({ sessionId: null, tailTimestampMs: T0 }),
    });
    expect(d.action).toBe("inject");
  });
});

describe("flush-grace holding", () => {
  it("quiet inside the grace → wait (never guess-continue)", () => {
    const d = gate({ after: fp({ tailTimestampMs: T0 }), nowMs: S0 + 5_000 });
    expect(d).toMatchObject({ action: "wait", waitMs: GRACE - 5_000 + RESUME_GRACE_SETTLE_MS });
  });

  it("unknown inside the grace → wait (hold, don't deny yet)", () => {
    const d = gate({ after: null, nowMs: S0 + 5_000 });
    expect(d.action).toBe("wait");
  });

  it("reengaged inside the grace → skip immediately, no wait", () => {
    const d = gate({ after: fp({ tailTimestampMs: S0 + 30_000 }), nowMs: S0 + 5_000 });
    expect(d).toMatchObject({ action: "skip", reason: "cli-reengaged" });
  });

  it("custom grace is honored", () => {
    const d = gate({ after: fp({ tailTimestampMs: T0 }), nowMs: S0 + 5_000, flushGraceMs: 20_000 });
    expect(d).toMatchObject({ action: "wait", waitMs: 20_000 - 5_000 + RESUME_GRACE_SETTLE_MS });
  });

  it("a first turn tail with no checkpoint tail still injects when idle", () => {
    const d = gate({ before: fp({ tailTimestampMs: null }), after: fp({ tailTimestampMs: null }) });
    expect(d.action).toBe("inject");
  });
});

describe("one-shot marker file", () => {
  it("round-trips through write and consume", () => {
    const dir = tempDir();
    writeInFlightTurnMarker(dir, marker());
    expect(consumeInFlightTurnMarker(dir)).toMatchObject({
      version: 1, chatId: "chat-1", correlationId: "c-1", cwd: "/w",
    });
  });

  it("second boot finds nothing (consume-once, never repeats)", () => {
    const dir = tempDir();
    writeInFlightTurnMarker(dir, marker());
    expect(consumeInFlightTurnMarker(dir)).not.toBeNull();
    expect(consumeInFlightTurnMarker(dir)).toBeNull();
  });

  it("clear removes the marker (completion and cancel paths)", () => {
    const dir = tempDir();
    writeInFlightTurnMarker(dir, marker());
    clearInFlightTurnMarker(dir);
    expect(consumeInFlightTurnMarker(dir)).toBeNull();
    expect(() => clearInFlightTurnMarker(dir)).not.toThrow();
  });

  it("corrupt, versioned-wrong, or unroutable markers consume to null", () => {
    const dir = tempDir();
    const path = join(dir, "in-flight-turn.json");
    writeFileSync(path, "{broken");
    expect(consumeInFlightTurnMarker(dir)).toBeNull();
    expect(consumeInFlightTurnMarker(dir)).toBeNull();
    writeInFlightTurnMarker(dir, marker({ version: 2 } as unknown as InFlightTurnMarker));
    expect(consumeInFlightTurnMarker(dir)).toBeNull();
    writeInFlightTurnMarker(dir, marker({ chatId: "" }));
    expect(consumeInFlightTurnMarker(dir)).toBeNull();
  });

  it("missing file consumes to null", () => {
    expect(consumeInFlightTurnMarker(tempDir())).toBeNull();
  });
});

describe("continuation construction", () => {
  it("binds the original correlation and names the delivery, never re-pastes", () => {
    const { text, meta } = buildResumeContinuation(marker());
    expect(text).toMatch(/Original request: c-1/);
    expect(text).toMatch(/Continue exactly this interrupted work, nothing else/);
    expect(meta).toMatchObject({
      chat_id: "chat-1",
      thread_id: "thread-1",
      adapter_id: "adapter-1",
      correlation_id: "c-1",
      resumedContinuationOf: "d-1",
    });
    expect(meta.message_id).toMatch(/^resume-/);
    expect(meta.message_id).not.toBe("m-1");
  });

  it("falls back down the identity chain when correlation is absent", () => {
    expect(buildResumeContinuation(marker({ correlationId: undefined })).text).toMatch(/Original request: m-1/);
    expect(buildResumeContinuation(
      marker({ correlationId: undefined, messageId: undefined }),
    ).text).toMatch(/Original request: d-1/);
    expect(buildResumeContinuation(
      marker({ correlationId: undefined, messageId: undefined, deliveryId: undefined }),
    ).text).toMatch(/Original request: unknown/);
  });
});

describe("backend normalization", () => {
  it("accepts factory ids and binary names, rejects the rest", () => {
    expect(normalizeResumeBackend("claude-code")).toBe("claude");
    expect(normalizeResumeBackend("claude")).toBe("claude");
    expect(normalizeResumeBackend("codex")).toBe("codex");
    expect(normalizeResumeBackend("muse")).toBe("muse");
    expect(normalizeResumeBackend("  CODEX ")).toBe("codex");
    expect(normalizeResumeBackend("kiro-cli")).toBeNull();
    expect(normalizeResumeBackend("grok")).toBeNull();
    expect(normalizeResumeBackend("unknown")).toBeNull();
    expect(normalizeResumeBackend(undefined)).toBeNull();
    expect(normalizeResumeBackend("")).toBeNull();
  });
});
