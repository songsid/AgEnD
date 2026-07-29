import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend } from "../../src/backend/factory.js";
import type { ErrorPattern } from "../../src/backend/types.js";

// Always resolve the pattern from the real backend object. A copied regex in the
// test file is a copy that can silently drift from the one that actually runs —
// which is exactly how the `monthly limit` gap survived.
function quotaWarning(backendName: string): ErrorPattern {
  const dir = mkdtempSync(join(tmpdir(), `quota-${backendName}-`));
  const patterns = createBackend(backendName, dir).getErrorPatterns?.() ?? [];
  const found = patterns.find(p => p.formatMessage && p.type === "quota");
  if (!found) throw new Error(`${backendName} has no formatted quota warning pattern`);
  return found;
}

/** What the daemon does: last match in the pane wins, formatted if possible. */
function notification(ep: ErrorPattern, pane: string): string | null {
  const flags = ep.pattern.flags.includes("g") ? ep.pattern.flags : ep.pattern.flags + "g";
  const matches = [...pane.matchAll(new RegExp(ep.pattern.source, flags))];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return ep.formatMessage ? ep.formatMessage(last) : ep.message;
}

describe("Codex usage-limit warning detection", () => {
  const ep = quotaWarning("codex");

  it("notifies on both weekly and monthly limits", () => {
    // The reported case: only `weekly` was matched, so this line went unnoticed.
    expect(notification(ep, "⚠ Heads up, you have less than 5% of your monthly limit left. Run /status for a breakdown."))
      .toBe("Codex monthly limit: less than 5% left");
    expect(notification(ep, "⚠ Heads up, you have less than 5% of your weekly limit left."))
      .toBe("Codex weekly limit: less than 5% left");
  });

  it("fires at both the 10% and 5% thresholds, and any other percentage", () => {
    for (const pct of ["10", "5", "1", "25"]) {
      expect(notification(ep, `you have less than ${pct}% of your monthly limit left.`))
        .toBe(`Codex monthly limit: less than ${pct}% left`);
    }
  });

  it("covers the other periods Codex could scope a limit by", () => {
    for (const period of ["hourly", "daily", "weekly", "monthly"]) {
      expect(notification(ep, `less than 10% of your ${period} limit left`))
        .toBe(`Codex ${period} limit: less than 10% left`);
    }
  });

  it("reports the period and percentage, not a generic 'running low'", () => {
    const msg = notification(ep, "less than 5% of your monthly limit left");
    expect(msg).toContain("5%");
    expect(msg).toContain("monthly");
    expect(msg).not.toBe(ep.message);   // the static fallback would lose both
  });

  it("still matches when tmux wraps the line (capture-pane has no -J)", () => {
    // A hard wrap can land at any word gap and the continuation line may be
    // padded, so every gap in the phrase is tested with a newline in it.
    const wrapped = [
      "⚠ Heads up, you have less than 5% of your monthly limit left. Run /status for a\nbreakdown.",
      "⚠ Heads up, you have less than 5% of your monthly limit\nleft. Run /status for a breakdown.",
      "⚠ Heads up, you have less than 5% of your\nmonthly limit left.",
      "⚠ Heads up, you have less than 5% of\nyour monthly limit left.",
      "⚠ Heads up, you have less than\n5% of your monthly limit left.",
      "⚠ Heads up, you have less than 5%\nof your monthly limit left.",
      "⚠ Heads up, you have less\nthan 5% of your monthly limit left.",
      "less than 5% of your monthly\n   limit left.",   // padded continuation
    ];
    for (const pane of wrapped) {
      expect(notification(ep, pane), JSON.stringify(pane)).toBe("Codex monthly limit: less than 5% left");
    }
  });

  it("reports the most recent warning when an older one is still on screen", () => {
    // 10% scrolled up, 5% just arrived — the user needs to hear about the 5%.
    const pane = [
      "⚠ Heads up, you have less than 10% of your monthly limit left.",
      "... agent output ...",
      "⚠ Heads up, you have less than 5% of your monthly limit left.",
    ].join("\n");
    expect(notification(ep, pane)).toBe("Codex monthly limit: less than 5% left");
  });

  it("ignores percentages in the agent's own output", () => {
    // `of your <period> limit` is what keeps these off the notification path.
    const innocent = [
      "less than 5% of the tests failed",
      "we got it to less than 5% overhead",
      "less than 10% of your files changed",
      "less than 5% of your monthly spend",       // no "limit"
      "less than 5% of your budget limit",        // not a period
      "reduced latency by less than 5%",
      "the weekly limit is documented somewhere",  // no percentage
    ];
    for (const pane of innocent) {
      expect(notification(ep, pane), pane).toBeNull();
    }
  });

  it("is a notify-only quota warning (severity is conveyed by the percentage)", () => {
    expect(ep.type).toBe("quota");
    expect(ep.action).toBe("notify");
  });
});

describe("period-scoped limit patterns across backends", () => {
  // Guard against the same "only one period spelled out" gap reappearing: any
  // pattern mentioning a period must accept every period it could be scoped by.
  const PERIODS = ["hourly", "daily", "weekly", "monthly"];
  const BACKENDS = ["claude-code", "codex", "opencode", "kiro-cli", "grok", "antigravity", "gemini-cli"];

  it("no backend matches one period while ignoring the others", () => {
    for (const name of BACKENDS) {
      const dir = mkdtempSync(join(tmpdir(), `periods-${name}-`));
      const patterns = createBackend(name, dir).getErrorPatterns?.() ?? [];
      for (const p of patterns) {
        const src = p.pattern.source;
        const mentioned = PERIODS.filter(period => src.toLowerCase().includes(period));
        if (mentioned.length === 0) continue;         // period-agnostic — fine
        expect(mentioned, `${name}: /${src}/ mentions only ${mentioned.join(",")}`)
          .toEqual(PERIODS);
      }
    }
  });
});
