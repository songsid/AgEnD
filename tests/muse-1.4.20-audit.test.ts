/** Real offline 1.4.20-R8619.1 captures (M-3113), checked against the committed 1.4.15-R8339.1 set and a same-run 1.4.18-R8587.1 capture; see fixture SOURCES.md. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseBackend, museApprovalRequestIdentity, museSessionCwd } from "../src/backend/muse.js";
import { entryKind, isTurnKind } from "../src/backend/session-signals.js";

const dir = join(process.cwd(), "tests/fixtures/muse-1.4.20");
const old = join(process.cwd(), "tests/fixtures/muse-1.4.15");
const read = (file: string, from = dir) => readFileSync(join(from, file), "utf8");
const pane = (name: string) => read(`${name}.pane.txt`);
const pane15 = (name: string) => read(`${name}.pane.txt`, old);
const backend = new MuseBackend("/tmp/agend-muse-1420-audit");
const dialogs = (p: string) => backend.getRuntimeDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
const errors = (p: string) => backend.getErrorPatterns().filter(e => e.pattern.test(p)).map(e => ({ type: e.type, action: e.action }));
const verdict = (p: string) => ({
  background: backend.backgroundWorkRunning(p), busy: backend.getBusyPattern().test(p), idle: backend.isPeriodicRedrawIdlePane(p),
  draft: backend.inputDraft(p)?.rows ?? null, dialogs: dialogs(p).map(d => d.description), errors: errors(p),
});
const IDLE = { background: false, busy: false, idle: true, draft: [], dialogs: [], errors: [] };
const ABNORMAL = /warning: the previous run of this session ended abnormally around .+ \(no clean shutdown was\n\s+recorded\)\. It was resumed cleanly\./;
function withComposer(idle: string, text: string): string {
  const lines = idle.split("\n");
  const i = lines.findIndex(l => l === "❯");
  if (i < 0) throw new Error("idle fixture has no empty prompt");
  lines[i] = text === "" ? "❯" : `❯ ${text}`;
  return lines.join("\n");
}

describe("Muse 1.4.20: the 1.4.15 surfaces, re-captured", () => {
  it.each(["echo-idle", "echo-done-later", "echo-resumed", "meta-idle", "meta-done", "prod-escalation-denied", "approval-escalated-after-esc", "approval-untrusted-after-1"])(
    "%s proves an empty idle composer", name => {
      expect(pane(name)).toContain("Muse Code 1.4.20");
      expect(backend.getReadyPattern().test(pane(name))).toBe(true);
      expect(verdict(pane(name))).toEqual(IDLE);
    });

  it("busy is busy; Escape restores the cancelled draft; /quit names the session; resume of an unknown id is recognised", () => {
    expect(verdict(pane("echo-busy"))).toMatchObject({ busy: true, idle: false });
    expect(verdict(pane("echo-after-escape"))).toMatchObject({ busy: false, idle: false, draft: ["cancel me"] });
    expect(pane("echo-quit")).toMatch(/To continue this session, run muse resume [a-f0-9-]{36}/);
    expect(backend.resumeMissingPattern().test(pane("resume-missing"))).toBe(true);
  });

  it("workspace trust is answered by the startup handler and blocks readiness, as on 1.4.15", () => {
    const p = pane("first-run-trust-dialog");
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(p)).map(d => d.keys)).toEqual([["1", "Enter"]]);
    expect(backend.getReadyPattern().test(p)).toBe(false);
    const p15 = pane15("first-run-trust-dialog");
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(p15)).map(d => d.keys)).toEqual([["1", "Enter"]]);
  });

  it("the logged-out menu blocks readiness without sending a key, as on 1.4.15", () => {
    for (const p of [pane("logged-out"), pane15("logged-out")]) {
      const found = backend.getStartupDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every(d => d.keys.length === 0)).toBe(true);
      expect(backend.isPeriodicRedrawIdlePane(p)).toBe(false);
      // At runtime the same menu is a held human prompt: never answered, deliveries wait.
      expect(dialogs(p).length).toBeGreaterThan(0);
      expect(dialogs(p).every(d => d.holdOnly === true && d.keys.length === 0 && d.blocksDelivery === true)).toBe(true);
    }
  });

  it.each(["approval-escalated", "approval-untrusted-staged"])("%s is a held human permission request, never auto-approved (same identity as 1.4.15)", name => {
    const p = pane(name), found = dialogs(p);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ interactionKind: "permission", keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true });
    expect(museApprovalRequestIdentity(p)).not.toBeNull();
    expect(museApprovalRequestIdentity(p)).toBe(museApprovalRequestIdentity(pane15(name)));
    expect(backend.isPeriodicRedrawIdlePane(p)).toBe(false);
    // The precheck's "new" approval strings: the escalated prompt still offers only "Yes, proceed" and "No".
    expect(p).not.toContain("Yes, don't ask again this session");
  });

  it("HTTP 429's retry row is a rate-limit failover; an injected 402 usage limit is a quota notification", () => {
    expect(verdict(pane("prod-rate-limited"))).toMatchObject({ busy: true, errors: [{ type: "rate_limit", action: "failover" }] });
    expect(pane("prod-usage-limit").split("\n")).toContain("◆ model failed: API error 402: Usage limit reached (usage_limit_reached)");
    expect(errors(pane("prod-usage-limit"))).toEqual([{ type: "quota", action: "notify" }]);
  });

  it.each(["echo-idle", "echo-busy", "echo-after-escape", "meta-idle", "meta-done", "prod-escalation-denied", "prod-rate-limited", "prod-usage-limit",
    "approval-escalated", "approval-escalated-after-esc", "approval-untrusted-staged", "approval-untrusted-after-1", "logged-out", "first-run-trust-dialog"])(
    "%s has the same detector verdict on 1.4.15 and 1.4.20", name => {
      expect(verdict(pane(name))).toEqual(verdict(pane15(name)));
    });
});

describe("Muse 1.4.20: a resume after the process was lost (resume_reconcile:orphaned_by_process_loss)", () => {
  it.each(["orphan-stream", "orphan-tool", "orphan-bg"])("%s: `resume <id>` lands on the same session at an empty idle composer, no dialog", name => {
    const p = pane(`${name}-resumed`);
    expect(p).toMatch(/resumed session [0-9a-f-]{36}/);
    expect(p).toMatch(ABNORMAL);
    expect(backend.getReadyPattern().test(p)).toBe(true);
    expect(verdict(p)).toEqual(IDLE);
    expect(backend.resumeMissingPattern().test(p)).toBe(false);
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(p))).toEqual([]);
    expect(verdict(p)).toEqual(verdict(pane15(`${name}-resumed`)));
  });

  it("the in-flight frames were busy (or running background work) before the process was lost, as on 1.4.15", () => {
    for (const name of ["orphan-stream-inflight", "orphan-tool-inflight", "orphan-bg-inflight"]) expect(verdict(pane(name))).toEqual(verdict(pane15(name)));
    expect(verdict(pane("orphan-stream-inflight"))).toMatchObject({ busy: true, idle: false });
    expect(verdict(pane("orphan-bg-inflight"))).toMatchObject({ background: true, busy: false, idle: true });
  });

  it("the next turn after the resume completes, and /quit names the same session id", () => {
    for (const name of ["orphan-stream-after-turn", "orphan-tool-after-turn"]) {
      expect(pane(name)).toMatch(/❯ carry on\n+◆ mock reply ok/);
      expect(verdict(pane(name))).toEqual(IDLE);
    }
    const id = pane("orphan-tool-resumed").match(/resumed session ([0-9a-f-]{36})/)![1];
    expect(pane("orphan-tool-quit")).toContain(`To continue this session, run muse resume ${id}`);
  });

  it("the reconcile records in session.jsonl keep 1.4.15's shape and are read as turn evidence", () => {
    const records = (text: string) => text.trim().split("\n").map(l => JSON.parse(l) as Record<string, any>);
    const shape = (r: Record<string, any>) => ({ kind: entryKind(r), event: Object.keys(r.payload.event ?? {}).sort(), reason: r.payload.event?.reason });
    const now = records(read("orphan-tool-session.jsonl")), prev = records(read("orphan-tool-session.jsonl", old));
    expect(museSessionCwd(read("orphan-tool-session.jsonl"))).toBe("/home/u/work");
    expect(now.slice(1).every(r => isTurnKind("muse", entryKind(r)))).toBe(true);
    expect(now.slice(1).map(shape)).toEqual(prev.slice(1).map(shape));
  });
});

describe("Muse 1.4.20: every screen captured in both sets reads the same as on 1.4.15", () => {
  const both = readdirSync(dir).filter(f => f.endsWith(".pane.txt") && existsSync(join(old, f))).map(f => f.replace(/\.pane\.txt$/, ""));
  it("the two sets share the whole capture list", () => { expect(both.length).toBeGreaterThanOrEqual(40); });
  it.each(both)("%s", name => { expect(verdict(pane(name))).toEqual(verdict(pane15(name))); });
});
