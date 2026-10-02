import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";

/**
 * #1098 — codex 0.156+ writes the apostrophe in its usage-limit line as U+2019
 * ("You’ve hit your usage limit."); 0.153.4 wrote ASCII. AgEnD's pattern only
 * took ASCII, so no current codex was ever paused for an exhausted plan. Verified
 * in the 0.153.4 / 0.156.1 / 0.157.0 / 0.159.2 / 0.160.0 binaries and live on 0.159.2
 * and 0.160.0 (tests/fixtures/codex-0160-usage-limit-curly-apostrophe.pane.txt, a
 * real pane produced against a mock server returning HTTP 429 usage_limit_reached).
 *
 * The same audit found the "Model metadata for `<slug>` not found" pattern could
 * never match either: Codex quotes the slug with backticks, the pattern wanted
 * ASCII quotes (live: tests/fixtures/codex-0160-model-metadata-warning.pane.txt).
 */
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const pane = (n: string) => readFileSync(join(fixtures, `codex-${n}.pane.txt`), "utf8");
const REAL_CURLY = pane("0160-usage-limit-curly-apostrophe");
const REAL_METADATA = pane("0160-model-metadata-warning");

const backend = new CodexBackend("/tmp/agend-codex-1098");
const patterns = backend.getErrorPatterns();
const hits = (text: string) => patterns.filter(e => { e.pattern.lastIndex = 0; return e.pattern.test(text); }).map(e => `${e.type}/${e.action}`);

const CURLY = "■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:03 PM.";
const ASCII = CURLY.replace("’", "'");

describe("the usage-limit line pauses, whichever apostrophe codex writes", () => {
  it("the real 0.160.0 pane (curly) is recognised as a quota pause", () => {
    expect(REAL_CURLY).toContain("You’ve hit your usage limit");
    expect(hits(REAL_CURLY)).toContain("quota/pause");
  });

  it("curly (0.156+) and ASCII (0.153.4) both match, as do the model-specific and plain forms", () => {
    for (const line of [
      CURLY, ASCII,
      "■ You’ve hit your usage limit for GPT-6-Astra. Switch to another model now, or try again later.",
      "■ You've hit your usage limit for GPT-6-Astra. Switch to another model now, or try again later.",
      "YOU’VE HIT YOUR USAGE LIMIT.",
    ]) expect(hits(line), line.slice(0, 40)).toContain("quota/pause");
  });

  it("does not match near-misses (other apostrophes, other words)", () => {
    for (const line of [
      "You have hit your usage limit.",
      "Youve hit your usage limit.",
      "You’ve hit your rate limit.",
      "I think you’ve hit a wall with this approach",
    ]) expect(hits(line), line).not.toContain("quota/pause");
  });

  it("no codex error pattern spells a contraction with a bare ASCII apostrophe (it would miss the typographic one)", () => {
    // Codex prints U+2019 in "You’ve", "can’t", …; a literal `'` between two letters in a pattern is the bug.
    expect(patterns.filter(e => /[a-z]'[a-z]/i.test(e.pattern.source)).map(e => e.message)).toEqual([]);
  });
});

describe("the pause is raised by the daemon when the pane is not a live composer", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function makeDaemon() {
    const dir = mkdtempSync(join(tmpdir(), "agend-1098-")); dirs.push(dir);
    writeFileSync(join(dir, "window-id"), "@9");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("codex-1098", {
      working_directory: "/tmp", backend: "codex",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, dir, false, new CodexBackend(dir), undefined, { child: () => logger } as any) as any;
    const errors: Array<{ type: string; action: string; message: string }> = [];
    daemon.on("pty_error", (e: any) => errors.push(e));
    return { daemon, errors };
  }
  const evaluate = (p: string) => {
    const { daemon, errors } = makeDaemon();
    const b = daemon.backend as CodexBackend;
    daemon.evaluateErrorPatterns(p, b.getErrorPatterns(), b.getReadyPattern(), 1_000_000);
    return errors.map(e => `${e.type}/${e.action}`);
  };

  // The real pane's error line, without the composer that codex paints after it.
  const realUpToError = REAL_CURLY.split("\n").slice(0, REAL_CURLY.split("\n").findIndex(l => l.includes("credits or try again")) + 1).join("\n");

  it("curly and ASCII both raise quota/pause (before: curly raised nothing)", () => {
    expect(evaluate(realUpToError)).toContain("quota/pause");
    expect(evaluate(realUpToError.replace("’", "'"))).toContain("quota/pause");
    expect(evaluate(`${CURLY}\n• Working (1s • esc to interrupt)`)).toContain("quota/pause");
  });

  it("an ordinary pane never pauses", () => {
    expect(evaluate("› hello\n• ok\n  Worked for <1s\n› Ask Codex to do anything\n  Context 100% left")).toEqual([]);
  });

  // Found while fixing this: on the real pane shape — the error line followed by
  // the live composer + Context footer — the "stale Luna Reserve text" guard in
  // Daemon.evaluateErrorPatterns (codexLivePane) baselines the match, so even
  // with the pattern fixed nothing pauses there. The guard cannot tell a reserve
  // session that is running from an account that simply hit its limit. Tracked
  // separately: this change is the pattern only.
  it.todo("pauses on the real hit-limit pane shape (error line, then the live composer) — currently suppressed by the stale-reserve guard");
});

describe("the model-metadata fallback warning matches the text codex really prints", () => {
  it("the live 0.160.0 warning (backtick-quoted slug) is recognised", () => {
    expect(REAL_METADATA).toContain("Model metadata for `totally-unknown-model-xyz` not found. Defaulting to fallback metadata");
    expect(hits(REAL_METADATA)).toContain("model_error/notify");
  });

  it("every quote style around the slug works, and so does a hard wrap inside the sentence", () => {
    for (const q of [["`", "`"], ["'", "'"], ['"', '"'], ["‘", "’"], ["“", "”"]]) {
      const line = `Model metadata for ${q[0]}gpt-x${q[1]} not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`;
      expect(hits(line), line.slice(0, 30)).toContain("model_error/notify");
    }
    expect(hits("Model metadata for `gpt-x` not found.\nDefaulting to fallback metadata; this can degrade")).toContain("model_error/notify");
  });

  it("is not triggered by prose that merely mentions metadata", () => {
    expect(hits("The model metadata for gpt-x was not found in the catalog")).not.toContain("model_error/notify");
  });
});
