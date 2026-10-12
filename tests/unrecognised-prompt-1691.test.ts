/**
 * #1691: a pane stuck on a prompt AgEnD doesn't recognise (#1690's "Switch model?" from claude 2.1.296) is detected
 * after a minute unchanged — deliveries held, awaiting_input, one Needs-you item, one report — and never answered.
 * An agent's numbered output (after or during a turn) is not a prompt; a known dialog keeps its own path; a pane change
 * ends it; an hour held is one report.
 *
 * Real panes: tests/fixtures/claude-2.1.296-*.pane.txt, captured from the real claude 2.1.296 under AgEnD's production
 * launch against a local mock API (scripts/manual/claude-version-audit, NUMLIST for the numbered output). The real
 * Daemon runtime scan and the real ClaudeCodeBackend (its dialog tables and composer reading) run against a stub tmux
 * serving those panes and recording keys. Nothing starts a CLI, a fleet or a tmux server.
 *
 * Since #1690 claude's table knows "Switch model?". These tests use that capture as what it was before — a real dialog
 * no table knows — so the rig's claude backend leaves that one entry out (`knownSwitch` keeps the real table).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, PaneStateMachine, UNRECOGNISED_PROMPT_STABLE_MS } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { MuseBackend } from "../src/backend/muse.js";
import { OpenCodeBackend } from "../src/backend/opencode.js";
import { InstanceLifecycle, type IncidentEventSource, type LifecycleContext } from "../src/instance-lifecycle.js";
import { presentationState } from "../src/interaction-observation.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { setLocale } from "../src/locale.js";
import { QUESTION_MAX, questionLine, unrecognisedPromptShape } from "../src/unrecognised-prompt.js";

const fixture = (name: string) => readFileSync(join(process.cwd(), "tests", "fixtures", `claude-2.1.296-${name}.pane.txt`), "utf8");
const SWITCH = fixture("switch-model-opus");
const SWITCH_TYPO = fixture("switch-model-typo");
const NUMBERED_AFTER = fixture("numbered-output-after-turn");
const NUMBERED_MIDTURN = fixture("numbered-output-midturn");
const AT_PROMPT = fixture("after-turn");
/** The ordinary prompt with a two-line draft in claude's own composer box shaped like options: the CLI's input, not a prompt. */
const DRAFT_IN_COMPOSER = AT_PROMPT.replace(/^❯[ \t\u00a0]*$/m, "❯ 1. first draft line\n  2. second draft line");

let dir: string;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "agend-1691-")); mkdirSync(join(dir, "inst")); logger.warn.mockClear(); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); setLocale("en"); });

