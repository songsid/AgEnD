/**
 * #3787 (#3787): Codex in the chat's activity block. The parser is read against a REAL Codex 0.160.0 rollout (a redacted
 * capture, tests/fixtures/chat-activity-3787: two web-chat messages, the second in a turn that Codex compacted four times
 * — once before the turn's first message, three times in the middle), and the cases the capture cannot hold are built from
 * the same record shapes. Every case here fails if the fix it names is taken out (the mutation runs are in the PR).
 *
 *   one step per action     Codex 0.153–0.167 runs every tool through an `exec` script call and also writes the tool it ran as an
 *                           `item_completed` item of its own: shown both, each action was two steps
 *   the prompt              Codex's own context (AGENTS.md instructions, the environment) is also a `user` message: it was taken
 *                           for the turn's prompt, and the turn lost its anchor
 *   not a failure           a turn that answered through the `reply` tool ends with `last_agent_message: null`: it is not failed
 *   compaction              `compacted` has no turn id and is megabytes long: a read that begins at or after it still names the
 *                           turn, and the steps hang on the same turn as the ones read before
 *   tail                    a rollout of hundreds of MB is read from its end, never whole
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodexStepParser, chatStep, readTailRecords, stepsOf, type LogStep } from "../src/log-steps.js";
import { LogService } from "../src/log-service.js";
import { LINE_MAX_BYTES, openTranscript, readNewLines, readWholeLine } from "../src/transcript-jsonl.js";
import { installDom } from "./helpers/mini-dom.js";

type Mod = any;
let groups: Mod, row: Mod;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  groups = await import("/ui/js/chat-activity-groups.js");
  row = await import("/ui/js/log-row.js");
  base.restore();
});

const FIX = join(import.meta.dirname, "fixtures", "chat-activity-3787");
const ROLLOUT = join(FIX, "codex-0.160.0-web-chat.jsonl");
const lines = readFileSync(ROLLOUT, "utf8").split("\n").filter(Boolean);
const ledger = JSON.parse(readFileSync(join(FIX, "codex-0.160.0-web-chat.ledger.json"), "utf8")) as Array<Record<string, any>>;
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-3787-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A Log service reading `path` as the chat's block does. */
const serviceOn = (path: string) => new LogService({ enabled: () => true, toolProgress: () => "verbose", known: () => true, events: () => [], emit() {}, source: () => ({ backend: "codex", path, format: "codex" }) });
/** The parser over `records` with byte offsets as a real read gives them. */
function parse(records: readonly string[], opts: { thinking?: boolean } = {}, from = 0): LogStep[] {
  const p = new CodexStepParser(opts);
  let at = from;
  for (const r of records) { p.push(r, at); at += Buffer.byteLength(r) + 1; }
  return p.steps;
}
const offsetOf = (i: number) => lines.slice(0, i).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
const brief = (s: LogStep) => (s.kind === "tool" ? `tool:${s.tool}:${s.cat}:${s.status}` : s.kind);
const rec = (type: string, payload: unknown, ts = "2026-11-13T05:00:00.000Z") => JSON.stringify({ timestamp: ts, type, payload });
const ev = (payload: Record<string, unknown>, ts?: string) => rec("event_msg", payload, ts);
const ri = (payload: Record<string, unknown>, turn = "t1", ts?: string) => rec("response_item", { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turn } }, ts);
const userMsg = (text: string, kinds: string[] = ["user.text"], turn = "t1") => rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: kinds } });
const TURN1 = "01a1d350-0002-7000-8000-000000000002";
const TURN2 = "01a1d350-0015-7000-8000-000000000015";
const TURN3 = "01a1d350-0028-7000-8000-000000000028";
const TURNS = [TURN1, TURN2, TURN3];
const COMPACTED = lines.map((l, i) => (l.startsWith('{"timestamp":') && l.includes('"type":"compacted"') ? i : -1)).filter((i) => i >= 0);
const TURN_STARTS = lines.map((l, i) => (l.includes('"type":"task_started"') ? i : -1)).filter((i) => i >= 0);

