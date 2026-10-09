import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

/**
 * #1494 review: a lost window's retry read can complete its nonce frame with `%exit` behind it in the same stdout
 * chunk. The parser resolves the read, then retires the attachment, which stays in place until the child exits; the
 * read's continuation runs after both. It must not re-register the window from a retired attachment.
 *
 * The real control parser and read lane, with an inert ChildProcess: no tmux, no fleet.
 */

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: mocks.spawn,
  execFile: () => { throw new Error("unexpected fallback spawn"); },
  execFileSync: () => { throw new Error("sync exec forbidden"); },
}));
const { TmuxControlClient } = await import("../src/tmux-control.js");

function processFixture() {
  return Object.assign(new EventEmitter(), {
    pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn((_data: string, _callback?: unknown) => true) }), kill: vi.fn(() => true),
  });
}
type Proc = ReturnType<typeof processFixture>;
type Internals = {
  lostWindows: Map<string, unknown>;
  paneToWindow: Map<string, string>;
  registeredWindows: Set<string>;
  mono: () => number;
};

let processes: Proc[] = [];
let clients: InstanceType<typeof TmuxControlClient>[] = [];
let sequence = 1;
let clock = 1_000_000;

function opened() {
  const client = new TmuxControlClient("s");
  clients.push(client);
  const internals = client as unknown as Internals;
  internals.mono = () => clock;
  client.start();
  const proc = processes.at(-1)!;
  proc.stdout.emit("data", Buffer.from("%begin 1 1 0\n%end 1 1 0\n"));
  return { client, internals, proc };
}
function nonce(proc: Proc): string {
  const found = String(proc.stdin.write.mock.calls.at(-1)?.[0]).match(/display-message -p '(agend-read-[^']+)'/);
  expect(found, "a control read was submitted").not.toBeNull();
  return found![1];
}
/** One stdout chunk: the read's frame, its nonce trailer, and whatever follows. */
function frame(proc: Proc, output: string, after = ""): Buffer {
  const id = ++sequence;
  return Buffer.from(`%begin 10 ${id} 1\n${output}%end 10 ${id} 1\n`
    + `%begin 10 ${id + 1} 1\n${nonce(proc)}\n%end 10 ${id + 1} 1\n${after}`);
}
const settle = async () => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0); };

/** @7 lost: what three failed resolves leave behind, with the retry spacing already elapsed. */
function lose(internals: Internals): void {
  internals.lostWindows.set("@7", { lastTryAt: clock - 5_000, token: 0, inFlight: false });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  processes = []; sequence = 1; clock = 1_000_000;
  mocks.spawn.mockReset().mockImplementation(() => { const proc = processFixture(); processes.push(proc); return proc; });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.useRealTimers();
});

describe("a lost window's retry and %exit in one chunk (#1494 review)", () => {
  it("does not re-register the window from the retired attachment", async () => {
    const { client, internals, proc } = opened();
    lose(internals);
    expect(client.isIdle("@7")).toBe(false);     // starts the retry on the control client
    await settle();

    proc.stdout.emit("data", frame(proc, "%3\n", "%exit\n"));
    await settle();

    expect(proc.kill, "the attachment was retired").toHaveBeenCalled();
    expect(internals.lostWindows.has("@7"), "still lost").toBe(true);
    expect(internals.registeredWindows.has("@7")).toBe(false);
    expect(internals.paneToWindow.has("%3")).toBe(false);
  });

  it("re-registers it when the same frame arrives without %exit (control)", async () => {
    const { client, internals, proc } = opened();
    lose(internals);
    client.isIdle("@7");
    await settle();

    proc.stdout.emit("data", frame(proc, "%3\n"));
    await settle();

    expect(proc.kill).not.toHaveBeenCalled();
    expect(internals.lostWindows.has("@7")).toBe(false);
    expect(internals.paneToWindow.get("%3")).toBe("@7");
  });
});

describe("a registered window's resolve and %exit in one chunk (#1494 review)", () => {
  it("does not map the pane learned on the retired attachment", async () => {
    const { client, internals, proc } = opened();
    const registering = client.registerWindow("@7");
    await settle();
    proc.stdout.emit("data", frame(proc, "%3\n", "%exit\n"));
    await registering;
    await settle();

    expect(proc.kill).toHaveBeenCalled();
    expect(internals.paneToWindow.has("%3"), "no mapping from a retired attachment").toBe(false);
    expect(internals.registeredWindows.has("@7"), "still registered, re-resolved on the next attachment").toBe(true);
  });

  it("maps it without %exit (control)", async () => {
    const { client, internals, proc } = opened();
    const registering = client.registerWindow("@7");
    await settle();
    proc.stdout.emit("data", frame(proc, "%3\n"));
    await registering;
    expect(internals.paneToWindow.get("%3")).toBe("@7");
  });
});
