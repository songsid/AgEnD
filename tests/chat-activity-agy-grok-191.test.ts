/**
 * AGEND-181 PR2: antigravity (agy) and grok transcripts for the Log and the chat's activity timeline — the two parsers
 * (from real redacted captures of INTERACTIVE instances AgEnD ran, tests/fixtures/chat-activity-3648), their anchors and
 * grouping, where each CLI's transcript is found, and the Log service reading them (thinking only when it is allowed).
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeStepParser, CodexStepParser, stepsOf, readTailRecords, type LogStep } from "../src/log-steps.js";
import { AntigravityStepParser, GrokStepParser } from "../src/log-steps-agy-grok.js";
import { LogService, type LogServiceDeps, type LogSource } from "../src/log-service.js";
import { GROK_LOOKUP_TTL_MS, antigravityTranscriptPath, grokUpdatesPath } from "../src/log-transcript-paths.js";
// @ts-expect-error — a JS module of the app, with no types
import { groupSteps, composeRows, isReplyStep } from "../src/ui/chat-activity-groups.js";

const FIX = join(import.meta.dirname, "fixtures", "chat-activity-3648");
const read = (f: string) => readFileSync(join(FIX, f), "utf8").split("\n").filter(Boolean);
const ledgerOf = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8")) as Array<Record<string, any>>;
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-191-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function agy(records: unknown[], thinking = true): LogStep[] {
  const p = new AntigravityStepParser({ thinking });
  records.forEach((r, i) => p.push(typeof r === "string" ? r : JSON.stringify(r), i * 1000));
  return p.steps;
}
function grok(records: unknown[], thinking = true): LogStep[] {
  const p = new GrokStepParser({ thinking });
  records.forEach((r, i) => p.push(typeof r === "string" ? r : JSON.stringify(r), i * 1000));
  return p.steps;
}
const shape = (items: LogStep[]) => items.map((s) => (s.kind === "tool" ? `tool:${s.tool}` : s.kind));
const upd = (sessionUpdate: string, rest: Record<string, unknown> = {}, ms = 1000, params: Record<string, unknown> = {}) =>
  ({ timestamp: Math.floor(ms / 1000), method: "session/update", params: { sessionId: "s", update: { sessionUpdate, ...rest }, _meta: { agentTimestampMs: ms }, ...params } });
const planner = (step_index: number, rest: Record<string, unknown>) => ({ step_index, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-11T11:10:00Z", ...rest });
const generic = (step_index: number, content: string, status = "DONE", rest: Record<string, unknown> = {}) =>
  ({ step_index, source: "MODEL", type: "GENERIC", status, created_at: "2026-11-11T11:10:05Z", content, ...rest });
const userInput = (step_index: number, text: string) => ({ step_index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-11T11:10:00Z", content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x.\n</ADDITIONAL_METADATA>` });

/* ------------------------------------------------------------------ antigravity */

