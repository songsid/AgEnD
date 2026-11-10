/** Real offline 1.4.15-R8339.1 captures, checked against the committed 1.4.14-R7309.1 set; see fixture SOURCES.md. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseBackend, museApprovalRequestIdentity, museSessionCwd } from "../src/backend/muse.js";
import { entryKind, isTurnKind } from "../src/backend/session-signals.js";

const dir = join(process.cwd(), "tests/fixtures/muse-1.4.15");
const old = join(process.cwd(), "tests/fixtures/muse-1.4.14");
const read = (file: string, from = dir) => readFileSync(join(from, file), "utf8");
const pane = (name: string) => read(`${name}.pane.txt`);
const pane14 = (name: string) => read(`${name}.pane.txt`, old);
const backend = new MuseBackend("/tmp/agend-muse-1415-audit");
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

describe("Muse 1.4.15: the 1.4.14 surfaces, re-captured", () => {
  it.each(["echo-idle", "echo-done-later", "echo-resumed", "meta-idle", "meta-done", "prod-escalation-denied", "approval-escalated-after-esc", "approval-untrusted-after-1"])(
    "%s proves an empty idle composer", name => {
      expect(pane(name)).toContain("Muse Code 1.4.15");
      expect(backend.getReadyPattern().test(pane(name))).toBe(true);
      expect(verdict(pane(name))).toEqual(IDLE);
    });

  it("busy is busy; Escape restores the cancelled draft; /quit names the session; resume of an unknown id is recognised", () => {
    expect(verdict(pane("echo-busy"))).toMatchObject({ busy: true, idle: false });
    expect(verdict(pane("echo-after-escape"))).toMatchObject({ busy: false, idle: false, draft: ["cancel me"] });
    expect(pane("echo-quit")).toMatch(/To continue this session, run muse resume [a-f0-9-]{36}/);
    expect(backend.resumeMissingPattern().test(pane("resume-missing"))).toBe(true);
  });

  it("workspace trust is answered by the startup handler and blocks readiness, as on 1.4.14", () => {
    const p = pane("first-run-trust-dialog");
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(p)).map(d => d.keys)).toEqual([["1", "Enter"]]);
    expect(backend.getReadyPattern().test(p)).toBe(false);
    const p13 = pane14("first-run-trust-dialog");
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(p13)).map(d => d.keys)).toEqual([["1", "Enter"]]);
  });

  it("the logged-out menu blocks readiness without sending a key, as on 1.4.14", () => {
    for (const p of [pane("logged-out"), pane14("logged-out")]) {
      const found = backend.getStartupDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every(d => d.keys.length === 0)).toBe(true);
      expect(backend.isPeriodicRedrawIdlePane(p)).toBe(false);
      // At runtime the same menu is a held human prompt: never answered, deliveries wait.
      expect(dialogs(p).length).toBeGreaterThan(0);
      expect(dialogs(p).every(d => d.holdOnly === true && d.keys.length === 0 && d.blocksDelivery === true)).toBe(true);
    }
  });

  it.each(["approval-escalated", "approval-untrusted-staged"])("%s is a held human permission request, never auto-approved (same identity as 1.4.14)", name => {
    const p = pane(name), found = dialogs(p);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ interactionKind: "permission", keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true });
    expect(museApprovalRequestIdentity(p)).not.toBeNull();
    expect(museApprovalRequestIdentity(p)).toBe(museApprovalRequestIdentity(pane14(name)));
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
    "%s has the same detector verdict on 1.4.14 and 1.4.15", name => {
      expect(verdict(pane(name))).toEqual(verdict(pane14(name)));
    });
});

describe("Muse 1.4.15: a resume after the process was lost (resume_reconcile:orphaned_by_process_loss)", () => {
  it.each(["orphan-stream", "orphan-tool", "orphan-bg"])("%s: `resume <id>` lands on the same session at an empty idle composer, no dialog", name => {
    const p = pane(`${name}-resumed`);
    expect(p).toMatch(/resumed session [0-9a-f-]{36}/);
    expect(p).toMatch(ABNORMAL);
    expect(backend.getReadyPattern().test(p)).toBe(true);
    expect(verdict(p)).toEqual(IDLE);
    expect(backend.resumeMissingPattern().test(p)).toBe(false);
    expect(backend.getStartupDialogs().filter(d => d.pattern.test(p))).toEqual([]);
    expect(verdict(p)).toEqual(verdict(pane14(`${name}-resumed`)));
  });

  it("the in-flight frames were busy (or running background work) before the process was lost, as on 1.4.14", () => {
    for (const name of ["orphan-stream-inflight", "orphan-tool-inflight", "orphan-bg-inflight"]) expect(verdict(pane(name))).toEqual(verdict(pane14(name)));
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

  it("the reconcile records in session.jsonl keep 1.4.14's shape and are read as turn evidence", () => {
    const records = (text: string) => text.trim().split("\n").map(l => JSON.parse(l) as Record<string, any>);
    const shape = (r: Record<string, any>) => ({ kind: entryKind(r), event: Object.keys(r.payload.event ?? {}).sort(), reason: r.payload.event?.reason });
    const now = records(read("orphan-tool-session.jsonl")), prev = records(read("orphan-tool-session.jsonl", old));
    expect(museSessionCwd(read("orphan-tool-session.jsonl"))).toBe("/home/u/work");
    expect(now.slice(1).every(r => isTurnKind("muse", entryKind(r)))).toBe(true);
    expect(now.slice(1).map(shape)).toEqual(prev.slice(1).map(shape));
  });
});

describe("Muse 1.4.15: the post-turn \"Double checking\" phase (already in 1.4.14)", () => {
  // The same echo turn captured at 4/6/10/15 s after the reply (echo-done is the 6 s frame of the main run): the phase
  // reads as busy while it is shown and the pane is idle once it ends.
  it("busy while \"◈ Double checking (Ns · esc to interrupt)\" is shown, an empty idle composer once it ends", () => {
    for (const name of ["echo-done", "echo-double-checking"]) {
      expect(pane(name)).toMatch(/◈ Double checking \(\d+s · esc to interrupt\)/);
      expect(verdict(pane(name))).toMatchObject({ busy: true, idle: false });
    }
    expect(pane("echo-done-later")).not.toContain("Double checking");
    expect(verdict(pane("echo-done-later"))).toEqual(IDLE);
  });
});

describe("Muse 1.4.15: the post-turn feature tip in the empty composer (#3588; the same on 1.4.14)", () => {
  // After a turn muse asks the model to pick one tip id; the mock answered side-chat / resume / effort, and muse drew that
  // tip in the empty composer. The same run on 1.4.14-R7309.1 draws the same text (tip-*-on-1.4.14).
  const CATALOG = [
    "Type @ to search and insert workspace file paths", "Start a message with ! to run a shell command yourself",
    "Paste an image with Ctrl+V — file paths and URLs work too", "Press Alt+V to dictate instead of typing",
    "Tab queues or steers while a run is active", "Press ? on an empty composer to see keyboard shortcuts",
    "Press Ctrl+O to expand collapsed tool output", "/side asks a quick question without touching this thread",
    "/fork branches the conversation from the latest point", "/goal pins a session objective with a progress bar",
    "/resume reopens a past session (--last for the latest)", "Ask to 'use a workflow' to fan out parallel agents on big tasks",
    "Say 'use a workflow' to fan out agents on big tasks", "Ask to monitor a running build or log and get pinged on changes",
    "/agent opens the subagent command center", "/tasks shows workflows, subagents and terminals in one place",
    "/loop 10m <prompt> schedules a recurring prompt", "Ctrl+B sends the selected task to the background queue",
    "/skills browses ready-made skills for repeatable procedures", "/plugins marketplace installs new commands and skills",
    "/effort adjusts reasoning depth vs speed", "/usage shows this session's token usage", "/export saves the conversation to a text file",
  ];

  it.each(["tip-side-chat", "tip-resume", "tip-effort", "tip-side-chat-on-1.4.14", "tip-resume-on-1.4.14", "tip-effort-on-1.4.14"])(
    "%s: the tip in the composer is an empty idle composer, not a draft", name => {
      const p = pane(name);
      expect(p).toMatch(/◆ mock reply ok\n+(?:─+\n)?❯ \S/);
      expect(verdict(p)).toEqual(IDLE);
    });

  it.each(CATALOG)("catalog tip %s is empty", tip => {
    expect(verdict(withComposer(pane("meta-done"), tip))).toEqual(IDLE);
  });

  it("a prefix of a tip, or a tip with more after it, is typed text", () => {
    expect(verdict(withComposer(pane("meta-done"), "/effort adjusts reasoning"))).toMatchObject({ idle: false, draft: ["/effort adjusts reasoning"] });
    expect(verdict(withComposer(pane("meta-done"), "/effort adjusts reasoning depth vs speed now"))).toMatchObject({ idle: false, draft: ["/effort adjusts reasoning depth vs speed now"] });
  });
});

describe("Muse 1.4.15: the escalated approval's third option (#3588)", () => {
  it("1.4.15 adds \"Always allow outside the sandbox\" between Yes and No; still the same held request as 1.4.14's two-option prompt", () => {
    const p = pane("approval-escalated");
    expect(p).toContain("2. Always allow outside the sandbox in this workspace: echo ... (p)");
    expect(p).toContain("3. No, and tell Muse Code what to do differently (esc)");
    expect(pane14("approval-escalated")).not.toContain("Always allow outside the sandbox");
    expect(museApprovalRequestIdentity(p)).toBe("echo hi");
  });

  it.each([
    ["the third row is not No", "3. No, and tell Muse Code what to do differently (esc)", "3. Never (esc)"],
    ["the second row is a different always-allow", "2. Always allow outside the sandbox in this workspace: echo ... (p)", "2. Always allow everything (p)"],
  ])("a near miss is not the prompt: %s", (_why, from, to) => {
    const p = pane("approval-escalated").replace(from, to);
    expect(p).not.toBe(pane("approval-escalated"));
    expect(dialogs(p)).toEqual([]);
    expect(museApprovalRequestIdentity(p)).toBeNull();
  });
});

describe("Muse 1.4.15: memory writes (the new \"Would you like to allow this memory write?\" prompt)", () => {
  // muse.add_memory / muse.edit_memory driven by the mock, every scope. Under AgEnD's production launch
  // (--disable-approval --trust-workspace: the permission profile's approval ceiling is allow_all) a memory write never
  // asks; with approval on (Auto-review) or --approval-mode untrusted the default profile does not ask either.
  it.each(["prod-memory-write", "prod-memory-project", "prod-memory-personal", "approval-memory-write", "approval-memory-project",
    "approval-memory-personal", "approval-memory-untrusted", "approval-memory-write-after-esc", "approval-memory-write-after-enter"])(
    "%s: the write is saved without a prompt and the pane settles at an empty idle composer", name => {
      const p = pane(name);
      expect(p).toMatch(/◆ Saved memory (?:project\/|personal\/)?notes\.md\n+◆ mock reply ok/);
      expect(p).not.toContain("Would you like to allow this memory write?");
      expect(verdict(p)).toEqual(IDLE);
    });

  it("a failed memory edit is a tool result, not an error AgEnD acts on", () => {
    const p = pane("prod-memory-edit");
    expect(p).toMatch(/◆ Edited memory notes\.md — failed\n+└ memory file not found/);
    expect(verdict(p)).toEqual(IDLE);
  });
});

describe("Muse 1.4.15: the strings new in this release (binary text)", () => {
  // Copied from the 1.4.15-R8339.1 binary. The memory-write prompt joins the approval family that 1.4.14 already had
  // (command / network access / file access / tool action); it is not reachable under AgEnD's launch (above). The
  // /name help text is slash-palette chrome. Neither is an error, a resume failure, or idle/busy text.
  const NEW = [
    "Would you like to allow this memory write?",
    "Name: Resume this session; address it in Peer messages.",
  ];
  it.each(NEW)("%s trips no error, dialog or resume-missing detector, even printed above an idle composer", text => {
    expect(errors(text)).toEqual([]);
    expect(backend.resumeMissingPattern().test(text)).toBe(false);
    const p = pane("meta-done").replace("◆ mock reply ok", `◆ mock reply ok\n  ${text}`);
    expect(p).not.toBe(pane("meta-done"));
    expect(verdict(p)).toEqual(IDLE);
  });
});
