/** Real offline 1.4.23-R8977.1 captures (M-3290), checked against the committed 1.4.20-R8619.1 set (and 1.4.11's quit menu); see fixture SOURCES.md. (main: the model/effort switch is the dev branch's, M-3180.) */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseBackend, museApprovalRequestIdentity, museLocalWorkQuitActive, museSessionCwd } from "../src/backend/muse.js";
import { entryKind, isTurnKind } from "../src/backend/session-signals.js";

const dir = join(process.cwd(), "tests/fixtures/muse-1.4.23");
const old = join(process.cwd(), "tests/fixtures/muse-1.4.20");
const v11 = join(process.cwd(), "tests/fixtures/muse-1.4.11");
const read = (file: string, from = dir) => readFileSync(join(from, file), "utf8");
const pane = (name: string) => read(`${name}.pane.txt`);
const pane20 = (name: string) => read(`${name}.pane.txt`, old);
const backend = new MuseBackend("/tmp/agend-muse-1423-audit");
const dialogs = (p: string) => backend.getRuntimeDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
const errors = (p: string) => backend.getErrorPatterns().filter(e => e.pattern.test(p)).map(e => ({ type: e.type, action: e.action }));
const verdict = (p: string) => ({
  background: backend.backgroundWorkRunning(p), busy: backend.getBusyPattern().test(p), idle: backend.isPeriodicRedrawIdlePane(p),
  draft: backend.inputDraft(p)?.rows ?? null, dialogs: dialogs(p).map(d => d.description), errors: errors(p),
  quitMenu: museLocalWorkQuitActive(p), approval: museApprovalRequestIdentity(p) !== null,
});
const IDLE = { background: false, busy: false, idle: true, draft: [], dialogs: [], errors: [], quitMenu: false, approval: false };
const ABNORMAL = /warning: the previous run of this session ended abnormally around .+ \(no clean shutdown was\n\s+recorded\)\. It was resumed cleanly\./;

describe("Muse 1.4.23: the 1.4.20 surfaces, re-captured", () => {
  it.each(["echo-idle", "echo-done-later", "echo-resumed", "meta-idle", "meta-done", "prod-escalation-denied", "approval-escalated-after-esc", "approval-untrusted-after-1"])(
    "%s proves an empty idle composer (the precheck's \"Muse Code\" 541 → 165 is string tables: the header reads as before)", name => {
      expect(pane(name)).toContain("Muse Code 1.4.23");
      expect(backend.getReadyPattern().test(pane(name))).toBe(true);
      expect(verdict(pane(name))).toEqual(IDLE);
    });

  it("busy is busy; Escape restores the cancelled draft; /quit names the session; resume of an unknown id is recognised", () => {
    expect(verdict(pane("echo-busy"))).toMatchObject({ busy: true, idle: false });
    expect(verdict(pane("echo-after-escape"))).toMatchObject({ busy: false, idle: false, draft: ["cancel me"] });
    expect(pane("echo-quit")).toMatch(/To continue this session, run muse resume [a-f0-9-]{36}/);
    expect(backend.resumeMissingPattern().test(pane("resume-missing"))).toBe(true);
  });

  it("workspace trust is answered by the startup handler and blocks readiness; the logged-out menu blocks readiness without a key, held at runtime", () => {
    const trust = pane("first-run-trust-dialog");
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(trust)).map(d => d.keys)).toEqual([["1", "Enter"]]);
    expect(backend.getReadyPattern().test(trust)).toBe(false);
    const p = pane("logged-out");
    const found = backend.getStartupDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(d => d.keys.length === 0)).toBe(true);
    expect(dialogs(p).length).toBeGreaterThan(0);
    expect(dialogs(p).every(d => d.holdOnly === true && d.keys.length === 0 && d.blocksDelivery === true)).toBe(true);
  });

  it.each(["approval-escalated", "approval-untrusted-staged"])("%s is a held human permission request, never auto-approved (same identity as 1.4.20)", name => {
    const p = pane(name), found = dialogs(p);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ interactionKind: "permission", keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true });
    expect(museApprovalRequestIdentity(p)).not.toBeNull();
    expect(museApprovalRequestIdentity(p)).toBe(museApprovalRequestIdentity(pane20(name)));
    // The precheck's approval strings are the plugin API's reserved names, not new options on these prompts.
    for (const label of ["Yes, and don't ask again", "Yes, don't ask again this session"]) expect(p).not.toContain(label);
  });

  it("HTTP 429's retry row is a rate-limit failover; an injected 402 usage limit is a quota notification", () => {
    expect(verdict(pane("prod-rate-limited"))).toMatchObject({ busy: true, errors: [{ type: "rate_limit", action: "failover" }] });
    expect(pane("prod-usage-limit").split("\n")).toContain("◆ model failed: API error 402: Usage limit reached (usage_limit_reached)");
    expect(errors(pane("prod-usage-limit"))).toEqual([{ type: "quota", action: "notify" }]);
  });
});