describe("antigravity: the parser, on a real interactive capture", () => {
  const steps = agy(read("agy-web-chat.jsonl"));
  it("each prompt is a user step with the ids AgEnD wrote into it; the <USER_REQUEST> wrapper and the metadata after it are not the prompt", () => {
    const users = steps.filter((s) => s.kind === "user");
    expect(users.map((u) => u.anchor)).toEqual([
      { messageId: "web-mwc0oy33-dc5ced92", humanId: "hmsg-6f8b19d7-7edd-4e57-abda-d66f3752f7f8" },
      { messageId: "web-mwc0tnan-c1417b0b", humanId: "hmsg-e56d4695-6b4e-48d7-824b-cf3fc3950b6b" },
    ]);
    expect(users[0]!.body).toContain("echo fixture-191");
    expect(users[0]!.body).not.toContain("<USER_REQUEST>");
    expect(users[0]!.body).not.toContain("ADDITIONAL_METADATA");
  });
  it("agy's `reply` is call_mcp_tool: shown as the MCP tool, anchored by its text and by the messageId its result returned", () => {
    const replies = steps.filter(isReplyStep);
    expect(replies.map((r) => r.tool)).toEqual(["mcp__agend-fleet__reply", "mcp__agend-fleet__reply", "mcp__agend-fleet__reply"]);
    expect(replies.map((r) => r.anchor!.messageId)).toEqual(["web-mwc0p66h-287bd1ad", "web-mwc0tsp0-1824dfca", "web-mwc0tx4h-de5785f9"]);
    expect(replies[1]!.anchor!.replyText).toBe("Created note.txt containing 'hello'. Proceeding to run the shell command...");
    expect(replies[1]!.cat).toBe("message");
    expect(JSON.parse(replies[1]!.input!)).toMatchObject({ reply_to: "web-mwc0tnan-c1417b0b", format: "text" });
  });
  it("two calls in one planner step get their own results, in order (a planner step may hold several calls)", () => {
    const tools = steps.filter((s) => s.kind === "tool" && s.turn === steps[0]!.turn);
    expect(tools.slice(0, 2).map((t) => [t.id, t.tool, t.status])).toEqual([["t2", "run_command", "done"], ["t3", "read_file", "done"]]);
    expect(tools[0]!.body).toBe("fixture-191\r\n");                     // the Created At / Completed At header and "Command output:" are not the output
    expect(tools[0]!.exitCode).toBe(0);
    expect(tools[1]!.body).toContain('"name":"reply"');
  });
  it("a failed command: its exit code and output; a write: done", () => {
    const failed = steps.find((s) => s.tool === "run_command" && s.status === "failed")!;
    expect(failed).toMatchObject({ cat: "run", subject: "cat does-not-exist.txt", exitCode: 1 });
    expect(failed.body).toContain("No such file or directory");
    expect(steps.find((s) => s.tool === "write_file")).toMatchObject({ cat: "edit", status: "done", subject: "/home/user/scratch-191/ws/agy/note.txt" });
  });
  it("a planner step with no call ends the turn (with its length); the closing word is an assistant step", () => {
    expect(steps.filter((s) => s.kind === "turn_end").map((s) => s.durationMs)).toEqual([10000, 12000]);
    expect(steps.filter((s) => s.kind === "assistant").map((s) => s.body)).toEqual([".", "."]);
  });
  it("thinking: the planner's own field, a step only when asked for (the counter-proof: off, there is none)", () => {
    expect(steps.filter((s) => s.kind === "thinking").length).toBeGreaterThan(0);
    expect(agy(read("agy-web-chat.jsonl"), false).some((s) => s.kind === "thinking")).toBe(false);
  });
});

describe("antigravity: grouping above the reply it produced (real ledger)", () => {
  const steps = agy(read("agy-web-chat.jsonl"));
  const ledger = ledgerOf("agy-web-chat.ledger.json");
  const now = Date.parse("2026-11-11T12:00:00Z");
  const result = groupSteps(ledger, steps, { now, complete: true });
  it("by exact id: each reply's row gets the steps since the previous reply", () => {
    expect(result.live).toBeNull();
    expect(result.groups.map((g: any) => [g.rowKey, g.level])).toEqual([["a1b2-3", "id"], ["a1b2-8", "id"], ["a1b2-10", "id"]]);
    expect(shape(result.groups[0].items)).toEqual(["thinking", "tool:run_command", "tool:read_file", "tool:run_command", "thinking"]);
    expect(shape(result.groups[1].items)).toEqual(["thinking", "tool:write_file"]);
    expect(shape(result.groups[2].items)).toEqual(["tool:run_command"]);
  });
  it("what agy said after its last reply is the group's not-sent text", () => {
    expect(shape(result.groups[2].trailing)).toEqual(["assistant"]);
  });
  it("the turn in progress is live until its reply row arrives", () => {
    const cut = read("agy-web-chat.jsonl").slice(0, 15);                  // up to (not including) the second reply
    const going = groupSteps(ledger.slice(0, 4), agy(cut), { now });
    expect(composeRows(ledger.slice(0, 4), going).map((r: any) => r.role)).toEqual(["user", "activity", "agent", "user", "activity", "agent", "activity"].slice(0, 7));
    expect(going.live?.level).toBe("live");
  });
  it("without ids on the ledger rows it falls back to the reply's text (and says so)", () => {
    const bare = ledger.map(({ anchor: _a, ...r }) => r);
    expect(groupSteps(bare, steps, { now }).groups.map((g: any) => g.level)).toEqual(["text", "text", "text"]);
  });
});

