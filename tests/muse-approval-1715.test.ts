/**
 * #1715: with `skip_permissions: false` muse's approval prompt is an
 * interaction that needs a human (awaiting_input, permission kind) — never
 * auto-answered. Real 1.4.6 + 1.4.4 captures; stubbed backend/tmux for the
 * daemon path; no CLI, tmux or fleet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const hooks = vi.hoisted(() => ({
  forbidden: vi.fn((..._args: unknown[]): never => { throw new Error("Forbidden host IO in #1715 sandbox"); }),
  http: null as null | ((req: any, res: any) => void),
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  exec: hooks.forbidden, execFile: hooks.forbidden, execSync: hooks.forbidden, execFileSync: hooks.forbidden,
  spawn: hooks.forbidden, spawnSync: hooks.forbidden, fork: hooks.forbidden,
}));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(),
  createServer: hooks.forbidden, createConnection: hooks.forbidden, connect: hooks.forbidden,
}));
vi.mock("node:http", async original => ({ ...await original<typeof import("node:http")>(),
  createServer: (handler: (req: any, res: any) => void) => {
    hooks.http = handler; return { on: vi.fn(), listen: vi.fn() };
  },
}));
vi.mock("../src/backend/factory.js", () => ({ createBackend: hooks.forbidden }));
vi.mock("../src/topic-commands.js", async original => ({ ...await original<typeof import("../src/topic-commands.js")>(),
  resolveInstanceContext: () => ({ context: null, tokenRatio: null }),
}));
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
vi.mock("../src/logger.js", () => ({ createLogger: () => logger, rotateLogIfNeeded: hooks.forbidden, rotateLogIfNeededAsync: hooks.forbidden }));

import { Daemon, PaneStateMachine } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { MuseBackend, museApprovalPromptActive, museApprovalRequestIdentity } from "../src/backend/muse.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { presentationState } from "../src/interaction-observation.js";
import { setLocale } from "../src/locale.js";

const DIR = join(process.cwd(), "tests", "fixtures", "muse-1.4.6");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf8");
const ESCALATED = pane("approval-escalated");
const STAGED = pane("approval-untrusted-staged");
// A quoting draft, built from its paste text the way the CLI renders it
// (`❯ first` + two-space continuations), so inputDraftShows binds it.
const QUOTE_PASTE = [
  "Please review this capture:",
  "Would you like to run the following command?",
  "$ echo quoted",
  "› 1. Yes, proceed (y)",
  "2. No, and tell Muse Code what to do differently (esc)",
  "Change approval defaults in /permissions",
];
const quotePane = () => pane("echo-after-escape").trimEnd().replace(
  "❯ cancel me", [`❯ ${QUOTE_PASTE[0]}`, ...QUOTE_PASTE.slice(1).map(r => `  ${r}`)].join("\n")) + "\n";

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeEach(() => {
  hooks.forbidden.mockClear(); hooks.http = null;
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(1_000_000); setLocale("en");
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe("#1715: the 1.4.6 approval prompt is recognised whole", () => {
  it.each([
    ["escalated two-option", "approval-escalated", "echo perm-check"],
    ["untrusted staged three-option", "approval-untrusted-staged", "echo hi"],
    ["1.4.6 compare", "compare-approval-escalated", "echo perm-check"],
    ["1.4.4 compare", "compare-1.4.4-approval-escalated", "echo perm-check"],
  ])("%s: live capture matches with its command as identity", (_label, name, command) => {
    const p = pane(name);
    expect(museApprovalPromptActive(p)).toBe(true);
    expect(museApprovalRequestIdentity(p)).toBe(command);
  });

  it.each([
    ["answered with esc", "approval-escalated-after-esc"],
    ["answered with 1", "approval-untrusted-after-1"],
    ["prod skip_permissions denial (no prompt)", "prod-escalation-denied"],
    ["ordinary idle", "echo-idle"],
    ["busy turn", "echo-busy"],
    ["header without options", pane("approval-escalated").replace(/› 1\. Yes, proceed \(y\)\n  2\. No.*\(esc\)/, "")],
    ["swapped options", pane("approval-escalated").replace("1. Yes, proceed (y)", "1. No, and tell Muse Code what to do differently (esc)")],
    ["extra fourth option", pane("approval-untrusted-staged").replace("  3. Abort the entire command (esc)", "  3. Abort the entire command (esc)\n  4. Maybe later")],
    ["missing command row", pane("approval-escalated").replace("  $ echo perm-check\n", "")],
    ["quoted above a free composer", `${pane("approval-escalated")}\n${pane("echo-idle")}`],
  ])("rejects %s", (_label, nameOrPane) => {
    const p = nameOrPane.includes("\n") ? nameOrPane : pane(nameOrPane);
    expect(museApprovalPromptActive(p)).toBe(false);
  });

  it("a populated composer quoting the prompt is draft content, not the live block (#1715 r2-1)", () => {
    // Prism r2 group 1: echo-after-escape whose draft quotes the complete
    // approval menu. The ❯ line holds text, so no prompt text is live chrome —
    // this must not block #829 clearing its own restored paste.
    const p = quotePane();
    const backend = new MuseBackend("/tmp/agend-muse-1715");
    const draft = backend.inputDraft(p)!;
    expect(draft.rows[0]).toBe("Please review this capture:");
    expect(backend.inputDraftShows(draft, QUOTE_PASTE.join("\n"))).toBe(true);
    expect(museApprovalPromptActive(p)).toBe(false);
  });

  it("a quote starting with a blank first row is still draft content (#1715 r3)", () => {
    // Prism r3: the restored paste begins with a newline, so the ❯ row is
    // empty — but it is still a readable, owned composer, not the live block
    // (which carries no ❯ row at all).
    const paste = `\n${QUOTE_PASTE.join("\n")}`;
    const p = pane("echo-after-escape").trimEnd().replace(
      "❯ cancel me", [`❯${paste.split("\n")[0]}`, ...paste.split("\n").slice(1).map(r => `  ${r}`)].join("\n")) + "\n";
    const backend = new MuseBackend("/tmp/agend-muse-1715");
    const draft = backend.inputDraft(p)!;
    expect(draft.rows[0]).toBe("");
    expect(backend.inputDraftShows(draft, paste)).toBe(true);
    expect(museApprovalPromptActive(p)).toBe(false);
  });

  it("the identity comes from the live block, never scrollback (#1715 r2-2)", () => {
    // Prism r2 group 2: a complete quoted menu in scrollback before the
    // untouched live pane. Active via the live block, identity is the live
    // command — the stale quote must not lend its command to this request.
    const stale = [
      "Would you like to run the following command?",
      "  $ echo old-quoted",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Muse Code what to do differently (esc)",
      "Change approval defaults in /permissions",
      "",
    ].join("\n");
    const p = `${stale}\n${ESCALATED}`;
    expect(museApprovalPromptActive(p)).toBe(true);
    expect(museApprovalRequestIdentity(p)).toBe("echo perm-check");
  });

  it("the dialog entry holds without keys and names permission", () => {
    const backend = new MuseBackend("/tmp/agend-muse-1715");
    const dialogs = backend.getRuntimeDialogs();
    const hits = dialogs.filter(d => d.isActive ? d.isActive(ESCALATED) : d.pattern.test(ESCALATED));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true, interactionKind: "permission" });
    // The identity is the command row, not the pane: the `Calling tools`
    // timer redraws every second, and a whole-pane hash would never confirm.
    expect(hits[0]?.requestIdentity?.(ESCALATED)).toBe("echo perm-check");
    expect(hits[0]?.requestIdentity?.(STAGED)).toBe("echo hi");
    expect(museApprovalRequestIdentity(ESCALATED.replace("(9s ·", "(10s ·"))).toBe("echo perm-check");
    const staged = dialogs.filter(d => d.isActive ? d.isActive(STAGED) : d.pattern.test(STAGED));
    expect(staged).toHaveLength(1);
    expect(staged[0]).toBe(hits[0]);
  });
});

// --- daemon path: awaiting_input, one permission Needs-you, no keys, no #1691 ---

function harness(paneText: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1715-")); dirs.push(dir);
  const dialogs = MuseBackend.prototype.getRuntimeDialogs.call({} as any);
  const backend = {
    binaryName: "muse",
    getRuntimeDialogs: () => dialogs, getErrorPatterns: () => [],
    // Intentionally broad: an option cursor would look ready to the bare machine.
    getReadyPattern: () => /^(?:READY|[ \t]*❯|[ \t]*›)/m,
    getBusyPattern: () => /Calling tools \(/, getCancelKey: () => "Escape",
    cleanup: hooks.forbidden, buildCommand: hooks.forbidden,
  } as any;
  const d = new Daemon("worker", { working_directory: dir, backend: "muse", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, false, backend, undefined, logger as any) as any;
  const screen = { pane: paneText, error: false };
  d.tmux = { capturePane: vi.fn(async () => { if (screen.error) throw new Error("capture failed"); return screen.pane; }),
    isWindowAlive: vi.fn(async () => true), getWindowId: () => "@sandbox",
    sendSpecialKey: hooks.forbidden, sendKeys: hooks.forbidden, pasteText: hooks.forbidden, pasteBuffer: hooks.forbidden,
    createWindow: hooks.forbidden, killWindow: hooks.forbidden,
  };
  d.processStatus = "running";
  d.instanceStateMonitorActive = true;
  d.instanceStateReadyPattern = backend.getReadyPattern();
  d.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), 600_000, Date.now(), backend.getBusyPattern());
  d.instanceStateMachine.recordOutput(); d.instanceState = "working";
  d.pendingWork.recordInbound(Date.now());
  d.maybeProxyReplyOnTurnEnd = vi.fn(); d.restart = hooks.forbidden; d.trySpawn = hooks.forbidden; d.pause = hooks.forbidden;
  d.hangDetector = new EventEmitter();
  vi.spyOn(d.hangDetector, "emit");
  const fm = new FleetManager(dir) as any;
  fm.getInstanceStatus = () => "running";
  fm.logger = logger; fm.fleetConfig = { instances: { worker: { working_directory: dir, backend: "muse" } }, defaults: {} };
  fm.lifecycle.daemons.set("worker", d);
  vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(false);
  fm.lifecycle.start = hooks.forbidden; fm.lifecycle.restart = hooks.forbidden;
  fm.resolveInstanceModel = () => ({ model: "test", display: "test", source: "instance" });
  fm.effortStrategyFor = () => "unsupported"; fm.resolveInstanceEffort = () => ({ effort: null, source: "unset" });
  fm.cacheInstanceExecutionState("worker", d.getInstanceStateSnapshot());
  d.ipcServer = { broadcast: vi.fn(), send: vi.fn() };
  const capture = () => d.captureAndEvaluateInstanceState("state_query");
  cleanups.push(() => { d.stopInstanceStateMonitor(); clearInterval(d.errorMonitorTimer); fm.stormWindow.shutdown(); });
  return { d, fm, screen, capture };
}

async function confirm(h: ReturnType<typeof harness>) {
  await h.capture();
  expect(h.d.getInteractionSnapshot().phase).toBe("candidate");
  await vi.advanceTimersByTimeAsync(500);
  expect(h.d.getInteractionSnapshot().phase).toBe("waiting");
}

describe("#1715: the approval prompt waits for a human, never answered", () => {
  it.each([["escalated", ESCALATED], ["staged", STAGED]])("%s: awaiting_input permission, no keys, no #1691 episode", async (_label, paneText) => {
    const h = harness(paneText);
    await confirm(h);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "waiting", kind: "permission" });
    expect(presentationState("working", h.d.getInteractionSnapshot())).toBe("awaiting_input");
    expect(h.d.inputBlockedDialogKey).not.toBeNull();
    expect(h.d.notAcceptingReason()).toContain("CLI dialog needs attention");
    expect(h.d.unrecognisedPrompt).toBeNull();
    h.d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(10_000);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "waiting", kind: "permission" });
    expect(h.d.unrecognisedPrompt).toBeNull();
    expect(hooks.forbidden).not.toHaveBeenCalled();
  });

  it("a quoted prompt in an owned draft probes clear on a real Daemon (#1715 r2-1)", async () => {
    // Prism r2 group 1 probe: recentPastes bind this spawn's text so
    // ownsInputDraft is true — yet the probe must return clear, so the
    // holdOnly dialog never blocks #829 clearing its own restored paste.
    const h = harness(quotePane());
    h.d.backend = {
      ...h.d.backend,
      inputDraft: (p: string) => new MuseBackend("/tmp/agend-muse-1715").inputDraft(p),
      inputDraftShows: (draft: never, text: string) => new MuseBackend("/tmp/agend-muse-1715").inputDraftShows(draft, text),
    };
    h.d.rememberPaste(QUOTE_PASTE.join("\n"), h.d.spawnGeneration);
    expect(await h.d.probeBlockingDialog()).toEqual({ state: "clear" });
  });

  it("a blank-first-row quote in an owned draft probes clear (#1715 r3)", async () => {
    const paste = `\n${QUOTE_PASTE.join("\n")}`;
    const stale = pane("echo-after-escape").trimEnd().replace(
      "❯ cancel me", [`❯${paste.split("\n")[0]}`, ...paste.split("\n").slice(1).map(r => `  ${r}`)].join("\n")) + "\n";
    const h = harness(stale);
    h.d.backend = {
      ...h.d.backend,
      inputDraft: (p: string) => new MuseBackend("/tmp/agend-muse-1715").inputDraft(p),
      inputDraftShows: (draft: never, text: string) => new MuseBackend("/tmp/agend-muse-1715").inputDraftShows(draft, text),
    };
    h.d.rememberPaste(paste, h.d.spawnGeneration);
    expect(await h.d.probeBlockingDialog()).toEqual({ state: "clear" });
  });

  it("a quoted prompt above a free composer never becomes permission evidence", async () => {
    const quoted = `${ESCALATED}\n${pane("echo-idle")}`;
    expect(museApprovalPromptActive(quoted)).toBe(false);
    const h = harness(quoted);
    await h.capture(); await vi.advanceTimersByTimeAsync(500);
    expect(h.d.getInteractionSnapshot().kind).not.toBe("permission");
    expect(h.d.inputBlockedDialogKey).toBeNull();
  });

  it("the prod skip_permissions denial path is unchanged: no dialog, no permission", async () => {
    const denied = pane("prod-escalation-denied");
    expect(museApprovalPromptActive(denied)).toBe(false);
    const backend = new MuseBackend("/tmp/agend-muse-1715");
    expect(backend.getRuntimeDialogs().filter(d => d.isActive ? d.isActive(denied) : d.pattern.test(denied))).toHaveLength(0);
    const h = harness(denied);
    await h.capture(); await vi.advanceTimersByTimeAsync(500);
    expect(h.d.getInteractionSnapshot().kind).not.toBe("permission");
  });
});
