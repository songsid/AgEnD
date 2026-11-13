/**
 * M-3032 (user OK 2026-11-13): AgEnD's injected reminder strings say what to do, and every rule keeps its meaning.
 * - Uncertain delivery, in every place an agent reads it: it may already have arrived → check/confirm first; resend
 *   ONLY when it shows `failed`. No text anywhere permits an unconditional resend.
 * - The reply-required prompt still asks for one reply through the reply tool (or a react), and only through them.
 * - The reply-pending notice still says report_result, with its placeholders.
 * - The MCP contract keeps the reply-tool rule and the "queued is normal, sending again duplicates" rule, for every backend.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMcpCoreInstructions, CODEX_PERSISTENCE_OUTPUT_SECTIONS, VERIFY_PEER_MESSAGE_RULE } from "../src/instructions.js";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { DeliveryStatusArgs } from "../src/outbound-schemas.js";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const locale = src("locale.ts");
const entries = (key: string) => [...locale.matchAll(new RegExp(`"${key.replace(/\./g, "\\.")}": "((?:[^"\\\\]|\\\\.)*)"`, "g"))].map(m => m[1]!);
const mcp = (backend: string) => buildMcpCoreInstructions({ instanceName: "a", workingDirectory: "/w", runtimeIdentity: { kind: "fleet-topic", backend, model: "m" } });
const BACKENDS = ["claude-code", "codex", "kiro-cli", "grok", "antigravity", "opencode", "muse"];

// Every sentence that lets the agent send again must make it conditional on `failed`.
function resendIsOnlyAfterFailed(text: string): boolean {
  const sentences = text.split(/(?<=[.;。；])\s*|\n/);
  return sentences.filter(s => /resend|re-send|send (it )?again|重送/i.test(s)).every(s => /only if (it )?(later )?shows `?failed`?|只有顯示 `?failed`? 時才重送|would deliver it twice/i.test(s));
}

describe("M-3032: uncertain delivery — check first, resend only when it shows failed", () => {
  const places: Array<[string, string]> = [
    ["MCP contract", mcp("claude-code")],
    ["peer-message rule (Collaboration Rule 7)", VERIFY_PEER_MESSAGE_RULE],
    ["Codex Persistence bullet", CODEX_PERSISTENCE_OUTPUT_SECTIONS],
    ["delivery_status tool description", String(TOOLS.find(t => t.name === "delivery_status")!.description)],
    ["delivery_status message_id description", String(DeliveryStatusArgs.shape.message_id.description)],
    ["agent CLI reference", src("agent-cli-instructions.md")],
    ...entries("delivery.status_uncertain").map((s, i) => [`delivery.status_uncertain #${i}`, s] as [string, string]),
  ];
  it.each(places)("%s: says it may already have arrived, asks to check/confirm, allows a resend only after failed", (_name, text) => {
    expect(text).toMatch(/may already have (arrived|reached)|可能已經送達/);
    expect(text).toMatch(/check|confirm|確認/i);
    expect(text).toMatch(/only if (it )?(later )?shows `?failed`?|只有顯示 `?failed`? 時才重送/);
    expect(resendIsOnlyAfterFailed(text)).toBe(true);
    expect(text).not.toMatch(/do not resend blindly|Never resend on uncertain|do not resend without checking|請先查明結果再決定是否重送/);
  });
  it("both languages of delivery.status_uncertain are rewritten (EN + zh-TW)", () => {
    expect(entries("delivery.status_uncertain")).toHaveLength(2);
  });
  it("failed still reads as not delivered (the state a resend is for)", () => {
    for (const s of entries("delivery.status_failed")) expect(s).toMatch(/not delivered|仍未送達/);
  });
  it("the MCP contract gives the waiting side a reply shape for an uncertain send", () => {
    expect(mcp("codex")).toContain("It may already have arrived; I'm checking and will confirm.");
  });
});

describe("M-3032: the reminders keep their rules", () => {
  const prompt = /const REPLY_RECOVERY_PROMPT = "((?:[^"\\]|\\.)*)";/.exec(src("daemon.ts"))![1]!;
  it("reply-required: one reply through the reply tool (or a react), only through them, work kept", () => {
    expect(prompt.startsWith("[system:reply-required] ")).toBe(true);
    expect(prompt).toMatch(/Send it once now with the reply tool/);
    expect(prompt).toMatch(/an emoji react is enough/);
    expect(prompt).toMatch(/Answer this only through the react or reply tool\./);
    expect(prompt).toMatch(/the work itself is done; keep it/);
    expect(prompt).toMatch(/if you already replied, carry on/);
    expect(prompt).not.toMatch(/\bDo not\b|\bNEVER\b/);
  });
  it("reply-pending (EN + zh-TW): report_result now, with the requester, correlation_id and asked placeholders", () => {
    const both = entries("delivery.reply_turn_ended");
    expect(both).toHaveLength(2);
    for (const s of both) {
      expect(s.startsWith("[system:reply-pending] {0} ")).toBe(true);
      expect(s).toContain("report_result");
      expect(s).toContain("\\ncorrelation_id={1}; asked={2}");
    }
  });
  it("the inbound hint still names the reply path (MCP and agent CLI)", () => {
    const hints = src("human-delivery-receipts.ts");
    expect(hints).toContain('"\\n(Answer with the reply tool.)"');
    expect(hints).toContain("'\\n(Answer with agend-agent reply \"…\".)'");
  });
  it.each(BACKENDS)("MCP contract for %s: reply tool for users, queued is normal and a resend duplicates", (b) => {
    const s = mcp(b);
    expect(s).toContain("→ answer with the `reply` tool (terminal text does not reach them).");
    expect(s).toContain("a `queued` reply or an IPC timeout is normal, so carry on (sending again would deliver it twice).");
    expect(s).not.toMatch(/Never direct text|NEVER re-send/);
  });
});
