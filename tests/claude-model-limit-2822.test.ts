/**
 * #2822: Claude's per-model limit — "You've reached your Fable limit. …" (claude 2.1.312 builds it from a 429 whose
 * representative claim is seven_day_overage_included) — had no detector: every turn failed, and the reply guard sent a
 * recovery turn after each one, which failed too. It is now a usage-limit hold with no reset time: told once, the reply
 * guard quiet on a person turn whose newest transcript event is that error, ended by Claude's next output of any turn,
 * listed in Needs you while it lasts.
 *
 * The only evidence is Claude's own record of the failed call in its transcript — an assistant record with
 * `isApiErrorMessage: true`, `apiErrorStatus: 429` (captured from the real CLI). Pane text never counts: Bash output, a
 * code block or an agent quoting the line render the same characters (Prism's #2827 review; this agent's own pane
 * tripped the unanchored credit pattern while it read the binary).
 *
 * Isolation: temp dirs; no tmux, no CLI, no network — the monitor gets records, the daemon gets its events.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { Daemon } from "../src/daemon.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { setLocale, t } from "../src/locale.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import type { Logger } from "../src/logger.js";

vi.mock("../src/backend/types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/backend/types.js")>(),
  resolveBinary: (name: string) => name,
}));

const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-2822-")); dirs.push(d); return d; };

const LIMIT = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
/** The record claude 2.1.312 wrote for the 429 (isolated container, mock API), fields trimmed. */
const RECORD = { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, error: "rate_limit", timestamp: "2026-10-28T10:16:00.000Z",
  message: { role: "assistant", content: [{ type: "text", text: LIMIT }] } };
const RENDERED = `  ⎿  ${LIMIT}`;

