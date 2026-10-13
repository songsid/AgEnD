/**
 * muse 1.4.7 audit (upstream CLI watch 2026-10-13, precheck MAJOR hard=2; ffb8104e): the screens AgEnD reads, captured
 * live from the 1.4.7 binary (tests/fixtures/muse-1.4.7/SOURCES.md), judged by the production MuseBackend.
 * Every surface reads as it did on 1.4.6 except one: 1.4.7 draws the selection cursor of the approval prompt (#1715)
 * and of the "Local work is still active" quit menu (#1716) as `⟩` instead of `›` / `❯`. Neither was recognised any
 * more — the approval prompt read as plain busy work, and the quit menu was neither held against a delivery's Enter
 * (which picks "Exit anyway") nor seen by the stop flow. Fixed here; each is pinned against its 1.4.6 capture.
 * The precheck's two hard items: the "usage limited" goal label (already on 1.4.6, the same quota notice), and the
 * session-wide approval option, which the two captured approval shapes (escalated, staged) do not carry. Its label and
 * `allow_local_prefix` occur the same number of times in the 1.4.6 and 1.4.7 binaries; the prompt that offers it was
 * not reached offline, so it is a scope limit of this audit, not a verdict on every approval surface.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseBackend, museApprovalRequestIdentity, museDraftShows, museLoginScreenActive } from "../src/backend/muse.js";
import { unrecognisedPromptShape } from "../src/unrecognised-prompt.js";

const DIR = join(process.cwd(), "tests", "fixtures", "muse-1.4.7");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf8");
const b = new MuseBackend("/tmp/agend-muse-1.4.7-audit");
const startup = (p: string) => b.getStartupDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p))).map(d => d.description);
const runtime = (p: string) => b.getRuntimeDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p))).map(d => d.description);
const errors = (p: string) => b.getErrorPatterns().filter(e => { e.pattern.lastIndex = 0; return e.pattern.test(p); }).map(e => e.type);
const verdict = (p: string) => ({ ready: b.getReadyPattern().test(p), busy: b.getBusyPattern().test(p), idle: b.isPeriodicRedrawIdlePane(p),
  draft: b.inputDraft(p)?.rows ?? null, startup: startup(p), runtime: runtime(p), errors: errors(p) });

describe("muse 1.4.7: the screens AgEnD reads, as the production backend judges them", () => {
  it.each([
    ["echo-idle", { busy: false, idle: true, draft: [] as string[] }],
    ["echo-done", { busy: false, idle: true, draft: [] as string[] }],
    ["echo-resumed", { busy: false, idle: true, draft: [] as string[] }],
    ["echo-busy", { busy: true, idle: false, draft: [] as string[] }],
    ["echo-after-escape", { busy: false, idle: false, draft: ["cancel me"] }],
    ["meta-idle", { busy: false, idle: true, draft: [] as string[] }],
    ["meta-done", { busy: false, idle: true, draft: [] as string[] }],
    // An escalation under --disable-approval is denied by muse itself: no prompt, the instance is simply idle again.
    ["prod-escalation-denied", { busy: false, idle: true, draft: [] as string[] }],
    ["approval-escalated-after-esc", { busy: false, idle: true, draft: [] as string[] }],
    ["approval-untrusted-after-1", { busy: false, idle: true, draft: [] as string[] }],
    // #1717: a running background task is idle-for-delivery while the composer is free; Escape on the quit menu
    // returns to it.
    ["prod-background-work", { busy: false, idle: true, draft: [] as string[] }],
    ["prod-quit-after-esc", { busy: false, idle: true, draft: [] as string[] }],
    // muse killed mid-tool, then resumed (what a crash respawn does): the unresolved call and the "ended abnormally"
    // warning are transcript; the composer is free. 1.4.6 paints the same rows.
    ["inflight-resumed", { busy: false, idle: true, draft: [] as string[] }],
  ])("%s: ready, busy/idle and the input draft", (name, want) => {
    expect(verdict(pane(name))).toEqual({ ready: true, ...want, startup: [], runtime: [], errors: [] });
  });

  it("a restored draft is recognised as AgEnD's own paste, so it is cleared before the next delivery (#829)", () => {
    const draft = b.inputDraft(pane("echo-after-escape"))!;
    expect(museDraftShows(draft.rows, draft.width, "cancel me")).toBe(true);
  });

  it("logged out: the login menu is held, never taken for the idle prompt", () => {
    const p = pane("offline-first-run");
    expect(museLoginScreenActive(p)).toBe(true);
    expect(b.isPeriodicRedrawIdlePane(p)).toBe(false);
    expect(runtime(p)).toEqual([expect.stringContaining("Muse login menu")]);
  });

  it("first run without --trust-workspace: the trust dialog (now with a `⟩` cursor), answered by the startup handler (1, Enter)", () => {
    const p = pane("first-run-trust-dialog");
    expect(p).toMatch(/^⟩ 1 {2}Trust and continue$/m);
    expect(b.getStartupDialogs().filter(d => d.pattern.test(p)).map(d => d.keys)).toEqual([["1", "Enter"]]);
    expect(b.getReadyPattern().test(p)).toBe(false);
  });

  it("resume of an unknown session: the message the resume-missing proof reads (#1217)", () => {
    expect(b.resumeMissingPattern().test(pane("resume-missing"))).toBe(true);
  });

  it("an HTTP 429 from the model: muse's retry line is the rate_limit failover it always was", () => {
    const p = pane("prod-rate-limited");
    expect(verdict(p)).toMatchObject({ busy: true, idle: false, errors: ["rate_limit"] });
    // The submitted text ("hit the rate limit") matches too; muse's own retry row must carry the verdict on its own.
    const retry = p.split("\n").filter(r => /^└ Meta Model API rate limited \(HTTP 429\) · retrying in \d+s · attempt \d+\/10$/.test(r));
    expect(retry).toHaveLength(1);
    expect(errors(retry[0]!)).toEqual(["rate_limit"]);
    expect(errors(p.replace(/^❯ hit the rate limit$/m, "❯ say something"))).toEqual(["rate_limit"]);
  });

  it("the /model picker is never the idle prompt (its `⟩` cursor is the same on 1.4.6)", () => {
    for (const name of ["model-picker", "compare-1.4.6-model-picker"]) {
      expect(verdict(pane(name)), name).toMatchObject({ busy: false, idle: false, runtime: [], errors: [] });
    }
  });
});

describe("muse 1.4.7: the `⟩` selection cursor on the approval prompt and the quit menu", () => {
  it.each([
    ["approval-escalated", "echo perm-check"],
    ["approval-untrusted-staged", "echo staged-check"],
  ])("%s: with approval left on, the prompt is a permission dialog awaiting a human (#1715)", (name, command) => {
    const p = pane(name);
    expect(p).toMatch(/^⟩ 1\. /m);
    expect(verdict(p)).toMatchObject({ busy: true, idle: false, startup: [], errors: [] });
    expect(verdict(p).runtime).toEqual([expect.stringContaining("approval prompt")]);
    expect(museApprovalRequestIdentity(p)).toBe(command);
    // The catch-all still sees the numbered shape; the daemon's known-dialog match wins, so it is never double-reported.
    expect(unrecognisedPromptShape(p)?.question).toBe("Would you like to run the following command?");
  });

  it.each(["prod-quit-with-local-work", "quit-dialog-ctrl-c-2"])("%s: /quit (or Ctrl-C twice) stops at 'Local work is still active', held and seen by the stop flow (#1716)", name => {
    const p = pane(name);
    expect(p).toMatch(/^ {2}⟩ 1\. Exit anyway$/m);
    expect(verdict(p)).toMatchObject({ idle: false, startup: [] });
    expect(verdict(p).runtime).toEqual([expect.stringContaining("Local work is still active")]);
    expect(b.quitBlockedByDialog(p)).toBe(true);
  });

  it.each([
    ["approval-escalated-cursor-2", "echo perm-check"],
    ["approval-untrusted-cursor-2", "echo staged-check"],
    ["approval-untrusted-cursor-3", "echo staged-check"],
  ])("%s: Down moves the `⟩` to a later option; still the same approval prompt", (name, command) => {
    const p = pane(name);
    expect(p).toMatch(/^⟩ [23]\. /m);
    expect(verdict(p).runtime).toEqual([expect.stringContaining("approval prompt")]);
    expect(museApprovalRequestIdentity(p)).toBe(command);
  });

  it("quit-menu-cursor-2: Down moves the `⟩` to Stay; still the held quit menu", () => {
    const p = pane("quit-menu-cursor-2");
    expect(p).toMatch(/^ {2}⟩ 2\. Stay$/m);
    expect(verdict(p).runtime).toEqual([expect.stringContaining("Local work is still active")]);
    expect(b.quitBlockedByDialog(p)).toBe(true);
  });

  it.each([
    ["approval-escalated"], ["approval-untrusted-staged"], ["prod-quit-with-local-work"], ["quit-dialog-ctrl-c-2"],
    ["inflight-resumed"], ["goal-usage-limited-resumed"],
  ])("%s: 1.4.7 reads exactly as 1.4.6 did", name => {
    // The quit menu's rows sit in the input box, so its cursor glyph is the one difference inside the draft.
    const glyphless = (p: string) => { const v = verdict(p); return { ...v, draft: v.draft?.map(r => r.replace(/^([ \t]*)[⟩❯›]/, "$1*")) ?? null }; };
    expect(glyphless(pane(name))).toEqual(glyphless(pane(`compare-1.4.6-${name}`)));
  });

  it("inside those prompt blocks the cursor glyph is the only change: 1.4.6 drew `›` on the approval prompt and `❯` on the quit menu", () => {
    expect(pane("compare-1.4.6-approval-escalated")).toMatch(/^› 1\. Yes, proceed \(y\)$/m);
    expect(pane("compare-1.4.6-approval-untrusted-staged")).toMatch(/^› 1\. Allow this stage once \(y\)$/m);
    expect(pane("compare-1.4.6-prod-quit-with-local-work")).toMatch(/^ {2}❯ 1\. Exit anyway$/m);
    const shape = (p: string) => { const s = unrecognisedPromptShape(p); return s && { kind: s.kind, options: s.options, question: s.question }; };
    expect(shape(pane("approval-escalated"))).toEqual(shape(pane("compare-1.4.6-approval-escalated")));
    expect(shape(pane("approval-untrusted-staged"))).toEqual({ kind: "numbered", options: 3, question: "Would you like to run the following command?" });
  });
});

describe("muse 1.4.7: the precheck's hard items", () => {
  it("a goal paused by a usage limit: `Goal (usage limited · …)` on the status bar, the same quota notice as on 1.4.6", () => {
    // The label is muse's own goal state (usage_limited), shown only while the goal is held by a usage limit — the
    // incident the quota notice reports. 1.4.6 paints the same label; nothing new to scope out.
    for (const name of ["goal-usage-limited-resumed", "compare-1.4.6-goal-usage-limited-resumed"]) {
      const p = pane(name);
      expect(p, name).toMatch(/Goal \(usage limited · \d+s\) 0%/);
      expect(verdict(p), name).toMatchObject({ ready: true, busy: false, idle: true, runtime: [], errors: ["quota"] });
    }
  });

  it("the session-wide approval option is not on the two captured approval shapes: two options escalated, three staged", () => {
    for (const name of ["approval-escalated", "approval-untrusted-staged"]) expect(pane(name), name).not.toMatch(/don't ask again/);
  });
});
