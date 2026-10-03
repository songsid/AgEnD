/**
 * #1101: Claude Code's real API-failure screens matched none of AgEnD's claude
 * error patterns — only the (older) `API Error: Overloaded` / `Rate limit`
 * wordings were known. What 2.1.287/2.1.288 print, captured from the real binary
 * against a local Anthropic mock (retries last ~3 minutes, so each pane below is
 * one stage of one incident):
 *
 *   429  ✻ 429 <message> · Retrying in 11s · attempt 6/10     (retrying, up to attempt 10/10)
 *        ● API Error: Request rejected (429) · <message>       (gave up)
 *   401  ✻ 401 invalid x-api-key · Retrying in 16s · attempt 6/10
 *        ⎿ Invalid API key · Fix external API key              (gave up; NBSP after ⎿)
 *   500  ✻ 500 Internal server error · Retrying in 8s · attempt 5/10
 *   529  ✻ API error · Retrying in 1s · attempt 2/10            (attempts 1-2 carry no status)
 *        ● API Error: Repeated 529 Overloaded errors. The API is at capacity …   (gave up)
 *
 * Rows read from the 2.1.288 renderer: ` · Retrying in ${wait}${resets} · attempt n/max`.
 * The retry rows are a turn in progress: busy, never a recovery, never a pause or
 * a failover (the CLI is still working the same request).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");
const RETRY_401 = fixture("claude-2.1.287-error-401-retrying.pane.txt");
const RETRY_429 = fixture("claude-2.1.287-error-429-retrying.pane.txt");
const FINAL_529 = fixture("claude-2.1.287-error-529.pane.txt");
const EXHAUSTED_401 = fixture("claude-2.1.288-error-401-exhausted.pane.txt");
const EXHAUSTED_429 = fixture("claude-2.1.288-error-429-exhausted.pane.txt");
const RETRY_GENERIC = fixture("claude-2.1.288-error-529-retry-generic.pane.txt");
const RETRY_500 = fixture("claude-2.1.288-error-500-retrying.pane.txt");

const RULE = "─".repeat(110);
const COMPOSER = `${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents`;
/** One status row in front of a live composer, the way every real retry pane has it. */
const live = (row: string) => `❯ hello\n${row}\n${COMPOSER}`;
const backend = new ClaudeCodeBackend("/tmp/agend-claude-1101");
const patterns = backend.getErrorPatterns();
const busy = backend.getBusyPattern();
const ready = backend.getReadyPattern();
/** "type/action" of every pattern that matches, in list order. */
const matched = (pane: string) => patterns.filter(ep => ep.pattern.test(pane)).map(ep => `${ep.type}/${ep.action}`);

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the real fixtures are the screens they claim to be", () => {
  it("each carries its defining line", () => {
    expect(RETRY_401).toMatch(/✻ 401 invalid x-api-key · Retrying in \d+s · attempt 6\/10/);
    expect(RETRY_429).toMatch(/✻ 429 Number of request tokens has exceeded your per-minute rate limit · Retrying in \d+s · attempt 6\/10/);
    expect(FINAL_529).toContain("● API Error: Repeated 529 Overloaded errors. The API is at capacity");
    expect(EXHAUSTED_401).toMatch(/⎿\s+Invalid API key · Fix external API key/);
    expect(EXHAUSTED_429).toContain("● API Error: Request rejected (429) · Number of request tokens has exceeded your per-minute rate limit");
    expect(RETRY_GENERIC).toContain("✻ API error · Retrying in 1s · attempt 2/10");
    expect(RETRY_500).toMatch(/✻ 500 Internal server error · Retrying in \d+s · attempt \d+\/10/);
  });
});

