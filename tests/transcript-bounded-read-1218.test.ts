/**
 * #1218 P0 (design: issue comment 6142912335; docs/design/1218-live-activity.md §3.3): every transcript read is
 * bounded. One look reads at most READ_MAX_BYTES; a poll takes at most LOOKS_PER_POLL looks, each awaited; a line over
 * LINE_MAX_BYTES (a tool result of MBs) is never decoded whole — its head is kept, and what it still says (a tool
 * result's id, a tool call's name) reaches the progress bubble, so a huge step is not lost. Real files on a scratch
 * directory; the claude monitor and the codex source as the daemon builds them.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINE_MAX_BYTES, LONG_HEAD_BYTES, LOOKS_PER_POLL, READ_MAX_BYTES, readNewLines, recordsInOrder } from "../src/transcript-jsonl.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { CodexRolloutSource, MuseSessionSource, readLineRange } from "../src/transcript-sources.js";
import { resetSharedRolloutIndexesForTests } from "../src/rollout-index.js";
import type { Logger } from "../src/logger.js";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1218-p0-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const logger = pino({ level: "silent" }) as unknown as Logger;
const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("readNewLines: one look is bounded", () => {
  it("a 3.5 MiB delta of small lines is read over looks of at most READ_MAX_BYTES: every line once, in order", async () => {
    const f = join(temp(), "t.jsonl");
    const lines = Array.from({ length: 36_000 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(80) }));
    writeFileSync(f, lines.map(l => l + "\n").join(""));
    let offset = 0, looks = 0;
    const got: string[] = [];
    for (;;) {
      const r = await readNewLines(f, offset);
      expect(r.newOffset - offset, "no look reads more than its budget").toBeLessThanOrEqual(READ_MAX_BYTES);
      got.push(...r.lines); offset = r.newOffset; looks++;
      if (!r.more) break;
    }
    expect(looks).toBe(4);
    expect(got).toEqual(lines);
  });

  it("a line over LINE_MAX_BYTES in the window: reported by position with its head and size, never parsed; the offset passes it", async () => {
    const f = join(temp(), "t.jsonl");
    const big = JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "toolu_a", type: "tool_result", content: "y".repeat(600 * 1024) }] } });
    writeFileSync(f, line({ a: 1 }) + big + "\n" + line({ b: 2 }));
    const r = await readNewLines(f, 0);
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.long).toHaveLength(1);
    expect(r.long[0]).toMatchObject({ at: 1, bytes: Buffer.byteLength(big), complete: true });
    expect(Buffer.byteLength(r.long[0]!.head)).toBeLessThanOrEqual(LONG_HEAD_BYTES);
    expect(r.long[0]!.head.startsWith('{"type":"user"')).toBe(true);
    expect([r.skipping, r.more]).toEqual([false, false]);
    expect([...recordsInOrder(r)].map(x => ("line" in x ? x.line : `long@${x.long.at}`))).toEqual(['{"a":1}', "long@1", '{"b":2}']);
  });

  it("a line longer than a whole look: reported once (incomplete), skipped through its end over the next looks, then reading resumes", async () => {
    const f = join(temp(), "t.jsonl");
    writeFileSync(f, line({ a: 1 }) + "z".repeat(3 * READ_MAX_BYTES) + "\n" + line({ after: true }));
    const seen: string[] = []; const longs: number[] = [];
    let offset = 0, skipping = false;
    for (let i = 0; i < 10; i++) {
      const r = await readNewLines(f, offset, { skipping });
      seen.push(...r.lines); longs.push(...r.long.map(l => l.bytes));
      expect(r.newOffset - offset).toBeLessThanOrEqual(READ_MAX_BYTES);
      offset = r.newOffset; skipping = r.skipping;
      if (!r.more && !r.skipping) break;
    }
    expect(seen, "no fragment of the long line is ever a line").toEqual(['{"a":1}', '{"after":true}']);
    expect(longs).toHaveLength(1);
    expect(skipping).toBe(false);
  });

  it("a long line still being written (no line end yet) is reported once; the rest is skipped when it lands", async () => {
    const f = join(temp(), "t.jsonl");
    writeFileSync(f, line({ a: 1 }) + "w".repeat(LINE_MAX_BYTES + 10));
    const r1 = await readNewLines(f, 0);
    expect([r1.lines, r1.long.length, r1.long[0]!.complete, r1.skipping]).toEqual([['{"a":1}'], 1, false, true]);
    appendFileSync(f, "w".repeat(5000) + "\n" + line({ next: 1 }));
    const r2 = await readNewLines(f, r1.newOffset, { skipping: true });
    expect([r2.lines, r2.long, r2.skipping]).toEqual([['{"next":1}'], [], false]);
  });

  it("a short record still being written waits (as before), and a head never ends inside a UTF-8 character", async () => {
    const f = join(temp(), "t.jsonl");
    writeFileSync(f, line({ a: 1 }) + '{"pending":');
    expect(await readNewLines(f, 0)).toMatchObject({ lines: ['{"a":1}'], long: [], skipping: false });
    const g = join(temp(), "u.jsonl");
    writeFileSync(g, "中".repeat(LINE_MAX_BYTES) + "\n");
    const r = await readNewLines(g, 0);
    expect(r.long[0]!.head).not.toContain("�");
    expect(r.long[0]!.head.length).toBe(Math.floor(LONG_HEAD_BYTES / 3));
  });
});

describe("the claude monitor: bounded looks per poll, and a long line's head still reaches the bubble", () => {
  function monitorOn(file: string) {
    const m = new TranscriptMonitor(temp(), logger);
    m.setTranscriptPath(file);
    const events: string[] = [];
    m.on("tool_use", (name: string) => events.push(`use:${name}`));
    m.on("tool_result", (id: string) => events.push(`result:${id}`));
    m.on("assistant_text", (t: string) => events.push(`text:${t.slice(0, 8)}`));
    return { m, events };
  }
  const assistant = (content: unknown[]) => line({ type: "assistant", message: { role: "assistant", content } });
  const user = (content: unknown[]) => line({ type: "user", message: { role: "user", content } });

  it("a 600 KiB tool result and a 400 KiB Write: their ids and names are still emitted, in transcript order", async () => {
    const f = join(temp(), "s.jsonl");
    writeFileSync(f,
      assistant([{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } }])
      + user([{ tool_use_id: "toolu_1", type: "tool_result", content: "r".repeat(600 * 1024) }])
      + assistant([{ type: "tool_use", id: "toolu_2", name: "Write", caller: { type: "direct" }, input: { file_path: "b.ts", content: "w".repeat(400 * 1024) } }])
      + assistant([{ type: "text", text: "done now" }]));
    const { m, events } = monitorOn(f);
    await m.pollIncrement();
    expect(events).toEqual(["use:Read", "result:toolu_1", "use:Write", "text:done now"]);
  });

  it("inside a line longer than a poll: the monitor keeps skipping it (never re-reports its middle as a line), then reads on", async () => {
    const f = join(temp(), "s.jsonl");
    writeFileSync(f, user([{ tool_use_id: "toolu_9", type: "tool_result", content: "m".repeat(5 * READ_MAX_BYTES) }]) + assistant([{ type: "text", text: "after it" }]));
    const { m, events } = monitorOn(f);
    await m.pollIncrement();
    expect([events, (m as any).skipping]).toEqual([["result:toolu_9"], true]);
    await m.pollIncrement();
    expect([events, (m as any).skipping]).toEqual([["result:toolu_9", "text:after it"], false]);
  });

  it(`a 6 MiB delta: one poll takes at most ${LOOKS_PER_POLL} looks; the next poll continues — nothing lost, nothing twice`, async () => {
    const f = join(temp(), "s.jsonl");
    const n = Math.floor(6 * 1024 * 1024 / 200);
    let body = "";
    for (let i = 0; i < n; i++) body += assistant([{ type: "text", text: `t${String(i).padStart(6, "0")} ${"p".repeat(120)}` }]);
    writeFileSync(f, body);
    const { m, events } = monitorOn(f);
    await m.pollIncrement();
    const first = events.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(n);
    await m.pollIncrement(); await m.pollIncrement();
    expect(events).toHaveLength(n);
    expect(new Set(events).size).toBe(n);
  });
});

describe("the codex source: a long output line is skipped by its head; turns after it are still read", () => {
  it("a 6 MiB custom_tool_call_output between a call and task_complete: the call, an output, and the turn's end", async () => {
    const root = temp(), cwd = temp();
    const day = join(root, "2026", "10", "13"); mkdirSync(day, { recursive: true });
    const f = join(day, "rollout-2026-10-13T10-00-00-0000.jsonl");
    const rec = (type: string, payload: Record<string, unknown>) => line({ timestamp: "2026-10-13T02:00:00.000Z", type, payload });
    writeFileSync(f, rec("session_meta", { id: "s1", cwd, timestamp: "2026-10-13T02:00:00.000Z" }));
    const source = new CodexRolloutSource(cwd, root);
    await source.poll();
    appendFileSync(f,
      rec("event_msg", { type: "task_started", turn_id: "t1" })
      + rec("response_item", { type: "custom_tool_call", call_id: "c1", name: "exec", input: "ls" })
      + rec("response_item", { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "o".repeat(6 * 1024 * 1024) }] })
      + rec("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "ok" }));
    const all = { uses: [] as string[], results: 0, turns: [] as string[] };
    const mid: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const e = await source.poll();
      mid.push((source as any).skipping);
      all.uses.push(...e.toolUses.map(u => u.name)); all.results += e.toolResults.length;
      all.turns.push(...(e.turns ?? []).map(t => `${t.kind}:${"end" in t ? t.end : ""}`));
    }
    expect(mid.slice(0, 2), "inside the 6 MiB output across polls, then through its end").toEqual([true, false]);
    expect(all.uses).toEqual(["exec"]);
    expect(all.results).toBe(1);
    expect(all.turns).toContain("end:complete");
  });
});

describe("readLineRange (a checkpoint's skipped range): chunked, long lines skipped, only kept lines held", () => {
  it("a range with a 3 MiB output between turn records: the records the caller keeps, never the output or a fragment of it", async () => {
    const f = join(temp(), "r.jsonl");
    const a = line({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } });
    const big = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", output: "q".repeat(3 * READ_MAX_BYTES) } }) + "\n";
    const b = line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "steer" }] } });
    const c = line({ type: "response_item", payload: { type: "reasoning" } });
    writeFileSync(f, a + big + b + c);
    const end = Buffer.byteLength(a + big + b + c);
    const keep = (l: string) => l.includes('"event_msg"') || l.includes('"role":"user"');
    expect(await readLineRange(f, 0, end, keep)).toEqual([a.trim(), b.trim()]);
    // Kept by the caller, a long line is read whole (≤ WHOLE_LINE_MAX_BYTES): the default keeps everything.
    expect((await readLineRange(f, 0, end)).map(l => l.length)).toEqual([a.trim().length, big.trim().length, b.trim().length, c.trim().length]);
    const alloc = vi.spyOn(Buffer, "alloc");
    try {
      await readLineRange(f, 0, end, keep);
      expect(Math.max(...alloc.mock.calls.map(c => Number(c[0]))), "never one buffer for the whole range").toBeLessThanOrEqual(READ_MAX_BYTES);
    } finally { alloc.mockRestore(); }
  });
});

// #1786 review (Fable): a long line that is a turn's record must never be lost to the line limit.
describe("long turn records are read whole (bounded): a turn's end and a pasted prompt are never lost", () => {
  async function rollout() {
    const root = temp(), cwd = temp();
    const day = join(root, "2026", "10", "13"); mkdirSync(day, { recursive: true });
    const f = join(day, "rollout-2026-10-13T10-00-00-0000.jsonl");
    const rec = (type: string, payload: Record<string, unknown>) => line({ timestamp: "2026-10-13T02:00:00.000Z", type, payload });
    writeFileSync(f, rec("session_meta", { id: "s1", cwd, timestamp: "2026-10-13T02:00:00.000Z" }));
    const source = new CodexRolloutSource(cwd, root);
    await source.poll();
    const turns = async (n = 3) => { const out: string[] = []; for (let i = 0; i < n; i++) out.push(...((await source.poll()).turns ?? []).map(t => `${t.kind}${"end" in t ? `:${t.end}` : ""}`)); return out; };
    return { f, rec, turns };
  }
  const longReply = "r".repeat(300 * 1024);
  it.each([
    ["turn_id first", (rec: any) => rec("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: longReply })],
    ["turn_id last", (rec: any) => line({ timestamp: "2026-10-13T02:00:00.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: longReply, turn_id: "t1" } })],
    ["over several looks", (rec: any) => rec("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "x".repeat(5 * READ_MAX_BYTES) })],
  ])("codex: a task_complete with a long final reply (%s) ends its turn", async (_name, completion) => {
    const r = await rollout();
    appendFileSync(r.f, r.rec("event_msg", { type: "task_started", turn_id: "t1" }) + completion(r.rec));
    expect(await r.turns(4)).toEqual(["start", "end:complete"]);
  });
  it("codex: a pasted 300 KiB prompt is still the turn's user record", async () => {
    const r = await rollout();
    appendFileSync(r.f, r.rec("event_msg", { type: "task_started", turn_id: "t1" })
      + r.rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "p".repeat(300 * 1024) }] })
      + r.rec("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "ok" }));
    expect(await r.turns()).toEqual(["start", "user", "end:complete"]);
  });
  it("readLineRange (a checkpoint's range): a kept long turn record is read whole, also across chunks", async () => {
    const f = join(temp(), "r.jsonl");
    const end1 = line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: longReply, turn_id: "a" } });
    const end2 = line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "y".repeat(3 * READ_MAX_BYTES), turn_id: "b" } });
    const out = line({ type: "response_item", payload: { type: "function_call_output", output: "o".repeat(2 * READ_MAX_BYTES) } });
    writeFileSync(f, end1 + out + end2);
    const got = await readLineRange(f, 0, Buffer.byteLength(end1 + out + end2), (l) => l.includes('"event_msg"'));
    expect(got.map(l => JSON.parse(l).payload.turn_id)).toEqual(["a", "b"]);
  });

  it("muse: a delta over the poll's look budget is finished on the next poll, with no growth of the log; a long prompt is kept", async () => {
    const FIX = join(import.meta.dirname, "fixtures", "reply-guard-1510", "muse-1.4.4");
    const LOG = readFileSync(join(FIX, "session.jsonl"), "utf8").trim().split("\n");
    const root = join(temp(), "sessions");
    const dir = join(root, "2026", "10", "10", "01a121bb-e928-7d00-ac73-07064285b859"); mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.jsonl"); writeFileSync(file, "");
    let clock = 0;
    const source = new MuseSessionSource("/home/user/project", root, 30_000, () => clock);
    await source.initialize();
    // The first prompt made long (a paste), and 5 MiB of other records before the run's end.
    const lines = LOG.map((l) => {
      const o = JSON.parse(l);
      if (o.payload_type === "runtime.user_intent.accepted" && !(globalThis as any).__done) { (globalThis as any).__done = 1; o.payload.model_messages[0].content[0].text += " " + "z".repeat(300 * 1024); }
      return JSON.stringify(o);
    });
    delete (globalThis as any).__done;
    const pad = Array.from({ length: 5 }, () => JSON.stringify({ recorded_at: 1, payload_type: "tool.output", payload: { text: "q".repeat(READ_MAX_BYTES) } }));
    appendFileSync(file, [...lines.slice(0, -1), ...pad, lines.at(-1)!].map(l => l + "\n").join(""));
    clock += 30_000;
    const first = (await source.poll()).turns ?? [];
    expect([...(source as any).skipping.values()].some(Boolean), "the first poll stopped inside a long record and keeps skipping it").toBe(true);
    const second = (await source.poll()).turns ?? [];
    const kinds = [...first, ...second].map(t => t.kind);
    expect(kinds).toEqual(["start", "user", "user", "end", "start", "end"]);
    expect(first.length, "the first poll stopped at its budget").toBeLessThan(6);
    const longUser = [...first, ...second].find(t => t.kind === "user") as { text: string };
    expect(longUser.text.length).toBeGreaterThan(300 * 1024);
  });

  it("codex: a switch to another rollout while skipping a long line reads that rollout from its first record after the baseline", async () => {
    resetSharedRolloutIndexesForTests(0);   // the test edits its own tree between polls
    const root = temp(), cwd = temp();
    const day = join(root, "2026", "10", "13"); mkdirSync(day, { recursive: true });
    const rec = (type: string, payload: Record<string, unknown>) => line({ timestamp: "2026-10-13T02:00:00.000Z", type, payload });
    // B exists before the source starts (its history is skipped: it is adopted at its baseline); A is the active one.
    const b = join(day, "rollout-2026-10-13T09-00-00-0002.jsonl");
    writeFileSync(b, rec("session_meta", { id: "b", cwd, timestamp: "2026-10-13T01:00:00.000Z" }) + rec("event_msg", { type: "task_complete", turn_id: "old", last_agent_message: "x" }));
    const a = join(day, "rollout-2026-10-13T10-00-00-0001.jsonl");
    writeFileSync(a, rec("session_meta", { id: "a", cwd, timestamp: "2026-10-13T02:00:00.000Z" }));
    const { utimesSync } = await import("node:fs");
    utimesSync(b, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const source = new CodexRolloutSource(cwd, root);
    await source.poll();
    appendFileSync(a, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "o".repeat(6 * READ_MAX_BYTES) } }).slice(0, 5 * READ_MAX_BYTES));
    await source.poll();
    expect([(source as any).currentFile, (source as any).skipping]).toEqual([a, true]);
    // B is written to again (a resumed session): it is now the newest, and its first new record is a turn start.
    appendFileSync(b, rec("event_msg", { type: "task_started", turn_id: "t9" }));
    const turns: string[] = [];
    for (let i = 0; i < 3; i++) turns.push(...((await source.poll()).turns ?? []).map(t => `${t.kind}:${t.turnId}`));
    expect((source as any).currentFile).toBe(b);
    expect(turns).toContain("start:t9");
    resetSharedRolloutIndexesForTests();
  });

  it("claude: a long assistant reply (over the line limit) still reaches the bubble as assistant text", async () => {
    const f = join(temp(), "s.jsonl");
    writeFileSync(f, line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "long reply " + "w".repeat(300 * 1024) }] } }));
    const m = new TranscriptMonitor(temp(), logger);
    m.setTranscriptPath(f);
    const texts: string[] = [];
    m.on("assistant_text", (t: string) => texts.push(t.slice(0, 10)));
    await m.pollIncrement();
    expect(texts).toEqual(["long reply"]);
  });
});
