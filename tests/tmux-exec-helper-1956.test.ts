/**
 * #1956 item 3: the spawn helper the fleet's tmux/stty commands are started by. Real helper processes; the binaries are
 * stubs (a shell script named tmux in a scratch bin on the calls' PATH) — never the real tmux, never the live server.
 * - The same result and error as the direct call: stdout, stderr, exit code, a timeout's kill; env and stdin input.
 * - Concurrent: a slow command never holds up another; a caller that awaits each call keeps its order.
 * - Exactly once: no "started" in time → the helper is ended and, once it is gone, the call goes direct; "started"
 *   with no answer → the error a timed-out direct call gives, never a second run; the helper killed mid-command →
 *   the command ran once, and is not run again.
 * - The fleet's own loop held past the start timeout retires nothing; a helper taken as wedged while its commands run
 *   is not killed: they answer, and only then does it exit (so does stop()).
 * - Not used when not running, refused, not allowlisted, or another binary on the call's PATH: direct.
 * - Restarted only by maintain(), after its backoff; ends with the fleet (stop, its parent dying).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecHelper, HELPER_SOURCE, type HelperExecOptions, type HelperExecResult } from "../src/tmux-exec-helper.js";

let root: string, bin: string, log: string, helpers: ExecHelper[] = [];
/** A private socket, as every test tmux call needs (the test process guard; the stub skips it). */
const SOCK = ["-L", "agend-test-1956"];
const env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_LOG: log });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-1956-exec-")); bin = join(root, "bin"); log = join(root, "log"); mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
if [ "$1" = "-L" ]; then shift 2; fi
echo "$*" >> "$TMUX_LOG"
case "$1" in
  slow) sleep "\${2:-1}"; printf slow ;;
  fail) echo "can't find window: x" >&2; exit 1 ;;
  env) printf '%s|%s' "$TMUX" "$LC_ALL" ;;
  cat) cat ;;
  *) printf 'ok:%s' "$*" ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
});
afterEach(() => { for (const h of helpers.splice(0)) h.stop(); rmSync(root, { recursive: true, force: true }); });
const ran = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
function helper(over: Partial<ConstructorParameters<typeof ExecHelper>[0]> = {}) {
  const direct = vi.fn((file: string, args: string[], _opts: HelperExecOptions) => Promise.resolve({ stdout: `direct:${file} ${args.join(" ")}`, stderr: "" }));
  const h = new ExecHelper({ direct, path: () => `${bin}:${process.env.PATH}`, ...over });
  helpers.push(h);
  return { h, direct };
}
/** A helper program that reads requests and answers as `answer` says (tests of the protocol's failure cases). */
function fakeHelper(answer: "never" | "started-only" | "first-only"): (allow: string[]) => ChildProcess {
  // first-only: starts the first request and answers it after 600 ms, never starts another; exits once its stdin has
  // ended and that answer is out (as the helper does).
  const src = answer === "never" ? `process.stdin.on("data", () => {}); setInterval(() => {}, 1000);`
    : answer === "first-only" ? `const { writeSync } = require("node:fs"); let b = "", first = true, busy = false, ended = false; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { b += c; let i; while ((i = b.indexOf("\\n")) >= 0) { const r = JSON.parse(b.slice(0, i)); b = b.slice(i + 1); if (!first) continue; first = false; busy = true; writeSync(1, JSON.stringify({ id: r.id, started: true }) + "\\n"); setTimeout(() => { writeSync(1, JSON.stringify({ id: r.id, done: true, stdout: "first", stderr: "", error: null }) + "\\n"); busy = false; if (ended) process.exit(0); }, 600); } }); process.stdin.on("end", () => { ended = true; if (!busy) process.exit(0); }); setInterval(() => {}, 1000);`
    : `const { writeSync } = require("node:fs"); let b = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { b += c; let i; while ((i = b.indexOf("\\n")) >= 0) { const r = JSON.parse(b.slice(0, i)); b = b.slice(i + 1); writeSync(1, JSON.stringify({ id: r.id, started: true }) + "\\n"); } }); setInterval(() => {}, 1000);`;
  return () => spawn(process.execPath, ["-e", src], { stdio: ["pipe", "pipe", "ignore"] });
}
const alive = (pid: number | undefined) => { try { process.kill(pid!, 0); return true; } catch { return false; } };

