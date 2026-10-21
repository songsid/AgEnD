/**
 * Tests for Grok backend rate_limit error pattern anchoring (#2325).
 *
 * SCOPE: Only the rate_limit pattern is anchored in this PR. The auth (401)
 * and quota patterns are intentionally unchanged — they use the same broad
 * patterns as before. Those patterns still produce false-positives on agent
 * code containing "quota" or "401", matching the existing audit verdicts
 * (#1792 follow-up). This PR fixes only the rate_limit false-positive
 * (the one reported in #2324).
 *
 * auth/quota scope: unchanged. `scan_quota(account_id)` still matches quota.
 * `if (status === 401)` still matches auth_error. These are known issues
 * tracked separately (#1792).
 *
 * Fixture sources (tests/fixtures/grok-1.0.60-audit/ and grok-1.0.52-audit/):
 *   Rate limit 1.0.60: 07-err-429.pane.txt, 07-err-429-text.pane.txt
 *   Rate limit 1.0.52: grok-1.0.52-audit/{1.0.50,1.0.52}-{80,120}/07-err-429.pane.txt
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pane60 = (width: string, step: string) =>
  readFileSync(join(ROOT, "tests/fixtures/grok-1.0.60-audit/1.0.60-" + width, step + ".pane.txt"), "utf-8");
const pane52 = (version: string, width: string, step: string) =>
  readFileSync(join(ROOT, "tests/fixtures/grok-1.0.52-audit/" + version + "-" + width, step + ".pane.txt"), "utf-8");

const backend = new GrokBackend("/tmp/agend-grok-test");
const patterns = backend.getErrorPatterns();

function matchType(pane: string): string | null {
  const hit = patterns.find(ep => ep.pattern.test(pane));
  return hit?.type ?? null;
}

// ── Real Grok rate_limit error lines (all 4 fixture variants) ───────────────

describe("Grok rate_limit — real fixtures MUST match", () => {
  it("1.0.60 at 120col (fixture: 07-err-429.pane.txt)", () => {
    expect(matchType(pane60("120", "07-err-429"))).toBe("rate_limit");
  });

  it("1.0.60 at 120col verbose (fixture: 07-err-429-text.pane.txt)", () => {
    expect(matchType(pane60("120", "07-err-429-text"))).toBe("rate_limit");
  });

  it("1.0.50 at 120col (fixture: grok-1.0.52-audit 1.0.50-120 07-err-429)", () => {
    expect(matchType(pane52("1.0.50", "120", "07-err-429"))).toBe("rate_limit");
  });

  it("1.0.50 at 80col — wraps to continuation ┃ line", () => {
    expect(matchType(pane52("1.0.50", "80", "07-err-429"))).toBe("rate_limit");
  });

  it("1.0.52 at 120col (fixture: grok-1.0.52-audit 1.0.52-120 07-err-429)", () => {
    expect(matchType(pane52("1.0.52", "120", "07-err-429"))).toBe("rate_limit");
  });

  it("1.0.52 at 80col — wraps to continuation ┃ line", () => {
    expect(matchType(pane52("1.0.52", "80", "07-err-429"))).toBe("rate_limit");
  });
});

// ── rate_limit false-positive guard ─────────────────────────────────────────

describe("Grok rate_limit — unrelated content MUST NOT match", () => {
  it("task description 'rate limit' (no ┃ border)", () => {
    const p = "  ❯ Implement retry logic for rate limit errors\n  │ ❯ │";
    expect(matchType(p)).not.toBe("rate_limit");
  });

  it("'429' mentioned in agent code (no ┃ border)", () => {
    const p = "  if (status === 429) { retry(); }\n  │ ❯ │";
    expect(matchType(p)).not.toBe("rate_limit");
  });

  it("unrelated ┃ Retry failed + later ┃ line containing scan_rate_limit (no known payload)", () => {
    // The pattern requires "rate_limit_error:" or the specific exhausted-resource
    // sentence. A ┃ line with an arbitrary function name "scan_rate_limit" must not match.
    const p = [
      "  ┃  Retry failed: unrelated error",
      "  ┃  scan_rate_limit(account)",
    ].join("\n");
    expect(matchType(p)).not.toBe("rate_limit");
  });

  it("unrelated ┃ Retry failed + later prose rate limit (no known payload)", () => {
    const p = [
      "  ┃  Retry failed: connection lost",
      "  Response complete.",
      "  Handle rate limit in the next task",
    ].join("\n");
    expect(matchType(p)).not.toBe("rate_limit");
  });

  it("'too many requests' in model output prose (no ┃ border)", () => {
    const p = "  There were too many requests in the last minute.";
    expect(matchType(p)).not.toBe("rate_limit");
  });
});
