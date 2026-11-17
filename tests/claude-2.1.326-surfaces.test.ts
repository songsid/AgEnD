/**
 * Claude Code 2.1.326 audit (the daily upstream watch's MAJOR of 2026-11-17, hard=18; the host had already self-updated
 * to it). This file holds the two changes that broke AgEnD on the live fleet, against real 2.1.326 frames:
 *
 * 1. The resume-from-summary menu's third row is "Don't ask again" (2.1.286–2.1.325: "Don't ask me again"). The menu
 *    was then read as no menu at all: neither answered (Down, Enter → "Resume full session as-is") nor held, and the
 *    startup scan reported ready with the menu still up. Captured live with cold-resume/resume-menu.mts (AgEnD's real
 *    startup scan, the production launch with --continue, a backdated 180k-token session, the server flag
 *    tengu_gleaming_fair served by the rig's flag proxy): before the fix 2.1.325 PASS, 2.1.326 FAIL (ready, no key);
 *    after it all three cases PASS (2.1.325, 2.1.326 at 160 and 80 columns).
 * 2. The API-retry row is lower-case: `✻ 429 … · retrying in 4s · attempt 5/10` (was "Retrying in"), and reads
 *    `· retrying… · attempt n/m` once the wait has run out (the renderer's `b===0` branch). The busy pattern matched
 *    only "Retrying in", so a retrying turn could look idle. Frames from the audit rig (production launch, local mock):
 *    429/401/500 and the first attempts' generic "API error". The no-wait form never showed in 350 frames at 0.2 s
 *    (the row moves on within the tick), so its fixture is the real 429 frame with only the wait replaced by the
 *    renderer's "retrying…".
 *
 * Provenance: the "2.1.325 → 2.1.326" section of scripts/manual/claude-version-audit/README.md.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend, claudeResumeMenuState } from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.326-${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-2.1.326-fixture");
type Dialog = { pattern: RegExp; isActive?: (pane: string) => boolean; description: string; keys?: string[]; holdOnly?: boolean; blocksDelivery?: boolean };
const acting = (dialogs: Dialog[], p: string) => dialogs.filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p)));
/** The live retry entries (inProgress) that read a pane, with the notice each would send. */
const retrying = (p: string) => backend.getErrorPatterns().filter(e => e.inProgress).flatMap(e => {
  const m = p.match(e.pattern);
  return m ? [{ type: e.type, notice: e.formatMessage ? e.formatMessage(m) : e.message }] : [];
});

describe("Claude Code 2.1.326: the resume-from-summary menu (live capture)", () => {
  it("is a 2.1.326 capture with the new third row", () => {
    for (const name of ["resume-summary-menu", "resume-summary-menu-80"]) {
      expect(pane(name), name).toContain("Claude Code v2.1.326");
      expect(pane(name), name).toMatch(/^[ \t]*3\. Don't ask again[ \t]*$/m);
    }
  });

  it("is the active menu with the cursor on the summary default, at 160 and 80 columns", () => {
    for (const name of ["resume-summary-menu", "resume-summary-menu-80"]) {
      expect(claudeResumeMenuState(pane(name)), name).toEqual({ active: true, defaultCursor: true });
    }
  });

  it("both tables answer it the one way that keeps the history: Down, Enter, and hold delivery meanwhile", () => {
    for (const name of ["resume-summary-menu", "resume-summary-menu-80"]) {
      for (const [table, dialogs] of [["startup", backend.getStartupDialogs()], ["runtime", backend.getRuntimeDialogs()]] as const) {
        const first = acting(dialogs as Dialog[], pane(name))[0];
        expect(first?.description, `${table} ${name}`).toContain("select 'Resume full session as-is'");
        expect([first?.keys, first?.blocksDelivery], `${table} ${name}`).toEqual([["Down", "Enter"], true]);
      }
    }
  });

  it("the old third row still reads the same (a 2.1.325 host)", () => {
    const old = pane("resume-summary-menu").replace("3. Don't ask again", "3. Don't ask me again");
    expect(claudeResumeMenuState(old)).toEqual({ active: true, defaultCursor: true });
  });

  it("fail-safe: a third row reworded again is still the menu — held for a human, no key, delivery blocked", () => {
    const other = pane("resume-summary-menu").replace("3. Don't ask again", "3. Never show this again");
    expect(claudeResumeMenuState(other)).toEqual({ active: true, defaultCursor: false });
    for (const dialogs of [backend.getStartupDialogs(), backend.getRuntimeDialogs()]) {
      const first = acting(dialogs as Dialog[], other)[0];
      expect([first?.description, first?.keys, first?.holdOnly, first?.blocksDelivery]).toEqual([expect.stringContaining("unrecognised variant"), [], true, true]);
    }
  });
  it("…but a fourth row, or prose under the pair, is not the menu (a quoted capture above the composer)", () => {
    const quoted = pane("resume-summary-menu").replace("3. Don't ask again", "3. Don't ask again\n    4. Something else");
    expect(claudeResumeMenuState(quoted).active).toBe(false);
  });

  it("after Down, Enter: the full session, ready, no menu", () => {
    const p = pane("resume-summary-after-full");
    expect(claudeResumeMenuState(p).active).toBe(false);
    expect(p).toContain("BIG hello");
    expect(backend.getReadyPattern().test(p)).toBe(true);
  });
});

describe("Claude Code 2.1.326: the API-retry row (production launch, with the statusline)", () => {
  const rows = ["error-429-retrying-statusline", "error-401-retrying-statusline", "error-500-retrying-statusline", "error-api-retrying-statusline", "error-429-retrying-no-wait"];

  it("are 2.1.326 retry rows in the lower-case form", () => {
    for (const name of rows) expect(pane(name), name).toMatch(/^✻ .* · retrying(?: in \d+s|…) · attempt \d+\/10$/m);
  });

  it("each is busy: the row holds the spinner's slot", () => {
    for (const name of rows) expect(backend.getBusyPattern().test(pane(name)), name).toBe(true);
  });

  it("the status rows send their notices with the attempt; the generic first attempts send none", () => {
    expect(retrying(pane("error-429-retrying-statusline"))).toEqual([{ type: "rate_limit", notice: "Claude API returned 429 — Claude Code is retrying automatically (attempt 5/10)" }]);
    expect(retrying(pane("error-500-retrying-statusline"))).toEqual([{ type: "rate_limit", notice: "Claude API returned 500 — Claude Code is retrying automatically (attempt 5/10)" }]);
    expect(retrying(pane("error-401-retrying-statusline"))).toEqual([{ type: "config_error", notice: "Claude API returned 401 — Claude Code is retrying (attempt 5/10); check the credentials" }]);
    expect(retrying(pane("error-429-retrying-no-wait"))).toEqual([{ type: "rate_limit", notice: "Claude API returned 429 — Claude Code is retrying automatically (attempt 5/10)" }]);
    expect(retrying(pane("error-api-retrying-statusline"))).toEqual([]);
  });

  it("the older capitalised row still reads the same (a 2.1.325 host)", () => {
    const old = pane("error-429-retrying-statusline").replace("· retrying in 4s ·", "· Retrying in 4s ·");
    expect(backend.getBusyPattern().test(old)).toBe(true);
    expect(retrying(old)).toHaveLength(1);
  });

  it("a row whose wait is not a duration is not a retry", () => {
    const bad = pane("error-429-retrying-statusline").replace("· retrying in 4s ·", "· retrying in soon ·");
    expect(retrying(bad)).toEqual([]);
  });
});
