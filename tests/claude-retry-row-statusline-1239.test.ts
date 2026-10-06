/**
 * #1239: #1101 recognised Claude's live retry row only when the footer under the
 * composer said `esc to interrupt`. Claude Code leaves that hint out whenever a
 * statusLine is configured, and AgEnD always configures one (writeConfig), so in
 * production a live `✻ 429 … · Retrying in 4s · attempt 4/10` read idle, with
 * no notice. The #1101 fixtures were captured without a statusline.
 *
 * The fixtures here are real 2.1.291 panes launched with the production
 * writeConfig + buildCommand (statusLine set; a local Anthropic mock returned
 * the errors). Also: the native Bash permission prompt whose option 2 wraps
 * because the working directory is long.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend, claudeBashPermissionActive } from "../src/backend/claude-code.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const RETRY_429 = fixture("claude-2.1.291-error-429-retrying-statusline.pane.txt");
const RETRY_500 = fixture("claude-2.1.291-error-500-retrying-statusline.pane.txt");
/** A fresh session, no background shell: the plainest live retry, and the same pane after Esc. */
const RETRY_CLEAN = fixture("claude-2.1.291-error-429-retrying-statusline-clean.pane.txt");
const RETRY_ESCAPED = fixture("claude-2.1.291-error-429-retry-escaped.pane.txt");
const READY = fixture("claude-2.1.291-ready-statusline.pane.txt");
const BUSY = fixture("claude-2.1.291-busy-statusline.pane.txt");
const REPEATED_529 = fixture("claude-2.1.291-error-529-repeated.pane.txt");
const OLD_RETRY_429 = fixture("claude-2.1.287-error-429-retrying.pane.txt");
const OLD_RETRY_500 = fixture("claude-2.1.288-error-500-retrying.pane.txt");
const EXHAUSTED_429 = fixture("claude-2.1.288-error-429-exhausted.pane.txt");
const EXHAUSTED_401 = fixture("claude-2.1.288-error-401-exhausted.pane.txt");
const FINAL_529 = fixture("claude-2.1.287-error-529.pane.txt");
const BASH_WRAPPED = fixture("claude-2.1.291-bash-permission-prompt-wrapped.pane.txt");
const BASH_WIDE = fixture("claude-2.1.291-bash-permission-prompt.pane.txt");

