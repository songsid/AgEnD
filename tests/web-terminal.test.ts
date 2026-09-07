import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebTerminalSession, generateAccessToken, nonEmptyTail, shellQuote, segmentInput,
  ACCESS_TOKEN_LENGTH, MAX_TOKEN_ATTEMPTS, MAX_TTL_MS, MAX_PENDING_INPUT_BYTES, MAX_PENDING_JOBS, MAX_PROBE_FAILURES,
  type TerminalBackend, type WebTerminalResult, type WebTerminalSpec,
} from "../src/web-terminal.js";

/**
 * Session logic against a scripted tmux backend: token gate, TTL, exit
 * evidence, observation, replay, input chunking. The real tmux/HTTP path is
 * covered by web-terminal-integration.test.ts.
 */
class FakeBackend implements TerminalBackend {
  started: Array<{ socket: string; command: string; cwd: string; cols: number; rows: number }> = [];
  emit: ((chunk: Buffer) => void) | null = null;
  inputs: Buffer[] = [];
  resizes: Array<[number, number]> = [];
  killed: string[] = [];
  pane = "";
  status: { alive: boolean; exitCode?: number } | null = { alive: true };
  failStart = false;
  /** Per-call latency for sendInput, keyed by first byte (ordering tests). */
  inputDelayMs: (bytes: Buffer) => number = () => 0;
  failInput: Error | null = null;
  killHangs = false;
  killRejects = false;
  resizeRejects = false;
  /** When set, start() parks here until released (cancel-during-start races). */
  startGate: Promise<void> | null = null;
  serverAlive = false;
  async start(opts: { socket: string; command: string; cwd: string; cols: number; rows: number; onOutput: (chunk: Buffer) => void }): Promise<void> {
    if (this.failStart) throw new Error("tmux missing");
    if (this.startGate) await this.startGate;
    this.started.push({ socket: opts.socket, command: opts.command, cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
    this.serverAlive = true;                                   // the dedicated server now exists
    this.emit = opts.onOutput;
  }
  /** Every input/resize in arrival order, for FIFO assertions. */
  ops: string[] = [];
  async sendInput(_s: string, bytes: Buffer): Promise<void> {
    const wait = this.inputDelayMs(bytes);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (this.failInput) throw this.failInput;
    this.inputs.push(Buffer.from(bytes));
    this.ops.push(`input:${bytes.toString()}`);
  }
  async resize(_s: string, cols: number, rows: number): Promise<void> {
    if (this.resizeRejects) throw new Error("tmux resize-window failed");
    this.resizes.push([cols, rows]);
    this.ops.push(`resize:${cols}x${rows}`);
  }
  async capture(): Promise<string> { return this.pane; }
  async paneStatus(): Promise<{ alive: boolean; exitCode?: number } | null> { return this.status; }
  async kill(socket: string): Promise<void> {
    this.killed.push(socket);
    if (this.killHangs) await new Promise(() => { /* never */ });
    if (this.killRejects) throw new Error("tmux server on socket could not be confirmed dead");
    this.serverAlive = false;
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
let now = 1_000_000;
const clock = () => now;

function spec(over: Partial<WebTerminalSpec> = {}): WebTerminalSpec {
  return {
    kind: "login", backend: "kiro-cli", command: "kiro-cli login", cwd: "/tmp", ttlMs: 60_000,
    requester: { adapterId: "discord", userId: "u1", chatId: "c1" },
    ...over,
  };
}

function make(over: Partial<WebTerminalSpec> = {}) {
  const backend = new FakeBackend();
  const done: WebTerminalResult[] = [];
  const hints: Array<[string, string | null]> = [];
  const audits: Array<[string, Record<string, unknown>]> = [];
  const session = new WebTerminalSession(spec(over), {
    onDone: r => { done.push(r); },
    onHint: (u, c) => { hints.push([u, c]); },
    onAudit: (e, f) => { audits.push([e, f]); },
  }, backend, logger, clock);
  return { session, backend, done, hints, audits };
}

beforeEach(() => { vi.useFakeTimers(); now = 1_000_000; logger.warn.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe("helpers", () => {
  it("access token: 20 chars, base32 alphabet, deterministic for given bytes", () => {
    const t = generateAccessToken(Buffer.alloc(13, 0));
    expect(t).toBe("A".repeat(ACCESS_TOKEN_LENGTH));
    const r = generateAccessToken();
    expect(r).toMatch(/^[A-Z2-7]{20}$/);
    expect(generateAccessToken()).not.toBe(r);
  });
  it("nonEmptyTail skips blank lines (the '/ / Pane is dead' bug)", () => {
    expect(nonEmptyTail("error: Already logged in\n\n\n\nPane is dead\n")).toBe("error: Already logged in / Pane is dead");
    expect(nonEmptyTail("a\nb\nc\nd\ne")).toBe("c / d / e");
  });
  it("shellQuote survives single quotes and metacharacters", () => {
    expect(shellQuote("it's $HOME `x` ; rm -rf /")).toBe(`'it'\\''s $HOME \`x\` ; rm -rf /'`);
  });
  it("segmentInput: typed text is a text run, control bytes and whole ESC sequences are control runs", () => {
    const seg = (str: string) => segmentInput(Buffer.from(str, "latin1")).map(r => `${r.kind}:${JSON.stringify(r.bytes.toString("latin1"))}`);
    const t = (str: string) => `text:${JSON.stringify(str)}`;
    const c = (str: string) => `control:${JSON.stringify(str)}`;
    expect(seg("hunter2")).toEqual([t("hunter2")]);
    expect(seg("hunter2\r")).toEqual([t("hunter2"), c("\r")]);
    expect(seg("\x03")).toEqual([c("\x03")]);
    expect(seg("\x1b[A")).toEqual([c("\x1b[A")]);                       // arrow: the whole CSI is control
    expect(seg("\x1b[1;5Cx")).toEqual([c("\x1b[1;5C"), t("x")]);        // parameters stay inside the sequence
    expect(seg("\x1bOP")).toEqual([c("\x1bOP")]);                       // SS3 (F1)
    expect(seg("a\tb\x7f")).toEqual([t("a"), c("\t"), t("b"), c("\x7f")]);
    expect(seg("\x1b")).toEqual([c("\x1b")]);                           // lone ESC
    expect(seg("")).toEqual([]);
  });

  it("rejects a TTL above the hard cap or non-positive", () => {
    expect(() => make({ ttlMs: MAX_TTL_MS + 1 })).toThrow(/ttlMs/);
    expect(() => make({ ttlMs: 0 })).toThrow(/ttlMs/);
  });
});

describe("start", () => {
  it("runs exactly the given command in a dedicated socket, clamps geometry, audits creation", async () => {
    const { session, backend, audits } = make({ cols: 9999, rows: 1 });
    await session.start();
    expect(backend.started).toHaveLength(1);
    expect(backend.started[0].command).toBe("kiro-cli login");
    expect(backend.started[0].socket).toMatch(/^agend-term-[0-9a-f]{12}$/);
    expect(backend.started[0].cols).toBe(250);
    expect(backend.started[0].rows).toBe(5);
    expect(session.state).toBe("running");
    expect(audits.map(a => a[0])).toContain("web_terminal_created");
    expect(JSON.stringify(audits)).not.toContain(session.peekAccessToken());
  });
  it("a backend failure finishes the session, drops the token, and rethrows", async () => {
    const { session, backend, audits } = make();
    backend.failStart = true;
    await expect(session.start()).rejects.toThrow(/tmux missing/);
    expect(session.state).toBe("finished");
    expect(session.peekAccessToken()).toBeNull();
    expect(audits.map(a => a[0])).toContain("web_terminal_start_failed");
  });
});

describe("token gate", () => {
  it("wrong token → bad with remaining count; third failure → locked, session destroyed, tmux killed", async () => {
    const { session, backend, done, audits } = make();
    await session.start();
    expect(session.redeemToken("NOPE")).toEqual({ result: "bad", remaining: 2 });
    expect(session.redeemToken("NOPE")).toEqual({ result: "bad", remaining: 1 });
    expect(session.redeemToken("NOPE")).toEqual({ result: "locked" });
    await vi.runAllTimersAsync();
    expect(session.state).toBe("finished");
    expect(backend.killed).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ ok: false, reason: "token_lockout" });
    expect(audits.filter(a => a[0] === "web_terminal_token_failed")).toHaveLength(MAX_TOKEN_ATTEMPTS);
    expect(audits.some(a => a[0] === "web_terminal_token_lockout")).toBe(true);
  });
  it("correct token (case/space/dash-insensitive) → cookie; token gone; second use → used", async () => {
    const { session } = make();
    await session.start();
    const token = session.peekAccessToken()!;
    const sloppy = `${token.slice(0, 5).toLowerCase()}-${token.slice(5, 10)} ${token.slice(10)}`;
    const r = session.redeemToken(sloppy);
    expect(r.result).toBe("ok");
    const cookie = (r as { cookie: string }).cookie;
    expect(cookie).toMatch(/^[0-9a-f]{64}$/);
    expect(session.peekAccessToken()).toBeNull();
    expect(session.redeemToken(token)).toEqual({ result: "used" });
    expect(session.checkCookie(cookie)).toBe(true);
    const wrongLast = cookie.at(-1) === "0" ? "1" : "0";        // guaranteed to differ (the flake sol caught: 1/16 runs)
    expect(session.checkCookie(cookie.slice(0, 63) + wrongLast)).toBe(false);
    expect(session.checkCookie(cookie + "0")).toBe(false);
    expect(session.checkCookie(undefined)).toBe(false);
  });
  it("a token with the right prefix but wrong length is rejected", async () => {
    const { session } = make();
    await session.start();
    const token = session.peekAccessToken()!;
    expect(session.redeemToken(token.slice(0, 19)).result).toBe("bad");
    expect(session.redeemToken(`${token}A`).result).toBe("bad");
  });
  it("after the session ends, redeem/cookie both refuse", async () => {
    const { session } = make();
    await session.start();
    const token = session.peekAccessToken()!;
    const ok = session.redeemToken(token) as { cookie: string };
    await session.cancel();
    expect(session.redeemToken(token)).toEqual({ result: "finished" });
    expect(session.checkCookie(ok.cookie)).toBe(false);
  });
});

describe("cancel racing start (sol PR-B rounds 3–4 B1/B2)", () => {
  it("cancel() does NOT settle while backend.start() is in flight; the one kill happens after the server exists; start rejects", async () => {
    vi.useRealTimers();
    const { session, backend, done } = make();
    let release!: () => void;
    backend.startGate = new Promise<void>(r => { release = r; });
    const starting = session.start();                          // parked inside backend.start
    let cancelSettled = false;
    const cancelling = session.cancel("fleet shutdown").then(() => { cancelSettled = true; });
    await new Promise(r => setTimeout(r, 30));
    expect(cancelSettled).toBe(false);                         // teardown is not "done" before the server can exist
    expect(backend.killed).toHaveLength(0);                    // no premature kill of a server that is not there yet
    expect(done).toHaveLength(0);                              // and no completion reported yet
    expect(session.peekAccessToken()).toBeNull();              // but the token is already withdrawn
    release();                                                 // tmux now creates the server
    await cancelling;
    await expect(starting).rejects.toThrow(/cancelled during startup/);
    expect(backend.killed).toHaveLength(1);                    // exactly one confirmed kill, after creation
    expect(backend.serverAlive).toBe(false);
    expect(done).toHaveLength(1);
    expect(done[0].cleanupFailed).toBeUndefined();
    expect(session.state).toBe("finished");
  });

  it("B2: a late kill that fails is reported in the ONE completion result (cleanupFailed) — never a silent success", async () => {
    vi.useRealTimers();
    const { session, backend, done, audits } = make();
    let release!: () => void;
    backend.startGate = new Promise<void>(r => { release = r; });
    const starting = session.start();
    const cancelling = session.cancel("fleet shutdown");
    backend.killRejects = true;                                // the server that appears late cannot be confirmed dead
    release();
    await cancelling;
    await expect(starting).rejects.toThrow(/cancelled during startup/);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ reason: "cancel", cleanupFailed: true });
    expect(audits.find(a => a[0] === "web_terminal_closed")![1]).toMatchObject({ cleanupFailed: true });
    expect(audits.some(a => a[0] === "web_terminal_cleanup_failed")).toBe(true);
  });

  it("a backend.start() that FAILS while cancel is pending settles cancel with a clean completion", async () => {
    vi.useRealTimers();
    const { session, backend, done } = make();
    let reject!: (e: Error) => void;
    backend.startGate = new Promise<void>((_r, rj) => { reject = rj; });
    const starting = session.start();
    const cancelling = session.cancel("fleet shutdown");
    reject(new Error("tmux exploded"));
    await cancelling;
    await expect(starting).rejects.toThrow(/cancelled during startup/);
    expect(done).toHaveLength(1);
    expect(session.state).toBe("finished");
  });
});

describe("lifecycle", () => {
  it("TTL lapse finishes with reason ttl and kills tmux", async () => {
    const { session, backend, done } = make({ ttlMs: 5_000 });
    await session.start();
    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ ok: false, reason: "ttl" });
    expect(backend.killed).toHaveLength(1);
    expect(session.ttlRemainingMs).toBe(0);
  });
  it("exit 0 → ok; non-zero → evidence is the last non-empty lines", async () => {
    const a = make(); await a.session.start();
    a.backend.status = { alive: false, exitCode: 0 };
    await a.session.poll();
    expect(a.done[0]).toMatchObject({ ok: true, reason: "exit", exitCode: 0 });

    const b = make(); await b.session.start();
    b.backend.pane = "? Select login method\nerror: Already logged in, please logout with kiro-cli logout first\n\n\n";
    b.backend.status = { alive: false, exitCode: 1 };
    await b.session.poll();
    expect(b.done[0].ok).toBe(false);
    expect(b.done[0].detail).toContain("Already logged in");
    expect(b.done[0].detail).not.toMatch(/\/ \/ /);
  });
  it("known failure strings map to a message and a suggestion", async () => {
    const { session, backend, done } = make({ observe: { failures: [
      { pattern: /Already logged in/, message: "still holds a token — re-login logs out first", suggest: "relogin" },
    ] } });
    await session.start();
    backend.pane = "error: Already logged in, please logout with kiro-cli logout first";
    backend.status = { alive: false, exitCode: 1 };
    await session.poll();
    expect(done[0]).toMatchObject({ ok: false, exitCode: 1, suggest: "relogin", detail: "still holds a token — re-login logs out first" });
  });
  it("success pattern seen → ok even with a non-zero exit; and after 15s grace while still alive", async () => {
    const a = make({ observe: { successPattern: /Logged in successfully/ } }); await a.session.start();
    a.backend.pane = "Logged in successfully";
    a.backend.status = { alive: false, exitCode: 130 };
    await a.session.poll();
    expect(a.done[0]).toMatchObject({ ok: true, detail: "success reported" });

    const b = make({ observe: { successPattern: /Logged in successfully/ } }); await b.session.start();
    b.backend.pane = "Logged in successfully";
    await b.session.poll();                    // seen at t0, process still alive
    expect(b.done).toHaveLength(0);
    now += 16_000;
    await b.session.poll();
    expect(b.done[0]).toMatchObject({ ok: true });
  });
  it("finish is idempotent: TTL after exit does not report twice", async () => {
    const { session, backend, done } = make({ ttlMs: 2_000 });
    await session.start();
    backend.status = { alive: false, exitCode: 0 };
    await session.poll();
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toHaveLength(1);
    expect(backend.killed).toHaveLength(1);
  });
});