function rig(opts: { extraDialogs?: object[]; backend?: "claude-code" | "muse" | "opencode"; start?: string; ready?: RegExp; knownSwitch?: boolean } = {}) {
  const screen = { text: opts.start ?? SWITCH };
  const keys: string[] = [];
  const pasted: string[] = [];
  const kind = opts.backend ?? "claude-code";
  const real = kind === "muse" ? new MuseBackend(join(dir, "inst")) as any
    : kind === "opencode" ? new OpenCodeBackend(join(dir, "inst")) as any
      : new ClaudeCodeBackend(join(dir, "inst"));
  const backend = Object.create(real) as ClaudeCodeBackend;
  const table = () => kind === "claude-code" && !opts.knownSwitch
    ? real.getRuntimeDialogs().filter((d: { pattern: RegExp }) => !/Switch model/.test(d.pattern.source))
    : real.getRuntimeDialogs();
  (backend as any).getRuntimeDialogs = () => [...table(), ...(opts.extraDialogs ?? [])];
  if (opts.ready) (backend as any).getReadyPattern = () => opts.ready;
  const d: any = new Daemon("w", {
    working_directory: dir, backend: kind, log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, join(dir, "inst"), false, backend, undefined, logger);
  d.tmux = {
    isWindowAlive: async () => true,
    capturePane: async () => screen.text,
    capturePaneWithHistory: async () => screen.text,
    sendSpecialKey: async (key: string) => { keys.push(key); return true; },
    sendKeys: async (key: string) => { keys.push(key); return true; },
    pasteText: async (text: string) => { pasted.push(text); return true; },
    getWindowId: () => "@1",
  };
  const parked: any[] = [];
  d.on("dialog_parked", (event: unknown) => parked.push(event));
  d.startErrorMonitor();
  const poll = (ms = 5_000) => vi.advanceTimersByTimeAsync(ms);
  const awaiting = () => presentationState("idle", d.getInteractionSnapshot()) === "awaiting_input";
  const needsYou = () => deriveNeedsYou({ prompts: [], deliveries: [], ownerOf: () => "world",
    instances: [{ name: "w", state: presentationState("idle", d.getInteractionSnapshot()), interaction: d.getInteractionSnapshot() } as any] });
  const held = async () => (await d.probeBlockingDialog()).state;
  return { d, screen, keys, pasted, parked, poll, awaiting, needsYou, held, stop: () => clearInterval(d.errorMonitorTimer) };
}
const unrecognised = (parked: any[]) => parked.filter(e => e.unrecognised);

describe("#1691: the #1690 'Switch model?' capture", () => {
  it("is held, awaiting input and reported once after a minute unchanged — and no key is ever sent", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS - 5_000);
      expect([r.parked.length, r.awaiting(), await r.held()], "not before the minute").toEqual([0, false, "clear"]);
      // The first scan (5 s) starts the minute; it completes at the 65 s scan and is reported on the next one.
      await r.poll(15_000);
      expect(unrecognised(r.parked)).toEqual([expect.objectContaining({ name: "w", holdOnly: true, unrecognised: true, question: "Switch model?" })]);
      expect(r.awaiting()).toBe(true);
      expect(await r.held(), "deliveries wait").toBe("dialog");
      const items = r.needsYou();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: "awaiting_input", instance: "w", reason: "dialog" });
      expect([r.keys, r.pasted], "AgEnD never answers it").toEqual([[], []]);
    } finally { r.stop(); }
  });

  it("the typo variant ('Switching to opsu') is the same unrecognised prompt", async () => {
    const r = rig();
    try {
      r.screen.text = SWITCH_TYPO;
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(unrecognised(r.parked)).toHaveLength(1);
      expect(r.keys).toEqual([]);
    } finally { r.stop(); }
  });
});

describe("#1691: an agent's numbered output is not a prompt", () => {
  it.each([["after the turn", NUMBERED_AFTER], ["mid-turn", NUMBERED_MIDTURN], ["at the ordinary prompt", AT_PROMPT]])("%s, held for five minutes: nothing", async (_n, pane) => {
    const r = rig();
    try {
      r.screen.text = pane;
      await r.poll(5 * 60_000);
      expect([r.parked.length, r.awaiting(), await r.held(), r.keys.length]).toEqual([0, false, "clear", 0]);
    } finally { r.stop(); }
  });

  it("option-shaped text in the CLI's own composer box (a draft) is the CLI's input, not a prompt", async () => {
    expect(unrecognisedPromptShape(DRAFT_IN_COMPOSER)?.kind, "shaped like one at the bottom").toBe("numbered");
    const r = rig();
    try {
      r.screen.text = DRAFT_IN_COMPOSER;
      await r.poll(5 * 60_000);
      expect([r.parked.length, r.awaiting(), await r.held()]).toEqual([0, false, "clear"]);
    } finally { r.stop(); }
  });

  it("a pane that keeps changing (a turn streaming the prompt-shaped text) never completes the minute", async () => {
    const r = rig();
    try {
      for (let i = 0; i < 60; i++) {   // five minutes of 5 s scans, the screen different every time
        r.screen.text = SWITCH.replace("Switch model?", `Switch model? ${"·".repeat(i % 7)}`);
        await r.poll(5_000);
      }
      expect([r.parked.length, r.awaiting(), r.keys.length]).toEqual([0, false, 0]);
    } finally { r.stop(); }
  });
});

// ── #1695 review (Prism): the four P2 groups, each with its control ─────────────────────────────────────────────
const MUSE_IDLE = readFileSync(join(process.cwd(), "tests", "fixtures", "muse-1.4.4", "echo-idle.pane.txt"), "utf8");
const OPENCODE_IDLE = readFileSync(join(process.cwd(), "tests", "fixtures", "opencode-1.18.34-ready-after-tool-auto.pane.txt"), "utf8");
const YN = "Overwrite config.yaml? [y/N]";
/** The question typed into the CLI's own input row (a draft), nothing else changed. */
const MUSE_DRAFT = MUSE_IDLE.replace(/^❯[ \t\u00a0]*$/m, `❯ ${YN}`);
const OPENCODE_DRAFT = (() => {
  const rows = OPENCODE_IDLE.split("\n");
  const build = rows.findIndex(r => /Build auto · Mock Model/.test(r));
  rows[build - 1] = rows[build - 1]!.replace(/┃.*$/, `┃  ${YN}`);
  return rows.join("\n");
})();

