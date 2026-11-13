/**
 * AGEND-181 (AGEND-195): a tool result read without its call — the Log's live read starts mid-turn, so the call lay before
 * the range — is born `done` and is not undone when the turn ends in the same read; and when it is a `reply`'s complete
 * result it still names the delivered messageId (the page merges it into the call it already shows, by id).
 */
import { describe, expect, it } from "vitest";
import { ClaudeStepParser, CodexStepParser, replyResultId } from "../src/log-steps.js";

const claudeResult = (id: string, content: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
const claudeEnd = JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 5 });
const codexOutput = (id: string, output: string) => JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: id, output } });
const codexEnd = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", duration_ms: 5, last_agent_message: "x" } });

describe("an orphan result stays done when the turn ends in the same read", () => {
  it("claude", () => {
    const p = new ClaudeStepParser();
    p.push(claudeResult("c1", "ok"), 0);
    const out = p.push(claudeEnd, 10);
    expect(out.some((s) => s.id === "c1")).toBe(false);                      // not re-emitted as interrupted
    expect(p.steps.find((s) => s.id === "c1")!.status).toBe("done");
  });
  it("codex", () => {
    const p = new CodexStepParser();
    p.push(codexOutput("c1", "ok"), 0);
    const out = p.push(codexEnd, 10);
    expect(out.some((s) => s.id === "c1")).toBe(false);
    expect(p.steps.find((s) => s.id === "c1")!.status).toBe("done");
  });
  it("a call that really never got its result is still interrupted at the turn's end", () => {
    const p = new ClaudeStepParser();
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "Bash", input: { command: "sleep 9" } }] } }), 0);
    p.push(claudeEnd, 10);
    expect(p.steps.find((s) => s.id === "c2")!.status).toBe("interrupted");
  });
});

describe("an orphan reply result is anchored by the delivered messageId — only its complete shape", () => {
  const anchorOf = (p: ClaudeStepParser | CodexStepParser, id: string) => p.steps.find((s) => s.id === id)?.anchor;
  it("a reply's result, whole: anchored (claude and codex)", () => {
    const c = new ClaudeStepParser();
    c.push(claudeResult("r1", '{"chatId":"web","messageId":"web-abc"}'), 0);
    expect(anchorOf(c, "r1")).toEqual({ messageId: "web-abc" });
    const x = new CodexStepParser();
    x.push(codexOutput("r1", 'Output:\n{"chatId":"web","messageId":"web-abc"}'), 0);
    expect(anchorOf(x, "r1")).toEqual({ messageId: "web-abc" });
  });
  it("another tool's result that carries a chatId or a messageId is no anchor", () => {
    const c = new ClaudeStepParser();
    c.push(claudeResult("o1", '{"chatId":"web","threadId":"t1","unread":3}'), 0);
    c.push(claudeResult("o2", '{"messageId":"web-no-chat-id"}'), 1);
    c.push(claudeResult("o3", 'the chatId is web and the messageId is not here'), 2);
    c.push(claudeResult("o4", '{"chatId":"web","messageId":"web-x","extra":1}'), 3);   // the whole shape, not a subset of a larger object
    expect(["o1", "o2", "o3", "o4"].map((id) => anchorOf(c, id))).toEqual([undefined, undefined, undefined, undefined]);
  });
  it("a reply call whose result follows is anchored as before (its text, then the messageId)", () => {
    const p = new ClaudeStepParser();
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "r2", name: "mcp__agend__reply", input: { text: "hello" } }] } }), 0);
    p.push(claudeResult("r2", '{"chatId":"web","messageId":"web-def"}'), 1);
    expect(anchorOf(p, "r2")).toEqual({ replyText: "hello", messageId: "web-def" });
    expect(replyResultId('{"chatId":"web","messageId":"web-def"}')).toBe("web-def");
  });
});