describe("the real Codex 0.160.0 capture: one step per action", () => {
  const steps = parse(lines);
  it("the fixture is what it says: Codex 0.160.0, three turns, four compactions, a reasoning record with no summary and no readable text", () => {
    expect(lines[0]).toContain('"cli_version":"0.160.0"');
    expect(TURN_STARTS).toHaveLength(3);
    expect(COMPACTED).toHaveLength(4);
    expect(COMPACTED[0]).toBeLessThan(lines.findIndex((l) => l.includes('"type":"message"') && l.includes('"role":"user"') && l.includes("b2df")));   // the first one lies before turn 2's own prompt
    const reasoning = lines.map((l) => JSON.parse(l).payload).filter((p) => p.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].summary).toEqual([]);
    expect(reasoning[0].encrypted_content).toMatch(/^gAAAAAB-REDACTED/);
  });
  it("turn 1: prompt, the model's words, five commands (two failed) and the reply — not an `exec` call besides each of them", () => {
    expect(steps.filter((s) => s.turn === TURN1).map(brief)).toEqual([
      "user", "assistant",
      "tool:command:run:done", "tool:command:read:done", "tool:command:run:failed", "tool:command:run:done", "tool:command:read:failed", "tool:command:run:done",
      "tool:agend:reply:message:done", "turn_end",
    ]);
    expect(steps.some((s) => s.tool === "exec")).toBe(false);
  });
  it("turn 3 (a reasoning record, no compaction): prompt, words, a command, the reply", () => {
    expect(steps.filter((s) => s.turn === TURN3).map(brief)).toEqual(["user", "assistant", "tool:command:run:done", "tool:agend:reply:message:done", "turn_end"]);
  });
  it("turn 2: the compactions are notes on the turn that was running, in file order", () => {
    expect(steps.filter((s) => s.turn === TURN2).map(brief)).toEqual([
      "state", "user", "assistant", "tool:command:read:done", "state", "tool:command:run:done", "state", "tool:agend:reply:message:done", "state", "turn_end",
    ]);
    expect(steps.filter((s) => s.kind === "state").every((s) => s.note === "compacted" && s.turn === TURN2)).toBe(true);
  });
  it("a step is the command Codex ran, not the shell it ran it through; failures carry their exit code", () => {
    const tools = steps.filter((s) => s.kind === "tool" && s.tool === "command");
    expect(tools.some((s) => /\/bin\/bash|-lc/.test(String(s.subject)))).toBe(false);
    expect(tools.map((s) => s.subject)).toContain("wc -l notes.txt");
    const failed = tools.filter((s) => s.status === "failed");
    expect(failed.map((s) => s.exitCode)).toEqual([127, 1]);
    expect(tools.find((s) => s.subject === "notes.txt")).toMatchObject({ cat: "read", status: "done" });     // Codex's own parsed_cmd: a read of one file
    expect(tools.every((s) => typeof s.durationMs === "number")).toBe(true);
  });
  it("a step that took an `exec` call over keeps the call's id and start (the output of that call adds nothing)", () => {
    const calls = lines.map((l) => JSON.parse(l)).filter((e) => e.payload?.type === "custom_tool_call");
    for (const c of calls) {
      const s = steps.find((x) => x.id === c.payload.call_id);
      expect(s, c.payload.call_id).toBeDefined();
      expect(s!.ts).toBe(Date.parse(c.timestamp));
    }
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);                                            // no id twice
  });
  it("the prompt of each turn is the person's message with the ids AgEnD wrote in it — and nothing of Codex's own context", () => {
    const users = steps.filter((s) => s.kind === "user");
    expect(users.map((u) => u.anchor)).toEqual([
      { messageId: "web-lm2k9a-aa11bb22", humanId: expect.stringMatching(/^hmsg-/) },
      { messageId: "web-lm2m1b-cc33dd44", humanId: expect.stringMatching(/^hmsg-/) },
      { messageId: "web-lm2n2c-ee55ff66", humanId: expect.stringMatching(/^hmsg-/) },
    ]);
    expect(JSON.stringify(steps)).not.toContain("environment_context");
  });
  it("each reply call is anchored by what it said and by the messageId its result returned; a turn that replied did not fail", () => {
    const replies = steps.filter((s) => s.tool === "agend:reply");
    expect(replies.map((r) => r.anchor)).toEqual([
      { replyText: expect.stringContaining("notes.txt originally contained alpha and beta"), messageId: "web-stub1-22d7" },
      { replyText: expect.stringContaining("Created `todo.md`"), messageId: "web-stub1-22d7-t2" },
      { replyText: expect.stringContaining("Let the ball cost x"), messageId: "web-stub1-22d7-t3" },
    ]);
    expect(steps.filter((s) => s.kind === "turn_end").map((s) => s.status)).toEqual([undefined, undefined, undefined]);
  });
  it("encrypted reasoning (the one real record, with no summary) is never shown, with thinking asked for or not", () => {
    for (const thinking of [false, true]) {
      const all = parse(lines, { thinking });
      expect(all.some((s) => s.kind === "thinking")).toBe(false);
      expect(JSON.stringify(all)).not.toMatch(/gAAAAAB|REDACTED-ENCRYPTED/);
    }
  });
  it("the thinking text a model DID write (a summary) shows only when asked for, and once", () => {
    const records = [
      ev({ type: "task_started", turn_id: "t1" }),
      ri({ type: "reasoning", summary: [{ type: "summary_text", text: "Reading notes.txt first." }], encrypted_content: "gAAAAAB-x" }),
      ev({ type: "agent_reasoning", text: "Reading notes.txt first." }),            // the same summary as an event
      ri({ type: "reasoning", summary: [], encrypted_content: "gAAAAAB-y" }),         // no summary: nothing
    ];
    expect(parse(records, { thinking: true }).filter((s) => s.kind === "thinking").map((s) => s.body)).toEqual(["Reading notes.txt first."]);
    expect(parse(records).some((s) => s.kind === "thinking")).toBe(false);
  });
});