describe("antigravity: edge cases of the format", () => {
  it("a call's id is the step index of its result: a result read without its call (the call lay before the range) is the same step", () => {
    const records = [userInput(1, "go"), planner(2, { tool_calls: [{ name: "run_command", args: { CommandLine: '"ls"' } }, { name: "read_file", args: { Path: '"/x/y"' } }] }), generic(3, "Created At: 2026-11-11T19:10:05+08:00\nCompleted At: 2026-11-11T19:10:06+08:00\nCommand exited with code 0.\n\nCommand output:\nok\n"), generic(4, "Created At: a\nCompleted At: b\nfile body")];
    const whole = agy(records);
    const second = agy(records.slice(2));                                // starts at the results: their calls are before it
    expect(whole.filter((s) => s.kind === "tool").map((s) => s.id)).toEqual(["t3", "t4"]);
    expect(second.map((s) => s.id)).toEqual(["t3", "t4"]);
    expect(whole[1]!.durationMs).toBe(1000);
    expect(second[0]).toMatchObject({ status: "done", body: "ok\n", exitCode: 0 });
  });
  it("a background command answers RUNNING with its task: the call is done and says so; an ERROR result fails it with the error", () => {
    const s = agy([userInput(1, "go"),
      planner(2, { tool_calls: [{ name: "run_command", args: { CommandLine: '"sleep 100"' } }, { name: "read_file", args: { Path: '"/nope"' } }] }),
      generic(3, "Created At: 2026-11-11T19:10:05+08:00\nTool is running as a background task with task id: c/task-3\nTask Description: sleep 100", "RUNNING"),
      generic(4, "Created At: x\nCompleted At: y\nEncountered error in step execution: file does not exist", "ERROR", { error: "file does not exist" })]);
    const tools = s.filter((x) => x.kind === "tool");
    expect(tools[0]).toMatchObject({ status: "done" });
    expect(tools[0]!.body).toContain("running as a background task");
    expect(tools[1]).toMatchObject({ status: "failed", body: "file does not exist" });
  });
  it("a new prompt interrupts a call that never got its result; the turn key is the step index of the prompt", () => {
    const s = agy([userInput(1, "first"), planner(2, { tool_calls: [{ name: "run_command", args: { CommandLine: '"sleep 9"' } }] }), userInput(4, "second")]);
    expect(s.find((x) => x.kind === "tool")!.status).toBe("interrupted");
    expect(s.filter((x) => x.kind === "user").map((x) => x.turn)).toEqual(["u1", "u4"]);
  });
  it("a checkpoint is a compaction; an error message is an error; SYSTEM_MESSAGE is not a step", () => {
    const s = agy([{ step_index: 1, type: "CHECKPOINT", source: "SYSTEM", status: "DONE", created_at: "2026-11-11T11:10:00Z", content: "…" },
      { step_index: 2, type: "ERROR_MESSAGE", source: "SYSTEM", status: "DONE", created_at: "2026-11-11T11:10:00Z", content: "quota exceeded" },
      { step_index: 3, type: "SYSTEM_MESSAGE", source: "SYSTEM", status: "DONE", created_at: "2026-11-11T11:10:00Z", content: "notice" }]);
    expect(s.map((x) => [x.kind, x.note ?? x.body])).toEqual([["state", "compacted"], ["error", "quota exceeded"]]);
  });
  it("secrets are masked in thinking, arguments, results and text, as everywhere in the Log", () => {
    const s = agy([userInput(1, "use DB_PASSWORD=hunter2hunter2"), planner(2, { thinking: "set API_TOKEN=sk-abcdefghijklmnop1234 and go", tool_calls: [{ name: "run_command", args: { CommandLine: '"export DB_PASSWORD=hunter2hunter2 && ls"' } }] }),
      generic(3, "Created At: a\nCompleted At: b\nCommand exited with code 0.\n\nCommand output:\nDB_PASSWORD=hunter2hunter2\n")]);
    const text = JSON.stringify(s);
    expect(text).not.toContain("hunter2hunter2");
    expect(text).not.toContain("sk-abcdefghijklmnop1234");
  });
  it("arguments are JSON text: a plain string, a number and an object all come out as values", () => {
    const s = agy([planner(2, { tool_calls: [{ name: "run_command", args: { CommandLine: '"echo hi"', WaitMsBeforeAsync: "5000" } }] })]);
    expect(JSON.parse(s[0]!.input!)).toEqual({ CommandLine: "echo hi", WaitMsBeforeAsync: 5000 });
  });
  it("a non-agend MCP tool is `mcp`, not messaging", () => {
    const s = agy([planner(2, { tool_calls: [{ name: "call_mcp_tool", args: { ServerName: '"github"', ToolName: '"list_issues"', Arguments: '{"repo":"a/b"}' } }] })]);
    expect(s[0]).toMatchObject({ tool: "mcp__github__list_issues", cat: "mcp" });
    expect(s[0]!.anchor).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ grok */

describe("grok: the parser, on a real interactive capture", () => {
  const steps = grok(read("grok-web-chat.jsonl"));
  it("each prompt is a user step with its ids; the turn is grok's own prompt number", () => {
    const users = steps.filter((s) => s.kind === "user");
    expect(users.map((u) => u.anchor)).toEqual([
      { messageId: "web-mwc0oy3d-d613eee0", humanId: "hmsg-64917fe6-875d-4ac6-91ef-dc2d4eb7518f" },
      { messageId: "web-mwc0tnav-2e5a94b8", humanId: "hmsg-6b7b6390-2b00-443f-a80b-059a7a67a781" },
    ]);
    expect(users.map((u) => u.turn)).toEqual(["p0", "p1"]);
  });
  it("grok's MCP tools go through use_tool: shown as the tool inside (`agend__reply` → mcp__agend__reply), with the arguments of that tool", () => {
    const replies = steps.filter(isReplyStep);
    expect(replies.map((r) => r.tool)).toEqual(["mcp__agend__reply", "mcp__agend__reply", "mcp__agend__reply"]);
    expect(replies.map((r) => r.anchor!.messageId)).toEqual(["web-mwc0p84s-29b483eb", "web-mwc0trlu-ba290bcb", "web-mwc0tvcy-d95e3e26"]);
    expect(replies[0]!.cat).toBe("message");
    expect(JSON.parse(replies[0]!.input!).text).toContain("Ran `echo fixture-191 && ls`");
  });
  it("calls are paired by toolCallId: a command, a failed read, an edit (its diff), a command that exits 1 although grok says completed", () => {
    const by = (name: string) => steps.filter((s) => s.tool === name);
    expect(by("run_terminal_command").map((s) => [s.status, s.exitCode])).toEqual([["done", 0], ["failed", 1]]);
    expect(by("read_file")[0]).toMatchObject({ status: "failed", cat: "read" });
    expect(by("read_file")[0]!.body).toContain("does not exist");
    expect(by("search_replace")[0]).toMatchObject({ cat: "edit", status: "done", subject: "/home/user/scratch-191/ws/gk/note.txt" });
    expect(by("search_replace")[0]!.body).toContain("+ hello");
    expect(by("run_terminal_command")[0]!.durationMs).toBe(170);
  });
  it("the refinement update (the same call, now with its arguments complete) changes nothing but what is more exact", () => {
    const shell = steps.find((s) => s.tool === "run_terminal_command")!;
    expect(JSON.parse(shell.input!)).toMatchObject({ command: "echo fixture-191 && ls", description: "Echo fixture id and list working directory", is_background: false });
    expect(JSON.parse(shell.input!).variant).toBeUndefined();
  });
  it("turn_completed ends the turn with grok's elapsed time; the closing word is an assistant step", () => {
    expect(steps.filter((s) => s.kind === "turn_end").map((s) => s.durationMs)).toEqual([13931, 11091]);
    expect(steps.filter((s) => s.kind === "assistant").map((s) => s.body)).toEqual(["I'll run the command in the working directory, then check for `hello.txt` and reply with what I find.", ".", "I'll create `note.txt` first, then send a progress note before the failing command.", "."]);
  });
  it("thinking is a step only when asked for", () => {
    expect(steps.filter((s) => s.kind === "thinking")).toHaveLength(7);
    expect(grok(read("grok-web-chat.jsonl"), false).some((s) => s.kind === "thinking")).toBe(false);
  });
});

describe("grok: grouping above the reply it produced (real ledger)", () => {
  const steps = grok(read("grok-web-chat.jsonl"));
  const ledger = ledgerOf("grok-web-chat.ledger.json");
  const result = groupSteps(ledger, steps, { now: Date.parse("2026-11-11T12:00:00Z"), complete: true });
  it("by exact id, with the middle report and the final one each over their own steps", () => {
    expect(result.groups.map((g: any) => [g.rowKey, g.level])).toEqual([["a1b2-4", "id"], ["a1b2-7", "id"], ["a1b2-9", "id"]]);
    expect(shape(result.groups[1].items)).toEqual(["thinking", "assistant", "tool:search_replace", "thinking"]);
    expect(shape(result.groups[2].items)).toEqual(["thinking", "tool:run_terminal_command", "thinking"]);
    expect(shape(result.groups[2].trailing)).toEqual(["assistant"]);
  });
});

describe("grok: edge cases of the format", () => {
  it("chunks of one kind that follow each other are one step (emitted again, whole, with the same id); another record ends the run", () => {
    const p = new GrokStepParser({ thinking: true });
    const a = p.push(JSON.stringify(upd("agent_thought_chunk", { content: { type: "text", text: "First " } })), 0);
    const b = p.push(JSON.stringify(upd("agent_thought_chunk", { content: { type: "text", text: "second." } })), 100);
    expect(a[0]!.body).toBe("First ");
    expect(b[0]).toMatchObject({ id: a[0]!.id, body: "First second." });
    p.push(JSON.stringify(upd("tool_call", { toolCallId: "c1", title: "read_file", rawInput: { target_file: "/a" } })), 200);
    p.push(JSON.stringify(upd("agent_thought_chunk", { content: { type: "text", text: "Again." } })), 300);
    expect(p.steps.filter((s) => s.kind === "thinking").map((s) => s.body)).toEqual(["First second.", "Again."]);
  });
  it("two prompts in a row (a queued message) are two user steps, by grok's prompt number", () => {
    const s = grok([upd("user_message_chunk", { content: { type: "text", text: "one" }, _meta: { promptIndex: 0 } }), upd("user_message_chunk", { content: { type: "text", text: "two" }, _meta: { promptIndex: 1 } })]);
    expect(s.filter((x) => x.kind === "user").map((x) => [x.turn, x.body])).toEqual([["p0", "one"], ["p1", "two"]]);
  });
  it("a cancelled turn is interrupted, and its running call with it; another stop reason is a failure with its reason", () => {
    const s = grok([upd("tool_call", { toolCallId: "c1", title: "run_terminal_command", rawInput: { command: "sleep 9" } }), { timestamp: 2, method: "_x.ai/session/update", params: { sessionId: "s", update: { sessionUpdate: "turn_completed", stop_reason: "cancelled", elapsed_ms: 5 } } }]);
    expect(s.find((x) => x.kind === "tool")!.status).toBe("interrupted");
    expect(s.find((x) => x.kind === "turn_end")).toMatchObject({ status: "interrupted", durationMs: 5 });
    const f = grok([{ timestamp: 2, method: "_x.ai/session/update", params: { sessionId: "s", update: { sessionUpdate: "turn_completed", stop_reason: "max_tokens" } } }]);
    expect(f[0]).toMatchObject({ kind: "turn_end", status: "failed", note: "max_tokens" });
  });
  it("a result read without its call (it lay before the range) is the same step by toolCallId; the call's refinement without a call is nothing", () => {
    const s = grok([upd("tool_call_update", { toolCallId: "c9", kind: "read", title: "Read /a" }), upd("tool_call_update", { toolCallId: "c9", status: "completed", content: [{ type: "content", content: { type: "text", text: "body" } }] })]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: "c9", status: "done", body: "body" });
  });
  it("a tool grok names that AgEnD does not know takes grok's own kind for its icon", () => {
    const s = grok([upd("tool_call", { toolCallId: "c1", title: "mystery", rawInput: {}, _meta: { "x.ai/tool": { name: "mystery", kind: "fetch" } } })]);
    expect(s[0]).toMatchObject({ tool: "mystery", cat: "web" });
  });
  it("a non-agend MCP tool is `mcp`; use_tool with no inner name stays use_tool", () => {
    const s = grok([upd("tool_call", { toolCallId: "c1", title: "use_tool", rawInput: { tool_name: "github__list_issues", tool_input: { repo: "a/b" } } }), upd("tool_call", { toolCallId: "c2", title: "use_tool", rawInput: {} })]);
    expect(s[0]).toMatchObject({ tool: "mcp__github__list_issues", cat: "mcp" });
    expect(s[1]!.tool).toBe("use_tool");
  });
  it("a result too long to parse completes its call with its size; unknown records and background_tasks are not steps", () => {
    const p = new GrokStepParser();
    p.push(JSON.stringify(upd("tool_call", { toolCallId: "big", title: "read_file", rawInput: { target_file: "/big" } })), 0);
    const long = `{"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"big","status":"completed","content":[{"type":"content","content":{"type":"text","text":"xxxx`;
    const out = p.push({ at: 0, head: long, bytes: 900_000, complete: true, offset: 10 }, 10);
    expect(out[0]).toMatchObject({ id: "big", status: "done", bodyBytes: 900_000 });
    expect(grok([upd("background_tasks", { tasks: [] }), upd("something_new", {})])).toEqual([]);
  });
  it("secrets are masked in thinking, arguments, results and text", () => {
    const s = grok([upd("agent_thought_chunk", { content: { type: "text", text: "API_TOKEN=sk-abcdefghijklmnop1234" } }),
      upd("tool_call", { toolCallId: "c1", title: "run_terminal_command", rawInput: { command: "export DB_PASSWORD=hunter2hunter2" } }),
      upd("tool_call_update", { toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "DB_PASSWORD=hunter2hunter2" } }] })]);
    expect(JSON.stringify(s)).not.toMatch(/hunter2hunter2|sk-abcdefghijklmnop1234/);
  });
});

