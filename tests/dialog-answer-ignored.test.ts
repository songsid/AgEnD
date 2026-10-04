import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { InstanceLifecycle, type IncidentEventSource, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale } from "../src/locale.js";

/**
 * A runtime dialog the daemon answers but that stays on screen (the keys had no effect) is reported ONCE per
 * episode, for any backend's dialog. The tmux is a stub serving a scripted pane and recording keys; the backend is a
 * plain table, so nothing here depends on one CLI. Nothing starts a CLI, a fleet or a tmux server.
 */
const SECRET = "PANE-ONLY-MARKER-text";
const PROMPT = `  agent output that mentions ${SECRET}\n\n  Trust this folder?  [Enter] yes\n`;
const CLEAR = "  ❯ Ask anything\n";

let dir: string;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "agend-dialog-ignored-")); mkdirSync(join(dir, "inst")); logger.warn.mockClear(); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); setLocale("en"); });

interface DialogSpec { keys?: string[]; blocksDelivery?: boolean; inputBlocked?: boolean; holdOnly?: boolean; verifyAfterKeys?: boolean; autoResolutionKey?: string }

/** `onKey` decides what the keys did to the screen; by default nothing (the dialog ignores them). */
interface Screen { text: string; queue: string[]; gate: Promise<void> | null; release: (() => void) | null; failKeys: boolean }