describe("one step per action: the `exec` call and the item it ran are one step", () => {
  const cmd = (id: string, command: string[], extra: Record<string, unknown> = {}) => ev({ type: "item_completed", turn_id: "t1", item: { type: "CommandExecution", id, command, status: "completed", exit_code: 0, aggregated_output: "out", duration: { secs: 0, nanos: 1_000_000 }, ...extra } });
  const exec = (call: string, input: string) => ri({ type: "custom_tool_call", call_id: call, name: "exec", input, status: "completed" });
  const out = (call: string) => ri({ type: "custom_tool_call_output", call_id: call, output: [{ type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }] });

  it("the first item of a script takes over its step; a second item of the same script is a step of its own", () => {
    const steps = parse([
      ev({ type: "task_started", turn_id: "t1" }),
      exec("c1", "text(await tools.exec_command({cmd:'a'})); text(await tools.exec_command({cmd:'b'}));"),
      cmd("exec-1", ["/bin/bash", "-lc", "a"]), cmd("exec-2", ["/bin/bash", "-lc", "b"]),
      out("c1"),
    ]);
    expect(steps.map((s) => [s.id, s.kind === "tool" ? s.tool : s.kind, s.subject, s.status])).toEqual([["c1", "command", "a", "done"], ["exec-2", "command", "b", "done"]]);
  });
  it("the script's step is born running (a command that has not finished is on screen) and is the item's when it finishes", () => {
    const p = new CodexStepParser();
    p.push(ev({ type: "task_started", turn_id: "t1" }));
    const started = p.push(exec("c1", "text(await tools.exec_command({cmd:'sleep 20'}));"));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ id: "c1", tool: "exec", status: "running" });
    const done = p.push(cmd("exec-1", ["sleep", "20"]));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: "c1", tool: "command", subject: "sleep 20", status: "done", exitCode: 0 });
    expect(done[0]!.input).toBe("sleep 20");              // not the script's text
    expect(p.push(out("c1"))).toEqual([]);
    expect(p.steps).toHaveLength(1);
  });
  it("a script that ran no tool (a calculation) stays one `exec` step, and its output completes it", () => {
    const p = new CodexStepParser();
    p.push(ev({ type: "task_started", turn_id: "t1" }));
    p.push(exec("c1", "text(1 + 1)"));
    p.push(ri({ type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "Script failed\nWall time 0.1 seconds\nOutput:\nboom" }] }));
    expect(p.steps.map((s) => [s.id, s.tool, s.status])).toEqual([["c1", "exec", "done"]]);
  });
  it("an item of a kind that is not shown does not take the script's step over", () => {
    const steps = parse([
      ev({ type: "task_started", turn_id: "t1" }),
      exec("c1", "text(await tools.something_new({}))"),
      ev({ type: "item_completed", turn_id: "t1", item: { type: "SubAgentActivity", id: "x" } }),
      out("c1"),
    ]);
    expect(steps.map((s) => [s.id, s.tool, s.status])).toEqual([["c1", "exec", "done"]]);
  });
  it("a new turn does not carry the last script over (an item with no script running is a step of its own)", () => {
    const steps = parse([
      ev({ type: "task_started", turn_id: "t1" }),
      exec("c1", "text(await tools.exec_command({cmd:'a'}))"),
      ev({ type: "task_started", turn_id: "t2" }),
      cmd("exec-9", ["b"]),
    ]);
    expect(steps.map((s) => [s.id, s.turn, s.status])).toEqual([["c1", "t1", "interrupted"], ["exec-9", "t2", "done"]]);
  });
  it("web searches, file changes, MCP calls and viewed images are steps too; the page and its results are not kept", () => {
    const steps = parse([
      ev({ type: "task_started", turn_id: "t1" }),
      exec("c1", "text(await tools.web__run({}))"),
      ev({ type: "item_completed", turn_id: "t1", item: { type: "Extension", kind: "web.search", id: "w1", query: "agend codex rollout", action: { type: "search", query: null, queries: ["agend codex rollout", "codex 0.160"] }, results: [{ title: "SECRET-PAGE-BODY" }] } }),
      out("c1"),
      exec("c2", "text(await tools.view_image({}))"),
      ev({ type: "item_completed", turn_id: "t1", item: { type: "ImageView", id: "i1", path: "file:///home/user/project/shot.png" } }),
      out("c2"),
    ], { thinking: true });
    expect(steps.map((s) => [s.tool, s.cat, s.subject])).toEqual([["web.search", "web", "agend codex rollout"], ["view_image", "read", "/home/user/project/shot.png"]]);
    expect(JSON.stringify(steps)).not.toContain("SECRET-PAGE-BODY");
  });
});

describe("the prompt: Codex's own context is not a person's message", () => {
  it("AGENTS.md instructions and the environment — named by what the message holds — are no step; the person's text is", () => {
    const steps = parse([
      ev({ type: "task_started", turn_id: "t1" }),
      userMsg("# AGENTS.md instructions for /home/user/project\n\n<INSTRUCTIONS>be nice</INSTRUCTIONS>\n<environment_context>x</environment_context>", ["agents_md.instructions", "environments.environment_context"]),
      userMsg("[agend-human-id:hmsg-1]\n(message_id: web-u1 | verification_id: hmsg-1)"),
    ]);
    expect(steps.map((s) => [s.kind, s.anchor])).toEqual([["user", { messageId: "web-u1", humanId: "hmsg-1" }]]);
  });
  it("a message the kinds name as Codex's own is no step even when its text looks like a prompt (the kinds decide, not the text)", () => {
    const steps = parse([
      ev({ type: "task_started", turn_id: "t1" }),
      userMsg("Please keep answers short.", ["agents_md.instructions"]),
      userMsg("(message_id: web-u1 | verification_id: hmsg-1)\nhello", ["user.text"]),
    ]);
    expect(steps.map((s) => [s.kind, s.anchor])).toEqual([["user", { messageId: "web-u1" }]]);
  });
  it("a rollout that does not name the kinds is judged by its text, AGENTS.md included", () => {
    const steps = parse([
      ev({ type: "task_started", turn_id: "t1" }),
      rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /w\n\nrules" }] }),
      rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] }),
      rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] }),
    ]);
    expect(steps.map((s) => [s.kind, s.body])).toEqual([["user", "fix the bug"]]);
  });
});

