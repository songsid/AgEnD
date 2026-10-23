import { selfEvidence, selfOomJournal } from "./helpers/self-oom-evidence.js";
import { readdirSync, appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoSessionOomStop, captureSessionOomRetry, clearSessionOomStopForRetry, readSessionOomStop, SESSION_OOM_STOP_FILE, SessionOomStoppedError, writeSessionOomStop } from "../src/session-oom-stop.js";
import { setLocale } from "../src/locale.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "oom-tombstone-2473-")); setLocale("en"); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const evidence = () => ({ owner: { bootId: "boot-a", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 },
  sessionKey: JSON.stringify(["claude-code", "owned-session"]), configuration: "a".repeat(64), stoppedAt: 100, count: 2, victim: { pid: 123, at: 99 }, evidence: selfEvidence() });

describe("#2473 stage2: authoritative OOM stop independent of pause and journal", () => {
  const legacy = (reason?: string) => JSON.stringify({ instance: "worker", timestamp: new Date(100).toISOString(), crashType: "window", exitCode: 137, reason, oomEvidence: selfEvidence() });
  it("holds an old structured OOM stop with unknown session owner until explicit retry, without erasing history", () => {
    const path = join(root, "crash-history.jsonl"), text = `${legacy("session_oom")}\n`; writeFileSync(path, text);
    expect(readSessionOomStop(root)).toMatchObject({ blocked: true, record: null, revision: expect.stringMatching(/^legacy:/) });
    expect(() => assertNoSessionOomStop(root)).toThrow(SessionOomStoppedError);
    clearSessionOomStopForRetry(root, captureSessionOomRetry(root));
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
    expect(readFileSync(path, "utf8")).toBe(text);
    // A later real OOM still overrides the durable retry receipt.
    const next = writeSessionOomStop(root, evidence()); expect(readSessionOomStop(root)).toMatchObject({ blocked: true, record: next });
  });
  it("normal structured crashes are not OOM proof; a new terminal record invalidates the cached check", () => {
    const path = join(root, "crash-history.jsonl"); writeFileSync(path, `${legacy()}\n`);
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
    appendFileSync(path, `${legacy("session_oom")}\n`);
    expect(readSessionOomStop(root).blocked).toBe(true);
  });
  it.each(["界".repeat(24_000), "x".repeat(70 * 1024)])("reads a complete large last crash record without inventing an OOM", (lastOutput) => {
    const path = join(root, "crash-history.jsonl");
    const record = { instance: "worker", timestamp: new Date(100).toISOString(), crashType: "window", exitCode: 1, lastOutput };
    // An earlier OOM does not override the last ordinary crash.
    writeFileSync(path, `${legacy("session_oom")}\n${JSON.stringify(record)}\n`);
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
    expect(() => assertNoSessionOomStop(root)).not.toThrow();
    appendFileSync(path, `${JSON.stringify({ ...record, reason: "session_oom", exitCode: 137, oomEvidence: selfEvidence() })}\n`);
    expect(readSessionOomStop(root).blocked).toBe(true);
    expect(() => assertNoSessionOomStop(root)).toThrow("session-OOM stop evidence");
  });
  it("does not label unreadable or truncated evidence as a confirmed session OOM", () => {
    const path = join(root, "crash-history.jsonl");
    writeFileSync(path, '{"instance":"worker","lastOutput":"unfinished');
    expect(() => assertNoSessionOomStop(root)).toThrow("could not be read safely");
    writeFileSync(path, `${legacy("session_oom")}\n`);
    expect(() => assertNoSessionOomStop(root)).toThrow("session-OOM stop evidence");
    rmSync(path);
    writeSessionOomStop(root, evidence());
    expect(() => assertNoSessionOomStop(root)).toThrow("session-OOM stop evidence");
    writeFileSync(join(root, SESSION_OOM_STOP_FILE), "damaged");
    expect(() => assertNoSessionOomStop(root)).toThrow("could not be read safely");
  });
  it("bounds the last-record scan and ignores large older records when the final record is complete", () => {
    const path = join(root, "crash-history.jsonl");
    const huge = JSON.stringify({ instance: "worker", timestamp: new Date(100).toISOString(), crashType: "window", lastOutput: "x".repeat(1024 * 1024) });
    writeFileSync(path, huge + "\n");
    expect(() => assertNoSessionOomStop(root)).toThrow("could not be read safely");
    appendFileSync(path, legacy() + "\n\n");
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
  });
  it("keeps the same evidence distinction in the zh-TW retry notice", () => {
    setLocale("zh-TW");
    const path = join(root, "crash-history.jsonl");
    writeFileSync(path, "truncated");
    expect(() => assertNoSessionOomStop(root)).toThrow("無法安全讀取");
    writeFileSync(path, legacy("session_oom") + "\n");
    expect(() => assertNoSessionOomStop(root)).toThrow("工作階段 OOM 停止紀錄");
  });
  it("a durable retry receipt cannot hide a newer terminal stop written by an old binary", () => {
    const path = join(root, "crash-history.jsonl"); writeFileSync(path, `${legacy("session_oom")}\n`);
    clearSessionOomStopForRetry(root, captureSessionOomRetry(root)); expect(readSessionOomStop(root)).toEqual({ blocked: false });
    const beforeNewStop = captureSessionOomRetry(root); appendFileSync(path, `${legacy("session_oom")}\n`);
    expect(readSessionOomStop(root)).toMatchObject({ blocked: true, record: null });
    expect(() => clearSessionOomStopForRetry(root, beforeNewStop)).toThrow(SessionOomStoppedError);
    clearSessionOomStopForRetry(root, captureSessionOomRetry(root)); expect(readSessionOomStop(root)).toEqual({ blocked: false });
  });
  it.each(["incomplete JSON", "x".repeat(70 * 1024)])("ambiguous or overlong legacy evidence stays held and can be explicitly acknowledged", (text) => {
    writeFileSync(join(root, "crash-history.jsonl"), text);
    expect(readSessionOomStop(root)).toMatchObject({ blocked: true, record: null });
    clearSessionOomStopForRetry(root, captureSessionOomRetry(root));
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
  });
  it("preserves a private, bounded, whitelisted stop and never consumes it while checking automatic starts", () => {
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
    const record = writeSessionOomStop(root, { ...evidence(), rawPane: "must-not-copy", token: "must-not-copy" } as any);
    const path = join(root, SESSION_OOM_STOP_FILE), text = readFileSync(path, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096); expect(text).not.toContain("must-not-copy");
    if (process.platform !== "win32") expect(lstatSync(path).mode & 0o777).toBe(0o600);
    for (let i = 0; i < 3; i++) expect(() => assertNoSessionOomStop(root)).toThrow(SessionOomStoppedError);
    expect(readSessionOomStop(root)).toMatchObject({ blocked: true, record });
    expect(readFileSync(path, "utf8")).toBe(text);
  });
  it("only explicit retry clears the record it observed, while preserving session files", () => {
    writeFileSync(join(root, "session-id"), "owned-session"); writeFileSync(join(root, "transcript"), "original conversation");
    writeSessionOomStop(root, evidence()); const retry = captureSessionOomRetry(root);
    expect(() => clearSessionOomStopForRetry(root, retry)).not.toThrow(); expect(readSessionOomStop(root)).toEqual({ blocked: false });
    expect(readFileSync(join(root, "session-id"), "utf8")).toBe("owned-session");
    expect(readFileSync(join(root, "transcript"), "utf8")).toBe("original conversation");
  });
  it("a queued old retry cannot clear a replacement OOM stop", () => {
    const first = writeSessionOomStop(root, evidence()), old = captureSessionOomRetry(root);
    clearSessionOomStopForRetry(root, old);
    const replacement = writeSessionOomStop(root, { ...evidence(), owner: { ...evidence().owner, bootId: "replacement" } });
    expect(replacement.id).not.toBe(first.id);
    expect(() => clearSessionOomStopForRetry(root, old)).toThrow(SessionOomStoppedError);
    expect(readSessionOomStop(root)).toMatchObject({ blocked: true, record: replacement });
  });
  it("a retry requested before an OOM stop appeared cannot authorize that later stop", () => {
    const early = captureSessionOomRetry(root); writeSessionOomStop(root, evidence());
    expect(() => clearSessionOomStopForRetry(root, early)).toThrow(SessionOomStoppedError);
  });
  it("a retry cannot acknowledge newer history even when the original marker could not be replaced", () => {
    const original = writeSessionOomStop(root, evidence()); const early = captureSessionOomRetry(root);
    const originalBytes = readFileSync(join(root, SESSION_OOM_STOP_FILE), "utf8");
    appendFileSync(join(root, "crash-history.jsonl"), `${legacy("session_oom")}\n`);
    expect(() => clearSessionOomStopForRetry(root, early)).toThrow(SessionOomStoppedError);
    expect(readSessionOomStop(root)).toMatchObject({ blocked: true, record: original });
    expect(readFileSync(join(root, SESSION_OOM_STOP_FILE), "utf8")).toBe(originalBytes);
    clearSessionOomStopForRetry(root, captureSessionOomRetry(root));
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
  });
  it.each(["not-json", "x".repeat(5000), JSON.stringify({ version: 1, reason: "session_oom" }),
    JSON.stringify({ version: 1, reason: "session_oom_cleared", clearedAt: 1, legacyRevision: null }),
    JSON.stringify({ version: 1, reason: "session_oom_cleared", id: "receipt", legacyRevision: null })])("corrupt or oversized evidence holds automatic starts and remains explicitly recoverable", (text) => {
    writeFileSync(join(root, SESSION_OOM_STOP_FILE), text, { mode: 0o600 });
    expect(readSessionOomStop(root)).toMatchObject({ blocked: true, record: null });
    expect(() => assertNoSessionOomStop(root)).toThrow(SessionOomStoppedError);
    clearSessionOomStopForRetry(root, captureSessionOomRetry(root)); expect(readSessionOomStop(root)).toEqual({ blocked: false });
  });
  it("never follows or clears a symlinked stop file or instance directory", () => {
    const target = join(root, "target"); writeFileSync(target, "do not alter");
    const home = join(root, "home"); mkdirSync(home); symlinkSync(target, join(home, SESSION_OOM_STOP_FILE));
    expect(readSessionOomStop(home)).toEqual({ blocked: true, record: null, revision: null });
    expect(() => captureSessionOomRetry(home)).toThrow(SessionOomStoppedError);
    const alias = join(root, "alias"); symlinkSync(home, alias, "dir");
    expect(() => writeSessionOomStop(alias, evidence())).toThrow(SessionOomStoppedError);
    expect(readFileSync(target, "utf8")).toBe("do not alter");
  });
  it.skipIf(typeof process.getuid !== "function")("foreign-owned roots and records cannot grant retry authority", () => {
    writeSessionOomStop(root, evidence()); const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(readSessionOomStop(root)).toEqual({ blocked: true, record: null, revision: null });
    expect(() => captureSessionOomRetry(root)).toThrow(SessionOomStoppedError);
  });
  it.skipIf(typeof process.getuid !== "function" || process.getuid?.() === 0)("an unreadable owned marker holds automatically and can be removed by explicit retry", () => {
    writeSessionOomStop(root, evidence()); chmodSync(join(root, SESSION_OOM_STOP_FILE), 0o000);
    expect(readSessionOomStop(root)).toMatchObject({ blocked: true, record: null });
    clearSessionOomStopForRetry(root, captureSessionOomRetry(root)); expect(readSessionOomStop(root)).toEqual({ blocked: false });
  });
  it("an already recorded stop cannot be overwritten by a later observer", () => {
    const original = writeSessionOomStop(root, evidence());
    expect(writeSessionOomStop(root, { ...evidence(), sessionKey: "different" })).toEqual(original);
    expect(existsSync(join(root, "paused"))).toBe(false);
    expect(existsSync(join(root, "crash-state.json"))).toBe(false);
  });
});