describe("the same command, the same answer", () => {
  it("stdout, through the helper (not direct)", async () => {
    const { h, direct } = helper(); h.start();
    expect(await h.exec("tmux", [...SOCK, "display-message", "-p", "x"], { env: env() })).toEqual({ stdout: "ok:display-message -p x", stderr: "" });
    expect(direct).not.toHaveBeenCalled();
  });
  it("a failing command: the error execFile gives — its exit code, stderr and message", async () => {
    const { h } = helper(); h.start();
    const err = await h.exec("tmux", [...SOCK, "fail"], { env: env() }).catch((e) => e);
    expect([err instanceof Error, err.code, err.stderr, err.killed, /Command failed: .*tmux -L agend-test-1956 fail/.test(err.message), err.message.includes("can't find window")])
      .toEqual([true, 1, "can't find window: x\n", false, true, true]);
  });
  it("a timeout kills it, as execFile's does", async () => {
    const { h } = helper(); h.start();
    const err = await h.exec("tmux", [...SOCK, "slow", "5"], { env: env(), timeout: 200 }).catch((e) => e);
    expect([err.killed, err.signal]).toEqual([true, "SIGTERM"]);
  });
  it("the call's env and stdin input reach the command", async () => {
    const { h } = helper(); h.start();
    expect((await h.exec("tmux", [...SOCK, "env"], { env: { ...env(), TMUX: "/tmp/sock,1,0", LC_ALL: "C.UTF-8" } })).stdout).toBe("/tmp/sock,1,0|C.UTF-8");
    expect((await h.exec("tmux", [...SOCK, "cat"], { env: env(), input: "pasted\nlines" })).stdout).toBe("pasted\nlines");
  });
});

describe("concurrent, and in each caller's order", () => {
  it("a slow capture never holds up a write: the write answers first", async () => {
    const { h } = helper(); h.start();
    const order: string[] = [];
    const slow = h.exec("tmux", [...SOCK, "slow", "1"], { env: env() }).then(() => order.push("capture"));
    const write = h.exec("tmux", [...SOCK, "send-keys", "Enter"], { env: env() }).then(() => order.push("write"));
    await Promise.all([slow, write]);
    expect(order).toEqual(["write", "capture"]);
  });
  it("a caller awaiting each call keeps its order", async () => {
    const { h } = helper(); h.start();
    for (const k of ["load-buffer", "paste-buffer", "send-keys"]) await h.exec("tmux", [...SOCK, k], { env: env() });
    expect(ran()).toEqual(["load-buffer", "paste-buffer", "send-keys"]);
  });
});

describe("exactly once", () => {
  it("no 'started' in time: the helper is ended, and once it is gone the call goes direct — once", async () => {
    const { h, direct } = helper({ spawnHelper: fakeHelper("never"), startTimeoutMs: 150 }); h.start();
    const r = await h.exec("tmux", [...SOCK, "send-keys", "Enter"], { env: env() });
    expect([r.stdout, direct.mock.calls.length, h.usable()]).toEqual(["direct:tmux -L agend-test-1956 send-keys Enter", 1, false]);
  });
  it("'started' and then no answer: the error a timed-out direct call gives — never run again directly", async () => {
    const { h, direct } = helper({ spawnHelper: fakeHelper("started-only"), answerGraceMs: 100 }); h.start();
    const err = await h.exec("tmux", [...SOCK, "paste-buffer"], { env: env(), timeout: 100 }).catch((e) => e);
    expect([err.killed, err.signal, direct.mock.calls.length, h.usable()]).toEqual([true, "SIGTERM", 0, false]);
  });
  it("the helper killed while its command runs: the command ran once, the call fails, nothing is run again", async () => {
    const { h, direct } = helper(); h.start();
    const call = h.exec("tmux", [...SOCK, "slow", "0.5"], { env: env() }).catch((e) => e);
    await vi.waitFor(() => expect(ran()).toEqual(["slow 0.5"]));                           // started by the helper
    (h as any).proc.kill("SIGKILL");
    const err = await call;
    await new Promise((r) => setTimeout(r, 700));                                          // the command finishes on its own
    expect([err.killed, direct.mock.calls.length, ran()]).toEqual([true, 0, ["slow 0.5"]]);
  });
  it("calls the helper never started when it died go direct, once each", async () => {
    const { h, direct } = helper({ spawnHelper: fakeHelper("never"), startTimeoutMs: 5_000 }); h.start();
    const a = h.exec("tmux", [...SOCK, "a"], { env: env() }), b = h.exec("tmux", [...SOCK, "b"], { env: env() });
    (h as any).proc.kill("SIGKILL");
    expect((await Promise.all([a, b])).map((r) => r.stdout)).toEqual(["direct:tmux -L agend-test-1956 a", "direct:tmux -L agend-test-1956 b"]);
    expect(direct.mock.calls.length).toBe(2);
  });
});

