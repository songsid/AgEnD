import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ bytes: 0, ranges: [] as number[][], maxRead: Infinity, zero: false }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof real.open>) => {
    const fh = await real.open(...args);
    return new Proxy(fh, { get(target, key) {
      if (key === "read") return async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (io.zero) return { bytesRead: 0, buffer };
        const result = await target.read(buffer, offset, Math.min(length, io.maxRead), position);
        io.bytes += result.bytesRead; io.ranges.push([position, position + result.bytesRead]);
        return result;
      };
      const value = (target as any)[key];
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});
import { ClaudeModelObserver, type ClaudeModelRecord } from "../src/claude-model-observation.js";
import { readTailRecords } from "../src/log-steps.js";

const configured = "claude-opus-5-5", sonnet = "claude-sonnet-5-5";
const response = (id: string, at: number, served = sonnet): ClaudeModelRecord => ({ kind: "served", id, sessionId: "session-A", at, served });
const observer = (saved?: any) => new ClaudeModelObserver(configured, configured, saved);
const roundTrip = (o: ClaudeModelObserver) => observer(JSON.parse(JSON.stringify(o.checkpoint())));

describe("same-session model-intent checkpoints", () => {
  it.each(["", sonnet])("keeps pending intent %s across JSON persistence and replay dedupe", requested => {
    const original = observer();
    const intent: ClaudeModelRecord = { kind: "intent", id: "intent-A", sessionId: "session-A", at: 1, served: requested };
    original.observe(intent, configured); original.observe(response("first", 2), configured);
    const restored = roundTrip(original);
    expect(restored.observe(intent, configured)).toBe(false); // daemon replay keeps the saved seen set
    for (const o of [original, restored]) o.observe(response("fresh", 3), configured);
    expect(original.snapshot().active).toBeNull(); expect(restored.snapshot()).toEqual(original.snapshot());
    if (requested) {
      restored.observe(response("confirmed", 4), sonnet);
      expect(restored.checkpoint().expected).toBe(sonnet);
      restored.observe(response("unexpected", 5, "claude-haiku-4-5"), sonnet);
      expect(restored.snapshot().active?.cause).toBe("observed");
    } else {
      restored.observe({ kind: "switch", id: "typed", sessionId: "session-A", at: 4, served: sonnet, original: configured, cause: "availability", scope: "unknown" }, sonnet);
      expect(restored.snapshot().active?.cause).toBe("availability");
    }
  });
  it("retains an active incident while a concrete command still lacks session confirmation", () => {
    const original = observer(); original.observe(response("fallback", 1, "claude-opus-4-8"), configured);
    original.observe({ kind: "intent", id: "pending", sessionId: "session-A", at: 2, served: sonnet }, configured);
    const restored = roundTrip(original); restored.observe(response("not-confirmed", 3), configured);
    expect(restored.snapshot().active).toMatchObject({ served: "claude-opus-4-8", baseline: true });
    expect(restored.checkpoint().expected).toBe(configured);
    restored.observe(response("confirmed", 4), sonnet); expect(restored.snapshot().active).toBeNull();
  });
  it("a checkpoint with no pending intent still detects a fresh difference", () => {
    const original = observer(); original.observe(response("normal", 1, configured), configured);
    const restored = roundTrip(original); restored.observe(response("difference", 2), configured);
    expect(restored.snapshot().active?.cause).toBe("observed");
  });
  it.each([undefined, { kind: "concrete", model: "opus" }, { kind: "unexpected" }, "arbitrary command text"])("conservatively restores missing or invalid intent %j", intent => {
    const original = observer(); original.observe(response("normal", 1, configured), configured);
    const restored = observer({ ...original.checkpoint(), intent }); restored.observe(response("unconfirmed", 2), configured);
    expect(restored.snapshot().active).toBeNull();
    restored.ownIntent(sonnet); restored.ownResult(true, sonnet);
    restored.observe(response("later-difference", 3, "claude-haiku-4-5"), sonnet);
    expect(restored.snapshot().active?.original).toBe(sonnet);
  });
  it("legacy v1 intent loss stays unresolved until a new session", () => {
    const original = observer(); original.observe({ kind: "intent", id: "legacy-intent", sessionId: "session-A", at: 1, served: "" }, configured);
    const { intent: _intent, ...saved } = original.checkpoint() as any;
    const restored = observer({ ...saved, v: 1 }); restored.observe(response("same-session", 2), configured);
    expect(restored.snapshot().active).toBeNull();
    restored.observe({ ...response("new-session", 3), sessionId: "session-B" }, configured);
    expect(restored.snapshot().active?.cause).toBe("observed");
  });
});

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-model-tail-")); Object.assign(io, { bytes: 0, ranges: [], maxRead: Infinity, zero: false }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("startup metadata tail: boundary and records share one physical read budget", () => {
  it("an explicit complete cursor never scans the later 16 MiB unfinished suffix", async () => {
    const path = join(root, "session.jsonl"), prefix = JSON.stringify({ model: configured, pad: "x".repeat(30) }) + "\n";
    writeFileSync(path, prefix + "u".repeat(16 * 1024 * 1024));
    const end = Buffer.byteLength(prefix), budget = 1024;
    const tail = await readTailRecords(path, { end, maxBytes: budget });
    expect(tail).toMatchObject({ end, truncated: false, records: [{ at: 0, record: prefix.trimEnd() }] });
    expect(io.bytes).toBeLessThanOrEqual(budget);
    expect(io.ranges.every(([, right]) => right <= end)).toBe(true);
  });
  it.each([false, true])("a boundary search within a long unfinished record is bounded (cursor=%s)", explicit => {
    const path = join(root, "session.jsonl"); writeFileSync(path, '{"old":true}\n' + "u".repeat(16 * 1024 * 1024));
    return readTailRecords(path, { ...(explicit ? { end: 8 * 1024 * 1024 } : {}), maxBytes: 1024 }).then(tail => {
      expect(io.bytes).toBeLessThanOrEqual(1024); expect(tail.records).toEqual([]);
      expect(tail.truncated).toBe(true);
    });
  });
  it("a cursor inside a record emits only earlier complete records, even with short physical reads", async () => {
    const path = join(root, "session.jsonl"), first = '{"a":1}\n', next = '{"b":2}\n';
    writeFileSync(path, first + next); io.maxRead = 2;
    const tail = await readTailRecords(path, { end: first.length + 4, maxBytes: 128 });
    expect(tail).toEqual({ records: [{ record: first.trimEnd(), at: 0 }], end: first.length, truncated: false });
    expect(io.bytes).toBeLessThanOrEqual(128);
  });
  it("does not emit a partial record when the remaining payload budget is exhausted", async () => {
    const path = join(root, "session.jsonl"); writeFileSync(path, '{"a":1}\n' + '{"pad":"' + "x".repeat(300) + '"}\n');
    const tail = await readTailRecords(path, { maxBytes: 32 });
    expect(tail.records).toEqual([]); expect(tail.truncated).toBe(true); expect(io.bytes).toBeLessThanOrEqual(32);
  });
  it("a non-progressing boundary read throws instead of adopting a guessed cursor", async () => {
    const path = join(root, "session.jsonl"); writeFileSync(path, '{"a":1}\n'); io.zero = true;
    await expect(readTailRecords(path, { end: 8, maxBytes: 32 })).rejects.toThrow(/no progress/);
  });
});
