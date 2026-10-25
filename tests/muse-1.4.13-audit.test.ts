/** Real offline 1.4.13-R6996.1 captures with 1.4.12-R6909.1 controls; see fixture SOURCES.md for scope. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseBackend, museApprovalRequestIdentity, museSessionCwd } from "../src/backend/muse.js";
import { entryKind, isTurnKind } from "../src/backend/session-signals.js";

const dir = join(process.cwd(), "tests/fixtures/muse-1.4.13");
const read = (file: string) => readFileSync(join(dir, file), "utf8");
const pane = (name: string) => read(`${name}.pane.txt`);
const backend = new MuseBackend("/tmp/agend-muse-1413-audit");
const dialogs = (p: string) => backend.getRuntimeDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
const errors = (p: string) => backend.getErrorPatterns().filter(e => e.pattern.test(p)).map(e => ({ type: e.type, action: e.action }));
const verdict = (p: string) => ({
  background: backend.backgroundWorkRunning(p), busy: backend.getBusyPattern().test(p), idle: backend.isPeriodicRedrawIdlePane(p),
  draft: backend.inputDraft(p)?.rows ?? null, dialogs: dialogs(p).map(d => d.description), errors: errors(p),
});
const IDLE = { background: false, busy: false, idle: true, draft: [], dialogs: [], errors: [] };

// The warning muse prints on `resume <id>` after the previous process died without a shutdown.
const ABNORMAL = /warning: the previous run of this session ended abnormally around .+ \(no clean shutdown was\n\s+recorded\)\. It was resumed cleanly\./;

describe("Muse 1.4.13: a resume after the process was lost (resume_reconcile:orphaned_by_process_loss)", () => {
  it.each([
    ["orphan-stream", "the model stream in flight (SIGKILL)"],
    ["orphan-tool", "a foreground tool running (SIGKILL)"],
    ["orphan-tool-hup", "a foreground tool running (tmux kill-server, SIGHUP)"],
    ["orphan-bg", "background work running (SIGKILL)"],
  ])("%s — %s: `resume <id>` lands on the same session at an empty idle composer, no dialog", name => {
    const p = pane(`${name}-resumed`);
    expect(p).toMatch(/resumed session [0-9a-f-]{36}/);
    expect(p).toMatch(ABNORMAL);
    expect(backend.getReadyPattern().test(p)).toBe(true);
    expect(verdict(p)).toEqual(IDLE);
    expect(backend.resumeMissingPattern().test(p)).toBe(false);
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(p))).toEqual([]);
  });

  it("the orphaned tool is closed out as unresolved, which is transcript text, not a prompt", () => {
    for (const name of ["orphan-tool-resumed", "orphan-tool-hup-resumed"]) {
      expect(pane(name)).toContain("◆ Review sleep 300 — unresolved\n└ manual reconciliation required");
      expect(pane(name)).toContain("◆ Interrupted · Report issues with /feedback");
    }
  });

  it("the in-flight frames were busy (or running background work) before the process was lost", () => {
    expect(verdict(pane("orphan-stream-inflight"))).toMatchObject({ busy: true, idle: false });
    expect(verdict(pane("orphan-tool-inflight"))).toMatchObject({ busy: true, idle: false });
    expect(verdict(pane("orphan-bg-inflight"))).toMatchObject({ background: true, busy: false, idle: true });
    expect(verdict(pane("orphan-bg-resumed")).background).toBe(false);
  });

  it("the next turn after the resume completes, and /quit names the same session id", () => {
    for (const name of ["orphan-stream-after-turn", "orphan-tool-after-turn"]) {
      expect(pane(name)).toMatch(/❯ carry on\n+◆ mock reply ok/);
      expect(verdict(pane(name))).toEqual(IDLE);
    }
    const id = pane("orphan-tool-resumed").match(/resumed session ([0-9a-f-]{36})/)![1];
    expect(pane("orphan-tool-quit")).toContain(`To continue this session, run muse resume ${id}`);
  });

  it("the reconcile records in session.jsonl are runtime.session run/task events, read as turn evidence; same shape as 1.4.12", () => {
    const records = (file: string) => read(file).trim().split("\n").map(l => JSON.parse(l) as Record<string, any>);
    const shape = (r: Record<string, any>) => ({ kind: entryKind(r), event: Object.keys(r.payload.event ?? {}).sort(), reason: r.payload.event?.reason });
    const now = records("orphan-tool-session.jsonl"), old = records("compare-1.4.12-orphan-tool-session.jsonl");
    expect(museSessionCwd(read("orphan-tool-session.jsonl"))).toBe("/home/u/work");
    const reconcile = now.slice(1);
    expect(reconcile.map(r => r.payload.event)).toEqual([
      expect.objectContaining({ kind: "terminal", terminal: "cancelled", reason: "resume_reconcile:orphaned_by_process_loss" }),
      expect.objectContaining({ kind: "cancelled", reason: "resume_reconcile:orphaned_by_process_loss" }),
      expect.objectContaining({ kind: "cancelled", reason: "resume_reconcile:orphaned_by_process_loss" }),
    ]);
    expect(reconcile.map(r => entryKind(r))).toEqual(["runtime.session:run", "runtime.session:task", "runtime.session:task"]);
    expect(reconcile.every(r => isTurnKind("muse", entryKind(r)))).toBe(true);
    expect(reconcile.map(shape)).toEqual(old.slice(1).map(shape));
  });

  it.each(["orphan-stream-resumed", "orphan-tool-resumed", "orphan-tool-hup-resumed", "orphan-bg-inflight", "orphan-bg-resumed"])(
    "%s has the same detector verdict on 1.4.12 and 1.4.13", name => {
      expect(verdict(pane(name))).toEqual(verdict(pane(`compare-1.4.12-${name}`)));
    });
});

describe("Muse 1.4.13: the 1.4.12 surfaces, re-captured", () => {
  it.each(["echo-idle", "echo-done", "echo-resumed", "meta-idle", "meta-done", "prod-escalation-denied", "approval-escalated-after-esc", "approval-untrusted-after-1"])(
    "%s proves an empty idle composer", name => {
      expect(backend.getReadyPattern().test(pane(name))).toBe(true);
      expect(verdict(pane(name))).toEqual(IDLE);
    });

  it("busy is busy; Escape restores the cancelled draft; resume of an unknown id is recognised", () => {
    expect(verdict(pane("echo-busy"))).toMatchObject({ busy: true, idle: false });
    expect(verdict(pane("echo-after-escape"))).toMatchObject({ busy: false, idle: false, draft: ["cancel me"] });
    expect(pane("echo-quit")).toMatch(/To continue this session, run muse resume [a-f0-9-]+/);
    expect(backend.resumeMissingPattern().test(pane("resume-missing"))).toBe(true);
  });

  it("workspace trust is the 1.4.12 dialog (byte-identical but for the path), answered by the startup handler", () => {
    const p = pane("first-run-trust-dialog");
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(p)).map(d => d.keys)).toEqual([["1", "Enter"]]);
    expect(backend.getReadyPattern().test(p)).toBe(false);
    const norm = (s: string) => s.replace(/^Workspace: .*$/m, "Workspace: W");
    expect(norm(p)).toBe(norm(readFileSync(join(process.cwd(), "tests/fixtures/muse-1.4.12/first-run-trust-dialog.pane.txt"), "utf8")));
  });

  it("the logged-out menu blocks readiness without sending a key; same as 1.4.12 but for the version", () => {
    const p = pane("logged-out");
    const found = backend.getStartupDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(d => d.keys.length === 0)).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(p)).toBe(false);
    expect(p.replace("1.4.13", "V")).toBe(pane("compare-1.4.12-logged-out").replace("1.4.12", "V"));
  });

  it.each(["approval-escalated", "approval-untrusted-staged"])("%s is a held human permission request, never auto-approved", name => {
    const p = pane(name), found = dialogs(p);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ interactionKind: "permission", keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true });
    expect(museApprovalRequestIdentity(p)).toBe(museApprovalRequestIdentity(pane(`compare-1.4.12-${name}`)));
    expect(museApprovalRequestIdentity(p)).not.toBeNull();
    expect(backend.isPeriodicRedrawIdlePane(p)).toBe(false);
    expect(p).not.toContain("Yes, don't ask again this session");
  });

  it("HTTP 429's retry row is a rate-limit failover; an injected 402 usage limit is a quota notification", () => {
    expect(verdict(pane("prod-rate-limited"))).toMatchObject({ busy: true, errors: [{ type: "rate_limit", action: "failover" }] });
    const row = pane("prod-usage-limit").split("\n").find(r => r.startsWith("◆ model failed: API error 402:"));
    expect(row).toBe("◆ model failed: API error 402: Usage limit reached (usage_limit_reached)");
    expect(errors(pane("prod-usage-limit"))).toEqual([{ type: "quota", action: "notify" }]);
  });

  it.each(["echo-idle", "echo-busy", "echo-after-escape", "prod-rate-limited", "prod-usage-limit", "approval-escalated", "approval-untrusted-staged"])(
    "%s has the same detector verdict on 1.4.12 and 1.4.13", name => {
      expect(verdict(pane(name))).toEqual(verdict(pane(`compare-1.4.12-${name}`)));
    });
});

describe("Muse 1.4.13: the new usage-limit turn notice (binary text; not reached offline)", () => {
  // Copied byte-for-byte from the 1.4.13-R6996.1 binary (absent from 1.4.12-R6909.1). Offline the mock could not make
  // muse print it, so its on-screen layout is unknown: every row of it is checked on its own as well as together.
  const NOTICE = "Usage limit reached\nThis turn stopped because your usage limit was reached.\nCheck /usage for details.\nSend a message to continue when usage is available.";

  it("is a quota notification wherever the title or the sentence lands, never a rate-limit failover or an auth pause", () => {
    expect(errors(NOTICE)).toEqual([{ type: "quota", action: "notify" }]);
    for (const row of NOTICE.split("\n").slice(0, 2)) expect(errors(`◆ ${row}`)).toEqual([{ type: "quota", action: "notify" }]);
    for (const row of NOTICE.split("\n").slice(2)) expect(errors(row)).toEqual([]);
  });

  it("printed above an idle composer, the composer still proves idle and opens no dialog", () => {
    const idle = pane("meta-done");
    const p = idle.replace("◆ mock reply ok", `◆ mock reply ok\n  ${NOTICE.split("\n").join("\n  ")}`);
    expect(p).not.toBe(idle);
    expect(verdict(p)).toEqual({ ...IDLE, errors: [{ type: "quota", action: "notify" }] });
  });
});