function rig(spec: DialogSpec = {}, opts: { onKey?: (screen: Screen) => void; sendResult?: boolean; extraDialogs?: object[] } = {}) {
  /** `queue`: the next reads of the pane, ahead of `text`. `gate`: reads wait on it. `failKeys`: the keys cannot be sent. */
  const screen: Screen = { text: PROMPT, queue: [], gate: null, release: null, failKeys: false };
  const keys: string[] = [];
  const dialog = { pattern: /Trust this folder\?/, description: "Trust prompt", keys: ["Enter"], ...spec };
  const backend: any = {
    binaryName: "fake-cli",
    getRuntimeDialogs: () => [dialog, ...(opts.extraDialogs ?? [])],
    getErrorPatterns: () => [],
    getReadyPattern: () => /Ask anything/,
  };
  const d: any = new Daemon("w", {
    working_directory: dir, backend: "claude-code", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, join(dir, "inst"), false, backend, undefined, logger);
  d.tmux = {
    isWindowAlive: async () => true,
    capturePane: async () => { if (screen.gate) await screen.gate; return screen.queue.length ? screen.queue.shift()! : screen.text; },
    capturePaneWithHistory: async () => screen.text,
    sendSpecialKey: async (key: string) => { if (screen.failKeys) return false; keys.push(key); opts.onKey?.(screen); return opts.sendResult ?? true; },
    pasteText: async () => true,
    getWindowId: () => "@1",
  };
  const ignored: any[] = [];
  const parked: any[] = [];
  d.on("dialog_answer_ignored", (event: unknown) => ignored.push(event));
  d.on("dialog_parked", (event: unknown) => parked.push(event));
  d.startErrorMonitor();
  const poll = (ms = 5_000) => vi.advanceTimersByTimeAsync(ms);
  return { d, screen, keys, ignored, parked, poll, stop: () => clearInterval(d.errorMonitorTimer) };
}

describe("a dialog that ignores the daemon's answer", () => {
  it("is reported once, after the third answer in a row that did nothing — and not again while it stays", async () => {
    const { ignored, poll, keys, stop } = rig();
    await poll(5_600); await poll(5_600);                  // a poll every 5 s; the answer and the look at its effect take ~0.5 s
    expect(ignored).toHaveLength(0);                       // two ignored answers are not yet a pattern
    await poll(5_600);
    expect(ignored).toEqual([{ name: "w", description: "Trust prompt", attempts: 3, holdsDeliveries: false }]);
    await poll(120_000);
    expect(ignored).toHaveLength(1);                       // throttled: once per episode, however long it stays
    expect(keys.length).toBeGreaterThan(3);                // (the answer itself is retried as before — only the silence changed)
    stop();
  });

  it("works for a dialog that holds nothing and for one that holds deliveries — the report says which", async () => {
    const plain = rig();
    await plain.poll(16_000);
    expect(plain.ignored[0].holdsDeliveries).toBe(false);
    plain.stop();
    const held = rig({ blocksDelivery: true, inputBlocked: true });
    await held.poll(16_000);
    expect(held.ignored).toEqual([expect.objectContaining({ attempts: 3, holdsDeliveries: true })]);
    held.stop();
  });

  it("carries the dialog's static description and a count — never the pane", async () => {
    const { ignored, poll, stop } = rig();
    await poll(16_000);
    expect(ignored).toHaveLength(1);
    expect(Object.keys(ignored[0]).sort()).toEqual(["attempts", "description", "holdsDeliveries", "name"]);
    expect(JSON.stringify(ignored)).not.toContain(SECRET);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET);
    stop();
  });

  it("an answer that TOOK is never reported: a burst of fresh prompts, each answered, is not a stuck prompt", async () => {
    // The keys clear the screen; a second later (a model round trip) the agent's next tool call paints the next prompt.
    const { ignored, parked, poll, keys, stop } = rig({ blocksDelivery: true, inputBlocked: true }, {
      onKey: screen => { screen.text = CLEAR; setTimeout(() => { screen.text = PROMPT; }, 1_000); },
    });
    await poll(200_000);                                   // over three minutes: a new prompt at every poll
    expect(keys.length).toBeGreaterThanOrEqual(30);
    expect(ignored).toEqual([]);
    expect(parked).toEqual([]);                            // …and the 60 s "parked" clock restarts with every answered screen
    stop();
  });

  it("needs three IN A ROW: an answer that took in between starts the count over", async () => {
    let took = false;
    const { screen, ignored, poll, stop } = rig({}, { onKey: screen => { if (took) screen.text = CLEAR; } });
    const round = async (tookThis: boolean) => { took = tookThis; screen.text = PROMPT; await poll(5_600); };
    await round(false); await round(false); await round(true); await round(false); await round(false);
    expect(ignored).toHaveLength(0);
    await round(false);
    expect(ignored).toHaveLength(1);
    stop();
  });

  it("a new episode after the dialog was gone is reported again; the same long one is not", async () => {
    const { screen, ignored, poll, stop } = rig();
    await poll(16_000);
    expect(ignored).toHaveLength(1);
    screen.text = CLEAR;                                   // somebody answered it
    await poll(5_000);
    screen.text = PROMPT;                                  // and a later one ignores the daemon too
    await poll(16_000);
    expect(ignored).toHaveLength(2);
    stop();
  });

  it("the later 'parked for a minute' report does not repeat it for the same dialog", async () => {
    const { ignored, parked, poll, stop } = rig({ blocksDelivery: true, inputBlocked: true });
    await poll(100_000);
    expect(ignored).toHaveLength(1);
    expect(parked).toEqual([]);
    stop();
  });

  it("a dialog whose keys could not even be SENT is not 'ignoring' them", async () => {
    const { ignored, poll, stop } = rig({}, { sendResult: false });
    await poll(60_000);
    expect(ignored).toEqual([]);
    stop();
  });

  it("a new spawn is a new pane: the count starts over", async () => {
    const { d, ignored, poll, stop } = rig();
    await poll(5_600); await poll(5_600);
    d.beginSpawn(); d.endSpawn();
    await poll(5_600);                                     // the third answer overall, the first of this pane
    expect(ignored).toEqual([]);
    stop();
  });

  it("a dialog with no keys to press has nothing to ignore", async () => {
    const { keys, ignored, poll, stop } = rig({ keys: [], blocksDelivery: true });
    await poll(30_000);
    expect(keys).toEqual([]);
    expect(ignored).toEqual([]);
    stop();
  });

  it("a hold-only dialog (no keys) is the parked report's business, not this one's", async () => {
    const { keys, ignored, poll, stop } = rig({ keys: [], holdOnly: true, blocksDelivery: true });
    await poll(30_000);
    expect(keys).toEqual([]);
    expect(ignored).toEqual([]);
    stop();
  });

  it("a verify-after-keys dialog keeps its own one-shot path (no second answer, no extra report)", async () => {
    const { d, keys, ignored, poll, stop } = rig({ verifyAfterKeys: true, autoResolutionKey: "trust", blocksDelivery: true, inputBlocked: true });
    d.spawnGeneration = 1;                                 // (a real spawn has begun; the one-shot fence is keyed by it)
    await poll(30_000);
    expect(keys).toEqual(["Enter"]);
    expect(ignored).toEqual([]);
    stop();
  });
});