describe("#1695 P2-1: a draft in muse's or opencode's own input box is the CLI's input, not a prompt", () => {
  it.each([["muse", MUSE_DRAFT, MUSE_IDLE], ["opencode", OPENCODE_DRAFT, OPENCODE_IDLE]] as const)("%s: held for three minutes — nothing (and the idle screen too)", async (backend, draft, idle) => {
    expect(unrecognisedPromptShape(draft)?.kind, "shaped like a prompt at the bottom").toBe("yes-no");
    for (const pane of [draft, idle]) {
      const r = rig({ backend, start: pane });
      try {
        await r.poll(3 * 60_000);
        expect([r.parked.length, r.awaiting(), await r.held(), r.keys.length], backend).toEqual([0, false, "clear", 0]);
      } finally { r.stop(); }
    }
  });
});

describe("#1695 r2 P2-1: muse's own menu cursor is not its composer", () => {
  /** muse's screen with its input box replaced by an unknown selection menu (no muse composer on screen). */
  const MUSE_MENU = (() => {
    const rows = MUSE_IDLE.split("\n");
    const rule = rows.findIndex(r => /^─{8,}/.test(r));
    return [...rows.slice(0, rule), "Choose a rollout strategy?", "❯ 1. Apply the selected strategy", "  2. Keep the existing strategy", ""].join("\n");
  })();
  it("an unknown numbered menu at muse's bottom is caught (its ❯ satisfies muse's ready pattern, but there is no input box)", async () => {
    expect(new MuseBackend(join(dir, "inst")).inputDraft(MUSE_MENU), "no muse input box").toBeNull();
    expect(unrecognisedPromptShape(MUSE_MENU)?.kind).toBe("numbered");
    const r = rig({ backend: "muse", start: MUSE_MENU });
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect([await r.held(), r.awaiting(), unrecognised(r.parked).length, r.keys.length]).toEqual(["dialog", true, 1, 0]);
    } finally { r.stop(); }
  });
});

describe("#1695 r2 P2-1: a backend with no reader whose ready pattern is a cursor glyph", () => {
  it("the menu's own ❯ row never counts as its ready chrome: the menu is caught", async () => {
    const r = rig({ backend: "opencode", start: SWITCH, ready: /❯|ctrl\+p commands/m });
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect([await r.held(), unrecognised(r.parked).length]).toEqual(["dialog", 1]);
    } finally { r.stop(); }
  });
});