describe("a turn that answered through the reply tool is not a failed turn", () => {
  const turn = (middle: string[], last: unknown) => parse([ev({ type: "task_started", turn_id: "t1" }), ...middle, ev({ type: "task_complete", turn_id: "t1", last_agent_message: last, duration_ms: 1000 })]).at(-1)!;
  const reply = [ri({ type: "custom_tool_call", call_id: "c1", name: "exec", input: "text(await tools.mcp__agend__reply({text:'Done.'}))", status: "completed" }), ri({ type: "custom_tool_call_output", call_id: "c1", output: "ok" })];
  it("`last_agent_message: null` after a `reply` call (in the script or as the call itself): done", () => {
    expect(turn(reply, null).status).toBeUndefined();
    expect(turn([ri({ type: "function_call", call_id: "f1", name: "mcp__agend__reply", arguments: JSON.stringify({ text: "Done." }) })], null).status).toBeUndefined();
  });
  it("after a message of the model's, or with a last message: done", () => {
    expect(turn([ri({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] })], null).status).toBeUndefined();
    expect(turn([], "Hi").status).toBeUndefined();
  });
  it("a turn that said nothing at all and has no last message is failed (as before)", () => {
    expect(turn([], null).status).toBe("failed");
  });
});

describe("compaction: the steps hang on the right turn wherever the read begins", () => {
  const cold = parse(lines);
  const rows = ledger;
  const shaped = (steps: LogStep[]) => groups.groupSteps(rows, steps, { now: Date.parse("2026-11-13T05:30:00Z"), complete: true }).groups
    .map((g: any) => [g.turn, g.rowKey, g.level, g.items.map((i: LogStep) => i.tool ?? i.kind)]);
  const wanted = () => shaped(cold);

  it("the cold read puts each reply's work above its own row, by the id the reply returned", () => {
    const want = wanted();
    expect(want.map((g: any[]) => [g[0], g[1], g[2]])).toEqual([[TURN1, "a1b2-2", "id"], [TURN2, "a1b2-4", "id"], [TURN3, "a1b2-6", "id"]]);
    expect(want[0][3]).toEqual(["assistant", "command", "command", "command", "command", "command", "command"]);
    expect(want[1][3]).toEqual(["assistant", "command", "command"]);
    expect(want[2][3]).toEqual(["assistant", "command"]);
  });
  it("a parser that begins at ANY record (the window after a long `compacted`, a read that meets no `task_started`) puts its steps on the turn they belong to", () => {
    let checked = 0;
    for (let k = 1; k < lines.length; k++) {
      const now = TURN_STARTS.filter((i) => i <= k).length - 1;                          // the turn record k is in (-1: before the first)
      const allowed = TURNS.slice(Math.max(now, 0));
      const read = parse(lines.slice(k), {}, offsetOf(k)).filter((s) => s.kind !== "user");
      for (const st of read) { expect(allowed, `read from record ${k}: ${st.kind} ${st.id}`).toContain(st.turn); checked++; }
    }
    expect(checked).toBeGreaterThan(60);
  });
  it("polled in every possible split — through the service, as the page polls, merged as the page merges — the thread groups exactly as the cold read does", async () => {
    const f = join(temp(), "rollout.jsonl");
    writeFileSync(f, lines.join("\n") + "\n");
    const svc = serviceOn(f);
    const want = wanted();
    for (let k = 1; k < lines.length; k++) {
      const first = parse(lines.slice(0, k));
      const next: any = await svc.steps("w", { chat: true, after: offsetOf(k) });
      const merged = row.mergeSteps(first, next.steps);
      expect(shaped(merged), `split at record ${k}`).toEqual(want);
      expect(new Set(merged.map((s: LogStep) => s.id)).size, `split at record ${k}: an id twice`).toBe(merged.length);
      expect(merged.filter((s: LogStep) => s.tool === "exec"), `split at record ${k}: a script beside its item`).toEqual([]);
    }
  });
  it("a split inside a script: the call is in one read, the item and the output in the next — one step, finished", async () => {
    const f = join(temp(), "rollout.jsonl");
    writeFileSync(f, lines.join("\n") + "\n");
    const callAt = lines.findIndex((l, i) => i > TURN_STARTS[2]! && l.includes('"type":"custom_tool_call"') && l.includes("echo done"));
    expect(callAt).toBeGreaterThan(0);
    const first = parse(lines.slice(0, callAt + 1));
    expect(first.at(-1)).toMatchObject({ tool: "exec", status: "running", subject: "echo done" });          // on screen while it runs, by its command
    const next: any = await serviceOn(f).steps("w", { chat: true, after: offsetOf(callAt + 1) });
    const merged = row.mergeSteps(first, next.steps);
    const turn3 = merged.filter((s: LogStep) => s.turn === TURN3 && s.kind === "tool");
    expect(turn3.map((s: LogStep) => [s.tool, s.status, s.subject])).toEqual([["command", "done", "echo done"], ["agend:reply", "done", "agend:reply"]]);
    expect(turn3[0]!.id).toBe(first.at(-1)!.id);                                                           // the same step, finished
  });
  it("a compaction note read before the turn is known waits for it: no step with no turn between two runs of one turn", () => {
    const i = COMPACTED[1]!;
    const next = parse(lines.slice(i), {}, offsetOf(i));
    expect(next[0]!.kind).toBe("state");
    expect(next.every((s) => s.turn === TURN2 || s.turn === TURN3)).toBe(true);
    expect(next.filter((s) => s.kind === "state")).toHaveLength(COMPACTED.length - 1);
    expect(next.filter((s) => s.kind === "state").every((s) => s.turn === TURN2)).toBe(true);
  });
  it("a `compacted` record of megabytes (a long line) is read as a note and nothing else; what follows it is on its turn", async () => {
    const f = join(temp(), "rollout.jsonl");
    const i = COMPACTED[1]!;
    const big = JSON.parse(lines[i]!);
    big.payload.replacement_history = [{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(2 * 1024 * 1024) }] }];
    const all = [...lines.slice(0, i), JSON.stringify(big), ...lines.slice(i + 1)];
    writeFileSync(f, all.join("\n") + "\n");
    const tail = await readTailRecords(f, { maxLines: 4000 });
    const long = tail.records.filter((r) => typeof r.record !== "string");
    expect(long).toHaveLength(1);
    expect((long[0]!.record as { bytes: number }).bytes).toBeGreaterThan(LINE_MAX_BYTES);
    const steps = stepsOf(new CodexStepParser(), tail.records, 200);
    expect(steps.map(brief)).toEqual(cold.map(brief));
    expect(steps.filter((s) => s.kind === "state").every((s) => s.turn === TURN2 || s.turn === TURN3)).toBe(true);
    // and through the service: the newest window, and a poll that begins at the long record itself
    const svc = serviceOn(f);
    const back: any = await svc.steps("w", { chat: true });
    expect(back.steps.map(brief)).toEqual(cold.map(brief));
    const fwd: any = await svc.steps("w", { chat: true, after: offsetOf(i) });
    expect(fwd.steps[0]).toMatchObject({ kind: "state", note: "compacted", turn: TURN2 });
    expect(fwd.steps.every((s: LogStep) => s.turn === TURN2 || s.turn === TURN3)).toBe(true);
  });
});

