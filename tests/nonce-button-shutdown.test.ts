import { describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * `pendingNonceButtons` is in memory; the buttons it arms sit in the chat for
 * up to 24 hours (`TIP_BUTTON_TIMEOUT_MS`). Shutdown used to clear the map and
 * leave them posted, so every restart orphaned a day of Tip buttons: they still
 * rendered as live, and pressing one took the stale branch — acknowledged, and
 * the dismissal silently dropped.
 *
 * `agend update --beta` restarts the fleet, so during a beta cycle that is most
 * of the buttons.
 */

type Entry = {
  prefix: string;
  instanceName: string;
  adapterId: string;
  adapter: { editMessageRemoveButtons?: ReturnType<typeof vi.fn> };
  chatId: string;
  threadId?: string;
  messageId?: string;
  expiredText: string;
  timer?: ReturnType<typeof setTimeout>;
};

function fleet(entries: Record<string, Entry>) {
  // Only the two members this path touches; constructing a real FleetManager
  // would boot a fleet to test a shutdown sweep.
  const fm = Object.create(FleetManager.prototype) as FleetManager & Record<string, any>;
  // NonceButtonEntry is module-private, and these stand-ins carry only the
  // fields the sweep reads; the cast names what they substitute for.
  fm["pendingNonceButtons"] = new Map(Object.entries(entries)) as unknown as FleetManager["pendingNonceButtons"];
  fm.logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as FleetManager["logger"];
  return fm;
}

const entry = (over: Partial<Entry> = {}): Entry => ({
  prefix: "tip-dismiss:",
  instanceName: "alpha",
  adapterId: "telegram",
  adapter: { editMessageRemoveButtons: vi.fn(async () => {}) },
  chatId: "chat-1",
  messageId: "msg-1",
  expiredText: "⌛ expired",
  ...over,
});

describe("retiring armed button prompts on shutdown", () => {
  it("collapses every posted prompt to its expired text", async () => {
    const a = entry({ messageId: "msg-a", expiredText: "⌛ tip expired" });
    const b = entry({ prefix: "exit-restart:", messageId: "msg-b", threadId: "topic-9", expiredText: "⌛ offer expired" });
    const fm = fleet({ "nonce-a": a, "nonce-b": b });

    await fm["retirePendingNoncePrompts"](1_000);

    expect(a.adapter.editMessageRemoveButtons).toHaveBeenCalledWith("chat-1", "msg-a", "⌛ tip expired", undefined);
    expect(b.adapter.editMessageRemoveButtons).toHaveBeenCalledWith("chat-1", "msg-b", "⌛ offer expired", "topic-9");
  });

  it("empties the map and cancels the timers", async () => {
    // The timers would otherwise keep the process alive, and a surviving map
    // entry would let a later sweep edit the same message twice.
    const timer = setTimeout(() => { throw new Error("expiry timer should have been cancelled"); }, 50);
    const fm = fleet({ "nonce-a": entry({ timer }) });

    await fm["retirePendingNoncePrompts"](1_000);

    expect(fm["pendingNonceButtons"].size).toBe(0);
    await new Promise(r => setTimeout(r, 80));  // the timer would have fired by now
  });

  it("gives up on a platform that will not answer, rather than holding shutdown open", async () => {
    // Shutdown still has instances to stop. A hung edit must not own that time:
    // abandoning it is exactly the old behaviour, so the budget cannot make
    // anything worse.
    const stuck = entry({ adapter: { editMessageRemoveButtons: vi.fn(() => new Promise<void>(() => {})) } });
    const fm = fleet({ "nonce-a": stuck });

    const started = Date.now();
    await fm["retirePendingNoncePrompts"](60);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stuck.adapter.editMessageRemoveButtons).toHaveBeenCalled();
  });

  it("keeps going when one platform call rejects", async () => {
    const failing = entry({ messageId: "msg-a", adapter: { editMessageRemoveButtons: vi.fn(async () => { throw new Error("message deleted"); }) } });
    const ok = entry({ messageId: "msg-b" });
    const fm = fleet({ "nonce-a": failing, "nonce-b": ok });

    await expect(fm["retirePendingNoncePrompts"](1_000)).resolves.toBeUndefined();

    expect(ok.adapter.editMessageRemoveButtons).toHaveBeenCalled();
  });

  it("skips a prompt that was never delivered", async () => {
    // Armed, then the send failed: there is no message to collapse.
    const undelivered = entry({ messageId: undefined });
    const fm = fleet({ "nonce-a": undelivered });

    await fm["retirePendingNoncePrompts"](1_000);

    expect(undelivered.adapter.editMessageRemoveButtons).not.toHaveBeenCalled();
    expect(fm["pendingNonceButtons"].size).toBe(0);
  });

  it("tolerates an adapter that cannot edit buttons at all", async () => {
    const noEdit = entry({ adapter: {} });
    const fm = fleet({ "nonce-a": noEdit });

    await expect(fm["retirePendingNoncePrompts"](1_000)).resolves.toBeUndefined();
    expect(fm["pendingNonceButtons"].size).toBe(0);
  });
});

describe("doStopAll is wired to the sweep", () => {
  it("retires the prompts while the adapters are still connected", async () => {
    // The unit tests above prove the sweep works; this proves shutdown calls
    // it, and calls it BEFORE the adapters are stopped — after that the edits
    // would have nothing to talk to.
    const fm = Object.create(FleetManager.prototype) as FleetManager & Record<string, any>;
    const order: string[] = [];

    const noop = () => {};
    Object.assign(fm, {
      logger: { debug: noop, info: noop, warn: noop, error: noop },
      shuttingDown: false,
      ipcStoppingInstances: new Set<string>(),
      stormWindow: { shutdown: noop },
      spawnGate: { shutdown: noop },
      startupRetries: new Map(),
      startupRetryNotices: new Map(),
      cancelButtons: new Map(),
      cancelButtonPublications: new Map(),
      cancelButtonIdleRetireTimers: new Map(),
      pendingClassicStarts: new Map(),
      pendingNonceButtons: new Map(),
      mirrorBuffer: new Map(),
      adapterState: new Map(),
      adapters: new Map(),
      adapter: null,
      lifecycle: { daemons: new Map() },   // `daemons` is a getter onto this
      instanceIpcClients: new Map(),
      worlds: new Map([["telegram", { stop: async () => { order.push("adapters stopped"); } }]]),
      topicArchiver: { stop: noop },
      clearStatuslineWatchers: noop,
      shutdownLoginWindows: async () => {},
      costGuard: { stop: noop },
      dailySummary: { stop: noop },
      dailyTipScheduler: { stop: noop },
      scheduler: { shutdown: noop },
      controlClient: { stop: noop },
      retirePendingNoncePrompts: async () => { order.push("prompts retired"); },
    });

    // Let the rest of the teardown fail: this stub stops at the point where
    // shutdown starts touching the filesystem, and completing it would mean
    // mirroring every later step of the real thing. The two calls under test
    // have both happened by then, and their ORDER is the claim.
    await fm["doStopAll"]().catch(() => { /* stub runs out past the adapters */ });

    expect(order).toEqual(["prompts retired", "adapters stopped"]);
  });
});
