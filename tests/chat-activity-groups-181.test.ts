/**
 * AGEND-181 PR1: the chat's interleaved activity timeline — the parser's anchors and thinking steps, and the pure
 * grouping that attaches a turn's steps to the reply they produced (exact id → text with a monotonic cursor → time →
 * a group of its own), from a real redacted Claude transcript of an AgEnD instance (tests/fixtures/chat-activity-3648).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeStepParser, CodexStepParser, promptAnchor, replyResultId, type LogStep } from "../src/log-steps.js";
// @ts-expect-error — a JS module of the app, with no types
import { groupSteps, composeRows, isReplyStep, TIME_SLACK_MS } from "../src/ui/chat-activity-groups.js";

const FIX = join(import.meta.dirname, "fixtures", "chat-activity-3648");
const lines = readFileSync(join(FIX, "claude-web-chat.jsonl"), "utf8").split("\n").filter(Boolean);
const ledger = JSON.parse(readFileSync(join(FIX, "claude-web-chat.ledger.json"), "utf8")) as Array<Record<string, any>>;

function parse(records: string[], thinking = false): LogStep[] {
  const p = new ClaudeStepParser({ thinking });
  records.forEach((r, i) => p.push(r, i * 1000));
  return p.steps;
}
/** The same records with a synthetic thinking summary in each empty thinking block (the real capture's are empty). */
const withThinking = lines.map((l) => {
  const e = JSON.parse(l);
  for (const b of e.message?.content ?? []) if (b?.type === "thinking" && b.thinking === "") b.thinking = "I should look at the fleet before answering.";
  return JSON.stringify(e);
});
const keys = (rows: Array<Record<string, any>>) => rows.map((r) => `${r.boot}-${r.id}`);
const shape = (items: LogStep[]) => items.map((s) => (s.kind === "tool" ? `tool:${s.tool}` : s.kind));

describe("anchors in the parser", () => {
  const steps = parse(lines);
  it("a prompt's ids: the leading human id and the trailing (message_id: … | verification_id: …)", () => {
    const users = steps.filter((s) => s.kind === "user");
    expect(users.map((u) => u.anchor)).toEqual([
      { messageId: "web-mwbq2a8v-5a701907", humanId: "hmsg-f7585fe2-350b-4d99-8e10-50d474232ed8" },
      { messageId: "web-mwbq7dle-648c7ccb", humanId: "hmsg-710389dc-70e3-4faf-a7cf-01be0c6c8695" },
    ]);
  });
  it("a reply call: the start of its text, then the messageId its result returned", () => {
    const replies = steps.filter(isReplyStep);
    expect(replies).toHaveLength(2);
    expect(replies[0]!.anchor).toEqual({ replyText: "Hi! 👋 I'm master, the coordinator for this fleet. What can I help you with?", messageId: "web-mwbq2d2z-8c41f302" });
    expect(replies[1]!.anchor!.messageId).toBe("web-mwbq7p0l-17a474c2");
    expect(replies[1]!.anchor!.replyText!.length).toBeLessThanOrEqual(200);
  });
  it("a tool that is not a reply has no anchor; the last (message_id: …) of a text wins; no ids: none", () => {
    expect(steps.filter((s) => s.kind === "tool" && !isReplyStep(s)).every((s) => !s.anchor)).toBe(true);
    expect(promptAnchor("(message_id: a1) quoted\n(message_id: web-real | verification_id: hmsg-x)")).toEqual({ messageId: "web-real" });
    expect(promptAnchor("plain text")).toBeUndefined();
    expect(replyResultId('{"chatId":"123","messageId":"4567"}')).toBe("4567");
    expect(replyResultId("no id")).toBeUndefined();
  });
});

describe("thinking steps", () => {
  it("not made unless asked (the real capture's thinking is empty anyway); empty text never makes one", () => {
    expect(parse(lines, true).some((s) => s.kind === "thinking")).toBe(false);
    expect(parse(withThinking, false).some((s) => s.kind === "thinking")).toBe(false);
  });
  it("asked: the summary is a step, masked like every other text", () => {
    const steps = parse(withThinking, true);
    expect(steps.filter((s) => s.kind === "thinking")).toHaveLength(3);
    const p = new ClaudeStepParser({ thinking: true });
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "use DB_PASSWORD=hunter2hunter2 then go" }] } }));
    expect(p.steps[0]!.kind).toBe("thinking");
    expect(p.steps[0]!.body).not.toContain("hunter2hunter2");
  });
  it("codex: a reasoning summary (and the event that repeats it) is one step — parser only; no real rollout is claimed", () => {
    const p = new CodexStepParser({ thinking: true });
    p.push(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }));
    p.push(JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Plan: read the file." }], encrypted_content: "xxxx" } }));
    p.push(JSON.stringify({ type: "event_msg", payload: { type: "agent_reasoning", text: "Plan: read the file." } }));
    p.push(JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [] } }));
    expect(p.steps.filter((s) => s.kind === "thinking").map((s) => s.body)).toEqual(["Plan: read the file."]);
    const off = new CodexStepParser();
    off.push(JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ text: "x" }] } }));
    expect(off.steps).toEqual([]);
  });
  it("codex: a reply call (mcp tool) is anchored by its text and result", () => {
    const p = new CodexStepParser();
    p.push(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "c1", name: "mcp__agend__reply", arguments: JSON.stringify({ text: "Done." }) } }));
    p.push(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: '{"chatId":"web","messageId":"web-x1"}' } }));
    expect(p.steps[0]!.anchor).toEqual({ replyText: "Done.", messageId: "web-x1" });
  });
});

