/**
 * #2822: Claude's per-model limit — `⎿  You've reached your Fable limit. …` (claude 2.1.312 builds it from a 429 whose
 * representative claim is seven_day_overage_included) — had no detector: every turn failed, and the reply guard sent
 * a recovery turn after each one, which failed too. It is now a usage-limit hold with no reset time: told once, the
 * reply guard quiet on turns that end on the line, cleared by the first turn that ends without it, listed in Needs
 * you while it lasts. Matched only as Claude renders its own API error: an agent quoting or researching the text must
 * never start a hold (the leader's must-pass case — this agent's own pane tripped the unanchored credit pattern while
 * reading the binary).
 *
 * Isolation: temp dirs; no tmux, no CLI, no network — the daemon's scan and guard are driven with pane text.
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
import type { Logger } from "../src/logger.js";

vi.mock("../src/backend/types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/backend/types.js")>(),
  resolveBinary: (name: string) => name,
}));

const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-2822-")); dirs.push(d); return d; };

const NBSP = " ";
/** Exactly what claude 2.1.312 painted in an isolated container for the 429 (captured with tmux capture-pane). */
const REAL = `  ⎿ ${NBSP}You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.`;
const patterns = () => new ClaudeCodeBackend(tmp()).getErrorPatterns();
const holdPattern = () => patterns().find(p => p.usageHold)!;

describe("#2822: the pattern — Claude's own error line, nothing else", () => {
  it.each([
    ["the captured 2.1.312 line", REAL, "Fable"],
    ["the /model hint", `  ⎿  You've reached your Fable limit. /model to switch models.`, "Fable"],
    ["the switch hint", `  ⎿  You've reached your Fable limit. Switch to another model to continue.`, "Fable"],
    ["no hint, typographic apostrophe", `  ⎿ ${NBSP}You’ve reached your Fable 5.1 limit.`, "Fable 5.1"],
  ])("matches %s and names the model", (_n, line, model) => {
    const ep = holdPattern();
    const m = line.match(ep.pattern);
    expect(m).not.toBeNull();
    expect(ep.usageHold!(m!)).toBe(model);
  });

  it.each([
    ["an agent quoting it as prose", "● You've reached your Fable limit. /model to switch models."],
    ["prose mid-sentence", "The CLI prints \"You've reached your Fable limit.\" when the credits run out."],
    ["an indented code block", "    You've reached your Fable limit. Run /usage-credits to continue or switch models with /model."],
    ["the binary-strings dump that tripped the fleet on 10-28", `var S7r=["You've hit your","You've reached your","You're out of usage credits"]`],
    ["the dialog title (no period)", "  You've reached your Fable limit"],
    ["the sibling wording (not chosen)", "  ⎿  Fable requires usage credits. /model to switch models."],
    ["the out-of-credits wording", "  ⎿  You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models."],
    ["the line with other text after it", `${REAL} (quoted from the docs)`],
  ])("does not match %s", (_n, line) => {
    expect(holdPattern().pattern.test(line)).toBe(false);
  });

  it("is a notify-only quota line with no usage-API cross-check (the 5h/7d API can show room while it holds)", () => {
    expect(holdPattern()).toMatchObject({ type: "quota", action: "notify", skipCooldown: true, skipRecoveryWait: true });
    expect(holdPattern().verifyQuota).toBeUndefined();
  });

  it("the notice names the model and says the reset time is unknown, in both languages", () => {
    const m = REAL.match(holdPattern().pattern)!;
    expect(holdPattern().formatMessage!(m)).toBe("Claude has reached its Fable usage limit — reset time unknown. Messages reach it but fail until the limit clears or the model is switched (/model).");
    setLocale("zh-TW");
    expect(t("inst.model_usage_limit", "Fable")).toBe("Claude 的 Fable 用量已達上限，恢復時間未知。訊息仍會送到，但在額度恢復或切換模型（/model）前都會失敗。");
  });
});

function scanDaemon() {
  const dir = tmp();
  const daemon = new Daemon("fable-agent", { working_directory: dir, log_level: "silent" } as any, dir, false,
    new ClaudeCodeBackend(dir), undefined, logger) as any;
  const errors: Array<{ message: string; action: string }> = [];
  const holds: boolean[] = [];
  daemon.on("pty_error", (e: { message: string; action: string }) => errors.push(e));
  daemon.on("usage_hold", (e: { held: boolean }) => holds.push(e.held));
  return { daemon, errors, holds };
}

