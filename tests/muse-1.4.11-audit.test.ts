/** Real offline 1.4.11-R6667.1 captures; see fixture SOURCES.md for scope. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseBackend, museApprovalRequestIdentity, museSessionCwd } from "../src/backend/muse.js";

const dir = join(process.cwd(), "tests/fixtures/muse-1.4.11");
const pane = (name: string) => readFileSync(join(dir, `${name}.pane.txt`), "utf8");
const backend = new MuseBackend("/tmp/agend-muse-1411-audit");
const dialogs = (p: string) => backend.getRuntimeDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
const errors = (p: string) => backend.getErrorPatterns().filter(e => e.pattern.test(p)).map(e => ({ type: e.type, action: e.action }));
const verdict = (p: string) => ({ background: backend.backgroundWorkRunning(p), busy: backend.getBusyPattern().test(p), idle: backend.isPeriodicRedrawIdlePane(p), draft: backend.inputDraft(p)?.rows ?? null, dialogs: dialogs(p).map(d => d.description), errors: errors(p) });

describe("Muse 1.4.11: actual ready, busy, cancel and resume surfaces", () => {
  it.each(["echo-idle", "echo-done", "echo-resumed", "meta-idle", "meta-done", "prod-escalation-denied", "prod-background-work", "prod-quit-after-esc"])("%s proves an empty idle composer", name => {
    expect(backend.getReadyPattern().test(pane(name))).toBe(true);
    expect(verdict(pane(name))).toMatchObject({ busy: false, idle: true, draft: [], dialogs: [], errors: [] });
  });
  it.each(["prod-background-work", "compare-1.4.10-prod-background-work"])("%s is idle with active local work, preventing automatic pause", name => {
    expect(backend.isPeriodicRedrawIdlePane(pane(name))).toBe(true);
    expect(backend.backgroundWorkRunning(pane(name))).toBe(true);
  });
  it("ordinary idle without background work remains eligible for automatic pause", () => {
    expect(backend.isPeriodicRedrawIdlePane(pane("echo-idle"))).toBe(true);
    expect(backend.backgroundWorkRunning(pane("echo-idle"))).toBe(false);
  });
  it("the prompt is visible while generating but cannot prove idle", () => {
    expect(backend.getReadyPattern().test(pane("echo-busy"))).toBe(true);
    expect(verdict(pane("echo-busy"))).toMatchObject({ busy: true, idle: false, draft: [] });
  });
  it("Escape restores the cancelled draft, so it is not an empty idle composer", () => {
    expect(verdict(pane("echo-after-escape"))).toMatchObject({ busy: false, idle: false, draft: ["cancel this audit turn"], errors: [] });
  });
  it("root options followed by resume still work and preserve the conversation", () => {
    expect(pane("echo-resumed")).toContain("resumed session");
    expect(pane("echo-resumed")).toContain("echo: echo audit turn");
    expect(pane("echo-quit")).toMatch(/To continue this session, run muse resume [a-f0-9-]+/);
    expect(backend.resumeMissingPattern().test(pane("resume-missing"))).toBe(true);
  });
  it.each(["session-route-facts.jsonl", "compare-1.4.10-session-route-facts.jsonl"])("the real %s still locates the session's workspace", name => {
    expect(museSessionCwd(readFileSync(join(dir, name), "utf8"))).toBe("/tmp/muse-audit/work");
  });
  it("workspace trust is answered only by the existing startup handler", () => {
    const p = pane("first-run-trust-dialog");
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(p)).map(d => d.keys)).toEqual([["1", "Enter"]]);
    expect(backend.getReadyPattern().test(p)).toBe(false);
  });
  it("the logged-out menu blocks readiness without sending a key", () => {
    const p = pane("offline-first-run");
    const found = backend.getStartupDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
    expect(found.length).toBeGreaterThan(0); expect(found.every(d => d.keys.length === 0)).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(p)).toBe(false);
  });
});

describe("Muse 1.4.11 hard finding: permission labels and production bypass", () => {
  it("production flags deny escalation without opening approval on either binary", () => {
    for (const name of ["prod-escalation-denied", "compare-1.4.10-prod-escalation-denied"]) {
      const p = pane(name);
      expect(p).toContain("unsandboxed execution requires human approval, but approval prompts are disabled");
      expect(dialogs(p)).toEqual([]); expect(backend.isPeriodicRedrawIdlePane(p)).toBe(true);
    }
  });
  it.each(["approval-escalated", "approval-escalated-cursor2", "approval-untrusted-staged", "approval-untrusted-cursor2"])("%s is a held human permission request, never auto-approved", name => {
    const p = pane(name); const found = dialogs(p);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ interactionKind: "permission", keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true });
    expect(museApprovalRequestIdentity(p)).toBe("echo harmless-audit");
    expect(backend.isPeriodicRedrawIdlePane(p)).toBe(false); expect(backend.inputDraft(p)).toBeNull();
  });
  it.each(["approval-escalated-after-esc", "approval-untrusted-after-esc"])("%s releases the held dialog", name => {
    expect(dialogs(pane(name))).toEqual([]); expect(backend.isPeriodicRedrawIdlePane(pane(name))).toBe(true);
  });
  it("both captured shapes have the old choices; no session-wide label is falsely claimed as captured", () => {
    expect(pane("approval-escalated")).toContain("1. Yes, proceed (y)");
    expect(pane("approval-untrusted-staged")).toContain("2. Always allow in this workspace: echo ... (p)");
    for (const name of ["approval-escalated", "approval-untrusted-staged"]) expect(pane(name)).not.toContain("Yes, don't ask again this session");
  });
});

describe("Muse 1.4.11 hard finding: rate-limit and quota errors", () => {
  it("HTTP 429's real retry row alone is classified, independent of user text", () => {
    const p = pane("prod-rate-limited");
    const row = p.split("\n").find(r => /^└ Meta Model API rate limited \(HTTP 429\) · retrying in \d+s · attempt \d+\/10$/.test(r));
    expect(row).toBeDefined(); expect(errors(row!)).toEqual([{ type: "rate_limit", action: "failover" }]);
    expect(verdict(p)).toMatchObject({ busy: true, idle: false, errors: [{ type: "rate_limit", action: "failover" }] });
    expect(p).not.toContain(".lock");
  });
  it("an injected quota response is a quota notification, not a rate-limit failover", () => {
    const p = pane("prod-usage-limit");
    const row = p.split("\n").find(r => r.startsWith("◆ model failed: API error 402:"));
    expect(row).toContain("Usage limit reached (usage_limit_reached)");
    expect(errors(row!)).toEqual([{ type: "quota", action: "notify" }]);
    expect(errors(p)).toEqual([{ type: "quota", action: "notify" }]);
  });
  it.each(["prod-quit-with-local-work", "quit-menu-cursor2"])("%s holds a delivery and is seen by the stop flow", name => {
    const p = pane(name); expect(backend.quitBlockedByDialog(p)).toBe(true);
    expect(dialogs(p)).toHaveLength(1); expect(dialogs(p)[0]).toMatchObject({ keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true });
    expect(backend.isPeriodicRedrawIdlePane(p)).toBe(false);
  });
});

it.each(["echo-idle", "echo-busy", "echo-done", "echo-after-escape", "echo-resumed", "prod-escalation-denied", "approval-escalated", "approval-untrusted-staged", "prod-rate-limited", "prod-usage-limit", "prod-background-work", "prod-quit-with-local-work"])("%s has the same detector verdict on 1.4.10 and 1.4.11", name => {
  expect(verdict(pane(name))).toEqual(verdict(pane(`compare-1.4.10-${name}`)));
});