describe("a big rollout is read from its end", () => {
  it("12 MB of older records before the capture: the newest steps come back, the old prompt is never parsed, and older ones are offered by cursor", async () => {
    const f = join(temp(), "rollout.jsonl");
    const OLD = "web-OLD-PROMPT-SENTINEL";
    const filler = JSON.stringify({ timestamp: "2026-11-01T00:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { pad: "p".repeat(2000) } } });
    writeFileSync(f, [
      rec("event_msg", { type: "task_started", turn_id: "old" }),
      userMsg(`(message_id: ${OLD} | verification_id: hmsg-old)`, ["user.text"], "old"),
    ].join("\n") + "\n");
    for (let i = 0; i < 6; i++) appendFileSync(f, (filler + "\n").repeat(1000));          // ~12 MB
    appendFileSync(f, lines.join("\n") + "\n");
    const svc = new LogService({ enabled: () => true, toolProgress: () => "verbose", known: () => true, events: () => [], emit() {}, source: () => ({ backend: "codex", path: f, format: "codex" }) });
    const a: any = await svc.steps("w", { chat: true });
    expect(a.steps.map(brief)).toEqual(parse(lines).map(brief));
    expect(JSON.stringify(a.steps)).not.toContain(OLD);
    expect(a.before).toEqual(expect.any(Number));                                         // older steps exist and were not read
    const tail = await readTailRecords(f, { maxLines: 4000 });
    expect(tail.truncated).toBe(true);
    expect(tail.records.length).toBeLessThanOrEqual(4000);
  });
});

describe("what the chat shows at each level (the server decides, the page only draws)", () => {
  const steps = parse(lines);
  it("standard: the kind of step and what it named — a file for a read, the program for a command; no arguments, no output", () => {
    const std = steps.filter((s) => s.kind === "tool" && s.tool === "command").map((s) => chatStep(s, "standard"));
    expect(std.map((s) => [s.cat, s.subject])).toEqual([
      ["run", "pwd"], ["read", "notes.txt"], ["run", "python"], ["run", "wc"], ["read", "missing.txt"], ["run", "printf"],
      ["read", "rg --files -g AGENTS.md -g todo.md -g notes.txt"], ["run", "printf"], ["run", "echo"],
    ]);
    expect(std.every((s) => s.body === undefined && s.input === undefined)).toBe(true);
  });
  it("verbose: the command and its output", () => {
    const wc = chatStep(steps.find((s) => s.subject === "wc -l notes.txt")!, "verbose");
    expect(wc.input).toBe("wc -l notes.txt");
    expect(wc.body).toContain("notes.txt");
  });
  it("a person's prompt text is dropped at every level (the chat already shows it)", () => {
    for (const level of ["standard", "verbose"] as const) {
      const u = chatStep(steps.find((s) => s.kind === "user")!, level);
      expect(u.body).toBeUndefined();
      expect(u.anchor).toBeDefined();
    }
  });
  it("a secret in a command is masked in its subject and input", () => {
    const token = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const s = parse([
      ev({ type: "task_started", turn_id: "t1" }),
      ev({ type: "item_completed", turn_id: "t1", item: { type: "CommandExecution", id: "e1", command: ["/bin/bash", "-lc", `curl -H "Authorization: Bearer ${token}" https://x.example`], status: "completed", exit_code: 0, aggregated_output: `key=${token}`, parsed_cmd: [{ type: "unknown", cmd: "curl" }] } }),
    ]);
    expect(JSON.stringify(s)).not.toContain(token);
  });
});

describe("a transcript is read only if it is a regular file: a symbolic link is not followed, a FIFO is not waited on", () => {
  const within = async <T>(p: Promise<T>, ms = 1500): Promise<T | "hung"> => Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);
  const fifo = (): string => { const f = join(temp(), "rollout.fifo"); execFileSync("mkfifo", [f]); return f; };
  const link = (): string => { const l = join(temp(), "rollout.jsonl"); symlinkSync(ROLLOUT, l); return l; };
  const posix = process.platform !== "win32";

  it.runIf(posix)("a symbolic link in the rollout's place: no steps, whatever the read (newest window, a poll with its look-back, an older page) — and the link's target is never read", async () => {
    const svc = serviceOn(link());
    for (const q of [{ chat: true }, { chat: true, after: offsetOf(30) }, { chat: true, before: offsetOf(30) }] as const) {
      const a: any = await svc.steps("w", q as never);
      expect(a, JSON.stringify(q)).toMatchObject({ supported: true, reason: "no_transcript", steps: [] });
    }
    expect(JSON.stringify(await svc.readBack("w", { limit: 10 }))).toContain("no_transcript");
  });
  it.runIf(posix)("a FIFO in the rollout's place answers at once, with no steps — the service does not wait for a writer", async () => {
    const svc = serviceOn(fifo());
    for (const q of [{ chat: true }, { chat: true, after: 100 }, {}] as const) {
      const a: any = await within(svc.steps("w", q as never));
      expect(a, JSON.stringify(q)).not.toBe("hung");
      expect(a).toMatchObject({ reason: "no_transcript", steps: [] });
    }
  });
  it.runIf(posix)("the readers themselves refuse them (a file swapped for a FIFO or a link after the service looked): they throw, they do not block", async () => {
    const f = fifo(), l = link();
    for (const [what, run] of [
      ["readTailRecords", (p: string) => readTailRecords(p, { maxLines: 10 })],
      ["readTailRecords before a cursor (the poll's look-back)", (p: string) => readTailRecords(p, { maxLines: 10, end: 100 })],
      ["readNewLines", (p: string) => readNewLines(p, 0)],
      ["readWholeLine", (p: string) => readWholeLine(p, 0, 10)],
      ["openTranscript", (p: string) => openTranscript(p)],
    ] as const) {
      for (const p of [f, l]) {
        const r = await within(run(p).then(() => "read", () => "refused"));
        expect(r, `${what} on ${p === f ? "a FIFO" : "a link"}`).toBe("refused");
      }
    }
  });
  it("a regular file is read as before (the guard is not in the way)", async () => {
    const a: any = await serviceOn(ROLLOUT).steps("w", { chat: true });
    expect(a.steps.length).toBeGreaterThan(0);
    const fh = await openTranscript(ROLLOUT); await fh.close();
  });
});

describe("a call or output over the line limit is bookkept like a short one (the bounded reader, as the page reads)", () => {
  const BIG = "z".repeat(LINE_MAX_BYTES + 4096);
  const call = (id: string, input: string) => ri({ type: "custom_tool_call", id: `ctc_${id}`, status: "completed", call_id: id, name: "exec", input });
  const done = (id: string, text: string) => ri({ type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text }] });
  const item = (it: Record<string, unknown>) => ev({ type: "item_completed", turn_id: "t1", item: it });
  const command = (id: string, exitCode: number) => item({ type: "CommandExecution", id, command: ["/bin/bash", "-lc", "false"], status: exitCode ? "failed" : "completed", exit_code: exitCode, aggregated_output: "nope", duration: { secs: 0, nanos: 5_000_000 } });
  const replyItem = (id: string, messageId: string) => item({ type: "McpToolCall", id, server: "agend", tool: "reply", arguments: { text: "hello" }, status: "completed", result: { content: [{ type: "text", text: JSON.stringify({ chatId: "web", messageId }) }] }, duration: { secs: 0, nanos: 1_000_000 } });
  const REPLY_SCRIPT = "text(await tools.mcp__agend__reply({text:'hello'}));";
  const start = [ev({ type: "task_started", turn_id: "t1" }), userMsg("work on it (message_id: web-u1)")];
  const rowsOf = [
    { boot: "b", id: 1, instance: "x", role: "user", sender: "u", text: "work on it", ts: "2026-11-13T05:00:00.000Z", anchor: "web-u1" },
    { boot: "b", id: 2, instance: "x", role: "agent", sender: "x", text: "an unrelated answer", ts: "2026-11-13T05:00:01.000Z", anchor: "web-unrelated" },
  ];
  const shaped = (steps: LogStep[]) => groups.groupSteps(rowsOf, steps, { now: Date.parse("2026-11-13T05:30:00Z"), complete: true }).groups
    .map((g: any) => [g.rowKey, g.level, g.items.map((i: LogStep) => `${i.tool ?? i.kind}:${i.status ?? ""}`)]);
  /** The file's records, written as a rollout; the steps of the page's cold read (the service) and of a whole-record parse. */
  async function cold(all: string[]): Promise<{ file: string; steps: LogStep[]; whole: LogStep[] }> {
    const file = join(temp(), "rollout.jsonl");
    writeFileSync(file, all.join("\n") + "\n");
    const read: any = await serviceOn(file).steps("w", { chat: true });
    return { file, steps: read.steps, whole: parse(all) };
  }
  /** What the page holds after every poll split: the cold read of the first k records merged with the poll after them. */
  async function splits(all: string[], file: string): Promise<Array<[number, LogStep[]]>> {
    const out: Array<[number, LogStep[]]> = [];
    for (let k = 1; k < all.length; k++) {
      const first = parse(all.slice(0, k));
      const next: any = await serviceOn(file).steps("w", { chat: true, after: all.slice(0, k).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0) });
      out.push([k, row.mergeSteps(first, next.steps)]);
    }
    return out;
  }

  it("a failed command whose script's output is over the limit stays failed: the output adds no nameless `done` step over it", async () => {
    const all = [...start, call("c1", "text(await tools.exec_command({cmd:'false'}));"), command("exec-1", 1), done("c1", `Script completed\nWall time 0.1 seconds\nOutput:\n${BIG}`)];
    const { file, steps, whole } = await cold(all);
    expect(whole.filter((s) => s.kind === "tool").map((s) => [s.id, s.tool, s.status, s.exitCode])).toEqual([["c1", "command", "failed", 1]]);
    expect(steps.filter((s) => s.kind === "tool").map((s) => [s.id, s.tool, s.status, s.exitCode])).toEqual([["c1", "command", "failed", 1]]);
    // the page merges the cold read, and every poll after a split, into what it holds: the command is still failed
    expect(row.mergeSteps([], steps).filter((s: LogStep) => s.kind === "tool").map((s: LogStep) => s.status)).toEqual(["failed"]);
    for (const [k, merged] of await splits(all, file)) {
      expect(merged.filter((s: LogStep) => s.kind === "tool").map((s: LogStep) => [s.id, s.tool, s.status]), `split at record ${k}`).toEqual([["c1", "command", "failed"]]);
    }
  });
  it("an output over the limit with no item takes its script's step over like a short one: finished, named, with the exit code its head says", async () => {
    const all = [...start, call("c1", "text(1 + 1)"), done("c1", `Script failed\nWall time 0.1 seconds\nProcess exited with code 3\nOutput:\n${BIG}`)];
    const { steps, whole } = await cold(all);
    const mine = (l: LogStep[]) => l.filter((s) => s.kind === "tool").map((s) => [s.id, s.tool, s.status, s.exitCode]);
    expect(mine(whole)).toEqual([["c1", "exec", "failed", 3]]);
    expect(mine(steps)).toEqual(mine(whole));
  });
  it("a reply whose own id is not in the ledger stays unattached through the bounded reader, as in a whole-record parse (no row of someone else's)", async () => {
    const all = [...start, call("c1", REPLY_SCRIPT), replyItem("exec-1", "web-a1"), done("c1", `Script completed\nWall time 0.1 seconds\nOutput:\n${BIG}`)];
    const { file, steps, whole } = await cold(all);
    const want = shaped(whole);
    expect(want.some((g: any[]) => g[1] === "none")).toBe(true);                 // explicit id, no such row: level none
    expect(want.every((g: any[]) => g[1] !== "turn" && g[0] !== "b-2")).toBe(true);
    expect(steps.filter((s) => s.kind === "tool")).toHaveLength(1);
    expect(shaped(steps)).toEqual(want);
    expect(shaped(row.mergeSteps([], steps))).toEqual(want);
    for (const [k, merged] of await splits(all, file)) expect(shaped(merged), `split at record ${k}`).toEqual(want);
  });
  it("an exec call whose input is over the limit is still the wrapper its first item takes over: one action, not two", async () => {
    const all = [...start, call("c1", `text(await tools.exec_command({cmd:'a'}));/*${BIG}*/`), command("exec-1", 0), done("c1", "Script completed\nWall time 0.1 seconds\nOutput:\n")];
    const { file, steps, whole } = await cold(all);
    const mine = (l: LogStep[]) => l.filter((s) => s.kind === "tool").map((s) => [s.id, s.tool, s.status]);
    expect(mine(whole)).toEqual([["c1", "command", "done"]]);
    expect(mine(steps)).toEqual([["c1", "command", "done"]]);
    // A poll that begins between such a call and its item cannot learn the call: the priming read is bounded to 256 KiB and the
    // call is longer than that, so its start is out of reach (a known limit — one extra step then, never a wrong one). Every other split is exact.
    for (const [k, merged] of await splits(all, file)) {
      if (k === start.length + 1) continue;
      expect(mine(merged), `split at record ${k}`).toEqual([["c1", "command", "done"]]);
    }
  });
  it("a long call that sends a reply is a turn that spoke: its `task_complete` with no last message is not a failure", async () => {
    const all = [...start, call("c1", `${REPLY_SCRIPT}/*${BIG}*/`), done("c1", "Script completed\nWall time 0.1 seconds\nOutput:\n"), ev({ type: "task_complete", turn_id: "t1", last_agent_message: null })];
    const { steps } = await cold(all);
    expect(steps.find((s) => s.kind === "turn_end")?.status).not.toBe("failed");
  });
});