describe("observation", () => {
  it("posts the device URL + code once per distinct URL, never the token", async () => {
    const { session, backend, hints, audits } = make({ observe: { codePattern: /Code:\s*([A-Z0-9-]+)/ } });
    await session.start();
    backend.pane = "Confirm the following code in the browser\nCode: QFZB-JZXL\nOpen this URL: https://d-1.awsapps.com/start/#/device?user_code=QFZB-JZXL\n";
    await session.poll(); await session.poll();
    expect(hints).toEqual([["https://d-1.awsapps.com/start/#/device?user_code=QFZB-JZXL", "QFZB-JZXL"]]);
    const hint = audits.find(a => a[0] === "web_terminal_hint")!;
    expect(hint[1]).toMatchObject({ host: "d-1.awsapps.com", hasCode: true });
    expect(JSON.stringify(hint[1])).not.toContain("QFZB");
  });
});

describe("browser I/O", () => {
  it("replays buffered output to a late client, then streams live; a second client replaces the first", async () => {
    const { session, backend } = make();
    await session.start();
    backend.emit!(Buffer.from("early "));
    const a = { sent: [] as Array<Buffer | string>, send(d: Buffer | string) { this.sent.push(d); }, close: vi.fn() };
    const detachA = session.attachClient(a);
    expect(JSON.parse(a.sent[0] as string)).toMatchObject({ t: "hello", backend: "kiro-cli", kind: "login" });
    expect(a.sent[1]!.toString()).toBe("early ");
    backend.emit!(Buffer.from("live"));
    expect(a.sent[2]!.toString()).toBe("live");
    const b = { sent: [] as Array<Buffer | string>, send(d: Buffer | string) { this.sent.push(d); }, close: vi.fn() };
    session.attachClient(b);
    expect(a.close).toHaveBeenCalledWith(4000, expect.any(String));
    expect(b.sent.slice(1).map(String)).toEqual(["early ", "live"]);
    detachA();                                       // stale detach must not remove the live client
    backend.emit!(Buffer.from("more"));
    expect(b.sent.at(-1)!.toString()).toBe("more");
  });
  it("input goes to tmux as one buffer (never argv-chunked); resize is clamped and only the newest queued geometry is applied", async () => {
    const { session, backend } = make();
    await session.start();
    expect(session.input(Buffer.alloc(600, 0x41))).toBe(true);
    await session.drain();
    expect(backend.inputs.map(b => b.length)).toEqual([600]);
    session.resize(9999, 0);                                    // queued as 250×5…
    session.resize(9999, 0);
    session.resize(80.7, 24.2);                                 // …superseded before it ran
    await session.drain();
    expect(backend.resizes).toEqual([[80, 24]]);
  });

  it("B4: input and resize are one FIFO — a slow first frame still lands before a fast second one", async () => {
    vi.useRealTimers();
    const { session, backend } = make();
    await session.start();
    backend.inputDelayMs = b => (b[0] === 0x41 ? 60 : 0);     // 'A…' is slow, the rest instant
    session.input(Buffer.alloc(300, 0x41));
    session.input(Buffer.from("B"));                            // coalesces into A's batch (not started yet)
    session.resize(100, 30);                                    // barrier
    session.input(Buffer.from("C"));
    await session.drain();
    // Byte order is browser order; the resize sits between the two batches.
    expect(Buffer.concat(backend.inputs).toString()).toBe("A".repeat(300) + "B" + "C");
    expect(backend.inputs.map(b => b.length)).toEqual([301, 1]);
    expect(backend.resizes).toEqual([[100, 30]]);
  });

  it("B4: a backlog beyond MAX_PENDING_INPUT_BYTES means tmux is wedged — the session ENDS instead of queueing keystrokes unattended", async () => {
    vi.useRealTimers();
    const { session, backend, done } = make();
    await session.start();
    backend.inputDelayMs = () => 50;                            // everything stalls behind the first frame
    expect(session.input(Buffer.alloc(4096, 1))).toBe(true);
    let accepted = 1;
    while (session.input(Buffer.alloc(4096, 1))) accepted++;
    expect(accepted).toBe(MAX_PENDING_INPUT_BYTES / 4096);      // exactly the cap, then the session ends
    await new Promise(r => setTimeout(r, 20));
    expect(session.state).toBe("finished");
    expect(done[0]).toMatchObject({ ok: false, reason: "error" });
    expect(done[0].detail).toMatch(/backlog/);
    await session.drain();
    expect(backend.inputs.length).toBeLessThanOrEqual(1);        // the queue stopped touching tmux once finished
  });

  it("M1: a keystroke flood coalesces into one paste and a resize storm into one resize — jobs stay tiny", async () => {
    vi.useRealTimers();
    const { session, backend } = make();
    await session.start();
    backend.inputDelayMs = () => 30;                            // the first job is in flight; everything else queues
    session.input(Buffer.from("a"));
    await new Promise(r => setTimeout(r, 5));
    for (let i = 0; i < 1000; i++) session.input(Buffer.from("k"));      // 1-byte frames → one batch
    for (let i = 0; i < 1000; i++) session.resize(100 + (i % 2), 30);    // window drag → one tail resize (newest wins)
    expect(session.pendingJobs).toBeLessThanOrEqual(2);
    expect(session.state).toBe("running");
    await session.drain();
    expect(Buffer.concat(backend.inputs).toString()).toBe("a" + "k".repeat(1000));
    expect(backend.resizes).toEqual([[101, 30]]);                          // i=999 → 100 + 1
  });

  it("M1: input between every resize is a barrier each time — the job cap then ends the session as wedged (fail closed)", async () => {
    vi.useRealTimers();
    const { session, backend, done } = make();
    await session.start();
    backend.inputDelayMs = () => 30;
    session.input(Buffer.from("a"));
    await new Promise(r => setTimeout(r, 5));
    for (let i = 0; i < 1000 && session.state === "running"; i++) {
      session.input(Buffer.from("k"));
      session.resize(100 + (i % 2), 30);
    }
    expect(session.pendingJobs).toBeLessThanOrEqual(MAX_PENDING_JOBS);
    expect(session.state).toBe("finished");                                 // synchronous fail-closed
    await new Promise(r => setTimeout(r, 20));                              // onDone fires after the (fake) kill resolves
    expect(done[0]).toMatchObject({ ok: false, reason: "error" });
    expect(done[0].detail).toMatch(/backlog/);
    await session.drain();
    expect(backend.ops.length).toBeLessThanOrEqual(MAX_PENDING_JOBS + 1);   // nothing queued after finish reaches tmux
  });

  it("M1: input before a resize is pasted before it, input after is pasted after (resize is a barrier)", async () => {
    vi.useRealTimers();
    const { session, backend } = make();
    await session.start();
    backend.inputDelayMs = () => 20;
    session.input(Buffer.from("x"));
    session.input(Buffer.from("A"));                             // same batch as x (neither started yet)
    session.resize(90, 25);                                      // barrier
    session.input(Buffer.from("B"));                             // new batch, after the resize
    await session.drain();
    expect(backend.inputs.map(String)).toEqual(["xA", "B"]);
    expect(backend.resizes).toEqual([[90, 25]]);
  });

  it("M1 (round 3): input A → resize 90×25 → input B → resize 100×30 keeps every barrier in its FIFO slot", async () => {
    vi.useRealTimers();
    const { session, backend } = make();
    await session.start();
    backend.inputDelayMs = () => 20;                            // first job in flight; the four events queue up
    session.input(Buffer.from("x"));
    await new Promise(r => setTimeout(r, 5));                   // x has started; the batch is closed
    session.input(Buffer.from("A"));
    session.resize(90, 25);
    session.input(Buffer.from("B"));                            // freezes the first resize
    session.resize(100, 30);                                    // a NEW tail job, after B — must not overtake it
    await session.drain();
    expect(backend.ops).toEqual(["input:x", "input:A", "resize:90x25", "input:B", "resize:100x30"]);
  });

  it("M1 (round 3): two resizes with no input between still coalesce into the newer one", async () => {
    vi.useRealTimers();
    const { session, backend } = make();
    await session.start();
    backend.inputDelayMs = () => 20;
    session.input(Buffer.from("x"));
    await new Promise(r => setTimeout(r, 5));
    session.resize(90, 25);
    session.resize(100, 30);
    session.input(Buffer.from("B"));
    await session.drain();
    expect(backend.ops).toEqual(["input:x", "resize:100x30", "input:B"]);
  });

  it("M1 (round 4): returning to the committed geometry after a frozen resize is still a new barrier, not a dedupe", async () => {
    vi.useRealTimers();
    const { session, backend } = make();                        // committed 120×36
    await session.start();
    backend.inputDelayMs = () => 20;
    session.input(Buffer.from("x"));
    await new Promise(r => setTimeout(r, 5));
    session.resize(90, 25);
    session.input(Buffer.from("A"));                            // freezes the 90×25 resize
    session.resize(120, 36);                                    // equals the COMMITTED size, but the browser's latest request
    await session.drain();
    expect(backend.ops).toEqual(["input:x", "resize:90x25", "input:A", "resize:120x36"]);
    session.resize(120, 36);                                    // now a true duplicate of the last request
    await session.drain();
    expect(backend.resizes).toHaveLength(2);
  });

  it("a vanished tmux server (probe answers nothing 3× in a row) ends the session instead of idling until TTL", async () => {
    const { session, backend, done } = make();
    await session.start();
    backend.status = null;
    for (let i = 0; i < MAX_PROBE_FAILURES - 1; i++) await session.poll();
    expect(session.state).toBe("running");                     // transient misses are tolerated
    backend.status = { alive: true };
    await session.poll();                                       // one good answer resets the count
    backend.status = null;
    for (let i = 0; i < MAX_PROBE_FAILURES; i++) await session.poll();
    expect(session.state).toBe("finished");
    expect(done[0]).toMatchObject({ ok: false, reason: "error" });
    expect(done[0].detail).toMatch(/unreachable/);
  });

  it("B1: a failed tmux input FAILS CLOSED — session ends once, client told, later queued input never reaches tmux, secret never logged", async () => {
    vi.useRealTimers();
    const { session, backend, done } = make();
    await session.start();
    const c = { sent: [] as Array<Buffer | string>, send(d: Buffer | string) { this.sent.push(d); }, close: vi.fn() };
    session.attachClient(c);
    backend.inputDelayMs = () => 20;
    backend.failInput = new Error("tmux load-buffer failed: 53 55 50 45 52 SUPER-SECRET");
    expect(session.input(Buffer.from("SUPER-SECRET"))).toBe(true);
    session.resize(100, 30);                                     // barrier so the next frame is a second job
    expect(session.input(Buffer.from("LATER-KEYS"))).toBe(true);
    await session.drain();
    await new Promise(r => setTimeout(r, 10));
    expect(session.state).toBe("finished");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ ok: false, reason: "error" });
    expect(done[0].detail).toMatch(/input failed/);
    expect(c.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(c.sent.at(-1) as string)).toMatchObject({ t: "exit", reason: "error" });
    expect(backend.inputs).toHaveLength(0);                      // nothing delivered, before or after
    expect(session.input(Buffer.from("more"))).toBe(false);
    const logs = JSON.stringify(logger.warn.mock.calls) + JSON.stringify(logger.info.mock.calls);
    expect(logs).not.toContain("SUPER-SECRET");
    expect(logs).not.toContain("53 55 50");
    expect(logs).not.toContain("LATER-KEYS");
  });

  it("B1: a failed resize does not end the session and does not commit the geometry, so the next resize retries", async () => {
    vi.useRealTimers();
    const { session, backend } = make();
    await session.start();
    backend.resizeRejects = true;
    session.resize(100, 30);
    await session.drain();
    expect(session.state).toBe("running");
    backend.resizeRejects = false;
    session.resize(100, 30);                                     // same geometry: must NOT be deduplicated away
    await session.drain();
    expect(backend.resizes).toEqual([[100, 30]]);
  });

  it("B2: a kill that rejects (server may still be alive) is reported: cleanupFailed on the result + audit, never silent", async () => {
    vi.useRealTimers();
    const { session, backend, done, audits } = make();
    await session.start();
    backend.killRejects = true;
    await session.cancel("test");
    expect(done).toHaveLength(1);
    expect(done[0].cleanupFailed).toBe(true);
    expect(audits.some(a => a[0] === "web_terminal_cleanup_failed")).toBe(true);
    expect(audits.find(a => a[0] === "web_terminal_closed")![1]).toMatchObject({ cleanupFailed: true });
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/cleanup failed/));
  });

  it("B2: a clean kill reports cleanupFailed false", async () => {
    const { session, done, audits } = make();
    await session.start();
    await session.cancel("test");
    expect(done[0].cleanupFailed).toBeUndefined();
    expect(audits.find(a => a[0] === "web_terminal_closed")![1]).toMatchObject({ cleanupFailed: false });
  });

  it("B5: a tmux kill that never returns does not hang finish, and is reported as a cleanup failure", async () => {
    const { session, backend, done } = make();
    await session.start();
    backend.killHangs = true;
    const finished = session.cancel("test");
    await vi.advanceTimersByTimeAsync(5_100);
    await finished;
    expect(done).toHaveLength(1);
    expect(done[0].cleanupFailed).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/cleanup failed/));
  });
  it("after finish, input and resize are ignored and the client gets exit + close", async () => {
    const { session, backend } = make();
    await session.start();
    const c = { sent: [] as Array<Buffer | string>, send(d: Buffer | string) { this.sent.push(d); }, close: vi.fn() };
    session.attachClient(c);
    await session.cancel("admin cancelled");
    expect(JSON.parse(c.sent.at(-1) as string)).toMatchObject({ t: "exit", ok: false, reason: "cancel" });
    expect(c.close).toHaveBeenCalledWith(1000, "cancel");
    expect(session.input(Buffer.from("x"))).toBe(false);
    session.resize(100, 30);
    await session.drain();
    expect(backend.inputs).toHaveLength(0);
    expect(backend.resizes).toHaveLength(0);
  });
});