describe("#2822: the transcript monitor tells Claude's own API error apart from model output", () => {
  it("an isApiErrorMessage record is an api_error (text, status, time), never assistant_text", () => {
    const m = new TranscriptMonitor(tmp(), logger) as any;
    const errors: unknown[][] = []; const texts: string[] = [];
    m.on("api_error", (...a: unknown[]) => errors.push(a)); m.on("assistant_text", (x: string) => texts.push(x));
    m.processEntry(RECORD);
    m.processEntry({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Claude prints "${LIMIT}"` }] } });
    expect(errors).toEqual([[LIMIT, 429, Date.parse(RECORD.timestamp)]]);
    expect(texts).toEqual([`Claude prints "${LIMIT}"`]);
  });

  it("a prompt is a user_prompt; a meta record or a tool result is not", () => {
    const m = new TranscriptMonitor(tmp(), logger) as any;
    let prompts = 0; m.on("user_prompt", () => prompts++);
    m.processEntry({ type: "user", message: { role: "user", content: "message 1" } });
    m.processEntry({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>" } });
    m.processEntry({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
    m.processEntry({ type: "user", message: { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", source: {} }] } });
    expect(prompts).toBe(2);                                                         // the string one and the block one
  });
});

function daemonFor() {
  const dir = tmp();
  const real = new ClaudeCodeBackend(dir);
  const daemon = new Daemon("fable-agent", {
    backend: "claude-code", working_directory: dir, log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, true, { binaryName: "claude", replyCompletionGuard: true, getErrorPatterns: () => real.getErrorPatterns() } as any, undefined, logger) as any;
  daemon.tmux = {};
  daemon.deliverMessage = vi.fn(async () => true);
  daemon.deliverDaemonReply = vi.fn(async () => true);
  daemon.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
  daemon.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true) };
  const holds: boolean[] = []; const notices: Array<{ type: string; action: string; message: string }> = [];
  daemon.on("usage_hold", (e: { held: boolean }) => holds.push(e.held));
  daemon.on("pty_error", (e: { type: string; action: string; message: string }) => notices.push(e));
  return { daemon, holds, notices, patterns: real.getErrorPatterns() };
}
const at = (state: "idle" | "working") => ({ state, unchangedForMs: 0, observedAt: Date.now(), stateChangedAt: Date.now() }) as any;
const meta = (n: number) => ({ chat_id: "chat", thread_id: "topic", adapter_id: "tg", message_id: `m-${n}`, correlation_id: `cid-${n}` });
const limitError = (d: any) => d.noteClaudeApiError(LIMIT, 429);

/**
 * One person turn as the real CLI orders it: Claude records the prompt, then `during` (its transcript events), and
 * AgEnD arms the turn when the delivery is confirmed — for a 429 that is AFTER the error was recorded (seen on 2.1.312).
 * The pane goes idle, and the guard decides after its confirm window.
 */
async function turn(daemon: any, n: number, during: () => void, pane = "● …\n❯ ") {
  const inbound = `[user:Ann via telegram] message ${n}`;
  daemon.noteClaudePrompt();
  during();
  daemon.markTurnStarted(meta(n), inbound);
  daemon.applyInstanceStateSnapshot(at("working"), `${inbound}\n${pane}`);
  daemon.applyInstanceStateSnapshot(at("idle"), `${inbound}\n${pane}`);
  await vi.advanceTimersByTimeAsync(61_000);
  daemon.applyInstanceStateSnapshot(at("idle"), `${inbound}\n${pane}`);
  await daemon.pasteLock;
}

describe("#2822: the hold", () => {
  it("Claude's limit error starts it once: one notice (model, reset time unknown); later errors are told no more", () => {
    const { daemon, holds, notices } = daemonFor();
    for (let i = 0; i < 3; i++) limitError(daemon);
    expect(holds).toEqual([true]);
    expect(notices).toEqual([expect.objectContaining({ type: "quota", action: "notify",
      message: "Claude has reached its Fable usage limit — reset time unknown. Messages reach it but fail until the limit clears or the model is switched (/model)." })]);
    expect(daemon.usageHold()).toMatchObject({ model: "Fable" });
    setLocale("zh-TW");
    expect(t("inst.model_usage_limit", "Fable")).toBe("Claude 的 Fable 用量已達上限，恢復時間未知。訊息仍會送到，但在額度恢復或切換模型（/model）前都會失敗。");
  });

  it.each([
    ["another status", "You've reached your Fable limit. /model to switch models.", 500],
    ["the sibling wording (not chosen)", "Fable requires usage credits. /model to switch models.", 429],
    ["the out-of-credits wording", "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.", 429],
  ])("no hold for %s", (_n, text, status) => {
    const { daemon, holds } = daemonFor();
    daemon.noteClaudeApiError(text, status, Date.now());
    expect(holds).toEqual([]);
  });

  it("pane text never starts it — the complete rendered line in Bash output, in a code block, or quoted (Prism P2-1)", () => {
    const { daemon, holds, notices, patterns } = daemonFor();
    const pane = [
      "● Bash(cat limit.txt)", RENDERED,                                             // a tool's successful output, ⎿ and all
      "```", RENDERED, "```",                                                        // a code block keeping the whole line
      `● Claude prints "${LIMIT}"`, "❯ ",
    ].join("\n");
    daemon.evaluateErrorPatterns(pane, patterns, /❯/, 1_000_000);
    daemon.noteClaudeOutput();                                                       // the agent's text quoting it is output
    expect(holds).toEqual([]);
    expect(notices.filter(n => /usage limit/i.test(n.message))).toEqual([]);
  });

  it("Claude's next output ends it — whatever turn it is, a person's or not (Prism P2-3)", () => {
    const { daemon, holds } = daemonFor();
    limitError(daemon);
    daemon.noteClaudeOutput();                                                       // e.g. a fleet_inbound turn: no reply guard
    expect(holds).toEqual([true, false]);
    expect(daemon.usageHold()).toBeNull();
  });
});

describe("#2822: the reply guard", () => {
  it("3 turns ending on the limit error → no recovery turn, no drop report; then an answer ends the hold and the guard is normal again", async () => {
    vi.useFakeTimers();
    const { daemon, holds } = daemonFor();
    const detected = vi.fn(); const unrecovered = vi.fn();
    daemon.on("reply_drop_detected", detected); daemon.on("reply_drop_unrecovered", unrecovered);
    for (const n of [1, 2, 3]) await turn(daemon, n, () => limitError(daemon));
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
    expect(detected).not.toHaveBeenCalled(); expect(unrecovered).not.toHaveBeenCalled();
    expect(holds).toEqual([true]);
    await turn(daemon, 4, () => daemon.noteClaudeOutput());                          // answered in text, no reply tool
    expect(holds).toEqual([true, false]);
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
    expect(String(daemon.deliverMessage.mock.calls[0][0])).toMatch(/^\[system:reply-required\]/);
  });

  it("an error from before this turn does not silence it (Prism P2-2): the turn still gets its one recovery", async () => {
    vi.useFakeTimers();
    const { daemon } = daemonFor();
    limitError(daemon);                                                              // the previous turn's error
    await turn(daemon, 2, () => {}, `${RENDERED}\n● ok\n❯ `);                        // old line on screen; only this turn's prompt recorded
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
  });

  it("an error earlier in this turn followed by an answer does not silence it (Prism P2-2)", async () => {
    vi.useFakeTimers();
    const { daemon, holds } = daemonFor();
    await turn(daemon, 1, () => { limitError(daemon); daemon.noteClaudeOutput(); });
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
    expect(holds).toEqual([true, false]);
  });

  it("an error from before this turn's prompt, read only after the turn was armed, does not silence it", async () => {
    vi.useFakeTimers();
    const { daemon } = daemonFor();
    limitError(daemon);
    const inbound = "[user:Ann via telegram] message 2";
    daemon.markTurnStarted(meta(2), inbound);
    daemon.noteClaudePrompt();                                                       // this turn's prompt, recorded after the old error
    daemon.applyInstanceStateSnapshot(at("working"), `${inbound}\n● …\n❯ `); daemon.applyInstanceStateSnapshot(at("idle"), `${inbound}\n● …\n❯ `);
    await vi.advanceTimersByTimeAsync(61_000); daemon.applyInstanceStateSnapshot(at("idle"), `${inbound}\n● …\n❯ `); await daemon.pasteLock;
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
  });
});

describe("#2822: real transcript records, monitor → daemon → guard (Prism r2)", () => {
  /** The daemon's own wiring of the monitor, on real-shaped records. */
  function wired() {
    const d = daemonFor();
    const m = new TranscriptMonitor(tmp(), logger) as any;
    m.on("api_error", (text: string, status: number | null) => d.daemon.noteClaudeApiError(text, status));
    m.on("user_prompt", () => d.daemon.noteClaudePrompt());
    m.on("assistant_text", () => d.daemon.noteClaudeOutput());
    m.on("tool_use", () => d.daemon.noteClaudeOutput());
    return { ...d, record: (e: unknown) => m.processEntry(e) };
  }
  const prompt = (content: unknown) => ({ type: "user", message: { role: "user", content } });
  const apiError = (status: number, text: string) => ({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: status, error: "x",
    timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] } });
  async function personTurn(daemon: any, n: number, records: () => void) {
    records();
    const inbound = `[user:Ann via telegram] message ${n}`;
    daemon.markTurnStarted(meta(n), inbound);
    daemon.applyInstanceStateSnapshot(at("working"), `${inbound}\n❯ `); daemon.applyInstanceStateSnapshot(at("idle"), `${inbound}\n❯ `);
    await vi.advanceTimersByTimeAsync(61_000); daemon.applyInstanceStateSnapshot(at("idle"), `${inbound}\n❯ `); await daemon.pasteLock;
  }

  it("(a) a block-form prompt after an old limit is newer: the new turn gets its one recovery", async () => {
    vi.useFakeTimers();
    const { daemon, record } = wired();
    record(prompt("message 1")); record(RECORD);
    await personTurn(daemon, 2, () => record(prompt([{ type: "text", text: "message 2" }, { type: "image", source: { type: "base64", data: "" } }])));
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
  });

  it("(b) a later API error of another kind (a 500, a non-matching 429) is newer: the turn gets its one recovery", async () => {
    for (const later of [apiError(500, "API Error: 500 Internal server error"), apiError(429, "API Error: Rate limit reached")]) {
      vi.useFakeTimers();
      const { daemon, record } = wired();
      await personTurn(daemon, 1, () => { record(prompt("message 1")); record(RECORD); record(later); });
      expect(daemon.deliverMessage, String(later.apiErrorStatus)).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    }
  });

  it("controls: the limit as the newest event is quiet — after a 500; a meta record, a tool result or a system record after it change nothing", async () => {
    vi.useFakeTimers();
    const { daemon, record } = wired();
    await personTurn(daemon, 1, () => {
      record(prompt("message 1")); record(apiError(500, "API Error: 500")); record(RECORD);
      // after it, records that are neither prompts nor output (Claude writes such records after an error)
      record({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>" } });
      record(prompt([{ type: "tool_result", tool_use_id: "t", content: "x" }]));
      record({ type: "system", subtype: "turn_duration", message: { role: "system", content: "x" } });
    });
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
  });
});

describe("#2822: Needs you", () => {
  it("one item while the hold lasts: the instance, the model, reset time unknown — gone with the hold", () => {
    const base = { prompts: [], deliveries: [], tasks: [], backendSignIns: [], ownerOf: () => "tg" } as any;
    const held = deriveNeedsYou({ ...base, instances: [{ name: "fable-agent", usageHold: { model: "Fable", since: 1_700_000_000_000 } }] });
    expect(held).toEqual([expect.objectContaining({ id: "usage:fable-agent:1700000000000", type: "instance", instance: "fable-agent", reason: "usage_limit", detail: "Fable" })]);
    expect(t("needs.reason.usage_limit", "Fable")).toBe("Usage limit reached · Fable · reset time unknown");
    setLocale("zh-TW");
    expect(t("needs.reason.usage_limit", "Fable")).toBe("用量已達上限 · Fable · 恢復時間未知");
    expect(deriveNeedsYou({ ...base, instances: [{ name: "fable-agent", usageHold: null }] })).toEqual([]);
  });
});