describe("the reads that find a record boundary stay inside their byte budget, whatever unfinished record follows", () => {
  /** Every byte any file handle hands back while `fn` runs. */
  async function counting<T>(fn: () => Promise<T>): Promise<{ result: T; bytes: number; reads: number }> {
    const probe = await openTranscript(ROLLOUT);
    const proto = Object.getPrototypeOf(probe) as { read: (...a: any[]) => Promise<{ bytesRead: number }> };
    await probe.close();
    const real = proto.read;
    let bytes = 0, reads = 0;
    proto.read = async function (this: unknown, ...args: any[]) { const r = await real.apply(this, args); bytes += r.bytesRead; reads++; return r; };
    try { const result = await fn(); return { result, bytes, reads }; } finally { proto.read = real; }
  }
  const MB = 1024 * 1024;
  const prefix = (): string => ev({ type: "task_started", turn_id: "t1" }) + "\n";           // a complete record
  /** A file of one complete record and `tail` bytes with no line end after it (a record being written). */
  const unfinished = (tail: number): { file: string; end: number } => {
    const file = join(temp(), "rollout.jsonl");
    const head = prefix();
    writeFileSync(file, head + '{"timestamp":"2026-11-13T05:00:00.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","output":"' + "q".repeat(tail));
    return { file, end: Buffer.byteLength(head) };
  };
  const PRIME = { maxBytes: 256 * 1024, maxLines: 300 };

  it("priming from an explicit cursor reads the records before it, not the unfinished record after it (a short complete prefix, then 8 MiB without a line end)", async () => {
    const { file, end } = unfinished(8 * MB);
    const r = await counting(() => readTailRecords(file, { ...PRIME, end }));
    expect(r.result.records.map((x) => x.record)).toEqual([prefix().trimEnd()]);                     // the complete line is still returned
    expect(r.result.end).toBe(end);
    expect(r.bytes).toBeLessThanOrEqual(PRIME.maxBytes);
    expect(r.bytes).toBeLessThanOrEqual(end + 1);                                                   // in fact: the prefix and one byte
  });
  it("the read does not grow with the unfinished record: 8 MiB and 32 MiB after it cost the same", async () => {
    const small = unfinished(8 * MB), big = unfinished(32 * MB);
    const a = await counting(() => readTailRecords(small.file, { ...PRIME, end: small.end }));
    const b = await counting(() => readTailRecords(big.file, { ...PRIME, end: big.end }));
    expect(b.bytes).toBe(a.bytes);
    expect(b.reads).toBe(a.reads);
  });
  it("a priming poll through the service: its reads do not scale with the unfinished record either", async () => {
    const small = unfinished(8 * MB), big = unfinished(32 * MB);
    const a = await counting(() => serviceOn(small.file).steps("w", { chat: true, after: small.end }));
    const b = await counting(() => serviceOn(big.file).steps("w", { chat: true, after: big.end }));
    expect(b.bytes).toBe(a.bytes);
  });
  it("the initial backfill (no cursor) reads at most its budget when the file ends in an unfinished record of 20 MiB, and says where it stands", async () => {
    const { file } = unfinished(20 * MB);
    const size = readFileSync(file).length;
    const r = await counting(() => readTailRecords(file, { maxBytes: 4 * MB }));
    expect(r.bytes).toBeLessThanOrEqual(4 * MB);
    expect(r.result.records).toEqual([]);                      // unknown state: no complete line within the budget — none is guessed
    expect(r.result).toMatchObject({ truncated: true, end: size, skip: true });
    const svc = await counting(() => serviceOn(file).steps("w", { chat: true }));
    expect(svc.bytes).toBeLessThanOrEqual(8 * MB);               // BACKFILL_MAX_BYTES, boundary search included
    expect(svc.result).toMatchObject({ steps: [], after: size, skip: true });
  });
  it("the backfill's cost does not grow with the unfinished record (20 MiB and 40 MiB after a short prefix)", async () => {
    const a = await counting(() => readTailRecords(unfinished(20 * MB).file, {}));
    const b = await counting(() => readTailRecords(unfinished(40 * MB).file, {}));
    expect(b.bytes).toBe(a.bytes);
  });
  it("after such a backfill the next poll drops through the unfinished record and loses nothing after it", async () => {
    const { file } = unfinished(9 * MB);                                                                    // longer than the backfill budget
    const svc = serviceOn(file);
    const first: any = await svc.steps("w", { chat: true });
    expect(first).toMatchObject({ steps: [], skip: true });
    appendFileSync(file, '"}}\n' + lines.slice(0, 14).join("\n") + "\n");                             // the record ends; real ones follow
    const next: any = await svc.steps("w", { chat: true, after: first.after, skip: first.skip });
    expect(next.steps.map(brief)).toEqual(parse(lines.slice(0, 14)).map(brief));
    expect(next.steps.length).toBeGreaterThan(0);
  });
  it("a record being written within the budget is still not returned, and the complete ones before it are", async () => {
    const f = join(temp(), "rollout.jsonl");
    writeFileSync(f, lines.slice(0, 5).join("\n") + "\n" + lines[5]!.slice(0, 100));
    const r = await readTailRecords(f, { maxBytes: 64 * 1024 });
    expect(r.records.map((x) => x.record)).toEqual(lines.slice(0, 5));
    expect(r.end).toBe(offsetOf(5));
    expect(r.skip).toBeUndefined();
    const older = await readTailRecords(f, { maxBytes: 64 * 1024, end: offsetOf(3) });             // the older page: before a cursor
    expect(older.records.map((x) => x.record)).toEqual(lines.slice(0, 3));
    expect(older.end).toBe(offsetOf(3));
  });
  it("a cursor that is not at a line end looks back from itself: the complete lines before it, never the data after", async () => {
    const f = join(temp(), "rollout.jsonl");
    writeFileSync(f, lines.slice(0, 6).join("\n") + "\n");
    const mid = offsetOf(4) + 10;
    const r = await readTailRecords(f, { end: mid });
    expect(r.end).toBe(offsetOf(4));
    expect(r.records.map((x) => x.record)).toEqual(lines.slice(0, 4));
  });
});