describe("#1695 P2-2: motion anywhere on the screen restarts the minute", () => {
  it.each([
    ["a busy spinner under the block", (i: number) => `${SWITCH.trimEnd()}\n✢ Accomplishing… (${i}s · ↓ 38.0k tokens)\n`],
    ["a ticking footer that is no busy indicator", (i: number) => `${SWITCH.trimEnd()}\n  updated ${i}s ago\n`],
  ])("%s for 100 s: not active; once it stops, active after a minute (control)", async (_n, frame) => {
    const r = rig();
    try {
      for (let i = 0; i < 20; i++) { r.screen.text = frame(i); await r.poll(5_000); }
      expect([r.parked.length, r.awaiting(), await r.held()]).toEqual([0, false, "clear"]);
      r.screen.text = SWITCH;
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect([unrecognised(r.parked).length, await r.held()]).toEqual([1, "dialog"]);
    } finally { r.stop(); }
  });

  it("a footer that alternates between two states (a blink) never lets the minute complete", async () => {
    const r = rig();
    try {
      const awaitingSeen: boolean[] = [];
      const heldOnFirstState: string[] = [];
      for (let i = 0; i < 30; i++) {   // 150 s, the footer flipping every scan
        r.screen.text = `${SWITCH.trimEnd()}\n  ${i % 2 ? "● connected" : "○ connected"}\n`;
        await r.poll(5_000);
        awaitingSeen.push(r.awaiting());
        // A delivery arriving whenever the first state is back (a probe on the other state would itself reset it).
        if (i % 2 === 0) heldOnFirstState.push(await r.held());
      }
      expect([unrecognised(r.parked).length, awaitingSeen.some(Boolean), heldOnFirstState.includes("dialog")]).toEqual([0, false, false]);
    } finally { r.stop(); }
  });

  it("the CLI's busy indicator on screen, even standing still, keeps it from counting", async () => {
    const r = rig();
    try {
      r.screen.text = `${SWITCH.trimEnd()}\n✢ Accomplishing… (12s · ↓ 38.0k tokens)\n`;
      await r.poll(3 * 60_000);
      expect([r.parked.length, r.awaiting(), await r.held()]).toEqual([0, false, "clear"]);
    } finally { r.stop(); }
  });

  it("output that arrived while the pane was captured restarts it", async () => {
    const r = rig();
    try {
      // Output lands while each capture is being taken (same screen text): the capture is not quiet evidence.
      const capture = r.d.tmux.capturePane;
      r.d.tmux.capturePane = async () => { r.d.instanceStateLastOutputAt = Date.now(); return capture(); };
      await r.poll(100_000);
      expect([r.parked.length, r.awaiting()]).toEqual([0, false]);
      r.d.tmux.capturePane = capture;   // control: quiet captures — active after a minute
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(unrecognised(r.parked)).toHaveLength(1);
    } finally { r.stop(); }
  });
});

describe("#1695 r2 P2-4: a fresh read before the minute is up resets it too", () => {
  it("55 s in, a probe sees it gone, it comes back before any scan: 15 s later still not active; a fresh minute later it is", async () => {
    const r = rig();
    try {
      await r.poll(55_000);
      r.screen.text = AT_PROMPT;
      expect(await r.held()).toBe("clear");
      r.screen.text = SWITCH;
      await r.poll(15_000);
      expect([await r.held(), r.awaiting(), unrecognised(r.parked).length]).toEqual(["clear", false, 0]);
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS);
      expect(await r.held(), "control: its own minute").toBe("dialog");
    } finally { r.stop(); }
  });

  it("an interaction re-capture (not a probe, not the scan) without the prompt is not the catch-all's evidence", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(await r.held()).toBe("dialog");
      expect(r.d.interactionEvidence(AT_PROMPT, r.d.runtimeDialogs())).toBeNull();
      expect(r.d.interactionEvidence(SWITCH, r.d.runtimeDialogs())?.kind, "control: the prompt itself").toBe("dialog");
    } finally { r.stop(); }
  });

  it("a read taken before the capture that last confirmed it cannot void it (capture order)", async () => {
    const r = rig();
    try {
      await r.poll(30_000);
      const tracked = r.d.unrecognisedPrompt;
      const lastRead = r.d.unrecognisedPromptReadAt;
      r.d.noteFreshPaneRead(AT_PROMPT, lastRead - 1);   // an older read, finishing late
      expect(r.d.unrecognisedPrompt).toBe(tracked);
      r.d.noteFreshPaneRead(AT_PROMPT, lastRead + 1);   // a newer one
      expect(r.d.unrecognisedPrompt).toBeNull();
    } finally { r.stop(); }
  });
});