describe("grouping: steps above the reply they produced", () => {
  const steps = parse(withThinking, true);
  const result = groupSteps(ledger, steps, { now: Date.parse("2026-11-11T07:00:00Z"), complete: true });
  it("by exact id: each reply's row gets the steps since the previous reply, in order; the reply call itself is the bubble", () => {
    expect(result.live).toBeNull();
    expect(result.groups.map((g: any) => [g.rowKey, g.level])).toEqual([["a1b2-2", "id"], ["a1b2-4", "id"]]);
    expect(shape(result.groups[0].items)).toEqual(["tool:ToolSearch"]);
    expect(shape(result.groups[1].items)).toEqual(["thinking", "tool:ToolSearch", "tool:mcp__agend__list_instances", "tool:mcp__agend__list_teams", "thinking", "thinking"]);
  });
  it("what the CLI said after its last reply rides on that group as not-sent text, once the turn ended", () => {
    expect(shape(result.groups[0].trailing)).toEqual(["assistant"]);
    expect(shape(result.groups[1].trailing)).toEqual(["assistant"]);
    expect(result.groups.every((g: any) => g.turnEnded)).toBe(true);
  });
  it("composeRows puts each group before its reply, the rows themselves untouched", () => {
    const rows = composeRows(ledger, result);
    expect(rows.map((r: any) => r.role)).toEqual(["user", "activity", "agent", "user", "activity", "agent"]);
    expect(rows.filter((r: any) => r.role !== "activity")).toEqual(ledger);
    expect(rows[1].id).toBe("act:" + steps.find((s) => s.kind === "user")!.turn + ":0");
  });
  it("a turn in progress is the live group at the end — and the same key becomes the reply's group when its row arrives", () => {
    // The second turn without its reply, its turn end and what follows: still thinking and calling tools.
    const cut = withThinking.slice(0, withThinking.findIndex((l) => l.includes("mcp__agend__reply") && l.includes("I looked at the fleet")));
    const going = parse(cut, true);
    const live = groupSteps(ledger.slice(0, 3), going, { now: Date.parse("2026-11-11T07:00:00Z") });
    expect(live.groups.map((g: any) => g.rowKey)).toEqual(["a1b2-2"]);
    expect(live.live.level).toBe("live");
    expect(shape(live.live.items)).toEqual(["thinking", "tool:ToolSearch", "tool:mcp__agend__list_instances", "tool:mcp__agend__list_teams", "thinking", "thinking"]);
    expect(composeRows(ledger.slice(0, 3), live).map((r: any) => r.role)).toEqual(["user", "activity", "agent", "user", "activity"]);
    expect(live.live.key).toBe(result.groups[1].key);
  });
  it("a reply call whose row has not arrived yet is the live group (no jump), but not for ever: later it stands alone", () => {
    const two = groupSteps(ledger.slice(0, 3), steps, { now: Date.parse("2026-11-11T06:16:42.000Z") });
    expect(two.live.level).toBe("live");
    expect(two.live.key).toBe(result.groups[1].key);
    const late = groupSteps(ledger.slice(0, 3), steps, { now: Date.parse("2026-11-11T07:00:00Z") });
    expect(late.live).toBeNull();
    expect(late.groups.find((g: any) => g.level === "none")).toBeTruthy();
  });
});