describe("a stalled fleet, a slow helper", () => {
  it("the fleet's loop held past the start timeout in a check-phase callback: nothing retired, nothing failed, each ran once", async () => {
    // As reviewed: a slow command runs; then, in a setImmediate callback, a write is sent and the fleet's loop is held
    // past the start timeout, so the timers phase comes before the poll that reads its "started".
    const events: string[] = [];
    const { h, direct } = helper({ startTimeoutMs: 300, log: (e) => events.push(e) }); h.start();
    const slow = h.exec("tmux", [...SOCK, "slow", "1.5"], { env: env() });
    await vi.waitFor(() => expect(ran()).toEqual(["slow 1.5"]));
    const write = await new Promise<{ p: Promise<HelperExecResult> }>((resolve) => setImmediate(() => {
      const p = h.exec("tmux", [...SOCK, "send-keys", "Enter"], { env: env() });
      const until = performance.now() + 360; while (performance.now() < until) { /* the fleet's loop, held */ }
      resolve({ p });
    }));
    expect((await Promise.all([slow, write.p])).map((r) => r.stdout)).toEqual(["slow", "ok:send-keys Enter"]);
    expect([events, direct.mock.calls.length, h.usable(), ran()]).toEqual([[], 0, true, ["slow 1.5", "send-keys Enter"]]);
  });
  it("taken as wedged while its command runs: not killed — that command answers, and the call it never started goes direct once it has exited", async () => {
    const events: string[] = [];
    const { h, direct } = helper({ spawnHelper: fakeHelper("first-only"), startTimeoutMs: 10_000, log: (e, d) => events.push(`${e}:${String(d?.why)}`) }); h.start();
    const pid = (h as any).proc.pid as number;
    const first = h.exec("tmux", [...SOCK, "slow"], { env: env() });
    await vi.waitFor(() => expect([...(h as any).pending.values()].some((p: { started: boolean }) => p.started)).toBe(true));
    (h as any).options.startTimeoutMs = 200;                                                // the helper has booted: now a short wait
    const second = h.exec("tmux", [...SOCK, "send-keys", "Enter"], { env: env() });
    const order: string[] = [];
    first.then(() => order.push("first")); second.then(() => order.push(`second exited=${!alive(pid)}`));
    expect((await Promise.all([first, second])).map((r) => r.stdout)).toEqual(["first", "direct:tmux -L agend-test-1956 send-keys Enter"]);
    expect([events, direct.mock.calls.length, order]).toEqual([["retired:no_start"], 1, ["first", "second exited=true"]]);
  });
  it("stop() while a command runs: it answers (not a timeout), then the helper exits", async () => {
    const { h } = helper(); h.start();
    const pid = (h as any).proc.pid as number;
    const call = h.exec("tmux", [...SOCK, "slow", "0.4"], { env: env() });
    await vi.waitFor(() => expect(ran()).toEqual(["slow 0.4"]));
    h.stop();
    expect((await call).stdout).toBe("slow");
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
  });
  it("an error names the command as the direct call does (tmux …, not the helper's absolute path)", async () => {
    const { h } = helper(); h.start();
    const err = await h.exec("tmux", [...SOCK, "fail"], { env: env() }).catch((e) => e);
    expect(err.message.split("\n")[0]).toBe("Command failed: tmux -L agend-test-1956 fail");
  });
});

describe("when the helper is not used: direct", () => {
  it("not started (the fleet hasn't), stopped, or another binary than tmux/stty", async () => {
    const { h, direct } = helper();
    await h.exec("tmux", [...SOCK, "x"], { env: env() });
    h.start();
    await h.exec("ls", ["-l"], { env: env() });
    h.stop();
    await h.exec("tmux", [...SOCK, "y"], { env: env() });
    expect(direct.mock.calls.map((c) => `${c[0]} ${c[1].join(" ")}`)).toEqual(["tmux -L agend-test-1956 x", "ls -l", "tmux -L agend-test-1956 y"]);
    expect(ran()).toEqual([]);
  });
  it("the call's PATH resolves tmux elsewhere than the helper's allowlist: direct", async () => {
    const { h, direct } = helper(); h.start();
    const other = join(root, "other"); mkdirSync(other); writeFileSync(join(other, "tmux"), "#!/bin/sh\nexit 0\n"); chmodSync(join(other, "tmux"), 0o755);
    await h.exec("tmux", [...SOCK, "z"], { env: { ...env(), PATH: other } });
    expect([direct.mock.calls.length, ran()]).toEqual([1, []]);
  });
  it("a request the helper refuses (not allowlisted there) goes direct", async () => {
    const { h, direct } = helper({ spawnHelper: () => spawn(process.execPath, ["-e", HELPER_SOURCE, "[]"], { stdio: ["pipe", "pipe", "ignore"] }) }); h.start();
    expect((await h.exec("tmux", [...SOCK, "q"], { env: env() })).stdout).toBe("direct:tmux -L agend-test-1956 q");
    expect(direct).toHaveBeenCalledTimes(1);
  });
});

