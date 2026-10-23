import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * #2484: an instance whose start failed waits for its automatic retry (1 → 5 → 15 min). A person's message sent in that
 * window used to fail with ❌ after the 30 s IPC grace and was gone, although the retry brought the instance up soon
 * after. Now such a message waits for the retry (shown as queued) and is delivered when the instance is up; it fails
 * only once the retries give up. Deliveries without the hold (cross-instance), and instances a person stopped or paused,
 * keep the 30 s grace.
 */

type Client = { connected: boolean; send(msg: unknown): boolean };
type Internals = {
  sendWhenConnected(name: string, payload: Record<string, unknown>, epoch?: number, stillCurrent?: () => boolean, onHold?: () => void): Promise<boolean>;
  instanceIpcClients: Map<string, Client>;
  daemons: Map<string, unknown>;
  fleetConfig: unknown;
  logger: Record<string, unknown>;
  spawnGate: { run(ctx: unknown, fn: () => Promise<void>): Promise<void> };
  startConfiguredInstance(name: string, topicMode: boolean): Promise<void>;
  queueStartupRetryNotice(kind: string, name: string, delayMs: number): void;
  scheduleStartupRetry(name: string, attempt: number): void;
  cancelStartupRetry(name: string): void;
  pendingStartupRetry(name: string): { attempt: number } | null;
  lifecycle: { isPaused(name: string): boolean };
  startRetryHoldFor(name: string, msg?: { chatId?: string; messageId?: string; threadId?: string }): { onStartRetryHold?: () => void };
  reactMessageStatus(...args: unknown[]): void;
};

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function client(sent: unknown[]): Client {
  return { connected: true, send(msg) { sent.push(msg); return true; } };
}

/** A fleet whose "alpha" failed its first start: its retries run the real scheduler; `starts` decides each outcome. */
function makeFleet(starts: Array<"fail" | "up">) {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "agend-2484-"));
  dirs.push(dir);
  const fm = new FleetManager(dir);
  const x = fm as unknown as Internals;
  const noop = () => {};
  x.logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => x.logger };
  x.fleetConfig = { instances: { alpha: { working_directory: dir } } };
  x.spawnGate = { run: (_ctx, fn) => fn() };
  x.queueStartupRetryNotice = noop;
  const sent: unknown[] = [];
  const attempts: number[] = [];
  x.startConfiguredInstance = async () => {
    attempts.push(Date.now());
    if ((starts.shift() ?? "fail") === "fail") throw new Error("backend binary missing");
    x.daemons.set("alpha", {});
    // The IPC connects a moment after the daemon is up.
    setTimeout(() => x.instanceIpcClients.set("alpha", client(sent)), 2_000);
  };
  x.instanceIpcClients.delete("alpha");
  return { fm, x, sent, attempts };
}