describe("what counts as 'the same dialog still there'", () => {
  it("the next QUEUED request, painted at once with different content, means the answer was accepted", async () => {
    let n = 0;
    // OpenCode keeps its permission requests in a list and shows the first: answering one shows the next with no
    // model round trip. Each Enter here is followed by the next request (another target) before the look.
    const { ignored, parked, keys, poll, stop } = rig({ blocksDelivery: true, inputBlocked: true }, {
      onKey: screen => { n++; screen.text = PROMPT.replace("folder?", `folder? /srv/queued-${"abcdefghijklmnop"[n % 16]}${"xyz"[n % 3]}`); },
    });
    await poll(100_000);
    expect(keys.length).toBeGreaterThanOrEqual(15);
    expect(ignored).toEqual([]);
    expect(parked).toEqual([]);
    stop();
  });

  it("identical requests one after the other look like an ignored answer — said so, not hidden (the pane cannot tell them apart)", async () => {
    const { ignored, poll, stop } = rig({ blocksDelivery: true, inputBlocked: true });
    await poll(16_800);
    expect(ignored).toHaveLength(1);
    stop();
  });

  it("a redraw of the same dialog (spinner frame, counters, spacing) is still the same dialog", async () => {
    let i = 0;
    const ticking = () => `${PROMPT}   ${"⠋⠙⠹⠸⠼⠴"[i % 6]} waiting ${i + 1}s  tokens: ${1000 + i}\n`.replace(/ {2,}/g, i % 2 ? "    " : "  ");
    const { screen, ignored, poll, stop } = rig({}, { onKey: screen => { i++; screen.text = ticking(); } });
    screen.text = ticking();
    await poll(16_800);
    expect(ignored).toHaveLength(1);
    stop();
  });
});

describe("a poll that does not complete an answer breaks 'in a row'", () => {
  const twoIgnored = async (r: ReturnType<typeof rig>) => { await r.poll(5_600); await r.poll(5_600); };

  it("a poll whose re-read under the lock finds the dialog already gone ends the episode", async () => {
    const r = rig();
    await twoIgnored(r);
    r.screen.queue = [PROMPT, CLEAR];                      // the monitor saw it, the re-read under the lock did not
    await r.poll(5_600);
    r.screen.queue = [];
    await r.poll(5_600);                                   // one ignored answer: not the third
    expect(r.ignored).toEqual([]);
    await r.poll(11_200);
    expect(r.ignored).toEqual([expect.objectContaining({ attempts: 3 })]);
    r.stop();
  });

  it("an episode that was reported is over once it is seen gone there: the next one is reported again", async () => {
    const r = rig();
    await r.poll(16_800);
    expect(r.ignored).toHaveLength(1);
    r.screen.queue = [PROMPT, CLEAR];
    await r.poll(5_600);
    await r.poll(16_800);                                  // three more ignored answers
    expect(r.ignored).toHaveLength(2);
    r.stop();
  });

  it("keys that could not be sent", async () => {
    const r = rig();
    await twoIgnored(r);
    r.screen.failKeys = true; await r.poll(5_600); r.screen.failKeys = false;
    await r.poll(5_600);
    expect(r.ignored).toEqual([]);
    await r.poll(11_200);
    expect(r.ignored).toEqual([expect.objectContaining({ attempts: 3 })]);
    r.stop();
  });

  it("a DIFFERENT dialog (here one with no keys to press) on screen in between: the episode being counted is gone", async () => {
    const other = { pattern: /Other prompt/, description: "Other prompt", keys: [] };
    const r = rig({}, { extraDialogs: [other] });
    await twoIgnored(r);
    r.screen.text = "  Other prompt  [Enter]\n"; await r.poll(5_600);
    r.screen.text = PROMPT;
    await r.poll(5_600);                                   // one ignored answer of a NEW episode
    expect(r.ignored).toEqual([]);
    await r.poll(11_200);
    expect(r.ignored).toEqual([expect.objectContaining({ attempts: 3 })]);
    r.stop();
  });

  it("…and an episode that was already reported does not stay 'reported' across it", async () => {
    const other = { pattern: /Other prompt/, description: "Other prompt", keys: [] };
    const r = rig({}, { extraDialogs: [other] });
    await r.poll(16_800);
    expect(r.ignored).toHaveLength(1);
    r.screen.text = "  Other prompt  [Enter]\n"; await r.poll(5_600);
    r.screen.text = PROMPT;
    await r.poll(16_800);
    expect(r.ignored).toHaveLength(2);
    r.stop();
  });

  it("a poll deferred because the pane lock was busy", async () => {
    const r = rig();
    await twoIgnored(r);
    let release!: () => void;
    const holding = r.d.paneWriteLock.run(() => new Promise<void>(resolve => { release = resolve; }));
    await r.poll(5_600);                                   // the scan finds the lock taken and defers
    release(); await holding;
    await r.poll(5_600);
    expect(r.ignored).toEqual([]);
    await r.poll(11_200);
    expect(r.ignored).toEqual([expect.objectContaining({ attempts: 3 })]);
    r.stop();
  });
});

