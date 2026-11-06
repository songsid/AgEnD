/**
 * #2873 (user, 2026-10-30): a quota, usage-limit or credit notice is one short line per backend, in the fleet's
 * language — "⚠️ Codex 用量用完，已暫停" / "⚠️ Codex usage limit used up — paused". "Paused" only where the instance is;
 * a reset time only where AgEnD already reads one (Claude, Antigravity). The incident's `message` stays the English one
 * for logs and webhooks. Each backend is checked on the CLI's own text (fixtures captured live where there is one) and
 * through the first pattern that matches, as the daemon picks it.
 *
 * Isolation: temp dirs; no tmux, no CLI, no network.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";
import { setLocale } from "../src/locale.js";
import { claudeResetTime, quotaLine, quotaPausedLine } from "../src/quota-notice.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { CodexBackend } from "../src/backend/codex.js";
import { GrokBackend } from "../src/backend/grok.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { MuseBackend } from "../src/backend/muse.js";
import type { ErrorPattern } from "../src/backend/types.js";
import { Daemon } from "../src/daemon.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import type { Logger } from "../src/logger.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-2873-")); dirs.push(d); return d; };
afterEach(() => { setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The daemon's pick: the first pattern that matches, and its notice from the last match. */
function noticeFor(patterns: ErrorPattern[], pane: string): { message: string; notice: string | undefined; type: string; action: string } {
  const ep = patterns.find(p => new RegExp(p.pattern.source, p.pattern.flags.replace("g", "")).test(pane));
  if (!ep) throw new Error("no pattern matched");
  const all = [...pane.matchAll(new RegExp(ep.pattern.source, ep.pattern.flags.includes("g") ? ep.pattern.flags : ep.pattern.flags + "g"))];
  const last = all[all.length - 1] ?? null;
  return { message: ep.formatMessage && last ? ep.formatMessage(last) : ep.message, notice: ep.notice?.(last), type: ep.type, action: ep.action };
}

const PANES = {
  codexUsage: () => fixture("codex-0160-usage-limit-curly-apostrophe.pane.txt"),
  codexApiQuota: () => "■ Quota exceeded. Check your plan and billing details.\n",
  codexWorkspaceCredits: () => fixture("codex-0165-workspace-credits-prompt.pane.txt"),
  // The spend-cap row as codex 0.165 printed it (codex-0165-workspace-spend-cap-prompt.pane.txt, line 26; that capture
  // also holds an earlier out-of-credits row, which is the one the first pattern takes there).
  codexSpendCap: () => fixture("codex-0165-workspace-spend-cap-prompt.pane.txt").split("\n").filter(l => /spend cap set by/.test(l)).join("\n"),
  codexWorkspaceUsage: () => "■ Usage limit reached. You've reached your usage limit. Increase your limits to continue.\n",
  codexLow: () => "⚠ Heads up, you have less than 5% of your weekly limit left. Run /status for a\nbreakdown.",
  agyCap: () => "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 139h12m12s.",
  agyExhausted: () => "Error: RESOURCE_EXHAUSTED",
  kiroMonthly: () => ["Monthly request limit reached - The limits reset on 11/01.", "", "> "].join("\n"),
  muse: () => "Error: out of credits",
  grok: () => "┃  insufficient credits",
};

// [case, backend, pane, expected zh, expected en, expected type/action (unchanged)]
const CASES: Array<[string, () => ErrorPattern[], () => string, string, string, string]> = [
  ["codex usage limit (paused, no reset time)", () => new CodexBackend(tmp()).getErrorPatterns(), PANES.codexUsage,
    "⚠️ Codex 用量用完，已暫停", "⚠️ Codex usage limit used up — paused", "quota/pause"],
  ["OpenAI API quota (paused)", () => new CodexBackend(tmp()).getErrorPatterns(), PANES.codexApiQuota,
    "⚠️ OpenAI API 額度用完，已暫停", "⚠️ OpenAI API quota used up — paused", "quota/pause"],
  ["codex workspace credits (paused)", () => new CodexBackend(tmp()).getErrorPatterns(), PANES.codexWorkspaceCredits,
    "⚠️ Codex 工作區額度用完，已暫停", "⚠️ Codex workspace credits used up — paused", "quota/pause"],
  ["codex workspace spend cap (paused)", () => new CodexBackend(tmp()).getErrorPatterns(), PANES.codexSpendCap,
    "⚠️ Codex 工作區花費上限已到，已暫停", "⚠️ Codex workspace spend cap reached — paused", "quota/pause"],
  ["codex workspace usage limit (paused)", () => new CodexBackend(tmp()).getErrorPatterns(), PANES.codexWorkspaceUsage,
    "⚠️ Codex 工作區用量用完，已暫停", "⚠️ Codex workspace usage limit used up — paused", "quota/pause"],
  ["codex running low (not paused)", () => new CodexBackend(tmp()).getErrorPatterns(), PANES.codexLow,
    "⚠️ Codex 週用量剩不到 5%", "⚠️ Codex weekly limit: under 5% left", "quota/notify"],
  ["antigravity quota with its reset (not paused)", () => new AntigravityBackend("/tmp").getErrorPatterns(), PANES.agyCap,
    "⚠️ Antigravity 額度用完（139h12m12s 後重置）", "⚠️ Antigravity quota used up (resets in 139h12m12s)", "quota/notify"],
  ["antigravity exhausted backstop", () => new AntigravityBackend("/tmp").getErrorPatterns(), PANES.agyExhausted,
    "⚠️ Antigravity 額度用完", "⚠️ Antigravity quota used up", "quota/notify"],
  ["kiro monthly request limit (no reset time)", () => new KiroBackend(tmp(), TEST_KIRO_COMPAT).getErrorPatterns(), PANES.kiroMonthly,
    "⚠️ Kiro 請求次數用完", "⚠️ Kiro request limit used up", "rate_limit/notify"],
  ["muse quota", () => new MuseBackend(tmp()).getErrorPatterns(), PANES.muse,
    "⚠️ Muse 額度用完", "⚠️ Muse quota used up", "quota/notify"],
  ["grok quota/credits backstop", () => new GrokBackend(tmp()).getErrorPatterns(), PANES.grok,
    "⚠️ Grok 額度用完", "⚠️ Grok quota/credits used up", "quota/notify"],
];

