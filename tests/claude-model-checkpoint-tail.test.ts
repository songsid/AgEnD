import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { LogService } from "../src/log-service.js";
import { readStartupTailRecords } from "../src/log-steps.js";
import { lastLineBoundary } from "../src/transcript-jsonl.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import pino from "pino";

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

describe("definite recovery while inference is unresolved", () => {
  it.each([
    ["legacy original", 1, undefined, "claude-opus-4-8"],
    ["legacy configured", 1, undefined, configured],
    ["unresolved original", 2, { kind: "unresolved" }, "claude-opus-4-8"],
    ["pending concrete original", 2, { kind: "concrete", model: "claude-haiku-4-5" }, "claude-opus-4-8"],
  ])("%s retires a quiet incident without enabling new inference", (_name, v, intent, returned) => {
    const original = observer();
    original.observe({ kind: "switch", id: "typed-recovery", sessionId: "session-A", at: 1, original: "claude-opus-4-8", served: sonnet, cause: "safeguards", scope: "session" }, sonnet);
    original.observe(response("before-restore", 2), sonnet);
    const restored = observer({ ...original.checkpoint(), v, intent });
    expect(restored.snapshot().active?.baseline).toBe(true);
    restored.observe(response("fresh-return", 3, returned as string), sonnet);
    expect(restored.snapshot()).toMatchObject({ lastServed: returned, active: null });
    expect(restored.checkpoint().expected).toBe(configured);
    restored.observe(response("still-unconfirmed", 4), sonnet);
    expect(restored.snapshot().active).toBeNull(); // recovery is not confirmation of the missing command
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
    const tail = await readStartupTailRecords(path, { end, maxBytes: budget });
    expect(tail).toMatchObject({ truncated: false, records: [{ at: 0, record: prefix.trimEnd() }] });
    expect(io.bytes).toBeLessThanOrEqual(budget);
    expect(io.ranges.every(([, right]) => right <= end)).toBe(true);
  });
  it.each([8 * 1024 * 1024, 16 * 1024 * 1024])("a boundary search inside an unfinished record is bounded at cursor %s", cursor => {
    const path = join(root, "session.jsonl"); writeFileSync(path, '{"old":true}\n' + "u".repeat(16 * 1024 * 1024));
    return readStartupTailRecords(path, { end: cursor, maxBytes: 1024 }).then(tail => {
      expect(io.bytes).toBeLessThanOrEqual(1024); expect(tail.records).toEqual([]);
      expect(tail.truncated).toBe(true); expect(tail).not.toHaveProperty("end");
    });
  });
  it("a cursor inside a record emits only earlier complete records, even with short physical reads", async () => {
    const path = join(root, "session.jsonl"), first = '{"a":1}\n', next = '{"b":2}\n';
    writeFileSync(path, first + next); io.maxRead = 2;
    const tail = await readStartupTailRecords(path, { end: first.length + 4, maxBytes: 128 });
    expect(tail).toEqual({ records: [{ record: first.trimEnd(), at: 0 }], truncated: false });
    expect(io.bytes).toBeLessThanOrEqual(128);
  });
  it("does not emit a partial record when the remaining payload budget is exhausted", async () => {
    const path = join(root, "session.jsonl"); writeFileSync(path, '{"a":1}\n' + '{"pad":"' + "x".repeat(300) + '"}\n');
    const tail = await readStartupTailRecords(path, { end: 1024, maxBytes: 32 });
    expect(tail.records).toEqual([]); expect(tail.truncated).toBe(true); expect(io.bytes).toBeLessThanOrEqual(32);
  });
  it("a non-progressing boundary read throws instead of adopting a guessed cursor", async () => {
    const path = join(root, "session.jsonl"); writeFileSync(path, '{"a":1}\n'); io.zero = true;
    await expect(readStartupTailRecords(path, { end: 8, maxBytes: 32 })).rejects.toThrow(/no progress/);
  });
});

it("actual LogService initial→poll never replays old steps beyond a long unfinished suffix", async () => {
  const path = join(root, "log.jsonl");
  const line = (record: unknown) => JSON.stringify(record) + "\n";
  const user = (id: string, text: string) => ({ type: "user", uuid: id, message: { role: "user", content: text } });
  const answer = (id: string, text: string) => ({ type: "assistant", uuid: id, message: { role: "assistant", content: [{ type: "text", text }] } });
  const old = line(user("old-user", "old user")) + line(answer("old-answer", "old answer"));
  writeFileSync(path, old + '{"padding":"' + "x".repeat(9 * 1024 * 1024));
  const service = new LogService({ enabled: () => true, known: () => true,
    source: () => ({ backend: "claude-code", format: "claude", path }), events: () => [], emit: () => {} });
  const initial: any = await service.steps("worker", {});
  let current: any = await service.steps("worker", { after: initial.after, key: initial.key, skip: initial.skip });
  expect(current.steps).toEqual([]);
  // #3809's bounded Log read keeps an interior EOF cursor and skips the unfinished record on forward polling.
  expect(initial).toMatchObject({ after: statSync(path).size, skip: true });
  appendFileSync(path, '"}\n' + line(user("new-user", "new user")) + line(answer("new-answer", "new answer")));
  const steps: any[] = [];
  for (let i = 0; i < 16; i++) {
    current = await service.steps("worker", { after: current.after, key: current.key, skip: current.skip });
    steps.push(...current.steps);
    if (!current.more) break;
  }
  expect(steps.map(s => s.body)).toEqual(["new user", "new answer"]);
  const idle: any = await service.steps("worker", { after: current.after, key: current.key, skip: current.skip });
  expect(idle.steps).toEqual([]);
});

it("the actual monitor uses the bounded startup lane after its inherited baseline lookup", async () => {
  const path = join(root, "session-A.jsonl"), startedAt = Date.now() - 1000;
  const record = { type: "system", subtype: "model_fallback", sessionId: "session-A", uuid: "early-record", timestamp: new Date().toISOString(),
    originalModel: configured, fallbackModel: sonnet };
  const prefix = JSON.stringify(record) + "\n"; writeFileSync(path, prefix + "x".repeat(16 * 1024 * 1024));
  const baseline = await lastLineBoundary(path), inheritedReads = io.bytes;
  expect(baseline).toBe(Buffer.byteLength(prefix));
  io.bytes = 0; io.ranges = [];
  await new Promise(resolve => setTimeout(resolve, 20)); // file predates the monitor; first attach uses its EOF baseline
  writeFileSync(join(root, "statusline.json"), JSON.stringify({ _agendLaunchId: "launch-A", session_id: "session-A", transcript_path: path }));
  const monitor = new TranscriptMonitor(root, pino({ level: "silent" }), null, () => ({ id: "launch-A", startedAt }));
  const observations: unknown[] = []; monitor.on("model_observation", value => observations.push(value));
  await monitor.pollIncrement();
  expect(observations).toHaveLength(1);
  expect(io.bytes - inheritedReads).toBeLessThanOrEqual(8 * 1024 * 1024);
});
