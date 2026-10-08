/**
 * #1405: a durable steer into a busy kiro TUI. The composer is read on every delivery and nothing else is trusted:
 * admitted only while it reads "steer" (on the hand-off gate, the pre-write re-check and the last capture before the
 * paste); the box must hold the paste before the one Enter and be the empty placeholder again after it. No defensive
 * second Enter, no Ctrl+S. Real Daemon, real DeliveryOutbox, real KiroBackend launched by the production buildCommand
 * (`--tui`, kiro-cli 2.27.1); a stub tmux serves the real 2.27.1 busy pane and its TEMPLATE variants
 * (kiro-steer-1405.test.ts). Nothing starts a CLI or a tmux server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { KiroBackend, type KiroCliCompatibility } from "../src/backend/kiro.js";

const BUSY = readFileSync(join(import.meta.dirname, "fixtures", "kiro-reply-guard", "tui-busy.pane.txt"), "utf8");
const COMPOSER = "›  Kiro is working · 0s · Type to steer · Ctrl+S to queue";
const composer = (row: string) => BUSY.replace(COMPOSER, row);
const QUEUE = composer("›  Kiro is working · 0s · Type to queue · Ctrl+S to steer");
const IDLE = composer("›  ask a question or describe a task ↵");
/** The box holding the paste: its first row is the start of what this delivery pasted (set by the stub pasteBuffer). */
let HOLDING = composer("›  (nothing pasted yet)");
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

const COMPAT: KiroCliCompatibility = {
  version: "kiro-cli 2.27.1", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: false, source: "version",
};

