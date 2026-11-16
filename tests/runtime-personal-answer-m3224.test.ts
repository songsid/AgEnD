import { describe, expect, it } from "vitest";
import { PersonalAgentAnswerReader, type PersonalAgentCli } from "../src/runtime-personal-answer.js";
import { parseNativeProviderEvent } from "../src/windows-cli-providers.js";

const event = (type: string, extra = {}) => ({ type, ...extra });
const answer = (text: string) => event("item.completed", { item: { type: "agent_message", text } });
const codex = (text = "The meeting is Tuesday.") => [event("turn.started"), answer(text), event("turn.completed")];
const result = (text = "The meeting is Tuesday.") => event("result", { subtype: "success", result: text });
function read(cli: PersonalAgentCli, events: unknown[], exit: number | null = 0, cancelled = false) {
  const reader = new PersonalAgentAnswerReader(cli);
  reader.write(Buffer.from(events.map(e => JSON.stringify(e)).join("\n")));
  return reader.finish(exit, cancelled);
}

describe("a personal agent discloses only one successfully completed answer", () => {
  it("omits Codex tool commands/output and keeps only the final agent message", () => {
    const tool = event("item.completed", { item: { type: "command_execution", command: "private-command", aggregated_output: "private-output" } });
    // Ordinary Runtime previews intentionally keep this information; their reader stays unchanged.
    expect(parseNativeProviderEvent("codex", JSON.stringify(tool))?.text).toContain("private-output");
    expect(read("codex", [event("turn.started"), answer("I am looking."), tool, answer("Final answer."), event("turn.completed")]))
      .toEqual({ ok: true, answer: "Final answer." });
  });
  it("takes Claude result.result, rather than provisional assistant/tool text", () => {
    expect(read("claude-code", [event("assistant", { message: { content: [{ type: "text", text: "private provisional text" }] } }), result("Final answer.")]))
      .toEqual({ ok: true, answer: "Final answer." });
  });
  it.each(["codex", "claude-code"] as const)("requires successful process exit for %s", cli => {
    expect(read(cli, cli === "codex" ? codex() : [result()], 1)).toEqual({ ok: false, reason: "failed" });
    expect(read(cli, cli === "codex" ? codex() : [result()], null, true)).toEqual({ ok: false, reason: "interrupted" });
  });
  it("never treats a partial answer as a completed turn", () => {
    expect(read("codex", [event("turn.started"), answer("unfinished")])).toEqual({ ok: false, reason: "incomplete" });
    expect(read("claude-code", [event("assistant", { message: { content: [{ type: "text", text: "unfinished" }] } })])).toEqual({ ok: false, reason: "incomplete" });
  });
  it.each(["codex", "claude-code"] as const)("refuses empty or failed protocol results for %s", cli => {
    expect(read(cli, cli === "codex" ? codex("  ") : [result("  ")])).toEqual({ ok: false, reason: "empty" });
    const events = cli === "codex" ? [...codex(), event("turn.failed", { error: { message: "private failure" } })]
      : [event("result", { subtype: "error_during_execution", result: "private failure" })];
    expect(read(cli, events)).toEqual({ ok: false, reason: "failed" });
  });
  it("refuses malformed, repeated or out-of-order completion", () => {
    expect(read("codex", [event("turn.completed")])).toEqual({ ok: false, reason: "protocol" });
    expect(read("codex", [...codex(), ...codex()])).toEqual({ ok: false, reason: "protocol" });
    expect(read("claude-code", [result(), result()])).toEqual({ ok: false, reason: "protocol" });
    const reader = new PersonalAgentAnswerReader("codex"); reader.write(Buffer.from("private raw stdout\n"));
    expect(reader.finish(0)).toEqual({ ok: false, reason: "protocol" });
  });
  it("bounds final text and the whole stream without returning private input", () => {
    expect(read("codex", codex("x".repeat(65_537)))).toEqual({ ok: false, reason: "output-limit" });
    const reader = new PersonalAgentAnswerReader("claude-code"); reader.write(Buffer.alloc(1024 * 1024 + 1, 120));
    expect(reader.finish(0)).toEqual({ ok: false, reason: "output-limit" });
  });
  it("handles UTF-8 split across transport chunks and seals the result at process completion", () => {
    const bytes = Buffer.from(codex("答案：週二").map(e => JSON.stringify(e)).join("\n"));
    const reader = new PersonalAgentAnswerReader("codex"); for (const byte of bytes) reader.write(Uint8Array.of(byte));
    expect(reader.finish(0)).toEqual({ ok: true, answer: "答案：週二" });
    reader.write(Buffer.from(JSON.stringify(event("turn.failed"))));
    expect(reader.finish(1)).toEqual({ ok: true, answer: "答案：週二" });
  });
});
