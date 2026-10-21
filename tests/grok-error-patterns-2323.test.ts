/**
 * Tests for Grok backend rate_limit error pattern anchoring (#2323).
 *
 * The original `/rate.?limit|too many requests|\b429\b/i` matched any pane
 * content containing those words — agent code, chat, task descriptions.
 * Only the rate_limit pattern is anchored in this fix (on the ┃ Grok box
 * border). Auth (401) and quota patterns are unchanged, per the existing
 * audit decisions (#1792) which pin those panes as idle (handled via
 * LOGIN_FLOWS.grok.authCheck and the WEEKLY dialog respectively).
 *
 * Fixture sources (grok-1.0.60-audit/):
 *   Rate limit: 07-err-429.pane.txt, 07-err-429-text.pane.txt
 */
import { describe, expect, it } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";

const backend = new GrokBackend("/tmp/agend-grok-test");
const patterns = backend.getErrorPatterns();

function matchType(pane: string): string | null {
  const hit = patterns.find(ep => ep.pattern.test(pane));
  return hit?.type ?? null;
}

// ── Real Grok rate_limit error lines (fixture-verified) ─────────────────────

describe("Grok rate_limit pattern — anchored on ┃ (fixture-verified)", () => {
  it("429 rate limit (fixture: 07-err-429.pane.txt)", () => {
    const pane = "  ┃  Retry failed: rate_limit_error: Rate limit exceeded";
    expect(matchType(pane)).toBe("rate_limit");
  });

  it("429 rate limit verbose (fixture: 07-err-429-text.pane.txt)", () => {
    const pane = "  ┃  Retry failed: rate_limit_error: rate limit exceeded; too many requests";
    expect(matchType(pane)).toBe("rate_limit");
  });

  it("429 rate limit 1.0.52 format (fixture: grok-1.0.52-audit 07-err-429, 120col)", () => {
    // 1.0.52 uses "Some resource has been exhausted: Your team has exceeded its rate limit."
    const pane = "  ┃  Retry failed: Some resource has been exhausted: Your team has exceeded its rate limit. Please try again later.";
    expect(matchType(pane)).toBe("rate_limit");
  });

  it("429 rate limit 1.0.52 at 80col (wraps to next ┃ line)", () => {
    // At 80 columns the text wraps; "rate limit" is on the continuation line
    const pane = "  ┃  Retry failed: Some resource has been exhausted: Your team has exceeded\n  ┃  its rate limit. Please try again later.";
    expect(matchType(pane)).toBe("rate_limit");
  });
});

// ── False-positive guard for rate_limit — code/prose MUST NOT match ──────────

describe("Grok rate_limit pattern — agent code and prose MUST NOT match", () => {
  it("agent code: scan_quota(...) in transcript — no rate_limit false positive", () => {
    const pane = [
      "  ❯ Write code",
      "  function scan_quota(account_id) {",
      "    return fetch('/api/quota?id=' + account_id);",
      "  }",
      "  ╭──╮",
      "  │ ❯ │",
      "  ╰──╯",
    ].join("\n");
    expect(matchType(pane)).not.toBe("rate_limit");
  });

  it("task description with 'rate limit' — no rate_limit false positive", () => {
    const pane = [
      "  ❯ Implement retry logic for rate limit errors",
      "  I'll add exponential backoff for rate limit and 429 responses.",
      "  │ ❯ │",
    ].join("\n");
    expect(matchType(pane)).not.toBe("rate_limit");
  });

  it("task mentioning '429' as a status code — no rate_limit false positive", () => {
    const pane = [
      "  ❯ Handle 429 responses with backoff",
      "  When you get a 429 too many requests response...",
      "  │ ❯ │",
    ].join("\n");
    expect(matchType(pane)).not.toBe("rate_limit");
  });

  it("model output discussing 'rate limit reached' without ┃ border — no false positive", () => {
    const pane = "  The rate limit reached after many requests. Use exponential backoff.";
    expect(matchType(pane)).not.toBe("rate_limit");
  });

  it("too many requests in prose — no false positive", () => {
    const pane = "  There were too many requests in the last minute; retry later.";
    expect(matchType(pane)).not.toBe("rate_limit");
  });
});