describe("#2873: each backend's notice is one short line, in the fleet's language", () => {
  it.each(CASES)("%s", (_name, patterns, pane, zh, en, kind) => {
    setLocale("en");
    const a = noticeFor(patterns(), pane());
    expect(a.notice).toBe(en);
    expect(`${a.type}/${a.action}`, "the incident itself is unchanged").toBe(kind);
    expect(a.message, "message stays the English one (logs, webhooks)").not.toBe(a.notice);
    setLocale("zh-TW");
    expect(noticeFor(patterns(), pane()).notice).toBe(zh);
    expect(noticeFor(patterns(), pane()).message, "message is not localised").toBe(a.message);
  });
});

describe("#2873: the line builder", () => {
  it("grok's line, as the user approved it, comes out byte for byte", () => {
    setLocale("zh-TW"); expect(quotaPausedLine("Grok", "weekly")).toBe("⚠️ Grok 週用量用完，已暫停");
    setLocale("en"); expect(quotaPausedLine("Grok", "weekly")).toBe("⚠️ Grok weekly limit used up — paused");
  });
  it("Claude's 'continuing automatically …' is a reset time: at a clock time, in a span, or as said", () => {
    expect(claudeResetTime("at 1:50pm")).toEqual({ at: "1:50pm" });
    expect(claudeResetTime("in 3h")).toEqual({ in: "3h" });
    expect(claudeResetTime("tomorrow")).toEqual({ at: "tomorrow" });
    setLocale("zh-TW"); expect(quotaLine("Claude", "usage", { paused: true, reset: { at: "1:50pm" } })).toBe("⚠️ Claude 用量用完，已暫停（1:50pm 重置）");
    setLocale("en"); expect(quotaLine("Claude", "usage", { paused: true, reset: { at: "1:50pm" } })).toBe("⚠️ Claude usage limit used up — paused (resets at 1:50pm)");
  });
});

const logger = pino({ level: "silent" }) as Logger;
/** Claude's own transcript records (claude 2.1.312, #2834 / #2822), through a monitor wired as the daemon wires it. */
function claude() {
  const dir = tmp();
  const daemon = new Daemon("worker", { working_directory: dir, log_level: "silent" } as any, dir, false, undefined, undefined, logger) as any;
  const monitor = new TranscriptMonitor(tmp(), logger) as any;
  monitor.on("api_error", (text: string, status: number | null, _at: number | null, kind: string | null) => daemon.noteClaudeApiError(text, status, kind));
  monitor.on("system_informational", (text: string) => daemon.noteClaudeInformational(text));
  const errors: any[] = [];
  daemon.on("pty_error", (e: any) => errors.push(e));
  return { record: (e: unknown) => monitor.processEntry(e), errors };
}
const assistantError = (status: number, error: string, text: string) =>
  ({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: status, error, message: { role: "assistant", content: [{ type: "text", text }] } });

describe("#2873: Claude's notices from its transcript", () => {
  it.each([["en", "⚠️ Claude usage limit used up — paused (resets at 6:53pm)", "⚠️ Claude API credits used up — paused", "⚠️ Claude Opus usage limit used up (reset time unknown; /model to switch)"],
    ["zh-TW", "⚠️ Claude 用量用完，已暫停（6:53pm 重置）", "⚠️ Claude API 額度用完，已暫停", "⚠️ Claude Opus 用量用完（重置時間未知，可用 /model 換模型）"]] as const)(
    "%s: usage pause with its time, credits, a model's limit; message unchanged", (lang, usage, credit, hold) => {
    setLocale(lang);
    const c = claude();
    c.record({ type: "system", subtype: "informational", content: "Usage limit reached · continuing automatically at 6:53pm · esc to cancel" });
    c.record(assistantError(400, "billing_error", "Credit balance is too low"));
    c.record(assistantError(429, "rate_limit", "You've reached your Opus limit. Run /usage-credits to continue or switch models with /model."));
    expect(c.errors.map(e => e.notice)).toEqual([usage, credit, hold]);
    expect(c.errors[0]).toMatchObject({ type: "quota", action: "notify", message: "Claude Code usage limit reached — paused; continuing automatically at 6:53pm" });
    expect(c.errors[1]).toMatchObject({ type: "quota", action: "pause", message: "Insufficient API credits" });
    expect(c.errors[2]).toMatchObject({ type: "quota", action: "notify" });
  });
});