describe("#2484 a person's message waits for the instance's own start retry", () => {
  it("is held past the 30 s grace, shown as queued once, and delivered when the 1-minute retry brings the instance up", async () => {
    const { x, sent } = makeFleet(["up"]);
    x.scheduleStartupRetry("alpha", 0); // the first start failed: retry in 1 min
    const onHold = vi.fn();
    let settled: boolean | Error | undefined;
    void x.sendWhenConnected("alpha", { content: "hi" }, undefined, undefined, onHold).then(v => { settled = v; }, e => { settled = e; });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBeUndefined();     // before: ❌ at 30 s
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(20_000); // retry at 60 s, IPC at 62 s
    expect(settled).toBe(true);
    expect(sent).toEqual([{ content: "hi" }]);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting through a failed retry and the 5-minute one after it", async () => {
    const { x, sent, attempts } = makeFleet(["fail", "up"]);
    x.scheduleStartupRetry("alpha", 0);
    let settled: boolean | Error | undefined;
    void x.sendWhenConnected("alpha", { content: "hi" }, undefined, undefined, () => {}).then(v => { settled = v; }, e => { settled = e; });

    await vi.advanceTimersByTimeAsync(60_000 + 4 * 60_000);
    expect(attempts).toHaveLength(1);
    expect(x.pendingStartupRetry("alpha")).toEqual({ attempt: 1 });
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000 + 5_000); // the 5-min retry at 6 min, IPC 2 s later
    expect(attempts).toHaveLength(2);
    expect(settled).toBe(true);
    expect(sent).toEqual([{ content: "hi" }]);
  });

  it("keeps waiting while the retry itself is running (queued at the spawn gate behind other recoveries)", async () => {
    const { x, sent } = makeFleet(["up"]);
    x.spawnGate = { run: async (_ctx, fn) => { await new Promise(r => setTimeout(r, 90_000)); await fn(); } };
    x.scheduleStartupRetry("alpha", 0);
    let settled: boolean | Error | undefined;
    void x.sendWhenConnected("alpha", { content: "hi" }, undefined, undefined, () => {}).then(v => { settled = v; }, e => { settled = e; });

    await vi.advanceTimersByTimeAsync(60_000 + 80_000); // the retry fired at 60 s; the gate lets it start at 150 s
    expect(x.pendingStartupRetry("alpha")).toBeNull();
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(true);
    expect(sent).toEqual([{ content: "hi" }]);
  });

  it("fails once the retries give up — within one grace of the last failed retry, not before", async () => {
    const { x, sent } = makeFleet(["fail"]);
    x.scheduleStartupRetry("alpha", 2); // the last step (15 min); its failure gives up
    let settled: boolean | Error | undefined;
    void x.sendWhenConnected("alpha", { content: "hi" }, undefined, undefined, () => {}).then(v => { settled = v; }, e => { settled = e; });

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    expect(x.pendingStartupRetry("alpha")).toBeNull(); // gave up
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBeInstanceOf(Error);
    expect((settled as Error).message).toMatch(/IPC is unavailable/);
    expect(sent).toEqual([]);
  });

  it("is not held once a person stops the instance (the stop cancels the retry): the usual grace, then ❌", async () => {
    const { x } = makeFleet(["up"]);
    x.scheduleStartupRetry("alpha", 0);
    let settled: boolean | Error | undefined;
    void x.sendWhenConnected("alpha", { content: "hi" }, undefined, undefined, () => {}).then(v => { settled = v; }, e => { settled = e; });
    await vi.advanceTimersByTimeAsync(10_000);
    x.cancelStartupRetry("alpha");
    await vi.advanceTimersByTimeAsync(30_500);
    expect(settled).toBeInstanceOf(Error);
  });

  it("is not held for a paused instance", async () => {
    const { x } = makeFleet(["up"]);
    x.scheduleStartupRetry("alpha", 0);
    x.lifecycle.isPaused = (name: string) => name === "alpha";
    const onHold = vi.fn();
    let settled: boolean | Error | undefined;
    void x.sendWhenConnected("alpha", { content: "hi" }, undefined, undefined, onHold).then(v => { settled = v; }, e => { settled = e; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBeInstanceOf(Error);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("a delivery without the hold (cross-instance) keeps the 30 s grace even while a retry is pending", async () => {
    const { x } = makeFleet(["up"]);
    x.scheduleStartupRetry("alpha", 0);
    let settled: boolean | Error | undefined;
    void x.sendWhenConnected("alpha", { content: "hi" }).then(v => { settled = v; }, e => { settled = e; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBeInstanceOf(Error);
  });

  it("an instance with no retry at all fails after the grace as before, and the hold notice is never shown", async () => {
    const { x } = makeFleet([]);
    const onHold = vi.fn();
    let settled: boolean | Error | undefined;
    void x.sendWhenConnected("alpha", { content: "hi" }, undefined, undefined, onHold).then(v => { settled = v; }, e => { settled = e; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBeInstanceOf(Error);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("the delivery facade passes the hold through: a person's message via deliverToInstance is stamped queued and delivered", async () => {
    const { fm, x, sent } = makeFleet(["up"]);
    const react = vi.fn();
    x.reactMessageStatus = react;
    x.scheduleStartupRetry("alpha", 0);
    let settled: unknown;
    void fm.deliverToInstance("alpha", { type: "fleet_inbound", content: "hi" }, x.startRetryHoldFor("alpha", { chatId: "c1", messageId: "m1" }))
      .then(v => { settled = v; }, e => { settled = e; });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settled).toBeUndefined();
    expect(react).toHaveBeenCalledWith("alpha", "c1", "m1", "queued", undefined);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(true);
    expect(sent).toMatchObject([{ type: "fleet_inbound", content: "hi" }]);
  });

  it("a reply-button click on an instance waiting for its start retry is stamped queued and delivered after the retry, not ❌", async () => {
    const { x, sent } = makeFleet(["up"]);
    const statuses: unknown[][] = [];
    x.reactMessageStatus = (...args: unknown[]) => { statuses.push(args); };
    const fm = x as unknown as Record<string, unknown>;
    fm.afterUserInboundDelivered = () => {};
    fm.emitSseEvent = () => {};
    fm.touchActivity = () => {};
    fm.setTopicIcon = () => {};
    x.scheduleStartupRetry("alpha", 0);
    const click = (fm.deliverReplyButtonChoice as (...a: unknown[]) => Promise<boolean>).call(x,
      { id: "set1", instance: "alpha", adapterId: "dc", chatId: "c1", threadId: "t1", messageId: "m1" },
      { label: "Deploy", value: "Deploy" },
      { userId: "u1", username: "han", source: "discord" });
    let settled: unknown;
    void click.then(v => { settled = v; }, e => { settled = e; });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBeUndefined();     // before: false (❌) at 30 s
    expect(statuses.map(s => s[3])).toEqual(["received", "queued"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(true);
    expect(sent).toMatchObject([{ type: "fleet_inbound", content: "[button] Deploy" }]);
    expect(statuses.map(s => s[3])).not.toContain("failed");
  });

  it("the platform hold stamps the message queued (⏳ on Discord), in its thread; a ClassicBot room message only waits", () => {
    const { x } = makeFleet([]);
    const react = vi.fn();
    x.reactMessageStatus = react;
    x.startRetryHoldFor("alpha", { chatId: "c1", messageId: "m1", threadId: "t1" }).onStartRetryHold!();
    expect(react).toHaveBeenCalledWith("alpha", "c1", "m1", "queued", "t1");
    react.mockClear();
    x.startRetryHoldFor("alpha").onStartRetryHold!();
    expect(react).not.toHaveBeenCalled();
  });
});
