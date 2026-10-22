/**
 * #2364: on a stop, the fleet ended the tmux exec helper's stdin and exited at once. Under a service manager the
 * helper (and its threads) was then SIGKILLed with what was left of the unit (KillMode=mixed), and systemd logged
 * "remains running after unit stopped" for it. stop() now waits, bounded, for the helper to exit on its own, and
 * FleetManager.stopAll() resolves only after that wait — so the process exits after the helper does.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecHelper, HELPER_STOP_WAIT_MS, tmuxExecHelper } from "../src/tmux-exec-helper.js";
import { FleetManager } from "../src/fleet-manager.js";

let root: string, bin: string;
const helpers: ExecHelper[] = [];
const SOCK = ["-L", "agend-test-2364"];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-2364-")); bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nif [ "$1" = "-L" ]; then shift 2; fi\ncase "$1" in slow) sleep "$2"; printf slow ;; *) printf ok ;; esac\n`);
  chmodSync(join(bin, "tmux"), 0o755);
});
afterEach(() => { for (const h of helpers.splice(0)) void h.stop(0); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const make = (spawnHelper?: (allow: string[]) => ChildProcess) => {
  const h = new ExecHelper({ direct: () => Promise.resolve({ stdout: "direct", stderr: "" }), path: () => `${bin}:${process.env.PATH}`, ...(spawnHelper ? { spawnHelper } : {}) });
  helpers.push(h);
  return h;
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const procOf = (h: ExecHelper) => (h as unknown as { proc: ChildProcess }).proc;

describe("ExecHelper.stop() waits for the helper to leave", () => {
  it("resolves once the real helper has exited — not before", async () => {
    const h = make(); h.start();
    const pid = procOf(h).pid!;
    await h.stop();
    expect(alive(pid)).toBe(false);
  });

  it("a command still running is answered first; stop() resolves after its answer and the helper's exit", async () => {
    const h = make(); h.start();
    const proc = procOf(h);
    const call = h.exec("tmux", [...SOCK, "slow", "0.4"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    await vi.waitFor(() => expect((h as unknown as { pending: Map<number, { started: boolean }> }).pending.size).toBe(1));
    const order: string[] = [];
    void call.then(() => order.push("answered"));
    await h.stop().then(() => order.push(`stopped exited=${proc.exitCode !== null}`));
    expect(order).toEqual(["answered", "stopped exited=true"]);
  });

  it("bounded: a helper that never leaves does not hold the stop longer than the wait", async () => {
    const h = make(() => spawn(process.execPath, ["-e", `process.stdin.on("data", () => {}); process.stdin.on("end", () => {}); setInterval(() => {}, 1000);`], { stdio: ["pipe", "pipe", "ignore"] }));
    h.start();
    const pid = procOf(h).pid!;
    const t0 = performance.now();
    await h.stop(300);
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(290);
    expect(ms).toBeLessThan(2000);
    expect(alive(pid)).toBe(true);           // left for the caller (and, under a service manager, its final kill)
    process.kill(pid, "SIGKILL");
  });

  it("nothing started, or already gone: resolves at once", async () => {
    const idle = make();
    const t0 = performance.now();
    await idle.stop();
    const h = make(); h.start();
    const proc = procOf(h);
    await h.stop();
    await h.stop();                           // a second stop: the helper is gone already
    expect(proc.exitCode).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(HELPER_STOP_WAIT_MS);
  });

  it("the default wait is about 2 s", () => {
    expect(HELPER_STOP_WAIT_MS).toBe(2000);
  });
});

describe("FleetManager.stopAll() resolves after the helper's wait", () => {
  it("not before tmuxExecHelper.stop() settles; one promise for overlapping calls; the latch clears after", async () => {
    let release!: () => void;
    const helperStop = vi.spyOn(tmuxExecHelper, "stop").mockImplementation(() => new Promise<void>(r => { release = r; }));
    const fm = Object.create(FleetManager.prototype) as FleetManager;
    const latch = () => (fm as unknown as { stopAllInFlight: Promise<void> | null }).stopAllInFlight;
    let stops = 0;
    Object.assign(fm, { stopAllInFlight: null, tmuxExecHelperTimer: null, doStopAll: async () => { stops++; } });
    const first = fm.stopAll();
    const second = fm.stopAll();
    expect(second).toBe(first);
    let settled = false;
    void first.then(() => { settled = true; });
    await vi.waitFor(() => expect(helperStop).toHaveBeenCalledOnce());
    await new Promise(r => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(latch()).toBe(first);   // still one stop in flight while the helper leaves
    release();
    await first;
    expect([settled, stops, latch()]).toEqual([true, 1, null]);
  });
});
