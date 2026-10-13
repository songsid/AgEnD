/**
 * muse 1.4.6 audit (upstream CLI watch 2026-10-12, precheck MAJOR hard=1; ffb8104e): the screens AgEnD reads,
 * captured live from the 1.4.6 binary (tests/fixtures/muse-1.4.6/SOURCES.md), judged by the production MuseBackend.
 * The verdicts are the same as 1.4.4 on every surface AgEnD relies on. One known gap is pinned as it is today
 * (#1715, the escalated approval prompt with approval left on); two more are pinned as fixed:
 *  - the "Local work is still active" quit menu is recognised and cancelled deliberately (#1716);
 *  - a running background task reads as idle-for-delivery while the composer is free (#1717).
 * Each was captured on 1.4.4 with the same sequence (the compare-* pairs) and reads the same there. 1.4.6's new staged
 * prompt (--approval-mode untrusted) is a new surface that falls into the same gap as #1715. It has no 1.4.4
 * counterpart to compare.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseBackend, museDraftShows, museLoginScreenActive } from "../src/backend/muse.js";
import { unrecognisedPromptShape } from "../src/unrecognised-prompt.js";

const DIR = join(process.cwd(), "tests", "fixtures", "muse-1.4.6");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf8");
const b = new MuseBackend("/tmp/agend-muse-1.4.6-audit");
const startup = (p: string) => b.getStartupDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p))).map(d => d.description);
const runtime = (p: string) => b.getRuntimeDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p))).map(d => d.description);
const errors = (p: string) => b.getErrorPatterns().filter(e => { e.pattern.lastIndex = 0; return e.pattern.test(p); }).map(e => e.type);
const verdict = (p: string) => ({ ready: b.getReadyPattern().test(p), busy: b.getBusyPattern().test(p), idle: b.isPeriodicRedrawIdlePane(p),
  draft: b.inputDraft(p)?.rows ?? null, startup: startup(p), runtime: runtime(p), errors: errors(p) });

describe("muse 1.4.6: the screens AgEnD reads, as the production backend judges them", () => {
  it.each([
    ["echo-idle", { busy: false, idle: true, draft: [] as string[] }],
    ["echo-done", { busy: false, idle: true, draft: [] as string[] }],
    ["echo-resumed", { busy: false, idle: true, draft: [] as string[] }],
    ["echo-busy", { busy: true, idle: false, draft: [] as string[] }],
    ["echo-after-escape", { busy: false, idle: false, draft: ["cancel me"] }],
    // The meta provider with AgEnD's production flags: the status bar's new `· Launch overrides` part is still a footer.
    ["meta-idle", { busy: false, idle: true, draft: [] as string[] }],
    ["meta-done", { busy: false, idle: true, draft: [] as string[] }],
    // An escalation under --disable-approval is denied by muse itself: no prompt, the instance is simply idle again.
    ["prod-escalation-denied", { busy: false, idle: true, draft: [] as string[] }],
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

  it("first run without --trust-workspace: the trust dialog, answered by the startup handler (1, Enter)", () => {
    const p = pane("first-run-trust-dialog");
    expect(b.getStartupDialogs().filter(d => d.pattern.test(p)).map(d => d.keys)).toEqual([["1", "Enter"]]);
    expect(b.getReadyPattern().test(p)).toBe(false);
  });

  it("resume of an unknown session: the message the resume-missing proof reads (#1217)", () => {
    expect(b.resumeMissingPattern().test(pane("resume-missing"))).toBe(true);
  });

  it("an HTTP 429 from the model: muse's retry line is the rate_limit failover it always was", () => {
    expect(verdict(pane("prod-rate-limited"))).toMatchObject({ busy: true, idle: false, errors: ["rate_limit"] });
  });
});

describe("muse 1.4.6: known gap (as in 1.4.4, #1715) and gaps fixed since (#1716, #1717)", () => {
  it.each(["approval-escalated", "approval-untrusted-staged"])("%s: with approval left on, the prompt reads as busy and no dialog claims it", name => {
    const p = pane(name);
    expect(verdict(p)).toMatchObject({ busy: true, idle: false, startup: [], runtime: [], errors: [] });
    // The catch-all sees the numbered prompt, but the busy line is on the same screen, so it never counts.
    expect(unrecognisedPromptShape(p)?.question).toBe("Would you like to run the following command?");
  });

  it("after the approval is answered, the pane is idle again", () => {
    for (const name of ["approval-escalated-after-esc", "approval-untrusted-after-1"]) expect(b.isPeriodicRedrawIdlePane(pane(name)), name).toBe(true);
  });

  it.each([["approval-escalated"], ["background-work"], ["quit-with-local-work"], ["quit-dialog-ctrl-c-2"]])("%s: 1.4.6 reads exactly as 1.4.4 did", name => {
    expect(verdict(pane(`compare-${name}`))).toEqual(verdict(pane(`compare-1.4.4-${name}`)));
  });

  it("the escalated approval prompt: the same numbered shape on 1.4.4 (1.4.6 only adds the 'Change approval defaults' hint row)", () => {
    const shape = (p: string) => { const s = unrecognisedPromptShape(p); return s && { kind: s.kind, options: s.options, question: s.question }; };
    expect(shape(pane("compare-approval-escalated"))).toEqual(shape(pane("compare-1.4.4-approval-escalated")));
    expect(shape(pane("compare-1.4.4-approval-escalated"))).toEqual({ kind: "numbered", options: 2, question: "Would you like to run the following command?" });
    expect(verdict(pane("compare-1.4.4-approval-escalated"))).toMatchObject({ busy: true, idle: false, runtime: [] });
  });

  it("a running background task is idle-for-delivery (composer free, #1717); /quit stops at 'Local work is still active' (#1716)", () => {
    expect(verdict(pane("prod-background-work"))).toMatchObject({ busy: false, idle: true, draft: [] });
    const quit = pane("prod-quit-with-local-work");
    expect(quit).toMatch(/Local work is still active/);
    expect(verdict(quit)).toMatchObject({ idle: false, startup: [] });
    expect(verdict(quit).runtime).toEqual([expect.stringContaining("Local work is still active")]);
    expect(unrecognisedPromptShape(quit), "the terminals panel under it keeps it from being bottom-anchored").toBeNull();
  });
});