describe("grouping: when the exact anchor is not there", () => {
  const steps = parse(withThinking, true);
  const now = Date.parse("2026-11-11T07:00:00Z");
  const noAnchor = ledger.map(({ anchor: _a, ...r }) => r);
  it("rows from before anchors were kept: the start of the reply's text, rows taken in order", () => {
    const g = groupSteps(noAnchor, steps, { now });
    expect(g.groups.map((x: any) => [x.rowKey, x.level])).toEqual([["a1b2-2", "text"], ["a1b2-4", "text"]]);
  });
  it("two replies with the same short text each get their own row (the cursor never goes back)", () => {
    const rep = (text: string, id: string, ts: number): LogStep[] => [
      { id: `r${id}`, turn: "t", ts, kind: "tool", tool: "mcp__agend__reply", status: "done", anchor: { replyText: text } } as LogStep,
    ];
    const s = [{ id: "u", turn: "t", ts: 1, kind: "user" } as LogStep, ...rep("ok", "1", 10), { id: "x", turn: "t", ts: 20, kind: "tool", tool: "Bash", status: "done" } as LogStep, ...rep("ok", "2", 30), { id: "e", turn: "t", ts: 40, kind: "turn_end" } as LogStep];
    const rows = [{ boot: "b", id: 1, role: "agent", text: "ok", ts: new Date(11).toISOString() }, { boot: "b", id: 2, role: "agent", text: "ok", ts: new Date(31).toISOString() }];
    const g = groupSteps(rows, s, { now: 1e12 });
    expect(g.groups.map((x: any) => x.rowKey)).toEqual(["b-1", "b-2"]);
    expect(shape(g.groups[0].items)).toEqual([]);
    expect(shape(g.groups[1].items)).toEqual(["tool:Bash"]);
  });
  it("the cursor never goes back: a later reply's text is not given to an older row that says the same (an earlier turn whose steps are not loaded)", () => {
    const s = [
      { id: "u", turn: "t", ts: 100, kind: "user" } as LogStep,
      { id: "r1", turn: "t", ts: 110, kind: "tool", tool: "mcp__agend__reply", status: "done", anchor: { messageId: "web-new-1", replyText: "Working on it." } } as LogStep,
      { id: "r2", turn: "t", ts: 120, kind: "tool", tool: "mcp__agend__reply", status: "done", anchor: { replyText: "ok" } } as LogStep,
      { id: "e", turn: "t", ts: 130, kind: "turn_end" } as LogStep,
    ];
    const rows = [
      { boot: "b", id: 1, role: "agent", text: "ok", ts: new Date(10).toISOString() },                                  // an older turn's, same words
      { boot: "b", id: 2, role: "user", text: "q", ts: new Date(99).toISOString() },
      { boot: "b", id: 3, role: "agent", text: "Working on it.", ts: new Date(111).toISOString(), anchor: "web-new-1" },
      { boot: "b", id: 4, role: "agent", text: "ok", ts: new Date(121).toISOString() },
    ];
    const g = groupSteps(rows, s, { now: 1e12 });
    expect(g.groups.map((x: any) => [x.rowKey, x.level])).toEqual([["b-3", "id"], ["b-4", "text"]]);
  });
  it("no id, no text match (the reply was edited): by time, within the slack", () => {
    const edited = noAnchor.map((r) => (r.role === "agent" ? { ...r, text: "(edited) " + r.text } : r));
    const g = groupSteps(edited, steps, { now });
    expect(g.groups.map((x: any) => [x.rowKey, x.level])).toEqual([["a1b2-2", "time"], ["a1b2-4", "time"]]);
    const far = edited.map((r) => (r.role === "agent" ? { ...r, ts: new Date(Date.parse(r.ts) + TIME_SLACK_MS + 60_000).toISOString() } : r));
    expect(groupSteps(far, steps, { now }).groups.every((x: any) => x.level === "none" && x.rowKey === null)).toBe(true);
  });
  it("nothing matches: an activity group of its own between the rows by time — never on a guess", () => {
    const g = groupSteps([ledger[0], ledger[2]].map(({ anchor: _a, ...r }: any) => r), steps, { now });
    const rows = composeRows([ledger[0], ledger[2]], g);
    expect(g.groups.every((x: any) => x.rowKey === null && x.level === "none")).toBe(true);
    // each sits where its time falls: the first before the second user row, the second after it
    expect(rows.map((r: any) => r.role)).toEqual(["user", "activity", "user", "activity"]);
  });
  it("a turn with no reply call (a backend that has none): its steps go above the last agent row of the turn", () => {
    const s = [{ id: "u", turn: "t", ts: 1, kind: "user", anchor: { messageId: "web-u1" } } as LogStep, { id: "x", turn: "t", ts: 2, kind: "tool", tool: "Bash", status: "done" } as LogStep, { id: "m", turn: "t", ts: 3, kind: "assistant", body: "answer" } as LogStep, { id: "e", turn: "t", ts: 4, kind: "turn_end" } as LogStep];
    const rows = [{ boot: "b", id: 1, role: "user", text: "q", anchor: "web-u1", ts: new Date(0).toISOString() }, { boot: "b", id: 2, role: "agent", text: "answer", ts: new Date(5).toISOString() }, { boot: "b", id: 3, role: "user", text: "next", ts: new Date(9).toISOString() }];
    const g = groupSteps(rows, s, { now: 1e12 });
    expect(g.groups.map((x: any) => [x.rowKey, x.level])).toEqual([["b-2", "turn"]]);
    expect(shape(g.groups[0].items)).toEqual(["tool:Bash", "assistant"]);
  });
  it("the window starts mid-turn (older steps not loaded): that first group says it is partial; a complete read does not", () => {
    const mid = steps.filter((s) => s.kind !== "user" || s.anchor?.messageId !== "web-mwbq2a8v-5a701907").slice(2);
    expect(groupSteps(ledger, mid, { now, complete: false }).groups[0].partial).toBe(true);
    expect(groupSteps(ledger, mid, { now, complete: true }).groups[0].partial).toBeUndefined();
  });
  it("no steps, or no ledger rows: nothing to attach, nothing thrown", () => {
    expect(groupSteps(ledger, [], { now })).toEqual({ groups: [], live: null });
    expect(composeRows([], groupSteps([], steps, { now })).every((r: any) => r.role === "activity")).toBe(true);
    expect(keys(composeRows(ledger, { groups: [], live: null }))).toEqual(keys(ledger));
  });
});
