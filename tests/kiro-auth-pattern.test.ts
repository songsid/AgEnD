import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroBackend } from "../src/backend/kiro.js";
import { Daemon } from "../src/daemon.js";

/**
 * Issue #440. kiro prints ONE header — `Kiro is having trouble responding right
 * now:` — above every failure kind, and the actual cause only appears in the
 * numbered list underneath. The generic header pattern sat first in the array,
 * and the monitor takes the FIRST matching pattern and breaks, so an expired
 * login was reported as "Rate limit" and, because rate_limit only notifies,
 * the auth auto-pause added in #378 never fired: the instance kept accepting
 * work it could not do.
 *
 * PANE text below is what `general` actually had on screen (captured live), not
 * a reconstruction.
 */
const NO_TOKEN_PANE = [
  "● Kiro is having trouble responding right now:",
  "   0: unexpected error occurred while processing the request",
  "   1: service error",
  "   2: dispatch failure (other): No token",
  "   3: other",
  "   4: No token",
  "   5: No token",
  "",
  "> ",
].join("\n");

/** The same header with a cause none of the specific patterns explain. */
const UNCLASSIFIED_PANE = [
  "● Kiro is having trouble responding right now:",
  "   0: unexpected error occurred while processing the request",
  "   1: something we have never seen",
  "",
  "> ",
].join("\n");

const THROTTLED_PANE = [
  "● Kiro is having trouble responding right now:",
  "   0: ThrottlingException: Rate exceeded",
  "",
  "> ",
].join("\n");

/** Exactly what the monitor does: first pattern in array order wins. */
function classify(pane: string) {
  return new KiroBackend("/tmp/test").getErrorPatterns().find(ep => ep.pattern.test(pane));
}

describe("kiro auth failure is not a rate limit (#440)", () => {
  it("classifies the real `No token` pane as auth_error and pauses", () => {
    const match = classify(NO_TOKEN_PANE);
    expect(match).toMatchObject({ type: "auth_error", action: "pause" });
    // The whole point: pause is what stops the instance burning turns.
    expect(match?.message).toMatch(/kiro-cli login/);
  });

  it("does not report it as a rate limit", () => {
    // The old behaviour, stated as its own assertion so a regression names itself.
    expect(classify(NO_TOKEN_PANE)?.type).not.toBe("rate_limit");
  });

  it("still catches the login strings taken from the kiro-cli binary", () => {
    for (const line of [
      "You are not logged in, please log in with",
      "ExpiredTokenException: The security token included in the request is expired",
      "no device registration found for token",
    ]) {
      expect(classify(line)).toMatchObject({ type: "auth_error", action: "pause" });
    }
  });

  it("does not pause an agent that is merely discussing the error", () => {
    // This fleet maintains AgEnD; these sentences get typed and pasted into
    // panes routinely. A bare `No token` keyword would pause on all of them.
    for (const prose of [
      "The bug is that `No token` gets misclassified as a rate limit.",
      "grep for dispatch failure and No token in the pane capture",
      "issue #440: dispatch failure (other): No token is reported as Rate limit",
    ]) {
      expect(classify(prose)?.type).not.toBe("auth_error");
    }
  });

  it("reports real throttling as a rate limit, on the exceptions kiro raises", () => {
    expect(classify(THROTTLED_PANE)).toMatchObject({ type: "rate_limit" });
    expect(classify(THROTTLED_PANE)?.message).toMatch(/throttl/i);
  });

  it("falls back to the generic header without claiming a rate limit", () => {
    const match = classify(UNCLASSIFIED_PANE);
    expect(match).toBeDefined();
    // Still reported — the header is the only signal we have — but the message
    // must not send an operator to check quota for a cause we did not identify.
    expect(match?.message).not.toMatch(/rate limit|throttl/i);
    expect(match?.message).toMatch(/pane/i);
  });

  it("keeps the catch-all header last so nothing specific is shadowed", () => {
    // The ordering invariant #440 was caused by violating. Asserted structurally
    // so a future insert at the top of the array fails here instead of in prod.
    const patterns = new KiroBackend("/tmp/test").getErrorPatterns();
    const generic = patterns.findIndex(ep => ep.pattern.source === "having trouble responding");
    expect(generic).toBe(patterns.length - 1);
  });
});

/**
 * Reordering alone is not enough. Several kiro patterns match the SAME pane (the
 * header plus its specific cause), the monitor reports only the first and
 * breaks, and recovery re-baselines only the pattern that fired. The losers keep
 * a stale baseline, so the first scan after recovery sees "new" occurrences of
 * text the user was already notified about and fires a second, contradictory
 * notification for one incident.
 */
describe("one incident produces one notification", () => {
  function makeDaemon() {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-shadow-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("shadow", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, { getReadyPattern: () => /^> /m } as any, undefined,
      { child: () => logger } as any);
    return { daemon, instanceDir };
  }

  it("does not follow the auth pause with a stale generic error", () => {
    const { daemon, instanceDir } = makeDaemon();
    const errors: any[] = [];
    daemon.on("pty_error", e => errors.push(e));
    const patterns = new KiroBackend("/tmp/test").getErrorPatterns();
    const ready = /^> /m;
    const t0 = 10 * 60_000; // clear of ERROR_COOLDOWN_MS from the zero epoch

    try {
      const ev = (pane: string, t: number) =>
        (daemon as any).evaluateErrorPatterns(pane, patterns, ready, t);

      ev(NO_TOKEN_PANE, t0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: "auth_error", action: "pause" });

      // User logs back in: kiro is answering again, but the failure text is
      // still in the scrollback — which is all the monitor ever sees.
      ev(`${NO_TOKEN_PANE}\nback to work\n> `, t0 + 5_000);
      ev(`${NO_TOKEN_PANE}\nback to work\n> `, t0 + 10_000);

      expect(errors).toHaveLength(1);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("still reports a genuinely new occurrence of an absorbed pattern", () => {
    // The absorb must baseline, not disable: a later real throttle still fires.
    const { daemon, instanceDir } = makeDaemon();
    const errors: any[] = [];
    daemon.on("pty_error", e => errors.push(e));
    const patterns = new KiroBackend("/tmp/test").getErrorPatterns();
    const ready = /^> /m;
    const t0 = 10 * 60_000;

    try {
      const ev = (pane: string, t: number) =>
        (daemon as any).evaluateErrorPatterns(pane, patterns, ready, t);

      ev(NO_TOKEN_PANE, t0);                                        // auth fires
      ev(`${NO_TOKEN_PANE}\nrecovered\n> `, t0 + 5_000);            // recovery
      ev(`${NO_TOKEN_PANE}\nrecovered\n> \n${THROTTLED_PANE}`, t0 + 6 * 60_000);

      expect(errors).toHaveLength(2);
      expect(errors[1].type).toBe("rate_limit");
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