const roots: string[] = [];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { AGEND_HOME: process.env.AGEND_HOME, KIRO_HOME: process.env.KIRO_HOME };
  const home = mkdtempSync(join(tmpdir(), "agend-1405d-home-")); roots.push(home);
  process.env.AGEND_HOME = join(home, "agend");
  process.env.KIRO_HOME = join(home, "kiro");
});
afterEach(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function kiro(root: string, kiroUi: "tui" | "legacy" = "tui", version = COMPAT.version): KiroBackend {
  const instanceDir = join(root, "instances", "worker");
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const b = new KiroBackend(instanceDir, { ...COMPAT, version });
  b.buildCommand({ workingDirectory: work, instanceDir, instanceName: "worker", mcpServers: {}, kiroUi });
  return b;
}

interface Opts {
  kiroUi?: "tui" | "legacy";
  /** The pane on each capture: before the paste, while the box holds it, after the Enter. An Error is thrown; a
   *  promise is a capture still in flight (held). `daemon` lets a capture simulate a respawn, pause or stop. */
  pane?: (s: { pasted: boolean; entered: boolean; captures: number; daemon: any }) => string | Error | Promise<string>;
  dialogOnVerify?: boolean;
  /** The dialog probe after the Enter takes this long (held). */
  dialogProbeMs?: number;
  /** The backend launched for this delivery (default: kiro-cli 2.27.1 with --tui). */
  version?: string;
  /** Runs as the last capture before the paste is taken (the hand-off's final admission). */
  beforeBaseline?: (daemon: any) => void;
  /** Called with a function that moves performance.now() forward (an event-loop stall), for panes/probes to use. */
  stall?: { ms: number; on: "capture-before-enter" | "dialog-probe" | "after-pre-enter-read" | "enter-transient" };
  /** waitForPaneReadyForDelivery's answer (a delivery that is not handed off waits for the idle prompt). */
  becameIdle?: boolean;
}

async function steer(opts: Opts = {}) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-1405d-")); roots.push(root);
  const instanceDir = join(root, "instances", "worker");
  const backend = kiro(root, opts.kiroUi, opts.version);
  expect(backend.supportsSteer()).toBe((opts.kiroUi ?? "tui") === "tui" && (opts.version ?? COMPAT.version) === COMPAT.version);
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "kiro",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, backend as any,
  { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => false, waitUntilIdle: vi.fn(async () => true) } as any, logger);
  daemon.setDeliveryOutboxPort(outbox);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const row = outbox.admit({
    operationId: "op", sourceKey: "s:op:w:steer", sourceInstance: "source", sourceDaemonBootId: "sb",
    targetInstance: "worker", kind: "steer", payload: { type: "steer", content: "hello", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  const s = { pasted: false, entered: false, captures: 0, daemon };
  const pane = opts.pane ?? (({ pasted, entered }) => (entered ? BUSY : pasted ? HOLDING : BUSY));
  // An event-loop stall: the continuation after an answer runs this much later than the answer itself.
  let stallOffset = 0;
  const realNow = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + stallOffset);
  const tmux = {
    capturePane: vi.fn(async () => {
      s.captures++;
      const v = await pane(s);
      if (v instanceof Error) throw v;
      if (opts.stall?.on === "capture-before-enter" && s.pasted && !s.entered) stallOffset += opts.stall.ms;
      return v;
    }),
    pasteBuffer: vi.fn(async (text: string) => {
      s.pasted = true;
      HOLDING = composer(`›  ${text.split("\n").find(l => l.trim()) ?? ""}`);
      return true;
    }),
    sendSpecialKey: vi.fn(async () => { s.entered = true; return true; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockImplementation(async (phase: unknown) => {
    // the transient wait inside the Enter primitive outlives the pre-Enter budget
    if (opts.stall?.on === "enter-transient" && phase === "initial-submit") stallOffset += opts.stall.ms;
    return true;
  });
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
  const waitIdle = vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(opts.becameIdle ?? false);
  const clear = { state: "clear" } as const;
  const dialog = { state: "dialog", dialog: { description: "a dialog" } } as any;
  const verifyProbe = () => {
    // the stall lands as the probe answers: its budget was positive when asked, the continuation runs past it
    if (opts.stall?.on === "dialog-probe") return Promise.resolve().then(() => { stallOffset += opts.stall!.ms; return clear; });
    if (opts.dialogProbeMs === Infinity) return new Promise(() => {});      // never answers
    return opts.dialogProbeMs
      ? new Promise(r => setTimeout(() => r(clear), opts.dialogProbeMs))
      : Promise.resolve(opts.dialogOnVerify ? dialog : clear);
  };
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValueOnce(clear).mockResolvedValueOnce(clear)
    .mockImplementation(verifyProbe as any);
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  const realWithin = daemon.steerComposerWithin.bind(daemon);
  vi.spyOn(daemon, "steerComposerWithin").mockImplementation(async (...args: unknown[]) => {
    const look = await realWithin(...args);
    // a valid reading, whose caller continues only after a stall (the helper's own check passed)
    if (opts.stall?.on === "after-pre-enter-read" && s.pasted && !s.entered && look) await Promise.resolve().then(() => { stallOffset += opts.stall!.ms; });
    return look;
  });
  const admits = vi.spyOn(daemon, "steerComposerAdmits");
  const realBaseline = daemon.capturePaneEvidence.bind(daemon);
  const baseline = vi.spyOn(daemon, "capturePaneEvidence").mockImplementation(async (...args: unknown[]) => {
    opts.beforeBaseline?.(daemon);
    return realBaseline(...args);
  });
  const meta = {
    delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
    user: "instance:source", user_id: "instance:source", message_id: "message-1405", chat_id: "", thread_id: "", ts: new Date().toISOString(),
  };
  daemon.steerMessage("hello", meta);
  await vi.runAllTimersAsync();
  await daemon.steerLock;
  const db = (outbox as any).db;
  return {
    outbox, tmux, waitIdle, daemon,
    /** Each composer admission asked, by its allowIdle argument: false = the hand-off gate, true = the pre-write re-check. */
    admitted: await Promise.all(admits.mock.calls.map(async (args, i) => [args[0], await admits.mock.results[i]!.value])),
    baselineReads: baseline.mock.calls.length,
    delivery: outbox.get(row.deliveryId)!,
    attempt: db.prepare("SELECT * FROM delivery_attempts WHERE delivery_id=?").get(row.deliveryId),
  };
}

describe("the hub's question reaches the launch", () => {
  it("Daemon.launchSupportsSteer answers from the backend it launched; a backend without the method leaves it to the name table", () => {
    const root = mkdtempSync(join(tmpdir(), "agend-1405d-")); roots.push(root);
    const daemonFor = (backend: unknown) => new Daemon("worker", {
      working_directory: root, log_level: "error",
      restart_policy: { max_retries: 1, backoff: "linear", reset_after: 1 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    } as any, join(root, "instances", "worker"), false, backend as any, undefined, logger);
    expect(daemonFor(kiro(root, "tui")).launchSupportsSteer()).toBe(true);
    expect(daemonFor(kiro(root, "legacy")).launchSupportsSteer()).toBe(false);
    expect(daemonFor({ binaryName: "claude" }).launchSupportsSteer()).toBeUndefined();
  });

  it("FleetManager.instanceLaunchSupportsSteer asks that instance's running Daemon; none running is undefined", () => {
    const fleet = { daemons: new Map([["w", { launchSupportsSteer: () => true }], ["l", { launchSupportsSteer: () => false }]]) };
    const ask = (name: string) => FleetManager.prototype.instanceLaunchSupportsSteer.call(fleet as any, name);
    expect(ask("w")).toBe(true);
    expect(ask("l")).toBe(false);
    expect(ask("gone")).toBeUndefined();
  });
});

describe("a steer into a busy kiro TUI whose composer reads steer", () => {
  it("is pasted, entered once, and delivered when the box is empty again — labelled as taken from the box", async () => {
    const r = await steer();
    expect(r.delivery.state).toBe("delivered");
    expect(r.attempt.evidence).toBe("steer-accepted; composer emptied (steer)");
    expect(r.attempt.submission_mode).toBe("steer");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(r.tmux.sendSpecialKey).toHaveBeenCalledOnce();         // no defensive second Enter, no Ctrl+S
    expect(r.tmux.sendSpecialKey.mock.calls.flat()).not.toContain("C-s");
    r.outbox.close();
  });

  it("the user switching to queue meanwhile, or the turn ending, still empties the box: delivered, saying which", async () => {
    for (const [after, label] of [[QUEUE, "queue"], [IDLE, "idle"]] as const) {
      const r = await steer({ pane: ({ pasted, entered }) => (entered ? after : pasted ? HOLDING : BUSY) });
      expect(r.attempt.evidence).toBe(`steer-accepted; composer emptied (${label})`);
      r.outbox.close();
    }
  });

  it("the box still holding the text after the Enter is uncertain — never pasted or entered again", async () => {
    const r = await steer({ pane: ({ pasted }) => (pasted ? HOLDING : BUSY) });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("steer-proof:composer-not-emptied");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(r.tmux.sendSpecialKey).toHaveBeenCalledOnce();
    r.outbox.close();
  });

  it("a paste that never reached the box gets no Enter", async () => {
    const r = await steer({ pane: () => BUSY });
    expect(r.delivery.state).not.toBe("delivered");
    expect(r.attempt.evidence).toBe("steer-paste:box-still-steer");
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("a dialog after the Enter is never taken as the box emptying", async () => {
    const r = await steer({ dialogOnVerify: true });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("steer-proof:composer-not-emptied");
    r.outbox.close();
  });
});

describe("a steer that is not handed off: it waits for the idle prompt like any message", () => {
  it("queue mode (the user's choice) at the gate: the gate refuses the hand-off — no paste, no toggle", async () => {
    const r = await steer({ pane: () => QUEUE });
    expect(r.admitted).toEqual([[false, false]]);                // only the gate was asked; nothing reached the write lock
    expect(r.waitIdle).toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.delivery.state).not.toBe("delivered");
    r.outbox.close();
  });

  it("switched to queue after the gate: the pre-write re-check refuses before the last capture is even taken", async () => {
    const r = await steer({ pane: ({ captures }) => (captures <= 1 ? BUSY : QUEUE) });
    expect(r.admitted.slice(0, 2)).toEqual([[false, true], [true, false]]);
    expect(r.baselineReads).toBe(0);
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("switched to queue on the very last capture before the paste: that capture refuses it — not written", async () => {
    // gate (1) and pre-write re-check (2) read steer; the baseline capture just before the paste reads queue
    const r = await steer({ pane: ({ captures }) => (captures <= 2 ? BUSY : QUEUE) });
    expect(r.admitted.slice(0, 2)).toEqual([[false, true], [true, true]]);
    expect(r.baselineReads).toBeGreaterThan(0);
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("text already in the box at the gate (a draft): not handed off", async () => {
    const r = await steer({ pane: () => HOLDING });
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("the legacy UI: no composer to read, so never handed off", async () => {
    const r = await steer({ kiroUi: "legacy" });
    expect(r.waitIdle).toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });
});

describe("#1432 review: what is not proof, and what no longer belongs to this write", () => {
  const held = (ms: number, value: string) => new Promise<string>(r => setTimeout(() => r(value), ms));

  it("a failed capture before the Enter is not 'the box holds the paste': no Enter, not delivered (P1)", async () => {
    // the paste was swallowed: every readable frame is the empty steer composer; only the pre-Enter reads fail
    const r = await steer({ pane: ({ pasted, entered }) => (pasted && !entered ? new Error("capture failed") : BUSY) });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.delivery.state).not.toBe("delivered");
    expect(r.attempt.evidence).toBe("steer-paste:box-unread");
    r.outbox.close();
  });

  it("…while a readable box holding the paste is the control: entered once, delivered", async () => {
    const r = await steer({ pane: ({ pasted, entered }) => (entered ? BUSY : pasted ? HOLDING : BUSY) });
    expect(r.tmux.sendSpecialKey).toHaveBeenCalledOnce();
    expect(r.delivery.state).toBe("delivered");
    r.outbox.close();
  });

  it("a respawn during the pre-Enter read: no Enter on either tmux, not delivered (P2)", async () => {
    const replacement = { capturePane: vi.fn(async () => BUSY), sendSpecialKey: vi.fn(async () => true), pasteBuffer: vi.fn(),
      getLastSendSpecialKeyError: vi.fn(), getWindowId: () => "@worker" };
    const r = await steer({ pane: ({ pasted, entered, daemon }) => {
      if (pasted && !entered && daemon.tmux !== replacement) { daemon.spawnGeneration += 1; daemon.tmux = replacement; }
      return pasted ? HOLDING : BUSY;
    } });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(replacement.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.delivery.state).not.toBe("delivered");
    r.outbox.close();
  });

  it("a pause during the pre-Enter read (the launch fence moves): no Enter (P2)", async () => {
    const r = await steer({ pane: ({ pasted, entered, daemon }) => {
      if (pasted && !entered) daemon.launchFenceEpoch += 1;
      return pasted ? HOLDING : BUSY;
    } });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.delivery.state).not.toBe("delivered");
    r.outbox.close();
  });

  it("a stop after the Enter: the later empty frame is not accepted (P2)", async () => {
    const r = await steer({ pane: ({ pasted, entered, daemon }) => {
      if (entered) { daemon.deliveryWritesStopping = true; return BUSY; }
      return pasted ? HOLDING : BUSY;
    } });
    expect(r.tmux.sendSpecialKey).toHaveBeenCalledOnce();
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("steer-proof:fenced");
    r.outbox.close();
  });

  it("a saved steer replayed to a launch that does not take one waits for the idle prompt (P3)", async () => {
    const r = await steer({ version: "kiro-cli 2.28.0" });              // TUI, composer reads steer, version unverified
    expect(r.waitIdle).toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("…and a launch replaced by an unverified one after the gate is sent back to the top, then down the idle path (P3)", async () => {
    const r = await steer({ pane: ({ captures, daemon }) => {
      // the gate (capture 1) saw a supported launch; by the pre-write re-check the instance runs an unverified version
      if (captures === 1) (daemon.backend as any).compatibility = { ...COMPAT, version: "kiro-cli 2.28.0" };
      return BUSY;
    } });
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(r.waitIdle).toHaveBeenCalled();
    r.outbox.close();
  });

  it("a draft arriving after the gate — even one starting with the idle placeholder's words — is not written onto (P4)", async () => {
    const draft = composer("›  ask a question or describe a task that retrieves my logs");
    const r = await steer({ pane: ({ captures }) => (captures <= 1 ? BUSY : draft) });
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("a capture held past the proof's budget is dropped: uncertain, never delivered late (P5)", async () => {
    const r = await steer({ pane: ({ pasted, entered }) => (entered ? held(4_000, BUSY) : pasted ? HOLDING : BUSY) });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("steer-proof:composer-not-emptied");
    r.outbox.close();
  });

  it("a dialog probe held past the budget is dropped too (P5)", async () => {
    const r = await steer({ dialogProbeMs: 10_000 });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("steer-proof:composer-not-emptied");
    r.outbox.close();
  });

  it("…and one that never answers does not hold the delivery (P5)", async () => {
    const r = await steer({ dialogProbeMs: Infinity });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("steer-proof:composer-not-emptied");
    r.outbox.close();
  });

  it("…while a slow capture inside the budget is the control: delivered (P5)", async () => {
    const r = await steer({ pane: ({ pasted, entered }) => (entered ? held(500, BUSY) : pasted ? HOLDING : BUSY), dialogProbeMs: 200 });
    expect(r.delivery.state).toBe("delivered");
    r.outbox.close();
  });
});

describe("#1432 review: each guard on its own", () => {
  it("a tmux swapped during the pre-Enter read, with no new spawn, still gets no Enter: the write is bound to its tmux", async () => {
    const replacement = { capturePane: vi.fn(async () => BUSY), sendSpecialKey: vi.fn(async () => true), pasteBuffer: vi.fn(),
      getLastSendSpecialKeyError: vi.fn(), getWindowId: () => "@worker" };
    const r = await steer({ pane: ({ pasted, entered, daemon }) => {
      if (pasted && !entered) daemon.tmux = replacement;
      return pasted ? HOLDING : BUSY;
    } });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(replacement.sendSpecialKey).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("a launch that stops taking a steer at the very last capture is not written to", async () => {
    const r = await steer({ beforeBaseline: daemon => { (daemon.backend as any).compatibility = { ...COMPAT, version: "kiro-cli 2.28.0" }; } });
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("a capture that never answers after the Enter does not hold the delivery: uncertain at the deadline", async () => {
    const r = await steer({ pane: ({ pasted, entered }) => (entered ? new Promise<string>(() => {}) : pasted ? HOLDING : BUSY) });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("steer-proof:composer-not-emptied");
    r.outbox.close();
  });

  it("an answer that arrives after a stall past the pre-Enter budget is dropped: no Enter", async () => {
    const r = await steer({ stall: { ms: 10_000, on: "capture-before-enter" } });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.attempt.evidence).toBe("steer-paste:box-read-late");
    r.outbox.close();
  });

  it("a dialog probe answering 'clear' after a stall past the proof's deadline is not accepted", async () => {
    const r = await steer({ stall: { ms: 10_000, on: "dialog-probe" } });
    expect(r.delivery.state).toBe("uncertain");
    r.outbox.close();
  });
});

describe("#1432 review r2: the text is this paste, and the Enter stays inside the budget", () => {
  it("another user's draft where the paste should be: no Enter, not delivered", async () => {
    const draft = composer("›  Please report the weather for tomorrow");
    const r = await steer({ pane: ({ pasted, entered }) => (entered ? BUSY : pasted ? draft : BUSY) });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.attempt.evidence).toBe("steer-paste:box-not-this-paste");
    r.outbox.close();
  });

  it("our paste appended to a draft is not ours either", async () => {
    const r = await steer({ pane: ({ pasted, entered }) => (entered ? BUSY : pasted ? HOLDING.replace("›  ", "›  half a draft ") : BUSY) });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.attempt.evidence).toBe("steer-paste:box-not-this-paste");
    r.outbox.close();
  });

  it("…while the box showing the start of this delivery's own payload is the control: delivered", async () => {
    const r = await steer();
    expect(r.tmux.pasteBuffer.mock.calls[0]![0]).toMatch(/^\[agend-delivery-id:/);
    expect(r.delivery.state).toBe("delivered");
    r.outbox.close();
  });

  it("a valid reading whose caller continues past the budget is not used: no Enter", async () => {
    const r = await steer({ stall: { ms: 10_000, on: "after-pre-enter-read" } });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.attempt.evidence).toBe("steer-paste:box-read-late");
    r.outbox.close();
  });

  it("an Enter whose transient wait outlives the budget is not sent", async () => {
    const r = await steer({ stall: { ms: 10_000, on: "enter-transient" } });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.attempt.evidence).toBe("submit-enter:pre-enter-deadline");
    r.outbox.close();
  });
});
