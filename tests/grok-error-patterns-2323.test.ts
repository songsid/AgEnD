/**
 * Tests for Grok backend error pattern detection (#2323).
 *
 * The original patterns were unanchored bare words that matched any pane
 * content containing "quota", "rate limit", "401", "429" etc. — including
 * agent-written code (scan_quota(...)), chat content, and task descriptions.
 *
 * The fixed patterns anchor on the Grok border glyph ┃ (U+2503) and match
 * only the server-generated error lines, as confirmed by the fixtures in
 * tests/fixtures/grok-1.0.60-audit/.
 *
 * Fixture sources:
 *   Rate limit: tests/fixtures/grok-1.0.60-audit/1.0.60-120/07-err-429*.pane.txt
 *   Auth (401): tests/fixtures/grok-1.0.60-audit/1.0.60-120/07-err-401.pane.txt
 *   Quota (402): tests/fixtures/grok-1.0.60-audit/1.0.60-120/07-err-402.pane.txt
 *   Quota (403): tests/fixtures/grok-1.0.60-audit/1.0.60-120/07-err-403-usage.pane.txt
 */
import { describe, expect, it } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";

const backend = new GrokBackend("/tmp/agend-grok-test");
const patterns = backend.getErrorPatterns();

function matchType(pane: string): string | null {
  const hit = patterns.find(ep => ep.pattern.test(pane));
  return hit?.type ?? null;
}

// ── Real Grok error lines (from fixtures) ────────────────────────────────────

describe("Grok error patterns — real error lines MUST match", () => {
  it("429 rate limit (fixture: 07-err-429.pane.txt)", () => {
    const pane = "  ┃  Retry failed: rate_limit_error: Rate limit exceeded";
    expect(matchType(pane)).toBe("rate_limit");
  });

  it("429 rate limit verbose (fixture: 07-err-429-text.pane.txt)", () => {
    const pane = "  ┃  Retry failed: rate_limit_error: rate limit exceeded; too many requests";
    expect(matchType(pane)).toBe("rate_limit");
  });

  it("401 auth error (fixture: 07-err-401.pane.txt)", () => {
    const pane = "  ┃  Authentication required: your session has expired or your credentials were rejected. Run /login to re-\n  ┃  authenticate, then resend your message.";
    expect(matchType(pane)).toBe("auth_error");
  });

  it("402 weekly limit (fixture: 07-err-402.pane.txt)", () => {
    const pane = "  ┃\n  ┃  You hit your weekly limit.\n  ┃";
    expect(matchType(pane)).toBe("quota");
  });

  it("403 usage limit (fixture: 07-err-403-usage.pane.txt)", () => {
    const pane = "  ┃  Request denied (403): invalid_request_error: usage limit reached";
    expect(matchType(pane)).toBe("quota");
  });

  it("weekly limit modal (fixture: grok-weekly-limit-modal.pane.txt)", () => {
    const pane = "  ┃\n  ┃  You hit your weekly limit.\n  ┃\n  ┃  1 (○) Upgrade tier\n  ┃  2 (○) Buy more credits";
    expect(matchType(pane)).toBe("quota");
  });
});

// ── False-positive guard — code/prose MUST NOT match ─────────────────────────

describe("Grok error patterns — code and prose MUST NOT match", () => {
  it("agent code: scan_quota(...) in transcript", () => {
    const pane = [
      "  ❯ Write code",
      "  function scan_quota(account_id) {",
      "    return fetch('/api/quota?id=' + account_id);",
      "  }",
      "  ╭──╮",
      "  │ ❯ │",
      "  ╰──╯",
    ].join("\n");
    expect(matchType(pane)).toBeNull();
  });

  it("chat content mentioning 'quota' in user message", () => {
    const pane = [
      "  ❯ How do I handle quota exceeded errors?",
      "  Here is how to handle quota exceeded in Python...",
      "  │ ❯ │",
    ].join("\n");
    expect(matchType(pane)).toBeNull();
  });

  it("task description with 'rate limit'", () => {
    const pane = [
      "  ❯ Implement retry logic for rate limit errors",
      "  I'll add exponential backoff for rate limit and 429 responses.",
      "  │ ❯ │",
    ].join("\n");
    expect(matchType(pane)).toBeNull();
  });

  it("code mentioning '401' and 'unauthorized' inline", () => {
    const pane = [
      "  ❯ Fix 401 unauthorized handling",
      "  if (status === 401) throw new Error('unauthorized');",
      "  // authentication error handling",
      "  │ ❯ │",
    ].join("\n");
    expect(matchType(pane)).toBeNull();
  });

  it("task mentioning '429' as a status code", () => {
    const pane = [
      "  ❯ Handle 429 responses with backoff",
      "  When you get a 429 too many requests response...",
      "  │ ❯ │",
    ].join("\n");
    expect(matchType(pane)).toBeNull();
  });

  it("model output discussing 'rate limit reached' without border glyph", () => {
    const pane = "  The rate limit reached after many requests. Use exponential backoff.";
    expect(matchType(pane)).toBeNull();
  });

  it("'insufficient credits' in plain prose", () => {
    const pane = "  The user saw insufficient credits error in the Grok dashboard.";
    expect(matchType(pane)).toBeNull();
  });
});
