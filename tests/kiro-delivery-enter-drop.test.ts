import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { KiroBackend } from "../src/backend/kiro.js";

/**
 * Regression for the Kiro "pasted but never submitted" bug, reproduced live on
 * kiro-cli 2.21.0 --legacy-ui (2026-09-03):
 *
 *   Kiro DROPS an Enter that arrives while it is busy but keeps the typed text as
 *   typeahead. The daemon's delivery idle gate for Kiro used to be output
 *   silence alone (2s), and a shell/MCP tool call is silent for its whole
 *   duration — so a message queued while the instance was working got pasted
 *   into that window, both Enters were dropped, "some output after Enter"
 *   (the turn's own output) confirmed it ✅, and the text sat in the prompt row
 *   until the next delivery submitted two messages as one.
 *
 * The frames below are the verbatim pane tails from that reproduction.
 */
const TOOL_RUNNING = [
  "1% !> Use your shell tool to run exactly this command and nothing else: sleep 9; echo DONE-MARKER .",
  "I will run the following command: sleep 9; echo DONE-MARKER (using tool: shell)",
  "Purpose: Sleep 9 seconds then echo marker",
].join("\n");
const IDLE_BARE = " ▸ Time: 15s\n2% !>";
const MESSAGE = "[user:hanhanv via discord, id:368442276000694273] MSG-1 pasted while kiro was busy\n(message_id: 1)";
const STRANDED = ` ▸ Time: 15s\n2% !> ${MESSAGE.split("\n")[0]}`;
const GENERATING = `2% !> ${MESSAGE.split("\n")[0]}\n⠇ Thinking...`;
const OLD_STRANDED = " ▸ Time: 9s\n7% !> [from:agend-leader-t1503382358143799511] an earlier message whose Enter was dropped";

const KIRO_COMPAT = {
  version: "kiro-cli 2.21.0", supportsRequireMcpStartup: true, supportsLegacyUi: true, supportsEffortFlag: true, source: "version" as const,
};

interface Harness {
  daemon: any;
  state: { pane: string; silent: boolean; outputSince: boolean };
  paste: ReturnType<typeof vi.fn>;
  enter: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  events: string[];
  dir: string;
}

function makeHarness(backend: unknown): Harness {
  const dir = mkdtempSync(join(tmpdir(), "agend-kiro-enter-drop-"));
  writeFileSync(join(dir, "window-id"), "@7");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("kiro-test", {
    working_directory: "/tmp",
    backend: "kiro-cli",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any) as any;

  const state = { pane: IDLE_BARE, silent: true, outputSince: true };
  const paste = vi.fn(async () => true);
  const enter = vi.fn(async () => true);
  const capture = vi.fn(async () => state.pane);
  daemon.tmux = {
    capturePane: capture,
    pasteBuffer: paste,
    sendSpecialKey: enter,
    sendKeys: vi.fn(async () => true),
    isWindowAlive: async () => true,
    getWindowId: () => "@7",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
  };
  daemon.controlClient = {
    isIdle: () => state.silent,
    waitUntilIdle: async () => { while (!state.silent) await new Promise(r => setTimeout(r, 50)); return true; },
    hasOutputSince: () => state.outputSince,
    getLastOutputAt: () => 0,
    getObservationResetAt: () => 0,
  };
  const events: string[] = [];
  for (const e of ["message_queued", "message_delivered", "message_confirmed", "message_failed"]) {
    daemon.on(e, () => events.push(e));
  }
  return { daemon, state, paste, enter, capture, events, dir };
}

/** Drive a delivery under fake timers until it settles (or the budget runs out). */
async function settle<T>(promise: Promise<T>, maxMs = 120_000): Promise<T> {
  let done = false;
  let result!: T;
  void promise.then(v => { result = v; done = true; });
  for (let elapsed = 0; !done && elapsed <= maxMs; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
  if (!done) throw new Error(`delivery did not settle within ${maxMs}ms of fake time`);
  return result;
}

const kiro = () => new KiroBackend(mkdtempSync(join(tmpdir(), "agend-kiro-be-")), KIRO_COMPAT);
const STATUS = { chatId: "c", messageId: "m" };
const dirs: string[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("kiro delivery: Enter dropped while busy (F1 bottom-anchored ready gate)", () => {
  it("does not paste into a quiet pane whose bottom row is a running tool, then pastes once the prompt is back", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.pane = TOOL_RUNNING;          // silent (identical frames) but busy
    h.state.silent = true;

    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, {});
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.events).toContain("message_queued");

    // The tool finishes and the prompt returns; the paste is then submitted and
    // the generation spinner confirms it.
    h.state.pane = IDLE_BARE;
    let pastes = 0;
    h.paste.mockImplementation(async () => { pastes++; h.state.pane = GENERATING; return true; });
    const ok = await settle(delivery);

    expect(ok).toBe(true);
    expect(pastes).toBe(1);
    expect(h.events).toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
  });
});