describe("its lifetime", () => {
  it("restarted only by maintain(), after its backoff", async () => {
    let now = 0;
    const { h } = helper({ now: () => now }); h.start();
    const first = (h as any).proc as ChildProcess;
    first.kill("SIGKILL");
    await vi.waitFor(() => expect((h as any).proc).toBeNull());
    now = 500; h.maintain();
    expect((h as any).proc).toBeNull();                                                    // inside the 1 s backoff
    now = 1_200; h.maintain();
    expect([(h as any).proc !== null, h.usable()]).toEqual([true, true]);
    expect((await h.exec("tmux", [...SOCK, "again"], { env: env() })).stdout).toBe("ok:again");
  });
  it("a call waiting on the helper keeps the process alive (as a direct call's child would); an idle helper never does", async () => {
    // Both as their own node process: one awaits a slow call and must print its answer; one only starts the helper and
    // must exit at once.
    const mod = join(process.cwd(), "src", "tmux-exec-helper.ts");
    const script = (body: string) => { const f = join(root, `s${Math.random().toString(36).slice(2)}.mts`);
      writeFileSync(f, `const { ExecHelper } = await import(${JSON.stringify(mod)});
const h = new ExecHelper({ direct: async () => ({ stdout: "direct", stderr: "" }), path: () => ${JSON.stringify(bin)} + ":" + process.env.PATH });
h.start();
${body}`); return f; };
    const run = (f: string) => new Promise<{ code: number | null; out: string; ms: number }>((resolve) => {
      const t = performance.now(), c = spawn(process.execPath, ["--import", "tsx", f], { env: env(), stdio: ["ignore", "pipe", "ignore"] });
      let out = ""; c.stdout!.on("data", (d) => { out += d; });
      c.on("close", (code) => resolve({ code, out, ms: performance.now() - t }));
    });
    const waits = await run(script(`const r = await h.exec("tmux", ["-L", "agend-test-1956", "slow", "0.3"], { env: process.env }); console.log(r.stdout);`));
    expect([waits.code, waits.out.trim()]).toEqual([0, "slow"]);
    const idle = await run(script(`console.log("started");`));
    expect([idle.code, idle.out.trim(), idle.ms < 5000]).toEqual([0, "started", true]);
  });
  it("stop(): the helper's stdin ends and it exits", async () => {
    const { h } = helper(); h.start();
    const pid = (h as any).proc.pid as number;
    h.stop();
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
  });
  it("a helper whose parent no longer exists exits, though its stdin is still open (the rule itself)", async () => {
    const gone = spawn(process.execPath, ["-e", ""]);
    const deadPid = gone.pid!;
    await new Promise((r) => gone.on("close", r));
    const h = spawn(process.execPath, ["-e", HELPER_SOURCE, "[]", String(deadPid)], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      // Its stdin is never ended here: only its parent check can end it.
      await vi.waitFor(() => expect(h.exitCode).toBe(0), { timeout: 5000 });
    } finally { try { h.kill("SIGKILL"); } catch { /* gone */ } h.stdin!.destroy(); }
  });
  it("its parent dying (SIGKILL) ends it, though something else still holds its stdin", async () => {
    // A stand-in parent starts the helper on its own stdin — a FIFO this test also holds open (read/write), so the
    // helper's stdin never ends — and is killed: only the helper's parent check can end it.
    const src = join(root, "helper.js"), stand = join(root, "stand-in.js"), fifo = join(root, "fifo");
    writeFileSync(src, HELPER_SOURCE);
    writeFileSync(stand, `const { spawn } = require("node:child_process");
const h = spawn(process.execPath, [${JSON.stringify(src)}, "[]"], { stdio: ["inherit", "ignore", "ignore"] });
process.stdout.write(h.pid + "\\n"); setInterval(() => {}, 1000);`);
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const fd = openSync(fifo, fsConstants.O_RDWR);                                          // never EOF while this is open
    const parent = spawn(process.execPath, [stand], { stdio: [fd, "pipe", "ignore"] });
    const hpid = await new Promise<number>((r) => parent.stdout!.once("data", (d) => r(Number(String(d).trim()))));
    try {
      expect(alive(hpid), "the helper runs").toBe(true);
      parent.kill("SIGKILL");
      await vi.waitFor(() => expect(alive(hpid)).toBe(false), { timeout: 5000 });
    } finally { closeSync(fd); try { process.kill(hpid, "SIGKILL"); } catch { /* gone */ } }
  });
});