describe("classification of the real screens", () => {
  it("a 429 being retried is a rate_limit NOTICE — never a failover", () => {
    expect(matched(RETRY_429)).toEqual(["rate_limit/notify"]);
  });

  it("the 429 Claude Code gave up on is the failover trigger, like `API Error: Rate limit` always was", () => {
    expect(matched(EXHAUSTED_429)).toEqual(["rate_limit/failover"]);
  });

  it("an exhausted 529 is `API overloaded`, notify", () => {
    expect(matched(FINAL_529)).toEqual(["rate_limit/notify"]);
    expect(patterns.find(ep => ep.pattern.test(FINAL_529))!.message).toBe("API overloaded");
  });

  it("a 5xx being retried is the same notice, with its own status", () => {
    expect(matched(RETRY_500)).toEqual(["rate_limit/notify"]);
    const ep = patterns.find(candidate => candidate.pattern.test(RETRY_500))!;
    expect(ep.formatMessage!(RETRY_500.match(new RegExp(ep.pattern.source, ep.pattern.flags))!))
      .toMatch(/^Claude API returned 500 — Claude Code is retrying automatically \(attempt \d+\/10\)$/);
  });

  it("a 401 being retried, and a 401 that ended, are config_error notices (not auth_error, which pauses)", () => {
    expect(matched(RETRY_401)).toEqual(["config_error/notify"]);
    expect(matched(EXHAUSTED_401)).toEqual(["config_error/notify"]);
  });

  it("the first two retries carry no status and are no error at all", () => {
    expect(matched(RETRY_GENERIC)).toEqual([]);
  });

  it("the notice says what the row said", () => {
    const notice = (pane: string) => {
      const ep = patterns.find(candidate => candidate.pattern.test(pane))!;
      return ep.formatMessage!(pane.match(new RegExp(ep.pattern.source, ep.pattern.flags))!);
    };
    expect(notice(RETRY_429)).toBe("Claude API returned 429 — Claude Code is retrying automatically (attempt 6/10)");
    expect(notice(RETRY_401)).toBe("Claude API returned 401 — Claude Code is retrying (attempt 6/10); check the credentials");
  });

  it("every other real claude screen on file stays quiet", () => {
    const quiet = readdirSync(FIXTURES).filter(name => /^claude-2\.1\.28\d-/.test(name)
      && !/-error-/.test(name) && !name.includes("dialog") && !name.includes("settings"));
    expect(quiet.length).toBeGreaterThan(15);
    for (const name of quiet) {
      const hits = matched(fixture(name));
      expect(hits.filter(hit => /rate_limit|config_error/.test(hit)), name).toEqual([]);
    }
  });

  it("text that merely mentions the rows is not the rows", () => {
    for (const prose of [
      "The CLI printed ✻ 429 too many · Retrying in 5s · attempt 1/10 and then stopped.",
      "  ⎿  note: ✻ 429 foo · Retrying in 5s · attempt 1/10",
      "● 429 Too Many Requests · Retrying in 5s · attempt 3/10",
      "✻ 404 not found · Retrying in 5s · attempt 3/10",
      "- Invalid API key · Fix external API key is what Claude prints when it is wrong",
      "Request rejected (429) is the final wording",
    ]) expect(matched(prose), prose).toEqual([]);
  });
});

describe("a retry is a turn in progress, not a stop", () => {
  const retryPanes: Array<[string, string]> = [
    ["401 retrying", RETRY_401], ["429 retrying", RETRY_429], ["500 retrying", RETRY_500], ["generic first attempts", RETRY_GENERIC],
  ];

  it("every real retry row reads as busy", () => {
    for (const [label, pane] of retryPanes) expect(busy.test(pane), label).toBe(true);
  });

  it("the rows that end an incident do not", () => {
    for (const pane of [EXHAUSTED_401, EXHAUSTED_429, FINAL_529]) expect(busy.test(pane)).toBe(false);
  });

  it("a settled capture of a retry row is `working` (it used to read `idle`), the exhausted turn is `idle`", () => {
    const state = (pane: string) =>
      new PaneStateMachine(ready, 600_000, 0, busy).observe(pane, 10_000, { settled: true }).state;
    for (const [label, pane] of retryPanes) expect(state(pane), label).toBe("working");
    expect(state(EXHAUSTED_429)).toBe("idle");
    expect(state(EXHAUSTED_401)).toBe("idle");
    expect(state(FINAL_529)).toBe("idle");
  });

  it("the wait may carry a reset time, and a long wait (Claude's own duration formats)", () => {
    for (const row of [
      "✻ Usage limit reached · Retrying in 4h 59m (resets 11pm) · attempt 3/10",
      "✢ 429 rate limited · Retrying in 1m 5s · attempt 7/10",
      "✶ 529 busy · Retrying in 5m · attempt 7/10",
      "* 500 oops · Retrying in 1h 2m 3s · attempt 7/10",
    ]) expect(busy.test(live(row)), row).toBe(true);
  });

  it("tmux and Claude hint rows, and a tip under the row, do not hide a live retry", () => {
    const hint = "                     tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf";
    const effort = "                                                                                                    ◐ medium · /effort";
    const row = "✻ 429 Number of request tokens has exceeded your per-minute rate limit · Retrying in 8s · attempt 6/10";
    for (const between of [hint, effort, "  ⎿  Tip: Use /btw to ask a quick side question", `${hint}\n${effort}`, ""]) {
      expect(busy.test(`❯ hello\n${row}\n${between}\n${COMPOSER}`), JSON.stringify(between)).toBe(true);
    }
  });

  it("prose and finished rows stay idle", () => {
    for (const row of [
      "✻ Brewed for 3m 8s · done 10:11 PM",
      "The retry log said · Retrying in 5s · attempt 1/10 once",
      "✻ API error · Retrying soon · attempt two",
      "✻ 429 rate limited · Retrying in 5s",
    ]) expect(busy.test(row), row).toBe(false);
  });
});