const backend = new ClaudeCodeBackend("/tmp/agend-claude-1239");
const patterns = backend.getErrorPatterns();
const busy = backend.getBusyPattern();
const ready = backend.getReadyPattern();
const matched = (pane: string) => patterns.filter(ep => ep.pattern.test(pane)).map(ep => `${ep.type}/${ep.action}`);
const state = (pane: string, at = 10_000) => new PaneStateMachine(ready, 600_000, 0, busy).observe(pane, at, { settled: true }).state;
const ROW_429 = /^✻ 429 mock rate_limit_error · Retrying in 2s · attempt 3\/10$/m;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** The real daemon error monitor (as in #1101's tests). */
function monitor() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1239-"));
  dirs.push(dir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("claude-1239", {
    working_directory: "/tmp", backend: "claude-code",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, false, backend, undefined, { child: () => logger } as any) as any;
  const errors: Array<{ type: string; action: string; message: string }> = [];
  daemon.on("pty_error", (error: { type: string; action: string; message: string }) => errors.push(error));
  daemon.instanceState = "working";
  let now = 10 * 60_000;
  const scan = (pane: string) => { now += 5_000; daemon.evaluateErrorPatterns(pane, patterns, ready, now, busy); };
  return { errors, scan };
}

describe("the fixtures are production panes", () => {
  it("statusLine set (`ok` row), and no `esc to interrupt` in any footer — running or not", () => {
    for (const pane of [RETRY_429, RETRY_500, RETRY_CLEAN, READY, BUSY]) {
      expect(pane).toContain("Claude Code v2.1.291");
      expect(pane).toMatch(/^ {2}ok$/m);
      expect(pane).not.toContain("esc to interrupt");
    }
    expect(RETRY_429).toMatch(ROW_429);
  });
});

describe("a live retry row under a statusLine is a running turn with a notice (#1239)", () => {
  it("busy, and a settled capture is `working` (it read `idle`)", () => {
    for (const pane of [RETRY_429, RETRY_500, RETRY_CLEAN]) {
      expect(busy.test(pane)).toBe(true);
      expect(state(pane)).toBe("working");
    }
  });

  it("the retry notice, with the status and the attempt", () => {
    expect(matched(RETRY_429)).toEqual(["rate_limit/notify"]);
    expect(matched(RETRY_500)).toEqual(["rate_limit/notify"]);
    const { errors, scan } = monitor();
    scan(RETRY_429);
    expect(errors).toEqual([expect.objectContaining({ type: "rate_limit", action: "notify", message: expect.stringContaining("returned 429") })]);
    expect(errors[0]!.message).toContain("attempt 3/10");
  });

  it("the same pane without a statusLine (the #1101 fixtures) is unchanged", () => {
    for (const pane of [OLD_RETRY_429, OLD_RETRY_500]) {
      expect(pane).toContain("esc to interrupt");
      expect(busy.test(pane)).toBe(true);
      expect(matched(pane)).toEqual(["rate_limit/notify"]);
    }
  });

  it("the ready and running production panes raise nothing; the running one is busy by its spinner", () => {
    expect(matched(READY)).toEqual([]);
    expect(busy.test(READY)).toBe(false);
    expect(matched(BUSY)).toEqual([]);
    expect(busy.test(BUSY)).toBe(true);
  });
});

describe("once the turn is over the row is history, footer or not", () => {
  const replaceRow = (pane: string, rows: string) => pane.replace(ROW_429, rows);

  it("followed by the completed-turn row", () => {
    const pane = replaceRow(RETRY_429, "✻ 429 mock rate_limit_error · Retrying in 2s · attempt 3/10\n✻ Worked for 41s · done 9:16 PM");
    expect(busy.test(pane)).toBe(false);
    expect(state(pane)).toBe("idle");
    expect(matched(pane)).toEqual([]);
  });

  it("Esc during the retries (real 2.1.291): the row is gone and the message is back in the composer", () => {
    expect(RETRY_CLEAN).toMatch(/· Retrying in 10s · attempt 5\/10$/m);
    expect(RETRY_ESCAPED).not.toContain("Retrying in");
    expect(RETRY_ESCAPED).toMatch(/^❯[ \u00a0]\[user:alice via telegram, id:1\] E429 please$/m);   // the composer row, no-break space and all
    expect(busy.test(RETRY_ESCAPED)).toBe(false);
    expect(state(RETRY_ESCAPED)).toBe("idle");
    expect(matched(RETRY_ESCAPED)).toEqual([]);
  });

  it("followed by `⎿ Interrupted` (a turn interrupted with the row still printed above)", () => {
    const pane = replaceRow(RETRY_429, "✻ 429 mock rate_limit_error · Retrying in 2s · attempt 3/10\n  ⎿  Interrupted · What should Claude do instead?");
    expect(busy.test(pane)).toBe(false);
    expect(matched(pane)).toEqual([]);
  });

  it("quoted together with its composer and statusline footer, above more history and the real composer", () => {
    // The live pane from the retry row down — row, composer, `ok`, footer — pasted
    // into the transcript above the real (idle) composer.
    const tail = RETRY_429.slice(RETRY_429.search(ROW_429)).trimEnd();
    const composerAt = READY.search(/^─{10,}$/m);
    const quoted = `${READY.slice(0, composerAt)}● An old capture:\n${tail}\n  That was a quotation.\n✻ Worked for 3s · done 9:20 PM\n${READY.slice(composerAt)}`;
    expect(quoted.match(/attempt 3\/10/g)).toHaveLength(1);
    expect(busy.test(quoted)).toBe(false);
    expect(matched(quoted)).toEqual([]);
  });

  it("a tip row under a live row still counts as live; a non-hint indented row does not", () => {
    expect(busy.test(replaceRow(RETRY_429, "✻ 429 mock rate_limit_error · Retrying in 2s · attempt 3/10\n  ⎿  Tip: Use /btw to ask a quick side question"))).toBe(true);
    expect(busy.test(replaceRow(RETRY_429, "✻ 429 mock rate_limit_error · Retrying in 2s · attempt 3/10\n          That was a quotation."))).toBe(false);
  });

  it("the final rows are still recognised: exhausted 429 fails over, 529 notifies, the configured key is a config error", () => {
    expect(matched(EXHAUSTED_429)).toContain("rate_limit/failover");
    expect(matched(FINAL_529)).toEqual(["rate_limit/notify"]);
    expect(matched(REPEATED_529)).toEqual(["rate_limit/notify"]);
    expect(matched(EXHAUSTED_401)).toContain("config_error/notify");
    for (const pane of [EXHAUSTED_429, FINAL_529, REPEATED_529, EXHAUSTED_401]) expect(busy.test(pane)).toBe(false);
  });
});

describe("the native Bash permission prompt with a wrapped option (#1239, secondary)", () => {
  it("is recognised when option 2 wraps onto a second row (a long working directory)", () => {
    expect(BASH_WRAPPED).toMatch(/2\. Yes, and always allow access to \S+ from this\n {6}project/);
    expect(claudeBashPermissionActive(BASH_WRAPPED)).toBe(true);
    expect(claudeBashPermissionActive(BASH_WIDE)).toBe(true);
    const held = backend.getRuntimeDialogs().filter(d => d.isActive?.(BASH_WRAPPED));
    expect(held).toEqual([expect.objectContaining({ keys: [], holdOnly: true })]);
  });

  it("still needs exactly the four options and the footer last", () => {
    expect(claudeBashPermissionActive(BASH_WRAPPED.replace(/^ {3}4\. No$/m, ""))).toBe(false);
    expect(claudeBashPermissionActive(BASH_WRAPPED.replace(/^ {3}4\. No$/m, "   4. No\n   5. Maybe"))).toBe(false);
    expect(claudeBashPermissionActive(BASH_WRAPPED.replace(/^ Esc to cancel · Tab to amend$/m, " Esc to cancel · Tab to amend\nmore output"))).toBe(false);
    expect(claudeBashPermissionActive(BASH_WRAPPED.replace(/^ Esc to cancel · Tab to amend$/m, ""))).toBe(false);
    expect(claudeBashPermissionActive(BASH_WRAPPED.replace(/^ Esc to cancel · Tab to amend$/m, "   5. Something else"))).toBe(false);
    expect(claudeBashPermissionActive(BASH_WRAPPED.replace(/^ ❯ 1\. Yes$/m, " stray text\n ❯ 1. Yes"))).toBe(false);
    expect(claudeBashPermissionActive(BASH_WRAPPED.replace("from this\n      project", "from this\n      folder"))).toBe(false);
  });
});
