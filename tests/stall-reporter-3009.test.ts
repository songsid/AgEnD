/**
 * #3009: the stall reporter names what the main thread is stuck in, from a worker thread, while it is stuck — the
 * event-loop watch cannot (it runs on the stuck thread). The main thread is really blocked in a system call here
 * (Atomics.wait = futex), and the real /proc/self/task/<pid> is read.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStallReporter, type StallReporter } from "../src/stall-reporter.js";

const dirs: string[] = [];
const reporters: StallReporter[] = [];
afterEach(() => { for (const r of reporters.splice(0)) r.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-3009-stall-")); dirs.push(d); return d; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Block THIS thread in the kernel (a futex wait), as a stuck synchronous call does. */
const blockMainThread = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = (f: string) => existsSync(f) ? readFileSync(f, "utf8") : "";

describe.skipIf(process.platform !== "linux")("the stall reporter (#3009)", () => {
  it("a main thread stuck in a system call is named while it is stuck: state, wchan, syscall — then 'running again'", async () => {
    const log = join(tmp(), "daemon.log");
    reporters.push(startStallReporter({ logFile: log, stallMs: 400, checkMs: 50, heartbeatMs: 50 })!);
    await sleep(300);                                               // the worker is up and has seen heartbeats
    blockMainThread(1_500);
    // Written while the main thread was blocked: it cannot have been this thread that wrote it.
    const during = read(log);
    // The call number is the architecture's (#3017 review, Prism P3): futex is 202 on x86_64, 98 on arm64.
    expect(during).toMatch(/ERROR: The fleet's main thread has not run for \d+ s \(#3009 stall report\): state=S wchan=\S+ syscall=\d+ /);
    const futex = ({ x64: "202", arm64: "98" } as Record<string, string>)[process.arch];
    if (futex) expect(during).toContain(` syscall=${futex} `);
    await sleep(300);
    expect(read(log)).toMatch(/WARN: The fleet's main thread is running again after \d+ s/);
  }, 15_000);

  it("a healthy loop writes nothing; one report per stall, not one per check", async () => {
    const log = join(tmp(), "daemon.log");
    reporters.push(startStallReporter({ logFile: log, stallMs: 400, checkMs: 50, heartbeatMs: 50 })!);
    await sleep(1_200);
    expect(read(log)).toBe("");
    blockMainThread(1_300);                                         // > 3 × the threshold
    expect(read(log).match(/ERROR:/g)).toHaveLength(1);
  }, 15_000);

  it("unreadable /proc fields are said as such, never a crash (a fake task dir with only `stat`)", async () => {
    const root = tmp(), task = join(root, "4242");
    mkdirSync(task);
    writeFileSync(join(task, "stat"), "4242 (node) D 1 4242 4242 0 -1");
    const log = join(tmp(), "daemon.log");
    reporters.push(startStallReporter({ logFile: log, stallMs: 300, checkMs: 50, heartbeatMs: 50, procRoot: root, tid: 4242 })!);
    await sleep(200);
    blockMainThread(900);
    expect(read(log)).toMatch(/state=D wchan=\(ENOENT\) syscall=\(ENOENT\)/);
  }, 15_000);

  it("stopped: no report afterwards", async () => {
    const log = join(tmp(), "daemon.log");
    const r = startStallReporter({ logFile: log, stallMs: 300, checkMs: 50, heartbeatMs: 50 })!;
    await sleep(200);
    r.stop();
    await sleep(200);
    blockMainThread(900);
    await sleep(200);
    expect(read(log)).toBe("");
  }, 15_000);
});

describe("the fleet runs it (#3009)", () => {
  it("started with daemon.log beside the event-loop watch, and stopped at shutdown and on an aborted start", () => {
    const src = readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
    const start = src.indexOf("this.eventLoopWatch = startEventLoopWatch({ logger: this.logger });");
    expect(start).toBeGreaterThan(0);
    expect(src.slice(start, start + 400)).toContain('this.stallReporter = startStallReporter({ logFile: join(this.dataDir, "daemon.log") });');
    expect(src.match(/this\.stallReporter\?\.stop\(\);/g)?.length).toBeGreaterThanOrEqual(3);   // restart, aborted start, shutdown
  });
});