describe("kiro delivery: unknown pane shapes never wedge the gate", () => {
  it("falls back to the silence decision when no prompt row is visible anywhere (panel/modal/blank)", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.pane = "";                    // nothing recognisable on screen
    h.paste.mockImplementation(async () => { h.state.pane = GENERATING; return true; });

    const ok = await settle(h.daemon.deliverMessage(MESSAGE, STATUS, {}), 10_000);

    expect(ok).toBe(true);
    expect(h.paste).toHaveBeenCalledTimes(1);
  });
});

describe("kiro delivery: submission verification (F2)", () => {
  it("re-sends Enter once the prompt is back when the first Enters were dropped, and only then confirms", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    // Paste lands, but both Enters are dropped: the text stays in the input row.
    h.paste.mockImplementation(async () => { h.state.pane = STRANDED; return true; });
    let enters = 0;
    h.enter.mockImplementation(async () => {
      enters++;
      // The third Enter (stranded-text-retry) is the one Kiro honours.
      if (enters >= 3) h.state.pane = GENERATING;
      return true;
    });

    const ok = await settle(h.daemon.deliverMessage(MESSAGE, STATUS, {}));

    expect(ok).toBe(true);
    expect(enters).toBe(3); // initial + queue-less defensive + stranded-text-retry
    expect(h.events).toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
  });

  it("reports failure instead of a false ✅ when the text never leaves the input row", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.paste.mockImplementation(async () => { h.state.pane = STRANDED; return true; });
    // Kiro keeps producing output (the old confirmation would have accepted this).
    h.state.outputSince = true;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE, STATUS, {}));

    expect(ok).toBe(false);
    expect(h.events).toContain("message_failed");
    expect(h.events).not.toContain("message_confirmed");
  });
});

describe("kiro delivery: stranded message from an earlier delivery (F3)", () => {
  it("submits the stranded text with one bare Enter before pasting the new message", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.pane = OLD_STRANDED;
    const order: string[] = [];
    h.enter.mockImplementation(async () => {
      order.push("enter");
      // The stranded submission runs its turn, then the prompt comes back.
      if (h.state.pane === OLD_STRANDED) { h.state.pane = " ▸ Time: 3s\n8% !>"; }
      else h.state.pane = GENERATING;
      return true;
    });
    h.paste.mockImplementation(async () => { order.push("paste"); h.state.pane = STRANDED; return true; });

    const ok = await settle(h.daemon.deliverMessage(MESSAGE, STATUS, {}));

    expect(ok).toBe(true);
    expect(order[0]).toBe("enter");                 // stranded text submitted first
    expect(order.indexOf("paste")).toBeGreaterThan(0);
    expect(h.events).toContain("message_confirmed");
  });

  it("never sends a bare Enter for Kiro's own placeholder hint or an empty prompt", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.pane = " ▸ Time: 2s\n2% !> Not sure where to start? Ask me about my features";
    const order: string[] = [];
    h.enter.mockImplementation(async () => { order.push("enter"); h.state.pane = GENERATING; return true; });
    h.paste.mockImplementation(async () => { order.push("paste"); return true; });

    await settle(h.daemon.deliverMessage(MESSAGE, STATUS, {}));

    expect(order[0]).toBe("paste");                 // no pre-submit Enter
  });
});

describe("non-Kiro backends keep the silence-based delivery path", () => {
  it("does not gate on the pane bottom row and confirms via idle→busy output as before", async () => {
    const plain = {
      binaryName: "claude",
      getReadyPattern: () => /❯/,
      getBusyPattern: () => null,
    };
    const h = makeHarness(plain); dirs.push(h.dir);
    h.state.pane = TOOL_RUNNING;      // would block Kiro; must not block others
    h.state.silent = true;
    h.state.outputSince = true;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE, STATUS, {}));

    expect(ok).toBe(true);
    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.capture).not.toHaveBeenCalled(); // no bottom-row gating, no residue checks
    expect(h.enter).toHaveBeenCalledTimes(1);   // no defensive retry for this backend
    expect(h.events).toContain("message_confirmed");
  });
});