describe("Muse 1.4.23: /quit with local work still running (the precheck's quit-hint count, first live capture since 1.4.11)", () => {
  it("the menu is held — never answered with Enter — on 1.4.23 as on 1.4.11; Down moves the cursor and it is still the menu", () => {
    for (const p of [pane("prod-quit-with-local-work"), pane("quit-menu-cursor2"), read("prod-quit-with-local-work.pane.txt", v11), read("quit-menu-cursor2.pane.txt", v11)]) {
      expect(museLocalWorkQuitActive(p)).toBe(true);
      const found = dialogs(p);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every(d => !d.keys.includes("Enter"))).toBe(true);
    }
    expect(pane("prod-quit-with-local-work")).toMatch(/⟩ 1\. Exit anyway\n\s+2\. Stay\n\n\s+Enter to confirm · Esc to cancel/);
    expect(pane("quit-menu-cursor2")).toMatch(/ 1\. Exit anyway\n\s*⟩ 2\. Stay/);
    expect(dialogs(pane("prod-quit-with-local-work")).map(d => d.description)).toEqual(dialogs(read("prod-quit-with-local-work.pane.txt", v11)).map(d => d.description));
  });
  it("before /quit the task runs in the background at an idle composer; after Escape the menu is gone and the task still runs", () => {
    expect(verdict(pane("prod-background-work"))).toMatchObject({ background: true, busy: false, idle: true, quitMenu: false, dialogs: [] });
    expect(verdict(pane("quit-menu-after-esc"))).toEqual(verdict(pane("prod-background-work")));
    expect(verdict(pane("prod-background-work"))).toEqual(verdict(read("prod-background-work.pane.txt", v11)));
  });
});

describe("Muse 1.4.23: a resume after the process was lost (resume_reconcile:orphaned_by_process_loss)", () => {
  it.each(["orphan-stream", "orphan-tool", "orphan-bg"])("%s: `resume <id>` lands on the same session at an empty idle composer, no dialog", name => {
    const p = pane(`${name}-resumed`);
    expect(p).toMatch(/resumed session [0-9a-f-]{36}/);
    expect(p).toMatch(ABNORMAL);
    expect(verdict(p)).toEqual(IDLE);
    expect(backend.resumeMissingPattern().test(p)).toBe(false);
    expect(verdict(p)).toEqual(verdict(pane20(`${name}-resumed`)));
  });
  it("the reconcile records in session.jsonl keep 1.4.20's shape and are read as turn evidence", () => {
    const records = (text: string) => text.trim().split("\n").map(l => JSON.parse(l) as Record<string, any>);
    const shape = (r: Record<string, any>) => ({ kind: entryKind(r), event: Object.keys(r.payload.event ?? {}).sort(), reason: r.payload.event?.reason });
    const now = records(read("orphan-tool-session.jsonl")), prev = records(read("orphan-tool-session.jsonl", old));
    expect(museSessionCwd(read("orphan-tool-session.jsonl"))).toBe("/home/u/work");
    expect(now.slice(1).every(r => isTurnKind("muse", entryKind(r)))).toBe(true);
    expect(now.slice(1).map(shape)).toEqual(prev.slice(1).map(shape));
  });
});

describe("Muse 1.4.23: every screen captured in both sets reads the same as on 1.4.20", () => {
  const both = readdirSync(dir).filter(f => f.endsWith(".pane.txt") && existsSync(join(old, f))).map(f => f.replace(/\.pane\.txt$/, ""));
  it("the two sets share the whole 1.4.20 capture list", () => { expect(both.length).toBe(readdirSync(old).filter(f => f.endsWith(".pane.txt")).length); });
  it.each(both)("%s", name => { expect(verdict(pane(name))).toEqual(verdict(pane20(name))); });
});