describe("#1695 r3 P2-4: every accepted fresh read counts, in order", () => {
  /** The real instance-state monitor's re-capture, as the daemon's own does (a real PaneStateMachine). */
  const stateMonitor = (r: ReturnType<typeof rig>) => {
    r.d.instanceStateMachine = new PaneStateMachine(r.d.backend.getReadyPattern(), 600_000, Date.now(), r.d.backend.getBusyPattern());
    r.d.instanceStateMonitorActive = true;
  };

  it("(a) an accepted state re-capture without the prompt ends it: the prompt back before any scan is not held", async () => {
    const r = rig();
    stateMonitor(r);
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(await r.held()).toBe("dialog");
      r.screen.text = AT_PROMPT;
      await r.d.captureAndEvaluateInstanceState("interaction_confirmation");
      expect(r.d.getInteractionSnapshot().phase, "the re-capture was accepted").toBe("clear");
      r.screen.text = SWITCH;
      expect(await r.held(), "no scan in between").toBe("clear");
    } finally { r.stop(); }
  });

  it("(a) control: an accepted state re-capture that still shows it keeps the hold", async () => {
    const r = rig();
    stateMonitor(r);
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      await r.d.captureAndEvaluateInstanceState("interaction_confirmation");
      expect(await r.held()).toBe("dialog");
    } finally { r.stop(); }
  });

  /** A probe whose capture is held until released with a given screen. */
  function heldProbe(r: ReturnType<typeof rig>) {
    let release!: (pane: string) => void;
    const capture = r.d.tmux.capturePane;
    r.d.tmux.capturePane = () => new Promise<string>(resolve => { release = resolve; });
    const result = r.d.probeBlockingDialog();
    r.d.tmux.capturePane = capture;
    return { result, release: (pane: string) => release(pane) };
  }

  it("(b) an older probe finishing after a newer one confirmed the prompt cannot void it", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const older = heldProbe(r);                        // started first …
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await r.held(), "a newer probe confirms it").toBe("dialog");
      older.release(AT_PROMPT);                          // … answers last, with a stale screen
      await older.result;
      expect(await r.held()).toBe("dialog");
    } finally { r.stop(); }
  });

  it("(b) control: an older probe after only the scan's confirmation still voids it (it is newer than the scan)", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const probe = heldProbe(r);
      probe.release(AT_PROMPT);
      await probe.result;
      expect(await r.held()).toBe("clear");
    } finally { r.stop(); }
  });
});

