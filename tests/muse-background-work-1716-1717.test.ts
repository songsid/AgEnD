/**
 * #1716 + #1717: muse background-task semantics — one decision: a running
 * background task does NOT count as busy; it counts as "local work still
 * active", with one semantic per consumer.
 *
 * Real live captures (tests/fixtures/muse-1.4.6/, 1.4.6 + 1.4.4 pairs);
 * stubbed backend/tmux for the daemon flows; no CLI, tmux or fleet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MuseBackend, museBackgroundWorkActive, museLocalWorkQuitActive } from "../src/backend/muse.js";
import type { CliBackend } from "../src/backend/types.js";
import type { TmuxManager } from "../src/tmux-manager.js";
import type { Logger } from "../src/logger.js";
import { Daemon } from "../src/daemon.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const DIR = join(process.cwd(), "tests", "fixtures", "muse-1.4.6");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf8");
const b = new MuseBackend("/tmp/agend-muse-1716-1717");

describe("#1717: a terminals panel with an idle composer is idle", () => {
  it.each(["prod-background-work", "compare-background-work", "compare-1.4.4-background-work"])(
    "%s: idle proof passes, busy stays false, draft is empty", (name) => {
      const p = pane(name);
      expect(b.getBusyPattern().test(p)).toBe(false);
      expect(b.isPeriodicRedrawIdlePane(p)).toBe(true);
      expect(b.inputDraft(p)?.rows).toEqual([]);
      expect(museBackgroundWorkActive(p)).toBe(true);
    });
});

describe("#1717: a busy turn is still busy, panel or not", () => {
  it("a working pane without a panel still fails the idle proof", () => {
    expect(b.isPeriodicRedrawIdlePane(pane("echo-busy"))).toBe(false);
  });

  it("a busy line above the box vetoes even with a panel below it", () => {
    // The turn muse started while a task runs: interrupt hint above the box,
    // terminals panel still drawn under it. Spliced from the live captures.
    const p = pane("prod-background-work").replace(
      "  (↓ to view terminals)\n",
      "  (↓ to view terminals)\n\n◇ Thinking (2s · esc to interrupt)\n",
    );
    expect(b.getBusyPattern().test(p)).toBe(true);
    expect(b.isPeriodicRedrawIdlePane(p)).toBe(false);
  });

  it("a multi-task panel past the plain search depth still passes — but only panel-headed", () => {
    const task = "└ ◆ Wait in the background  running                                                                                  11s\n";
    const multi = pane("prod-background-work").replace(task, task + task + task);
    // Bottom separator is 6 rows deep now (header + 3 tasks + bar): past the
    // plain 4-row cap, accepted only because the row after it is the header.
    expect(b.isPeriodicRedrawIdlePane(multi)).toBe(true);
    expect(museBackgroundWorkActive(multi)).toBe(true);
    // Same depth without the header: still fails closed (the #958 5-row bar cap).
    const noHeader = multi.replace("main · ↓ to select\n", "  mock-model · high · ~/work · Launch overrides\n");
    expect(b.isPeriodicRedrawIdlePane(noHeader)).toBe(false);
  });

  it("ordinary idle panes have no panel and no quit menu", () => {
    for (const name of ["echo-idle", "echo-done", "meta-idle"]) {
      const p = pane(name);
      expect(b.isPeriodicRedrawIdlePane(p), name).toBe(true);
      expect(museBackgroundWorkActive(p), name).toBe(false);
      expect(museLocalWorkQuitActive(p), name).toBe(false);
    }
  });
});

describe("#1717: unknown panel shapes fail closed", () => {
  const bg = () => pane("prod-background-work");
  it("a header with no task row is not a panel", () => {
    const p = bg().replace(/└ ◆ Wait in the background.*\n/, "");
    expect(museBackgroundWorkActive(p)).toBe(false);
    expect(b.isPeriodicRedrawIdlePane(p)).toBe(false);
  });

  it("a task row that is not running is not a running panel", () => {
    const p = bg().replace("  running", "  done   ");
    expect(museBackgroundWorkActive(p)).toBe(false);
    expect(b.isPeriodicRedrawIdlePane(p)).toBe(false);
  });

  it("a quoted panel up in the transcript does not count", () => {
    // Panel text above a later separator with a plain idle screen at the
    // bottom: transcript echo, not the live panel.
    const p = `${bg()}\n${pane("echo-idle")}`;
    expect(p).toContain("↓ to select");
    expect(museBackgroundWorkActive(p)).toBe(false);
  });

  it("the dialog-chrome double arrow is not the panel header", () => {
    const p = bg().replace("main · ↓ to select", "main · ↓↑ to select");
    expect(museBackgroundWorkActive(p)).toBe(false);
    expect(b.isPeriodicRedrawIdlePane(p)).toBe(false);
  });
});

describe("#1716: the 'Local work is still active' quit menu", () => {
  const quit = () => pane("prod-quit-with-local-work");

  it("is recognised whole, on the live capture", () => {
    expect(museLocalWorkQuitActive(quit())).toBe(true);
    expect(b.quitBlockedByDialog(quit())).toBe(true);
  });

  it("is not recognised without its options or its hint", () => {
    expect(museLocalWorkQuitActive(quit().replace("    2. Stay\n", ""))).toBe(false);
    expect(museLocalWorkQuitActive(quit().replace("Exit anyway", "Exit"))).toBe(false);
    expect(museLocalWorkQuitActive(quit().replace("  Enter to confirm · Esc to cancel", ""))).toBe(false);
    expect(museLocalWorkQuitActive(quit().replace("  Local work is still active", "  Something else"))).toBe(false);
  });

  it("is not recognised on ordinary panes", () => {
    for (const name of ["echo-idle", "echo-busy", "prod-background-work", "meta-idle"]) {
      expect(museLocalWorkQuitActive(pane(name)), name).toBe(false);
    }
  });

  it("a quit menu quoted in the transcript above a free composer is history, not live (#1730 P2-1)", () => {
    // The live menu's rows, replayed as an old transcript quote, with the
    // current echo-idle screen below (separated so the idle proof above-window
    // stays inside the current screen).
    const quitLines = pane("prod-quit-with-local-work").split("\n");
    const start = quitLines.findIndex(l => l.includes("Local work is still active"));
    const end = quitLines.findIndex(l => l.includes("Enter to confirm"));
    const menuQuote = quitLines.slice(start, end + 1).join("\n");
    // The current screen's own rows (trailing blanks trimmed, like a live
    // capture's padding); interior blanks stay so the idle proof above-window
    // never reaches the quote.
    const idleCore = pane("echo-idle").trimEnd();
    const stale = `${menuQuote}\n\n\n\n\n\n\n${idleCore}\n`;
    expect(stale.split("\n").length).toBeLessThan(40);
    expect(b.isPeriodicRedrawIdlePane(stale)).toBe(true);
    expect(b.inputDraft(stale)?.rows).toEqual([]);
    expect(museBackgroundWorkActive(stale)).toBe(false);
    expect(museLocalWorkQuitActive(stale)).toBe(false);
  });

  it("a quit menu quoted above a busy composer is history too, not live (#1730 P2-1 refined)", () => {
    // Prism's r2 witness: the same historic menu quote, but the current
    // screen is echo-after-escape — the composer holds this spawn's own
    // "cancel me" draft, so inputDraftShows matches an owned paste. The menu
    // must still be rejected: it belongs to an older input block, not the
    // current live one, and a holdOnly dialog must not block #829's clearing
    // of the restored draft.
    const quitLines = pane("prod-quit-with-local-work").split("\n");
    const start = quitLines.findIndex(l => l.includes("Local work is still active"));
    const end = quitLines.findIndex(l => l.includes("Enter to confirm"));
    const stale = `${quitLines.slice(start, end + 1).join("\n")}\n\n\n\n\n\n\n\n\n\n${pane("echo-after-escape").trimEnd()}\n`;
    expect(stale.split("\n").length).toBeLessThan(40);
    expect(b.inputDraft(stale)?.rows).toEqual(["cancel me"]);
    expect(b.inputDraftShows(b.inputDraft(stale)!, "cancel me")).toBe(true);
    expect(museLocalWorkQuitActive(stale)).toBe(false);
    expect(b.quitBlockedByDialog(stale)).toBe(false);
  });

  it("a borrowed header above the live block is rejected even when the hint is in the draft (#1730 P2-1 r3a)", () => {
    // Prism r3(a): the historic quote ends just BEFORE its hint, and the live
    // composer's draft supplies the hint row itself. The 12-row backward scan
    // must not borrow the header/options from above the live block's top.
    const quitLines = pane("prod-quit-with-local-work").split("\n");
    const start = quitLines.findIndex(l => l.includes("Local work is still active"));
    const end = quitLines.findIndex(l => l.includes("Enter to confirm"));
    const quote = quitLines.slice(start, end).join("\n");
    const echo = pane("echo-after-escape").trimEnd().replace(
      "❯ cancel me", "❯ cancel me\n  Enter to confirm · Esc to cancel");
    const stale = `${quote}\n\n\n\n\n\n\n\n\n\n${echo}\n`;
    expect(b.inputDraft(stale)?.rows).toEqual(["cancel me", "Enter to confirm · Esc to cancel"]);
    expect(museLocalWorkQuitActive(stale)).toBe(false);
    expect(b.quitBlockedByDialog(stale)).toBe(false);
  });

  it("a draft quoting the whole menu is composer content, not live chrome (#1730 P2-1 r3b)", () => {
    // Prism r3(b): every menu string, including the hint, is the populated
    // composer's own text. The live quit menu replaces the input box, so a
    // block colliding with the current draft is a quote, never chrome.
    const quotedMenu = [
      "Please review this captured menu:",
      "Local work is still active",
      "The following will stop when you exit:",
      "background task · tool.bash",
      "1. Exit anyway",
      "2. Stay",
      "Enter to confirm · Esc to cancel",
    ];
    const echo = pane("echo-after-escape").trimEnd().replace(
      "❯ cancel me", ["❯ " + quotedMenu[0], ...quotedMenu.slice(1).map(r => `  ${r}`)].join("\n"));
    expect(b.inputDraft(echo)?.rows).toEqual(quotedMenu);
    expect(b.inputDraftShows(b.inputDraft(echo)!, quotedMenu.join("\n"))).toBe(true);
    expect(museLocalWorkQuitActive(echo)).toBe(false);
    expect(b.quitBlockedByDialog(echo)).toBe(false);
  });

  it("a scrollback header above the box does not shadow the live menu (#1730 P2-1 r4)", () => {
    // Prism r4: a stale header line just above the input box's top separator,
    // live menu rows untouched. The oldest header in the window must not win
    // over the eligible live header inside the box.
    const lines = pane("prod-quit-with-local-work").split("\n");
    const topSep = lines.findIndex(l => /^─+$/.test(l));
    const shadowed = [...lines.slice(0, topSep), "  Local work is still active", ...lines.slice(topSep)].join("\n");
    expect(museLocalWorkQuitActive(shadowed)).toBe(true);
    expect(b.quitBlockedByDialog(shadowed)).toBe(true);
  });

  it("deliveries hold on it and never answer it: a passive dialog with no keys", () => {
    const dialog = b.getRuntimeDialogs().find(d => d.isActive === museLocalWorkQuitActive);
    expect(dialog).toMatchObject({ keys: [], holdOnly: true, blocksDelivery: true });
    expect(dialog!.pattern.test(quit())).toBe(true);
  });
});

// --- the report: the kill is never silent ---

describe("#1716: the background-work-ended marker is scoped to its own stop", () => {
  let mdir: string;
  beforeEach(() => { mdir = mkdtempSync(join(tmpdir(), "agend-1716-marker-")); });
  afterEach(() => { rmSync(mdir, { recursive: true, force: true }); });

  it("a fresh marker reports, a stale one never does", async () => {
    const { writeBackgroundWorkEndedMarker, readBackgroundWorkEndedMarker } =
      await import("../src/background-work-ended.js");
    expect(readBackgroundWorkEndedMarker(mdir, Date.now())).toBeNull();
    const beganAt = Date.now();
    writeBackgroundWorkEndedMarker(mdir, "stop");
    expect(readBackgroundWorkEndedMarker(mdir, beganAt)?.reason).toBe("stop");
    // An earlier stop's marker is not this stop's news.
    expect(readBackgroundWorkEndedMarker(mdir, beganAt + 10_000)).toBeNull();
  });

  it("an unreadable marker never reports", async () => {
    const { readBackgroundWorkEndedMarker } = await import("../src/background-work-ended.js");
    writeFileSync(join(mdir, "background-work-ended.json"), "not json");
    expect(readBackgroundWorkEndedMarker(mdir, 0)).toBeNull();
  });
});

// --- daemon flows: stubbed backend/tmux, fake timers, no CLI/tmux/fleet ---

const standingIn = <T,>(stub: object): T => stub as unknown as T;
const rootLogger = pino({ level: "silent" }) as Logger;
type AnyDaemon = Daemon & Record<string, any>;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-1716-")); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function makeDaemon(): AnyDaemon {
  return new Daemon("bg-test", {
    working_directory: dir,
    backend: "muse",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, true, undefined, undefined, rootLogger) as AnyDaemon;
}

const QUIT = () => pane("prod-quit-with-local-work");
const BG = () => pane("prod-background-work");

describe("#1716: the stop flow cancels the menu with Escape — no option chosen, no blind key", () => {
  it("Escape, then SIGTERM, without waiting out the grace", async () => {
    vi.useFakeTimers();
    const d = makeDaemon();
    const keys: string[] = [];
    const killed: string[] = [];
    let alive = true;
    const getPaneStatus = vi.fn(async () => ({ alive }));
    d["backend"] = standingIn<CliBackend>({ binaryName: "muse", quitBlockedByDialog: (p: string) => museLocalWorkQuitActive(p), getQuitCommand: () => "/quit" });
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(async () => QUIT()),
      getPaneStatus,
      sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); return true; }),
      sendKeys: vi.fn(async () => true),
      killWindow: vi.fn(async () => {}),
    });
    d["checkpointSessionId"] = vi.fn(async () => {});
    d["sendQuitSequence"] = vi.fn(async () => true);
    d["killProcessTree"] = vi.fn(async (...args: unknown[]) => { killed.push(String(args[0])); alive = false; });
    const stopping = d.stop().catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(keys).toEqual(["Escape"]);
    expect(killed[0]).toBe("SIGTERM");
    expect(getPaneStatus.mock.calls.length).toBeLessThan(5);
    // #1716: the ended background work is recorded for the stop reply.
    const { readBackgroundWorkEndedMarker } = await import("../src/background-work-ended.js");
    expect(readBackgroundWorkEndedMarker(dir, 0)?.reason).toBe("stop");
  });

  it.each([
    ["r2: stale quote above an owned cancel-me draft", "cancel me", () => {
      const quitLines = QUIT().split("\n");
      const start = quitLines.findIndex(l => l.includes("Local work is still active"));
      const end = quitLines.findIndex(l => l.includes("Enter to confirm"));
      return `${quitLines.slice(start, end + 1).join("\n")}\n\n\n\n\n\n\n\n\n\n${pane("echo-after-escape").trimEnd()}\n`;
    }],
    ["r3a: borrowed header with the hint in the draft", "cancel me", () => {
      const quitLines = QUIT().split("\n");
      const start = quitLines.findIndex(l => l.includes("Local work is still active"));
      const end = quitLines.findIndex(l => l.includes("Enter to confirm"));
      const echo = pane("echo-after-escape").trimEnd().replace(
        "❯ cancel me", "❯ cancel me\n  Enter to confirm · Esc to cancel");
      return `${quitLines.slice(start, end).join("\n")}\n\n\n\n\n\n\n\n\n\n${echo}\n`;
    }],
    ["r3b: draft quoting the whole menu", "Please review this captured menu:\nLocal work is still active\nThe following will stop when you exit:\nbackground task · tool.bash\n1. Exit anyway\n2. Stay\nEnter to confirm · Esc to cancel", () => {
      const quoted = ["Please review this captured menu:", "Local work is still active", "The following will stop when you exit:", "background task · tool.bash", "1. Exit anyway", "2. Stay", "Enter to confirm · Esc to cancel"];
      return pane("echo-after-escape").trimEnd().replace(
        "❯ cancel me", [`❯ ${quoted[0]}`, ...quoted.slice(1).map(r => `  ${r}`)].join("\n")) + "\n";
    }],
  ])("a quoted menu with an owned draft probes clear on a real Daemon (%s)", async (_name, paste, makePane) => {
    // Prism's probes: recentPastes bind this spawn's text so ownsInputDraft is
    // true — yet the real probeBlockingDialog must return clear, so the new
    // holdOnly dialog never blocks #829 clearing its own restored draft.
    const stale = (makePane as () => string)();
    const d = makeDaemon();
    d["backend"] = standingIn<CliBackend>({
      binaryName: "muse",
      getRuntimeDialogs: () => b.getRuntimeDialogs(),
      inputDraft: (p: string) => b.inputDraft(p),
      inputDraftShows: (draft: never, text: string) => b.inputDraftShows(draft, text),
    });
    d["rememberPaste"](paste as string, d["spawnGeneration"]);
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(async () => stale),
      getPaneStatus: vi.fn(async () => ({ alive: true })),
    });
    expect(await d["probeBlockingDialog"]()).toEqual({ state: "clear" });
  });

  it("a shadowed live menu still probes dialog on a real Daemon (#1730 P2-1 r4)", async () => {
    // Prism r4 positive control: stale header above the box, live menu
    // untouched — the probe must return dialog so the stop flow still holds
    // and reports the ended background work.
    const lines = QUIT().split("\n");
    const topSep = lines.findIndex(l => /^─+$/.test(l));
    const shadowed = [...lines.slice(0, topSep), "  Local work is still active", ...lines.slice(topSep)].join("\n");
    const d = makeDaemon();
    d["backend"] = standingIn<CliBackend>({
      binaryName: "muse",
      getRuntimeDialogs: () => b.getRuntimeDialogs(),
      inputDraft: (p: string) => b.inputDraft(p),
      inputDraftShows: (draft: never, text: string) => b.inputDraftShows(draft, text),
    });
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(async () => shadowed),
      getPaneStatus: vi.fn(async () => ({ alive: true })),
    });
    const probe = await d["probeBlockingDialog"]();
    expect(probe.state).toBe("dialog");
  });

  it("no menu, no marker: a clean stop reports nothing", async () => {
    const d = makeDaemon();
    d["backend"] = standingIn<CliBackend>({ binaryName: "muse", quitBlockedByDialog: (p: string) => museLocalWorkQuitActive(p), getQuitCommand: () => "/quit" });
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(async () => pane("echo-idle")),
      getPaneStatus: vi.fn(async () => ({ alive: false })),
      sendSpecialKey: vi.fn(async () => true),
      sendKeys: vi.fn(async () => true),
      killWindow: vi.fn(async () => {}),
    });
    d["checkpointSessionId"] = vi.fn(async () => {});
    d["sendQuitSequence"] = vi.fn(async () => true);
    d["killProcessTree"] = vi.fn(async () => {});
    await d.stop().catch(() => {});
    const { readBackgroundWorkEndedMarker } = await import("../src/background-work-ended.js");
    expect(readBackgroundWorkEndedMarker(dir, 0)).toBeNull();
  });
});

describe("#1717: an idle pause defers while background work runs", () => {
  function armPause(paneText: string) {
    const d = makeDaemon();
    const quitSent: boolean[] = [];
    d["backend"] = standingIn<CliBackend>({ binaryName: "muse", backgroundWorkRunning: (p: string) => museBackgroundWorkActive(p) });
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(async () => paneText),
      getPaneStatus: vi.fn(async () => ({ alive: true })),
    });
    d["instanceState"] = "idle";
    d["freezeRuntimeMonitors"] = vi.fn();
    d["checkpointSessionId"] = vi.fn(async () => {});
    d["sendQuitSequence"] = vi.fn(async () => { quitSent.push(true); return true; });
    return { d, quitSent };
  }

  it("a running panel holds the pause: no /quit is sent", async () => {
    const { d, quitSent } = armPause(BG());
    await d.pause("idle" as never).catch(() => {});
    expect(quitSent).toEqual([]);
    expect(d["pauseWakeState"]).not.toBe("paused");
  });

  it("an ordinary idle pane pauses as before", async () => {
    vi.useFakeTimers();
    const { d, quitSent } = armPause(pane("echo-idle"));
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(async () => pane("echo-idle")),
      getPaneStatus: vi.fn(async () => ({ alive: false })),
    });
    d["killProcessTree"] = vi.fn(async () => {});
    const pausing = d.pause("idle" as never).catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await pausing;
    expect(quitSent).toEqual([true]);
  });

  it("a state flip to working during the pane read holds the pause (#1730 P2-2a)", async () => {
    const d = makeDaemon();
    let release!: (p: string) => void;
    const held = new Promise<string>(r => { release = r; });
    d["backend"] = standingIn<CliBackend>({ binaryName: "muse", backgroundWorkRunning: (p: string) => museBackgroundWorkActive(p) });
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(() => held),
      getPaneStatus: vi.fn(async () => ({ alive: true })),
    });
    d["instanceState"] = "idle";
    d["freezeRuntimeMonitors"] = vi.fn();
    d["checkpointSessionId"] = vi.fn(async () => {});
    const quit = vi.fn(async () => true);
    d["sendQuitSequence"] = quit;
    const pausing = d.pause("idle" as never).catch(() => {});
    // The pause is parked at the capture await; the turn resumes first.
    d["applyInstanceStateSnapshot"]({ state: "working", unchangedForMs: 0, observedAt: Date.now(), stateChangedAt: Date.now() });
    release(pane("echo-idle"));
    await pausing;
    expect(quit).not.toHaveBeenCalled();
    expect(d["pauseWakeState"]).not.toBe("paused");
  });

  it("a queued paste during the pane read holds the pause (#1730 P2-2b)", async () => {
    const d = makeDaemon();
    let release!: (p: string) => void;
    const held = new Promise<string>(r => { release = r; });
    d["backend"] = standingIn<CliBackend>({ binaryName: "muse", backgroundWorkRunning: (p: string) => museBackgroundWorkActive(p) });
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(() => held),
      getPaneStatus: vi.fn(async () => ({ alive: true })),
    });
    d["instanceState"] = "idle";
    d["freezeRuntimeMonitors"] = vi.fn();
    d["checkpointSessionId"] = vi.fn(async () => {});
    const quit = vi.fn(async () => true);
    d["sendQuitSequence"] = quit;
    const pausing = d.pause("idle" as never).catch(() => {});
    d["pasteQueueDepth"] = 1;
    release(pane("echo-idle"));
    await pausing;
    expect(quit).not.toHaveBeenCalled();
  });

  it("a replaced tmux during the pane read holds the pause (#1730 P2-2c)", async () => {
    const d = makeDaemon();
    let release!: (p: string) => void;
    const held = new Promise<string>(r => { release = r; });
    d["backend"] = standingIn<CliBackend>({ binaryName: "muse", backgroundWorkRunning: (p: string) => museBackgroundWorkActive(p) });
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(() => held),
      getPaneStatus: vi.fn(async () => ({ alive: true })),
    });
    d["instanceState"] = "idle";
    d["freezeRuntimeMonitors"] = vi.fn();
    d["checkpointSessionId"] = vi.fn(async () => {});
    const quit = vi.fn(async () => true);
    d["sendQuitSequence"] = quit;
    const pausing = d.pause("idle" as never).catch(() => {});
    // The window is respawned mid-read (now with background work); the held
    // read belongs to the dead owner and must not authorise a quit.
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@2",
      capturePane: vi.fn(async () => pane("prod-background-work")),
      getPaneStatus: vi.fn(async () => ({ alive: true })),
    });
    release(pane("echo-idle"));
    await pausing;
    expect(quit).not.toHaveBeenCalled();
  });

  it("a failed pane capture pauses as before — never wedged unpaused", async () => {
    vi.useFakeTimers();
    const { d, quitSent } = armPause(BG());
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(async () => { throw new Error("tmux gone"); }),
      getPaneStatus: vi.fn(async () => ({ alive: false })),
    });
    d["killProcessTree"] = vi.fn(async () => {});
    const pausing = d.pause("idle" as never).catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await pausing;
    expect(quitSent).toEqual([true]);
  });
});

describe("#1716: the stop reply and topic notice name the ended background work", () => {
  let fdir: string;
  beforeEach(() => { fdir = mkdtempSync(join(tmpdir(), "agend-1716-fleet-")); });
  afterEach(() => { rmSync(fdir, { recursive: true, force: true }); });

  async function fleetWithMarker(name: string, fresh: boolean) {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { writeBackgroundWorkEndedMarker } = await import("../src/background-work-ended.js");
    const fleet = new FleetManager(fdir) as any;
    const instDir = join(fdir, "instances", name);
    mkdirSync(instDir, { recursive: true });
    if (!fresh) writeBackgroundWorkEndedMarker(instDir, "stop", Date.now() - 600_000);
    // Like the daemon's stop flow, the marker lands mid-stop — after the
    // stop began, so the stop's own scope accepts it.
    fleet.lifecycle = { stop: vi.fn(async () => {
      if (fresh) writeBackgroundWorkEndedMarker(instDir, "stop");
    }) };
    fleet.notifyInstanceTopic = vi.fn(() => true);
    return fleet;
  }

  it("stopInstance posts the topic notice and reports the flag for a fresh marker", async () => {
    const fleet = await fleetWithMarker("muse-1", true);
    const outcome = await fleet.stopInstance("muse-1");
    expect(outcome).toEqual({ backgroundWorkEnded: true });
    expect(fleet.notifyInstanceTopic).toHaveBeenCalledOnce();
    const [target, text] = fleet.notifyInstanceTopic.mock.calls[0];
    expect(target).toBe("muse-1");
    expect(text).toContain("background work");
  });

  it("stopInstance stays silent on a stale marker or none at all", async () => {
    const stale = await fleetWithMarker("muse-1", false);
    expect(await stale.stopInstance("muse-1")).toEqual({ backgroundWorkEnded: false });
    expect(stale.notifyInstanceTopic).not.toHaveBeenCalled();
    const { FleetManager } = await import("../src/fleet-manager.js");
    const clean = new FleetManager(fdir) as any;
    const instDir = join(fdir, "instances", "muse-2");
    mkdirSync(instDir, { recursive: true });
    clean.lifecycle = { stop: vi.fn(async () => {}) };
    clean.notifyInstanceTopic = vi.fn(() => true);
    expect(await clean.stopInstance("muse-2")).toEqual({ backgroundWorkEnded: false });
    expect(clean.notifyInstanceTopic).not.toHaveBeenCalled();
  });

  it("the Classic /stop reply appends the sentence when work was ended", async () => {
    const fleet = await fleetWithMarker("muse-1", true);
    fleet.fleetConfig = { instances: { "muse-1": {} } };
    fleet.classicChannels = { unregister: () => ({ instanceName: "muse-1" }), getAll: () => [] };
    fleet.reregisterClassicChannels = vi.fn();
    const reply = await fleet.handleClassicStop("chan", "discord");
    expect(reply).toContain("Agent stopped");
    expect(reply).toContain("Background work was running and was ended with it");
  });

  it("the Classic /stop reply survives a stub that resolves nothing (web-favorites-1664 CI)", async () => {
    const fleet = await fleetWithMarker("muse-1", false);
    fleet.fleetConfig = { instances: { "muse-1": {} } };
    fleet.classicChannels = { unregister: () => ({ instanceName: "muse-1" }), getAll: () => [] };
    fleet.reregisterClassicChannels = vi.fn();
    fleet.stopInstance = vi.fn(async () => undefined);
    const reply = await fleet.handleClassicStop("chan", "discord");
    expect(reply).toContain("Agent stopped");
    expect(reply).not.toContain("Background work");
  });

  it("the Classic /stop reply is unchanged when nothing was ended", async () => {
    const fleet = await fleetWithMarker("muse-1", false);
    fleet.fleetConfig = { instances: { "muse-1": {} } };
    fleet.classicChannels = { unregister: () => ({ instanceName: "muse-1" }), getAll: () => [] };
    fleet.reregisterClassicChannels = vi.fn();
    const reply = await fleet.handleClassicStop("chan", "discord");
    expect(reply).not.toContain("Background work");
  });

  it("the fleet restart/update completion names the instances", async () => {
    const { formatRestartProgressCompletion } = await import("../src/restart-progress.js");
    const base = { running: 2, total: 2, version: "9.9", pausedNames: [] as string[] };
    const withNames = formatRestartProgressCompletion("restart",
      { ...base, backgroundWorkEndedNames: ["muse-1", "muse-2"] }, Date.now() - 1000);
    expect(withNames).toContain("Background work was running and was ended: muse-1, muse-2");
    const without = formatRestartProgressCompletion("update", { ...base }, Date.now() - 1000);
    expect(without).not.toContain("Background work");
  });

  it("collectBackgroundWorkEndedNames scopes to the operation (#1730 P2-3)", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { writeBackgroundWorkEndedMarker } = await import("../src/background-work-ended.js");
    const collect = (FleetManager.prototype as any).collectBackgroundWorkEndedNames;
    const cdir = mkdtempSync(join(tmpdir(), "agend-1716-collect-"));
    try {
      const getInstanceDir = (n: string) => join(cdir, "instances", n);
      mkdirSync(join(cdir, "instances", "one"), { recursive: true });
      mkdirSync(join(cdir, "instances", "two"), { recursive: true });
      // Plain boot (null op) reports nothing, even with a marker present.
      writeBackgroundWorkEndedMarker(join(cdir, "instances", "one"), "stop");
      expect(collect.call({ getInstanceDir }, ["one", "two"], null)).toEqual([]);
      // A fresh marker reports; a stale one and a missing one do not.
      const opStart = Date.now();
      writeBackgroundWorkEndedMarker(join(cdir, "instances", "one"), "stop", opStart + 5);
      writeBackgroundWorkEndedMarker(join(cdir, "instances", "two"), "stop", opStart - 600_000);
      expect(collect.call({ getInstanceDir }, ["one", "two"], opStart)).toEqual(["one"]);
    } finally {
      rmSync(cdir, { recursive: true, force: true });
    }
  });

  it("the real update fallback carries the ended names (#1730 P2-3)", async () => {
    // Same instrument as the #1737 fence tests: the real startAll completion
    // block, extracted by AST and run against an inert manager — so this also
    // proves the region stays compatible with their fixed vm context.
    const ts = (await import("typescript")).default;
    const { createContext, runInContext } = await import("node:vm");
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { RestartProgress, formatRestartProgressCompletion } = await import("../src/restart-progress.js");
    const marker = await import("../src/update-marker.js");
    const { writeBackgroundWorkEndedMarker } = await import("../src/background-work-ended.js");
    const wdir = mkdtempSync(join(tmpdir(), "agend-1716-fallback-"));
    try {
      const now = Date.now();
      marker.beginUpdateProgress(wdir, { adapterId: "a", chatId: "c", messageId: "A" }, now - 500);
      const pending = marker.readUpdateProgress(wdir)!;
      const instDir = join(wdir, "instances", "one");
      mkdirSync(instDir, { recursive: true });
      writeBackgroundWorkEndedMarker(instDir, "stop", now - 100);
      const sendText = vi.fn().mockResolvedValue({ messageId: "fallback" });
      const adapter = { id: "a", editMessage: vi.fn().mockResolvedValue(undefined), sendText };
      const fm: any = Object.create(FleetManager.prototype);
      Object.assign(fm, {
        dataDir: wdir,
        fleetConfig: { instances: { one: {}, two: {} }, channel: { group_id: "c" } },
        adapters: new Map([["a", adapter]]),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        startNeedsYou: vi.fn(), announceToolPermissionsChange: vi.fn(), tightenInstanceDirectories: vi.fn(),
        fleetLevelSignature: () => "inert", checkStartupSignatureConsistency: vi.fn(),
        applyJobStoreCache: { settleAfterRestart: () => [] }, reloadPending: false,
        sweepOrphanedCancelButtons: async () => {}, announceWebChatOnce: async () => {},
        configuredStartupInstanceNames: () => ["one", "two"],
        lifecycle: { isPaused: () => false, daemons: new Map([["one", {}], ["two", {}]]) },
        findGeneralInstance: () => null, tipsEnabled: () => false,
        updateCleanupWatch: null, updateProgressTimer: null, updateProgressEditRunning: false,
        lastUpdateProgressText: null, updateCompletionTipText: null,
        sendFleetStartCompletionFallback: async (_chat: string, text: string) => { await adapter.sendText("c", text); return true; },
      });
      const source = readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
      const ast = ts.createSourceFile("fleet-manager.ts", source, ts.ScriptTarget.ES2022, true);
      let method: any, block: any;
      const visit = (n: any): void => {
        if (ts.isMethodDeclaration(n) && n.name.getText(ast) === "startAllWithinDeadline") method = n;
        ts.forEachChild(n, visit);
      };
      visit(ast);
      const find = (n: any): void => {
        if (ts.isBlock(n) && n.statements.some((st: any) => ts.isVariableStatement(st)
          && st.declarationList.declarations.some((d: any) => d.name.getText(ast) === "completionSummary"))) block = n;
        ts.forEachChild(n, find);
      };
      find(method.body);
      const statements = block.statements;
      const first = statements.findIndex((st: any) => ts.isVariableStatement(st)
        && st.declarationList.declarations.some((d: any) => d.name.getText(ast) === "configuredNames"));
      const tail = method.body.statements.find((st: any) => ts.isExpressionStatement(st)
        && ts.isCallExpression(st.expression) && ts.isPropertyAccessExpression(st.expression.expression)
        && st.expression.expression.name.text === "finishStartup");
      const snapshot = method.body.statements.find((st: any) => ts.isVariableStatement(st)
        && st.declarationList.declarations.some((d: any) => d.name.getText(ast) === "bootUpdateMarker"));
      const script = (snapshot ? snapshot.getText(ast) + "\n" : "")
        + statements.slice(first).map((st: any) => st.getText(ast)).join("\n") + "\n" + tail.getText(ast);
      const progress = new RestartProgress(2, pending.startedAt, fm.logger, { mode: "update" });
      const context = createContext({
        fm, fleet: fm.fleetConfig, topicMode: true, pendingUpdateProgress: pending, pendingProgressOperation: "update",
        startupProgress: progress, progressStart: Promise.resolve(true),
        updateMarkerIdentity: marker.updateMarkerIdentity, updateReceiptOf: marker.updateReceiptOf,
        formatRestartProgressCompletion, t: () => "fleet ready", Date,
        load: async (name: string) => {
          if (name !== "node:module") throw Error("unexpected inert import");
          return { createRequire: () => () => ({ version: "9.9" }) };
        },
      });
      const js = ts.transpileModule(`(async function(){ ${script} }).call(fm)`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
        .replaceAll("import.meta.url", "'file:///inert/compiled.js'").replaceAll("import(", "load(").replaceAll("export {};", "");
      await runInContext(js, context);
      const text = String(sendText.mock.calls[0][1]);
      expect(text).toContain("Background work was running and was ended: one");
    } finally {
      rmSync(wdir, { recursive: true, force: true });
    }
  });
});
