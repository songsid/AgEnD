import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

/**
 * #1490 (2.2 audit, line 64):
 *  - The reconnect grace ran from the observation reset, not from each window's re-resolution: with many windows, or
 *    tmux slow under load, the last windows were re-mapped after the grace and read idle at once.
 *  - One control read slower than its 2 s attempt retired the whole control client, wiping every pane's
 *    observations (and a 2 s blind spell plus re-resolution followed).
 *
 * The real TmuxControlClient with its real control parser and read lane over an inert ChildProcess; fallback reads
 * are a mocked execFile. No tmux, no fleet.
 */

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  (mocks.execFile as any)[Symbol.for("nodejs.util.promisify.custom")] = (...args: unknown[]) => new Promise((resolve, reject) => {
    mocks.execFile(...args, (error: unknown, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  return {
    ...await importOriginal<typeof import("node:child_process")>(), spawn: mocks.spawn, execFile: mocks.execFile,
    execFileSync: () => { throw new Error("sync exec forbidden"); },
  };
});
const { TmuxControlClient } = await import("../src/tmux-control.js");
const { TmuxManager } = await import("../src/tmux-manager.js");
const { getTmuxSocketName } = await import("../src/paths.js");

function processFixture() {
  return Object.assign(new EventEmitter(), {
    pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn((_data: string, _callback?: unknown) => true) }), kill: vi.fn(() => true),
  });
}
type Proc = ReturnType<typeof processFixture>;
type Internals = {
  registeredWindows: Set<string>;
  paneToWindow: Map<string, string>;
  lastOutputAt: Map<string, number>;
  mono: () => number;
  resolvePane(windowId: string): Promise<void>;
  resetPaneObservations(): void;
  getObservationResetAt(): number;
};

let processes: Proc[] = [];
let clients: InstanceType<typeof TmuxControlClient>[] = [];
let sequence = 1;
let fallbackCalls = 0;
const tick = () => vi.advanceTimersByTimeAsync(0);

function opened() {
  const client = new TmuxControlClient("s");
  clients.push(client);
  client.start();
  const proc = processes.at(-1)!;
  proc.stdout.emit("data", Buffer.from("%begin 1 1 0\n%end 1 1 0\n"));
  return { client, proc, internals: client as unknown as Internals, manager: new TmuxManager("s", "@1", undefined, client) };
}
function nonceAt(proc: Proc, call: number): string {
  const found = String(proc.stdin.write.mock.calls[call]?.[0]).match(/display-message -p '(agend-read-[^']+)'/);
  expect(found, `control read #${call} was submitted`).not.toBeNull();
  return found![1];
}
/** The frame a control read gets: its output, then its nonce trailer. */
function frame(proc: Proc, call: number, output: string): Buffer {
  const id = ++sequence;
  return Buffer.from(`%begin 10 ${id} 1\n${output}%end 10 ${id} 1\n%begin 10 ${id + 1} 1\n${nonceAt(proc, call)}\n%end 10 ${id + 1} 1\n`);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  processes = []; sequence = 1; fallbackCalls = 0;
  TmuxManager.setSocketName(getTmuxSocketName());
  mocks.spawn.mockReset().mockImplementation(() => { const proc = processFixture(); processes.push(proc); return proc; });
  mocks.execFile.mockReset().mockImplementation((_file, _args, _options, callback) => {
    fallbackCalls++;
    const child = processFixture();
    queueMicrotask(() => { child.emit("exit", 0); callback(null, "fallback\n"); child.emit("close", 0); });
    return child;
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.useRealTimers();
});

describe("the reconnect grace is counted per window, from its re-resolution (#1490)", () => {
  it("a window re-mapped after the reset's grace is not idle until it has been silent since its mapping", async () => {
    const client = new TmuxControlClient("s", 2_000);
    clients.push(client);
    const internals = client as unknown as Internals;
    let reads: Array<(v: string) => void> = [];
    (client as unknown as { read: () => Promise<string> }).read = () => new Promise<string>((resolve) => { reads.push(resolve); });
    internals.registeredWindows.add("@9");
    internals.resetPaneObservations();                     // connect(): every mapping dropped, grace armed
    await vi.advanceTimersByTimeAsync(3_000);              // re-resolution of the last window is slow: past the grace
    const resolving = internals.resolvePane.call(client, "@9");
    reads.shift()!("%9\n");
    await resolving;
    expect(internals.paneToWindow.get("%9")).toBe("@9");
    expect(client.isIdle("@9"), "nothing observed since it was mapped a moment ago").toBe(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(client.isIdle("@9")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.isIdle("@9"), "silent for silenceMs since its mapping").toBe(true);
    reads = [];
  });

  it("output after the mapping is judged by the normal silence rule (control)", async () => {
    const client = new TmuxControlClient("s", 2_000);
    clients.push(client);
    const internals = client as unknown as Internals;
    (client as unknown as { read: () => Promise<string> }).read = async () => "%9\n";
    internals.registeredWindows.add("@9");
    internals.resetPaneObservations();
    await vi.advanceTimersByTimeAsync(3_000);
    await internals.resolvePane.call(client, "@9");
    internals.lastOutputAt.set("%9", Date.now());
    expect(client.isIdle("@9")).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.isIdle("@9")).toBe(true);
  });
});

describe("one slow control read does not tear down the control client (#1490)", () => {
  it("is answered by a one-shot read at its deadline; the client is not retired and keeps every observation", async () => {
    const { proc, internals, manager } = opened();
    proc.stdout.emit("data", Buffer.from("%output %5 hello\n"));
    expect(internals.lastOutputAt.has("%5")).toBe(true);
    const resetBefore = internals.getObservationResetAt();

    const slow = manager.capturePane();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await slow, "the caller got the fallback's answer").toBe("fallback\n");
    expect(proc.kill, "the control client was not retired").not.toHaveBeenCalled();
    expect(internals.lastOutputAt.has("%5"), "observations were not wiped").toBe(true);
    expect(internals.getObservationResetAt(), "no observation reset").toBe(resetBefore);
  });

  it("drains the late frame, then serves the next read from the control stream with the right answer", async () => {
    const { proc, manager } = opened();
    const slow = manager.capturePane();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await slow).toBe("fallback\n");

    proc.stdout.emit("data", frame(proc, 0, "late answer\n"));    // the slow command finally answers
    await tick();
    const next = manager.capturePane();
    await tick();
    expect(proc.stdin.write, "the next read uses the control stream again").toHaveBeenCalledTimes(2);
    proc.stdout.emit("data", frame(proc, 1, "fresh answer\n"));
    expect(await next, "not the drained frame's output").toBe("fresh answer\n");
    expect(fallbackCalls, "only the slow read needed a fallback").toBe(1);
  });

  it("while a frame is being drained, other reads go straight to a one-shot read, not into the stream", async () => {
    const { proc, manager } = opened();
    const slow = manager.capturePane();
    await vi.advanceTimersByTimeAsync(2_000);
    await slow;
    const meanwhile = manager.capturePane();
    expect(await meanwhile).toBe("fallback\n");
    expect(proc.stdin.write, "nothing else written while draining").toHaveBeenCalledTimes(1);
  });

  it("retires the attachment if the frame never arrives within the drain limit", async () => {
    const { proc, manager } = opened();
    const slow = manager.capturePane();
    await vi.advanceTimersByTimeAsync(2_000);
    await slow;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.kill, "a stream silent for the drain limit is retired").toHaveBeenCalledOnce();
  });
});