describe("#1695 r4 P2-4: a scan is ordered against every newer read too", () => {
  const stateMonitor = (r: ReturnType<typeof rig>) => {
    r.d.instanceStateMachine = new PaneStateMachine(r.d.backend.getReadyPattern(), 600_000, Date.now(), r.d.backend.getBusyPattern());
    r.d.instanceStateMonitorActive = true;
  };
  /** The interval scan's next capture, held until released with a given screen. */
  async function heldScan(r: ReturnType<typeof rig>) {
    let release: ((pane: string) => void) | null = null;
    const capture = r.d.tmux.capturePane;
    r.d.tmux.capturePane = () => new Promise<string>(resolve => { release = resolve; });
    while (!release) await vi.advanceTimersByTimeAsync(500);
    r.d.tmux.capturePane = capture;
    return async (pane: string) => { release!(pane); await vi.advanceTimersByTimeAsync(0); };
  }

  it("an older scan without the prompt, finishing after a newer state re-capture confirmed it, does not clear it", async () => {
    const r = rig();
    stateMonitor(r);
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      const tracked = r.d.unrecognisedPrompt;
      expect(tracked.active).toBe(true);
      const scan = await heldScan(r);                    // the scan's capture starts …
      await vi.advanceTimersByTimeAsync(1_000);
      await r.d.captureAndEvaluateInstanceState("interaction_confirmation");   // … a newer read confirms it …
      expect(r.d.getInteractionSnapshot().phase).toBe("waiting");
      await scan(AT_PROMPT);                             // … and the scan answers last, with a stale screen
      expect([r.d.unrecognisedPrompt === tracked, await r.held()]).toEqual([true, "dialog"]);
    } finally { r.stop(); }
  });

  it("an older scan showing motion, finishing after a newer probe confirmed it, does not restart the minute", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      const tracked = r.d.unrecognisedPrompt;
      const scan = await heldScan(r);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await r.held(), "a newer probe confirms it").toBe("dialog");
      await scan(`${SWITCH}\n  ⠋ something moved`);
      expect([r.d.unrecognisedPrompt === tracked, tracked.active, await r.held()]).toEqual([true, true, "dialog"]);
    } finally { r.stop(); }
  });

  it("an older scan showing the prompt, finishing after a newer probe ended it, does not bring it back", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      const scan = await heldScan(r);
      await vi.advanceTimersByTimeAsync(1_000);
      r.screen.text = AT_PROMPT;
      expect(await r.held(), "a newer probe sees it gone").toBe("clear");
      await scan(SWITCH);
      expect(r.d.unrecognisedPrompt).toBeNull();
    } finally { r.stop(); }
  });

  it("an older probe without the prompt, finishing after a newer SCAN confirmed it, does not void it", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      let release!: (pane: string) => void;
      const capture = r.d.tmux.capturePane;
      r.d.tmux.capturePane = () => new Promise<string>(resolve => { release = resolve; });
      const probe = r.d.probeBlockingDialog();           // the probe's capture starts …
      r.d.tmux.capturePane = capture;
      await r.poll(5_000);                               // … a scan after it confirms the prompt …
      release(AT_PROMPT);                                // … and the probe answers last, with a stale screen
      await probe;
      expect(await r.held()).toBe("dialog");
    } finally { r.stop(); }
  });

  // r5: nothing tracked yet — a newer read without the prompt still orders the older scan out.
  async function noTrackerThenOldScan(newerRead: ((r: ReturnType<typeof rig>) => Promise<void>) | null) {
    const r = rig({ start: AT_PROMPT });
    stateMonitor(r);
    await r.poll(70_000);
    expect(r.d.unrecognisedPrompt).toBeNull();
    const scan = await heldScan(r);                       // ~70 s: the scan's capture starts …
    await vi.advanceTimersByTimeAsync(1_000);
    if (newerRead) await newerRead(r);                    // … a newer read sees no prompt …
    await scan(SWITCH);                                   // … the scan answers last, with the prompt
    return r;
  }

  it("(a) no tracker: a newer accepted state re-capture without the prompt keeps an older scan from starting evidence", async () => {
    const r = await noTrackerThenOldScan(async r => {
      await r.d.captureAndEvaluateInstanceState("interaction_confirmation");
      expect(r.d.getInteractionSnapshot().phase).toBe("clear");
    });
    try {
      expect(r.d.unrecognisedPrompt).toBeNull();
      r.screen.text = SWITCH;                             // the prompt really shows up later …
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS - 10_000);
      expect([r.awaiting(), await r.held()], "… and gets its own full minute, from its own first scan").toEqual([false, "clear"]);
    } finally { r.stop(); }
  });

  it("(b) no tracker: a newer probe that captured no prompt keeps an older scan from starting evidence", async () => {
    const r = await noTrackerThenOldScan(async r => { expect(await r.held()).toBe("clear"); });
    try {
      expect(r.d.unrecognisedPrompt).toBeNull();
      r.screen.text = SWITCH;
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS - 10_000);
      expect([r.awaiting(), await r.held()]).toEqual([false, "clear"]);
    } finally { r.stop(); }
  });

  it("control: no newer read — the older scan starts the minute, and a minute on it holds", async () => {
    const r = await noTrackerThenOldScan(null);
    try {
      expect(r.d.unrecognisedPrompt?.active).toBe(false);
      r.screen.text = SWITCH;
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS);
      expect(await r.held()).toBe("dialog");
    } finally { r.stop(); }
  });

  it("controls: a NEWER scan still clears, keeps or restarts", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      const tracked = r.d.unrecognisedPrompt;
      expect(await r.held()).toBe("dialog");
      await r.poll(5_000);                               // the same screen: kept
      expect([r.d.unrecognisedPrompt === tracked, await r.held()]).toEqual([true, "dialog"]);
      r.screen.text = `${SWITCH}\n  ⠋ something moved`;
      await r.poll(5_000);                               // motion: a fresh minute
      expect([r.d.unrecognisedPrompt === tracked, r.d.unrecognisedPrompt?.active]).toEqual([false, false]);
      r.screen.text = AT_PROMPT;
      await r.poll(5_000);                               // gone: cleared
      expect(r.d.unrecognisedPrompt).toBeNull();
    } finally { r.stop(); }
  });
});

describe("#1695 P2-3: evidence never outlives its launch", () => {
  it("active, then a respawn: the new launch's first probe is clear; it builds its own minute", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(await r.held()).toBe("dialog");
      r.d.beginSpawn(); r.d.endSpawn();
      expect(await r.held(), "first probe of the new launch").toBe("clear");
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(await r.held(), "control: its own minute").toBe("dialog");
    } finally { r.stop(); }
  });

  it("55 s into the minute, then a respawn: 15 s later it is not active", async () => {
    const r = rig();
    try {
      await r.poll(55_000);
      r.d.beginSpawn(); r.d.endSpawn();
      await r.poll(15_000);
      expect([r.awaiting(), await r.held(), unrecognised(r.parked).length]).toEqual([false, "clear", 0]);
    } finally { r.stop(); }
  });

  it("frozen monitors or another launch fence void it too", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      r.d.launchFenceEpoch++;
      expect(await r.held()).toBe("clear");
    } finally { r.stop(); }
  });
});