describe("#2446 upgrade re-evaluates old victim-only stops", () => {
  it("releases a valid v1 stop once, archives evidence privately and preserves session", () => {
    const old = { ...evidence(), version: 1, id: "old-stop", reason: "session_oom" } as any; delete old.evidence;
    writeFileSync(join(root, SESSION_OOM_STOP_FILE), JSON.stringify(old));
    writeFileSync(join(root, "session-id"), "preserved-session");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("without self-caused memory evidence"));
    expect(readFileSync(join(root, "session-id"), "utf8")).toBe("preserved-session");
    const files = readdirSync(root).filter(name => name.startsWith("session-oom-stop-pre-policy2-"));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, files[0]!), "utf8"))).toEqual(old);
    expect(lstatSync(join(root, files[0]!)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(root, SESSION_OOM_STOP_FILE), "utf8"))).toMatchObject({ migration: "no_self_oom_evidence" });
  });
  it("releases old legacy session_oom history but retains a newly proven legacy stop", () => {
    const path = join(root, "crash-history.jsonl");
    const old = { instance: "worker", timestamp: new Date(100).toISOString(), crashType: "window", reason: "session_oom" };
    const text = JSON.stringify(old) + "\n"; writeFileSync(path, text);
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
    expect(readFileSync(path, "utf8")).toBe(text);
    appendFileSync(path, JSON.stringify({ ...old, oomEvidence: selfEvidence() }) + "\n");
    expect(readSessionOomStop(root)).toMatchObject({ blocked: true, confirmedOom: true });
  });
  it("re-evaluates numeric evidence rather than trusting the stored policy label", () => {
    writeSessionOomStop(root, evidence());
    const path = join(root, SESSION_OOM_STOP_FILE), record = JSON.parse(readFileSync(path, "utf8"));
    record.evidence.largestOtherRssPages = 10000;
    writeFileSync(path, JSON.stringify(record));
    expect(readSessionOomStop(root)).toEqual({ blocked: false });
  });
});