/* ------------------------------------------------------------------ where the transcripts are */

describe("where each CLI's transcript is", () => {
  const ID = "0323876c-f288-4572-a09d-1619b9277d59";
  it("agy: the latest conversation of the working directory (last_conversations.json), as agy --continue resumes it", () => {
    const home = temp();
    mkdirSync(join(home, ".gemini", "antigravity-cli", "cache"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json"), JSON.stringify({ "/work/a": ID, "/work/b": "not-an-id" }));
    expect(antigravityTranscriptPath("/work/a", home)).toBe(join(home, ".gemini", "antigravity-cli", "brain", ID, ".system_generated", "logs", "transcript.jsonl"));
    expect(antigravityTranscriptPath("/work/b", home)).toBeNull();               // a value that is not a conversation id is never joined into a path
    expect(antigravityTranscriptPath("/work/other", home)).toBeNull();
    expect(antigravityTranscriptPath("/work/a", temp())).toBeNull();             // no file at all
  });
  it("agy: an id that tries to leave the brain directory is not followed", () => {
    const home = temp();
    mkdirSync(join(home, ".gemini", "antigravity-cli", "cache"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json"), JSON.stringify({ "/w": "../../../../etc" }));
    expect(antigravityTranscriptPath("/w", home)).toBeNull();
  });
  it("grok: the session of the working directory with the newest activity; looked up at most every few seconds", () => {
    const home = temp();
    const base = join(home, ".grok", "sessions", encodeURIComponent("/work/g"));
    const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
    for (const id of [A, B]) { mkdirSync(join(base, id), { recursive: true }); writeFileSync(join(base, id, "updates.jsonl"), "{}\n"); }
    mkdirSync(join(base, "33333333-3333-4333-8333-333333333333"));                // a session with no updates yet
    utimesSync(join(base, A, "updates.jsonl"), new Date(2e12 - 1e6), new Date(2e12 - 1e6));
    utimesSync(join(base, B, "updates.jsonl"), new Date(2e12), new Date(2e12));
    const t0 = 5_000_000;
    expect(grokUpdatesPath("/work/g", home, t0)).toBe(join(base, B, "updates.jsonl"));
    utimesSync(join(base, A, "updates.jsonl"), new Date(2e12 + 5e6), new Date(2e12 + 5e6));
    expect(grokUpdatesPath("/work/g", home, t0 + 1)).toBe(join(base, B, "updates.jsonl"));          // held
    expect(grokUpdatesPath("/work/g", home, t0 + GROK_LOOKUP_TTL_MS + 1)).toBe(join(base, A, "updates.jsonl"));
    expect(grokUpdatesPath("/work/none", home, t0)).toBeNull();
  });
});

/* ------------------------------------------------------------------ the Log service reads them */

function service(src: LogSource): LogService {
  const deps: LogServiceDeps = { enabled: () => true, known: () => true, source: () => src, events: () => [], emit: () => {} };
  return new LogService(deps);
}
describe("the Log service reads antigravity and grok transcripts", () => {
  it.each([["antigravity", "agy-web-chat.jsonl", "mcp__agend-fleet__reply"], ["grok", "grok-web-chat.jsonl", "mcp__agend__reply"]] as const)("%s: steps for an admin (thinking), none of it for anyone else", async (format, file, reply) => {
    const path = join(FIX, file);
    const svc = service({ backend: format, path, format });
    const admin: any = await svc.steps("x", { thinking: true });
    expect(admin).toMatchObject({ enabled: true, supported: true, thinking: true });
    expect(admin.steps.some((s: LogStep) => s.kind === "thinking")).toBe(true);
    expect(admin.steps.filter((s: LogStep) => s.tool === reply)).toHaveLength(3);
    const other: any = await svc.steps("x", {});
    expect(other.thinking).toBe(false);
    expect(other.steps.some((s: LogStep) => s.kind === "thinking")).toBe(false);          // the parser was not asked: not filtered by the page
    expect(other.steps.length).toBeGreaterThan(0);
    expect(other.cwd).toBeUndefined();
  });
  it("live: the steps after the page's cursor, including a result for a call it already has", async () => {
    const dir = temp(), path = join(dir, "transcript.jsonl");
    const lines = read("agy-web-chat.jsonl");
    writeFileSync(path, lines.slice(0, 7).join("\n") + "\n");                    // up to the planner step that calls reply
    const svc = service({ backend: "antigravity", path, format: "antigravity" });
    const first: any = await svc.steps("x", { thinking: true });
    const call = first.steps.find((s: LogStep) => s.tool === "mcp__agend-fleet__reply");
    expect(call.status).toBe("running");
    appendFileSync(path, lines.slice(7).join("\n") + "\n");
    const next: any = await svc.steps("x", { thinking: true, after: first.after, key: first.key });
    const done = next.steps.find((s: LogStep) => s.id === call.id);
    expect(done).toMatchObject({ status: "done", anchor: { messageId: "web-mwc0p66h-287bd1ad" } });
  });
  it("a backend whose transcript is not found says so; one that has no parser says unsupported", async () => {
    expect(await service({ backend: "grok", path: null, format: "grok", reason: "no_transcript" }).steps("x", {})).toMatchObject({ supported: true, reason: "no_transcript", steps: [] });
    expect(await service({ backend: "grok", path: join(temp(), "missing.jsonl"), format: "grok" }).steps("x", {})).toMatchObject({ supported: true, reason: "no_transcript" });
    expect(await service({ backend: "opencode", path: null, format: null, reason: "unsupported" }).steps("x", {})).toMatchObject({ supported: false, reason: "unsupported" });
  });
  it("the tail reader hands agy's lines through whole (no line of its transcript is long)", async () => {
    const tail = await readTailRecords(join(FIX, "agy-web-chat.jsonl"), { maxLines: 100 });
    expect(tail.records.every((r) => typeof r.record === "string")).toBe(true);
    expect(stepsOf(new AntigravityStepParser(), tail.records, 100).filter((s) => s.kind === "user")).toHaveLength(2);
  });
});

describe("a result whose call lay before the range read is not undone at the turn's end (the Log's live read starts mid-turn)", () => {
  it("a reply's result read without its call still names the delivered messageId (the page merges it into the call by id); another tool's result is no anchor", () => {
    const p = new AntigravityStepParser();
    p.push(JSON.stringify(generic(7, 'Created At: x\nCompleted At: y\n{"chatId":"web","messageId":"web-abc"}')), 0);
    p.push(JSON.stringify(generic(8, "Created At: x\nCompleted At: y\nthe messageId is not here")), 1);
    p.push(JSON.stringify(generic(9, 'Created At: x\nCompleted At: y\n{"messageId":"web-no-chat-id"}')), 2);
    expect(p.steps.map((s) => s.anchor)).toEqual([{ messageId: "web-abc" }, undefined, undefined]);
  });
  it("claude: the orphan result stays done when the turn ends in the same read", () => {
    const p = new ClaudeStepParser();
    p.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] } }), 0);
    const out = p.push(JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 5 }), 10);
    expect(out.map((s) => s.status)).toEqual([undefined]);
    expect(p.steps.find((s) => s.id === "c1")!.status).toBe("done");
  });
  it("codex: the same", () => {
    const p = new CodexStepParser();
    p.push(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "ok" } }), 0);
    const out = p.push(JSON.stringify({ type: "event_msg", payload: { type: "task_complete", duration_ms: 5, last_agent_message: "x" } }), 10);
    expect(out.some((s) => s.id === "c1")).toBe(false);
    expect(p.steps.find((s) => s.id === "c1")!.status).toBe("done");
  });
  it("antigravity and grok: the same", () => {
    const a = new AntigravityStepParser();
    a.push(JSON.stringify(generic(3, "Created At: x\nCompleted At: y\nok")), 0);
    const outA = a.push(JSON.stringify(planner(4, { content: "bye" })), 10);
    expect(outA.some((s) => s.id === "t3")).toBe(false);
    expect(a.steps.find((s) => s.id === "t3")!.status).toBe("done");
    const g = new GrokStepParser();
    g.push(JSON.stringify(upd("tool_call_update", { toolCallId: "c9", status: "completed", content: [{ type: "content", content: { type: "text", text: "b" } }] })), 0);
    const outG = g.push(JSON.stringify({ timestamp: 2, method: "_x.ai/session/update", params: { sessionId: "s", update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" } } }), 10);
    expect(outG.some((s) => s.id === "c9")).toBe(false);
    expect(g.steps.find((s) => s.id === "c9")!.status).toBe("done");
  });
});