describe("#1695 P2-4: a fresh read without the prompt ends the evidence", () => {
  it("probe clear, then the prompt back before any scan: still clear — it needs a fresh minute", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      r.screen.text = AT_PROMPT;
      expect(await r.held()).toBe("clear");
      r.screen.text = SWITCH;
      expect(await r.held(), "no scan in between").toBe("clear");
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(await r.held(), "control: a fresh minute").toBe("dialog");
    } finally { r.stop(); }
  });
});

describe("#1691: a known dialog keeps its own path", () => {
  it("with the real table (#1690 knows 'Switch model?'), the capture is that known dialog — never the catch-all", async () => {
    const r = rig({ knownSwitch: true });
    try {
      await r.poll(3 * 60_000);
      expect(unrecognised(r.parked)).toEqual([]);
      expect(r.parked.map(e => e.description)).toEqual([expect.stringMatching(/model\/effort switch confirmation/)]);
      expect([await r.held(), r.keys]).toEqual(["dialog", []]);
    } finally { r.stop(); }
  });

  it("a backend dialog that knows the screen is the one reported — never the catch-all", async () => {
    const known = { pattern: /Switch model\?/, isActive: (pane: string) => /Switch model\?/.test(pane), keys: [], description: "Claude model switch (known)", holdOnly: true };
    const r = rig({ extraDialogs: [known] });
    try {
      await r.poll(3 * 60_000);
      expect(r.parked.map(e => [e.description, e.unrecognised ?? false])).toEqual([["Claude model switch (known)", false]]);
      expect(r.keys).toEqual([]);
    } finally { r.stop(); }
  });
});

describe("#1691: a [y/n] the interactive-prompt detector already tells", () => {
  it("is held and awaiting input, but told once — by interactive_prompt, not a second time by the catch-all", async () => {
    const r = rig();
    const told: unknown[] = [];
    r.d.on("interactive_prompt", (e: unknown) => told.push(e));
    try {
      r.screen.text = "Installing dependencies…\n\nOverwrite the existing config.yaml? [y/N]\n";
      await r.poll(3 * 60_000);
      expect(told).toHaveLength(1);
      expect(unrecognised(r.parked)).toEqual([]);
      expect([r.awaiting(), await r.held(), r.keys.length]).toEqual([true, "dialog", 0]);
    } finally { r.stop(); }
  });
});

describe("#1691: a known dialog AgEnD answers stays its own even when the answer does not take", () => {
  it("answered every scan and still on screen: never the catch-all (no hold, no unrecognised report)", async () => {
    const known = { pattern: /Switch model\?/, isActive: (pane: string) => /Switch model\?/.test(pane), keys: ["Escape"], description: "Claude model switch (answered)" };
    const r = rig({ extraDialogs: [known] });
    try {
      await r.poll(3 * 60_000);
      expect(unrecognised(r.parked)).toEqual([]);
      expect(r.keys.length, "its own path answered it").toBeGreaterThan(0);
      expect(r.keys.every(k => k === "Escape")).toBe(true);
    } finally { r.stop(); }
  });
});

