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
/** The box holding the paste (its first row): no placeholder. */
const HOLDING = composer("›  [agend-delivery-id:d] [STEERING — mid-task course correction.]");
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

function kiro(root: string, kiroUi: "tui" | "legacy" = "tui"): KiroBackend {
  const instanceDir = join(root, "instances", "worker");
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const b = new KiroBackend(instanceDir, COMPAT);
  b.buildCommand({ workingDirectory: work, instanceDir, instanceName: "worker", mcpServers: {}, kiroUi });
  return b;
}

interface Opts {
  kiroUi?: "tui" | "legacy";
  /** The pane on each capture: before the paste, while the box holds it, after the Enter. */
  pane?: (s: { pasted: boolean; entered: boolean; captures: number }) => string;
  dialogOnVerify?: boolean;
  /** waitForPaneReadyForDelivery's answer (a delivery that is not handed off waits for the idle prompt). */
  becameIdle?: boolean;
}

async function steer(opts: Opts = {}) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-1405d-")); roots.push(root);
  const instanceDir = join(root, "instances", "worker");
  const backend = kiro(root, opts.kiroUi);
  expect(backend.supportsSteer()).toBe((opts.kiroUi ?? "tui") === "tui");
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
  const s = { pasted: false, entered: false, captures: 0 };
  const pane = opts.pane ?? (({ pasted, entered }) => (entered ? BUSY : pasted ? HOLDING : BUSY));
  const tmux = {
    capturePane: vi.fn(async () => { s.captures++; return pane(s); }),
    pasteBuffer: vi.fn(async () => { s.pasted = true; return true; }),
    sendSpecialKey: vi.fn(async () => { s.entered = true; return true; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
  const waitIdle = vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(opts.becameIdle ?? false);
  const clear = { state: "clear" } as const;
  const dialog = { state: "dialog", dialog: { description: "a dialog" } } as any;
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValueOnce(clear).mockResolvedValueOnce(clear)
    .mockResolvedValue(opts.dialogOnVerify ? dialog : clear);
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  const admits = vi.spyOn(daemon, "steerComposerAdmits");
  const baseline = vi.spyOn(daemon, "capturePaneEvidence");
  const meta = {
    delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
    user: "instance:source", user_id: "instance:source", message_id: "message-1405", chat_id: "", thread_id: "", ts: new Date().toISOString(),
  };
  daemon.steerMessage("hello", meta);
  await vi.runAllTimersAsync();
  await daemon.steerLock;
  const db = (outbox as any).db;
  return {
    outbox, tmux, waitIdle,
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
