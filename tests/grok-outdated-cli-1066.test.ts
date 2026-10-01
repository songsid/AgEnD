/**
 * #1066: grok's server refuses an outdated CLI with HTTP 426, and AgEnD said
 * nothing. The line below is the one the user reported (grok CLI 1.0.5):
 * it needs a notice telling the operator to run `grok update` — failover and
 * pausing cannot fix a CLI version.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";
import { Daemon } from "../src/daemon.js";

const REPORTED = "Request failed (426) — Your Grok CLI version (1.0.5) is outdated. Please update to version 1.0.13 or later via `grok update` or the installation documentation.";
const grok = new GrokBackend("/tmp/agend-grok-1066");
const patterns = grok.getErrorPatterns();
const outdated = patterns.find(p => p.type === "outdated_cli")!;
const lastMatch = (pane: string) => [...pane.matchAll(new RegExp(outdated.pattern.source, outdated.pattern.flags + "g"))].at(-1);
const notice = (pane: string) => { const m = lastMatch(pane); return m ? outdated.formatMessage!(m) : null; };
/** Wrap a line at `width` columns, the way a narrow pane shows it. */
const wrap = (line: string, width: number) => line.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");

describe("grok: an outdated CLI (HTTP 426) gets a 'run grok update' notice (#1066)", () => {
  it("the reported line → notify, every time, naming both versions", () => {
    expect(outdated).toMatchObject({ action: "notify", skipCooldown: true });
    expect(notice(`some output\n${REPORTED}\n❯ `)).toBe("Grok CLI is outdated (1.0.5) — run `grok update` (needs 1.0.13 or later)");
  });

  it("still reads it when the pane wraps the line", () => {
    expect(notice(wrap(REPORTED, 80))).toBe("Grok CLI is outdated (1.0.5) — run `grok update` (needs 1.0.13 or later)");
    expect(notice(wrap(REPORTED, 37))).toContain("(1.0.5)");
  });

  it("the bare 426 refusal still says what to run", () => {
    expect(notice("Request failed (426) Upgrade Required")).toBe("Grok CLI is outdated — run `grok update`");
  });

  it("no other grok pattern claims the line (no failover, no pause)", () => {
    const hits = patterns.filter(p => p.pattern.test(REPORTED)).map(p => p.type);
    expect(hits).toEqual(["outdated_cli"]);
  });

  it("ordinary panes and the other grok errors are not it", () => {
    for (const pane of [
      "⠋ Thinking… 3.2s",
      "Turn cancelled by user",
      "Request failed (429) Too Many Requests",
      "Request failed (401) Unauthorized",
      "Error: insufficient credits",
      "  426 +    const port = 4260;",                 // a diff row numbered 426
      "Run grok update to get the newest features.",   // generic update prose
      "Please update to version 1.0.13 or later via grok update", // the tail alone
      "HTTP 426 is Upgrade Required.",
    ]) expect(lastMatch(pane), pane).toBeUndefined();
  });
});

describe("through the daemon's error monitor", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers(); });

  it("emits the formatted notice, and again on the next refusal inside the cooldown", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "agend-1066-")); dirs.push(dir);
    const backend = new GrokBackend(dir);
    const daemon = new Daemon("grok-worker", {
      working_directory: dir, backend: "grok", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, dir, false, backend as any, undefined, { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } as any) as any;
    let pane = "";
    daemon.tmux = { isWindowAlive: vi.fn(async () => true), capturePane: vi.fn(async () => pane) };
    const errors: any[] = [];
    daemon.on("pty_error", (e: any) => errors.push(e));
    daemon.startErrorMonitor();
    try {
      const prompt = "❯ ";
      pane = `❯ hello\n${REPORTED}\n${prompt}`;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000); // back at its prompt: recovered
      pane = `❯ hello\n${REPORTED}\n❯ again\n${REPORTED}\n${prompt}`;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(errors.map(e => [e.type, e.action, e.message])).toEqual([
        ["outdated_cli", "notify", "Grok CLI is outdated (1.0.5) — run `grok update` (needs 1.0.13 or later)"],
        ["outdated_cli", "notify", "Grok CLI is outdated (1.0.5) — run `grok update` (needs 1.0.13 or later)"],
      ]);
    } finally {
      daemon.freezeRuntimeMonitors();
    }
  });
});