describe("#1691: the episode", () => {
  it("a delivery probe right after the pane changed sees it free — no waiting for the next scan", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(await r.held()).toBe("dialog");
      r.screen.text = AT_PROMPT;
      expect(await r.held()).toBe("clear");
    } finally { r.stop(); }
  });

  it("before the minute is up, a pane change resets it: the prompt back counts from zero", async () => {
    const r = rig();
    try {
      await r.poll(30_000);
      r.screen.text = AT_PROMPT;
      await r.poll(20_000);
      r.screen.text = SWITCH;
      await r.poll(40_000);   // 90 s since it first appeared, 40 s since it came back
      expect([r.awaiting(), await r.held()]).toEqual([false, "clear"]);
      await r.poll(30_000);
      expect(await r.held(), "control: a minute after it came back").toBe("dialog");
    } finally { r.stop(); }
  });

  it("the same prompt back after a pane change waits a fresh minute", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      r.screen.text = AT_PROMPT;
      await r.poll(10_000);
      r.screen.text = SWITCH;
      await r.poll(30_000);
      expect([r.awaiting(), await r.held()], "not again until it has sat a minute").toEqual([false, "clear"]);
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS);
      expect(await r.held()).toBe("dialog");
    } finally { r.stop(); }
  });

  it("a pane change ends it (deliveries free, not awaiting); the prompt again is a new episode with its own single report", async () => {
    const r = rig();
    try {
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(unrecognised(r.parked)).toHaveLength(1);
      r.screen.text = AT_PROMPT;
      await r.poll(20_000);
      expect([r.awaiting(), await r.held()]).toEqual([false, "clear"]);
      r.screen.text = SWITCH;
      await r.poll(UNRECOGNISED_PROMPT_STABLE_MS + 10_000);
      expect(unrecognised(r.parked)).toHaveLength(2);
      expect(r.keys).toEqual([]);
    } finally { r.stop(); }
  });

  it("held for an hour: one report, one Needs-you item, no keys", async () => {
    const r = rig();
    try {
      await r.poll(60 * 60_000);
      expect(unrecognised(r.parked)).toHaveLength(1);
      expect(r.needsYou()).toHaveLength(1);
      expect(await r.held()).toBe("dialog");
      expect([r.keys, r.pasted]).toEqual([[], []]);
    } finally { r.stop(); }
  });
});

describe("#1691: the shape reader", () => {
  it("a [y/n] question at the bottom; a single option with no neighbour is not a prompt; prose above the bottom is not", () => {
    expect(unrecognisedPromptShape("Some work.\n\nOverwrite config.yaml? [y/N]\n")).toMatchObject({ kind: "yes-no", question: "Overwrite config.yaml? [y/N]" });
    expect(unrecognisedPromptShape("Pick one\n❯ 1. Only option\n")).toBeNull();
    expect(unrecognisedPromptShape(`Pick one\n❯ 1. A\n  2. B\n${"more output\n".repeat(6)}`), "options must be at the bottom").toBeNull();
    expect(unrecognisedPromptShape("Pick\n❯ 1. A\n  3. C\n"), "numbers must run on").toBeNull();
  });
  it("the question line: escapes and control characters out, whitespace collapsed, bounded", () => {
    expect(questionLine("\x1b[1mSwitch\x1b[0m\tmodel?\x07  ")).toBe("Switch model?");
    const long = questionLine("Q".repeat(500));
    expect(long.length).toBe(QUESTION_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("#1691: the notice", () => {
  function lifecycle() {
    const notifyInstanceTopic = vi.fn(() => true);
    const notifyFleetError = vi.fn();
    const ctx = {
      fleetConfig: { defaults: {}, instances: { general: { general_topic: true }, w: {} } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir: dir, getInstanceDir: (name: string) => join(dir, name),
      eventLog: { insert: vi.fn() }, isPlannedRestart: () => false, isClassicInstance: () => false,
      notifyInstanceTopic, notifyFleetError,
    } as unknown as LifecycleContext;
    const daemon = new EventEmitter() as IncidentEventSource & EventEmitter;
    new InstanceLifecycle(ctx).attachIncidentHandlers("w", daemon);
    return { daemon, notifyInstanceTopic, notifyFleetError };
  }
  it.each([
    ["en", "⚠️ w is waiting on a prompt AgEnD doesn't recognise (“Switch model?”). Open its terminal and answer it there: AgEnD won't press anything. Messages to it are held until the prompt is gone."],
    ["zh-TW", "⚠️ w 停在一個 AgEnD 不認得的提示上（「Switch model?」）。請打開它的終端在那裡回答，AgEnD 不會替你按任何鍵。提示消失前，送給它的訊息會先保留。"],
  ] as const)("%s: the topic says what it asks and that nothing is pressed; General is told in one line", (locale, text) => {
    setLocale(locale);
    const { daemon, notifyInstanceTopic, notifyFleetError } = lifecycle();
    daemon.emit("dialog_parked", { name: "w", description: "a prompt AgEnD does not recognise", holdOnly: true, kind: "dialog", episode: 1, unrecognised: true, question: "Switch model?" });
    expect(String((notifyInstanceTopic.mock.calls[0] as unknown[])[1])).toBe(text);
    expect(notifyFleetError).toHaveBeenCalledOnce();
    expect(String(notifyFleetError.mock.calls[0]![0])).toContain("Switch model?");
  });
});