/** The real daemon error monitor over the panes of one incident, in order. */
function monitor() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1101-"));
  dirs.push(dir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("claude-1101", {
    working_directory: "/tmp", backend: "claude-code",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, false, backend, undefined, { child: () => logger } as any) as any;
  const errors: Array<{ type: string; action: string; message: string }> = [];
  daemon.on("pty_error", (error: { type: string; action: string; message: string }) => errors.push(error));
  daemon.instanceState = "working";
  let now = 10 * 60_000;
  const scan = (pane: string, advanceMs = 5_000) => {
    now += advanceMs;
    daemon.evaluateErrorPatterns(pane, patterns, ready, now, busy);
  };
  return { daemon, errors, scan };
}

const FINAL_429_ROW = /^● API Error: Request rejected \(429\) ·.*$/m;
/** The finished exhausted-429 screen with its final error row replaced by `text`. */
const finished = (text: string) => EXHAUSTED_429.replace(FINAL_429_ROW, text);
const REAL_RETRY_ROW = "✻ 429 Number of request tokens has exceeded your per-minute rate limit · Retrying in 11s · attempt 6/10";

describe("only the live retry row counts (a quotation of one in a finished transcript does not)", () => {
  const state = (pane: string, at = 10_000) =>
    new PaneStateMachine(ready, 600_000, 0, busy).observe(pane, at, { settled: true }).state;

  it("a documentation line that only looks like the suffix is not a retry", () => {
    const pane = finished("● Parser example:\n  * note for documentation · Retrying in not a duration · attempt 6/10");
    expect(busy.test(pane)).toBe(false);
    expect(state(pane)).toBe("idle");
    expect(state(pane, 610_000), "and never `stuck`").toBe("idle");
    expect(matched(pane)).toEqual([]);
  });

  it("a real retry row quoted in a transcript that has since finished is history", () => {
    const pane = finished(`${REAL_RETRY_ROW}\nThat was a quotation. The request has completed.`);
    expect(busy.test(pane)).toBe(false);
    expect(state(pane)).toBe("idle");
    expect(state(pane, 610_000)).toBe("idle");
    expect(matched(pane)).toEqual([]);
    const { errors, scan } = monitor();
    scan(pane);
    expect(errors).toEqual([]);
  });

  it("the same quoted row as the last thing before the composer IS indistinguishable from the live one", () => {
    // Stated limit: nothing on screen tells a quotation printed right above the
    // composer from the live row, and it only ever errs towards `working`.
    expect(busy.test(live(REAL_RETRY_ROW))).toBe(true);
  });
});

describe("only the final error ROW fails over or reports overload", () => {
  const idle = EXHAUSTED_401.replace(/^  ⎿.*Invalid API key.*$/m, "");

  it("an explanation that quotes the words is not the final row", () => {
    for (const prose of [
      "● The final response is labelled API Error: Request rejected (429) when all retries fail.",
      "  note: API Error: Request rejected (429) is printed once the retries are exhausted",
      "● The new final response is labelled API Error: Repeated 529 Overloaded errors.",
    ]) {
      const { errors, scan } = monitor();
      scan(finished(prose));
      expect(errors, prose).toEqual([]);
    }
    expect(idle).not.toContain("Invalid API key");
  });

  it("a retry whose upstream message quotes the final wording is still a retry notice, not a failover", () => {
    const pane = RETRY_429.replace(/(✻ 429 ).*( · Retrying in)/, "$1API Error: Request rejected (429)$2");
    expect(pane).toContain("✻ 429 API Error: Request rejected (429) · Retrying in");
    expect(busy.test(pane)).toBe(true);
    const { errors, scan } = monitor();
    scan(pane);
    expect(errors.map(e => `${e.type}/${e.action}`)).toEqual(["rate_limit/notify"]);
  });

  it("the real final rows still are", () => {
    expect(matched(EXHAUSTED_429)).toEqual(["rate_limit/failover"]);
    expect(matched(FINAL_529)).toEqual(["rate_limit/notify"]);
  });
});

describe("through the real error monitor", () => {
  it("a 429 that is retried and then given up on: one notice while retrying, then the failover", () => {
    const { daemon, errors, scan } = monitor();
    scan(RETRY_429);
    expect(errors.map(e => `${e.type}/${e.action}`)).toEqual(["rate_limit/notify"]);
    expect(errors[0].message).toBe("Claude API returned 429 — Claude Code is retrying automatically (attempt 6/10)");
    // The CLI is retrying, not broken: no recovery gate, nothing for delivery to warn about.
    expect(daemon.errorWaitingForRecovery).toBe(false);
    expect(daemon.isErrorState).toBe(false);

    // The countdown re-renders; it is the same incident.
    scan(RETRY_429.replace(/Retrying in \d+s/, "Retrying in 6s"));
    expect(errors).toHaveLength(1);

    // Retries exhausted: the final line is a NEW occurrence and triggers the failover.
    scan(EXHAUSTED_429);
    expect(errors.map(e => `${e.type}/${e.action}`)).toEqual(["rate_limit/notify", "rate_limit/failover"]);
  });

  it("a 401 that is retried and then given up on is reported twice: retrying, then fix the key", () => {
    const { errors, scan } = monitor();
    scan(RETRY_401);
    scan(EXHAUSTED_401);
    expect(errors.map(e => `${e.type}/${e.action}`)).toEqual(["config_error/notify", "config_error/notify"]);
    expect(errors[0].message).toContain("retrying");
    expect(errors[1].message).toContain("fix ANTHROPIC_API_KEY");
  });

  it("a 529 raises nothing while the first retries run, and `API overloaded` once it gives up", () => {
    const { errors, scan } = monitor();
    scan(RETRY_GENERIC);
    expect(errors).toEqual([]);
    scan(FINAL_529);
    expect(errors.map(e => `${e.type}/${e.action}`)).toEqual(["rate_limit/notify"]);
    expect(errors[0].message).toBe("API overloaded");
  });

  it("a healthy screen after the incident raises nothing and the next incident is new", () => {
    const { errors, scan } = monitor();
    scan(RETRY_429);
    scan(fixture("claude-2.1.287-busy.pane.txt"), 6 * 60_000);
    scan(RETRY_429, 6 * 60_000);
    expect(errors.map(e => e.type)).toEqual(["rate_limit", "rate_limit"]);
  });
});

describe("the Cancel button follows the turn, not the notice", () => {
  /** The real Daemon error monitor wired to the real lifecycle handler. */
  function wired() {
    const dir = mkdtempSync(join(tmpdir(), "agend-1101-lc-"));
    dirs.push(dir);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
    const clearCancelButton = vi.fn();
    const checkModelFailover = vi.fn();
    const ctx = {
      fleetConfig: { defaults: { backend: "claude-code" }, instances: { worker: { backend: "claude-code" } } },
      logger, dataDir: dir,
      getInstanceDir: (name: string) => join(dir, "instances", name),
      eventLog: { insert: vi.fn() }, isPlannedRestart: () => false, isClassicInstance: () => false,
      notifyInstanceTopic: vi.fn(), setTopicIcon: vi.fn(), webhookEmit: vi.fn(),
      clearCancelButton, checkModelFailover, restartSingleInstance: vi.fn(async () => {}),
    } as unknown as LifecycleContext;
    const lifecycle = new InstanceLifecycle(ctx);
    const daemon = new Daemon("worker", {
      working_directory: "/tmp", backend: "claude-code",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "silent",
    } as any, dir, false, backend, undefined, logger as any) as any;
    lifecycle.attachIncidentHandlers("worker", daemon);
    daemon.instanceState = "working";
    const scan = (pane: string) => daemon.evaluateErrorPatterns(pane, patterns, ready, 10 * 60_000, busy);
    return { scan, clearCancelButton, checkModelFailover };
  }
  const flush = () => new Promise(resolve => setImmediate(resolve));

  it.each([["401", RETRY_401], ["429", RETRY_429], ["500", RETRY_500]] as const)(
    "a %s retry notice keeps the running turn's Cancel button", async (_status, pane) => {
      const { scan, clearCancelButton, checkModelFailover } = wired();
      scan(pane);
      await flush();
      expect(clearCancelButton).not.toHaveBeenCalled();
      expect(checkModelFailover).not.toHaveBeenCalled();
    });

  it.each([["exhausted 429", EXHAUSTED_429], ["exhausted 401", EXHAUSTED_401], ["exhausted 529", FINAL_529]] as const)(
    "%s ends the turn and retires it", async (_label, pane) => {
      const { scan, clearCancelButton } = wired();
      scan(pane);
      await flush();
      expect(clearCancelButton).toHaveBeenCalledWith("worker");
    });
});