describe("#2822: told once per hold", () => {
  it("three failing turns → one notice and one hold; the later lines are absorbed", () => {
    const { daemon, errors, holds } = scanDaemon();
    const p = patterns();
    let pane = "❯ hello";
    for (let turn = 1; turn <= 3; turn++) {
      pane += `\n❯ message ${turn}\n${REAL}\n❯ `;
      daemon.evaluateErrorPatterns(pane, p, /❯/, 1_000_000 + turn);
    }
    expect(errors.map(e => e.message)).toEqual([t("inst.model_usage_limit", "Fable")]);
    expect(holds).toEqual([true]);
    expect(daemon.usageHold()).toMatchObject({ model: "Fable" });
  });

  it("an agent discussing the text never starts a hold", () => {
    const { daemon, errors, holds } = scanDaemon();
    const pane = [
      "● Claude prints \"You've reached your Fable limit.\" when Fable's credits are gone; the hint is \"/model to switch models.\"",
      "● You've reached your Fable limit. /model to switch models.",
      "    You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.",
      "❯ ",
    ].join("\n");
    daemon.evaluateErrorPatterns(pane, patterns(), /❯/, 2_000_000);
    expect(errors.filter(e => /usage limit/i.test(e.message))).toEqual([]);
    expect(holds).toEqual([]);
    expect(daemon.usageHold()).toBeNull();
  });
});

function guardDaemon() {
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
  const holds: boolean[] = [];
  daemon.on("usage_hold", (e: { held: boolean }) => holds.push(e.held));
  return { daemon, holds, patterns: real.getErrorPatterns() };
}
const at = (state: "idle" | "working") => ({ state, unchangedForMs: 0, observedAt: Date.now(), stateChangedAt: Date.now() }) as any;
const meta = (n: number) => ({ chat_id: "chat", thread_id: "topic", adapter_id: "tg", message_id: `m-${n}`, correlation_id: `cid-${n}` });

/** One person turn whose pane ends as given; the guard is evaluated after its idle-confirm window. */
async function turn(daemon: any, n: number, body: string, scan?: any[], above = "") {
  const inbound = `[user:Ann via telegram] message ${n}`;
  daemon.markTurnStarted(meta(n), inbound);
  const pane = `${above}${inbound}\n${body}\n❯ `;
  daemon.applyInstanceStateSnapshot(at("working"), pane);
  if (scan) daemon.evaluateErrorPatterns(pane, scan, /❯/, 3_000_000 + n);
  daemon.applyInstanceStateSnapshot(at("idle"), pane);
  await vi.advanceTimersByTimeAsync(61_000);
  daemon.applyInstanceStateSnapshot(at("idle"), pane);
  await daemon.pasteLock;
}

describe("#2822: the reply guard while the limit holds", () => {
  it("3 turns on the limit line → no recovery prompt, no drop report; a 4th turn without it clears the hold and the guard works again", async () => {
    vi.useFakeTimers();
    const { daemon, holds, patterns: p } = guardDaemon();
    const detected = vi.fn(); const unrecovered = vi.fn();
    daemon.on("reply_drop_detected", detected); daemon.on("reply_drop_unrecovered", unrecovered);
    for (const n of [1, 2, 3]) await turn(daemon, n, REAL, p);
    expect(daemon.deliverMessage).not.toHaveBeenCalled();             // no [system:reply-required] turn
    expect(detected).not.toHaveBeenCalled(); expect(unrecovered).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
    expect(holds).toEqual([true]);
    // The model was switched (or the limit reset): the turn ends without the line.
    await turn(daemon, 4, "● Here is the answer.", p);
    expect(holds).toEqual([true, false]);
    expect(daemon.usageHold()).toBeNull();
    // …and with no reply delivered, the guard is back to its normal one recovery prompt.
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
    expect(String(daemon.deliverMessage.mock.calls[0][0])).toMatch(/^\[system:reply-required\]/);
  });

  it("the first failing turn is quiet even if the guard runs before the scan has seen the line", async () => {
    vi.useFakeTimers();
    const { daemon } = guardDaemon();
    await turn(daemon, 1, REAL);                                       // no scan at all
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
  });

  it("an old limit line above this turn's message does not keep the turn quiet", async () => {
    vi.useFakeTimers();
    const { daemon } = guardDaemon();
    await turn(daemon, 2, "● thinking, but no reply sent", undefined, `${REAL}\n❯ \n`);
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);           // judged on its own part of the pane
  });
});

describe("#2822: Needs you", () => {
  it("one item while the hold lasts: the instance, the model, reset time unknown", () => {
    const base = { prompts: [], deliveries: [], tasks: [], backendSignIns: [], ownerOf: () => "tg" } as any;
    const held = deriveNeedsYou({ ...base, instances: [{ name: "fable-agent", usageHold: { model: "Fable", since: 1_700_000_000_000 } }] });
    expect(held.items ?? held).toEqual([expect.objectContaining({ id: "usage:fable-agent:1700000000000", type: "instance", instance: "fable-agent", reason: "usage_limit", detail: "Fable" })]);
    expect(t("needs.reason.usage_limit", "Fable")).toBe("Usage limit reached · Fable · reset time unknown");
    setLocale("zh-TW");
    expect(t("needs.reason.usage_limit", "Fable")).toBe("用量已達上限 · Fable · 恢復時間未知");
    const cleared = deriveNeedsYou({ ...base, instances: [{ name: "fable-agent", usageHold: null }] });
    expect(cleared.items ?? cleared).toEqual([]);
  });
});