describe("a read that outlives its spawn or its monitors changes nothing", () => {
  /** The third answer's look at the pane is held; `interrupt` happens while it is pending. */
  async function heldThirdLook(interrupt: (d: any) => void) {
    let n = 0;
    const r = rig({}, { onKey: screen => { if (++n === 3) screen.gate = new Promise<void>(resolve => { screen.release = resolve; }); } });
    await r.poll(5_600); await r.poll(5_600);
    await r.poll(5_600);                                   // the third answer: its look is waiting on the gate
    expect(r.keys).toHaveLength(3);
    interrupt(r.d);
    r.screen.gate = null; r.screen.release?.();
    await r.poll(100);
    return r;
  }

  it("a spawn that began meanwhile starts its own count: the old read is dropped, not counted into it", async () => {
    const r = await heldThirdLook(d => { d.beginSpawn(); d.endSpawn(); });
    expect(r.ignored).toEqual([]);
    await r.poll(5_600);                                   // the new spawn's FIRST answer…
    await r.poll(5_600);                                   // …and its second
    expect(r.ignored).toEqual([]);
    await r.poll(5_600);
    expect(r.ignored).toEqual([expect.objectContaining({ attempts: 3 })]);
    r.stop();
  });

  it("monitors frozen meanwhile (stop / pause): nothing is reported afterwards", async () => {
    const r = await heldThirdLook(d => d.freezeRuntimeMonitors());
    expect(r.ignored).toEqual([]);
    await r.poll(30_000);
    expect(r.ignored).toEqual([]);
  });
});

describe("the lifecycle turns the event into a notice", () => {
  function lifecycle(planned = false) {
    const notifyInstanceTopic = vi.fn(() => true);
    const notifyFleetError = vi.fn();
    const eventLog = { insert: vi.fn() };
    const ctx = {
      fleetConfig: { defaults: { backend: "kiro-cli" }, instances: { general: { general_topic: true }, w: {} } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir: dir, getInstanceDir: (name: string) => join(dir, name),
      eventLog, isPlannedRestart: () => planned, isClassicInstance: () => false,
      notifyInstanceTopic, notifyFleetError,
    } as unknown as LifecycleContext;
    const daemon = new EventEmitter() as IncidentEventSource & EventEmitter;
    new InstanceLifecycle(ctx).attachIncidentHandlers("w", daemon);
    return { daemon, notifyInstanceTopic, notifyFleetError, eventLog };
  }

  it("tells the instance's topic (with the hold note only when deliveries are held) and the fleet, and logs the event", () => {
    const { daemon, notifyInstanceTopic, notifyFleetError, eventLog } = lifecycle();
    daemon.emit("dialog_answer_ignored", { name: "w", description: "Trust prompt", attempts: 3, holdsDeliveries: false });
    daemon.emit("dialog_answer_ignored", { name: "w", description: "Trust prompt", attempts: 3, holdsDeliveries: true });
    const [plain, held] = notifyInstanceTopic.mock.calls.map(call => String((call as unknown[])[1]));
    expect(plain).toMatch(/w.*Trust prompt.*3 tries in a row.*by hand/s);
    expect(plain).not.toMatch(/held/);
    expect(held).toMatch(/Deliveries to this instance are held/);
    expect(notifyFleetError).toHaveBeenCalledTimes(2);
    expect(String(notifyFleetError.mock.calls[0]![0])).toMatch(/Trust prompt.*3 tries/);
    expect(eventLog.insert).toHaveBeenCalledWith("w", "dialog_answer_ignored", { description: "Trust prompt", attempts: 3, holdsDeliveries: false });
  });

  it("is silent (but still logged) during a planned restart", () => {
    const { daemon, notifyInstanceTopic, notifyFleetError, eventLog } = lifecycle(true);
    daemon.emit("dialog_answer_ignored", { name: "w", description: "Trust prompt", attempts: 3, holdsDeliveries: true });
    expect(notifyInstanceTopic).not.toHaveBeenCalled();
    expect(notifyFleetError).not.toHaveBeenCalled();
    expect(eventLog.insert).toHaveBeenCalledTimes(1);
  });

  it("says the same thing in zh-TW", () => {
    const { daemon, notifyInstanceTopic } = lifecycle();
    setLocale("zh-TW");
    daemon.emit("dialog_answer_ignored", { name: "w", description: "Trust prompt", attempts: 3, holdsDeliveries: true });
    expect(String((notifyInstanceTopic.mock.calls[0] as unknown[])[1])).toMatch(/自動回答沒有生效.*3 次.*訊息會先保留/s);
  });
});
