/**
 * #1218 P0 (design: issue comment 6142912335; docs/design/1218-live-activity.md §3.3): every transcript read is
 * bounded. One look reads at most READ_MAX_BYTES; a poll takes at most LOOKS_PER_POLL looks, each awaited; a line over
 * LINE_MAX_BYTES (a tool result of MBs) is never decoded whole — its head is kept, and what it still says (a tool
 * result's id, a tool call's name) reaches the progress bubble, so a huge step is not lost. Real files on a scratch
 * directory; the claude monitor and the codex source as the daemon builds them.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { LINE_MAX_BYTES, LONG_HEAD_BYTES, LOOKS_PER_POLL, READ_MAX_BYTES, readNewLines, recordsInOrder } from "../src/transcript-jsonl.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { CodexRolloutSource, readLineRange } from "../src/transcript-sources.js";
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
  it("a 2 MiB custom_tool_call_output between a call and task_complete: the call, an output, and the turn's end", async () => {
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
      + rec("response_item", { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "o".repeat(2 * 1024 * 1024) }] })
      + rec("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "ok" }));
    const all = { uses: [] as string[], results: 0, turns: [] as string[] };
    for (let i = 0; i < 4; i++) {
      const e = await source.poll();
      all.uses.push(...e.toolUses.map(u => u.name)); all.results += e.toolResults.length;
      all.turns.push(...(e.turns ?? []).map(t => `${t.kind}:${"end" in t ? t.end : ""}`));
    }
    expect(all.uses).toEqual(["exec"]);
    expect(all.results).toBe(1);
    expect(all.turns).toContain("end:complete");
  });
});

describe("readLineRange (a checkpoint's skipped range): chunked, long lines skipped, only kept lines held", () => {
  it("a range with a 3 MiB line between turn records: the records on both sides, never the long line or a fragment", async () => {
    const f = join(temp(), "r.jsonl");
    const a = line({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } });
    const big = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", output: "q".repeat(3 * READ_MAX_BYTES) } }) + "\n";
    const b = line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "steer" }] } });
    const c = line({ type: "response_item", payload: { type: "reasoning" } });
    writeFileSync(f, a + big + b + c);
    const end = Buffer.byteLength(a + big + b + c);
    expect(await readLineRange(f, 0, end)).toEqual([a.trim(), b.trim(), c.trim()]);
    expect(await readLineRange(f, 0, end, (l) => l.includes('"event_msg"') || l.includes('"role":"user"'))).toEqual([a.trim(), b.trim()]);
  });
});
