import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSdNotifier, startSdWatchdog } from "../src/sd-notify.js";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function harness() {
  vi.useFakeTimers();
  let owner = 42;
  const callbacks: Array<(e: Error | null) => void> = [];
  const send = vi.fn((_state: string, _socket: string, done: (e: Error | null) => void) => { callbacks.push(done); });
  const warn = vi.fn();
  const notify = createSdNotifier({ socket: "/scratch/notify", pid: () => 42, recordedPid: () => owner,
    send, warn: () => warn, now: () => Date.now() });
  return { notify, send, warn, callbacks, revoke: () => { owner = 7; } };
}
const timeout = () => Object.assign(new Error("Command failed: systemd-notify WATCHDOG=1"), { code: null, signal: "SIGTERM", killed: true });

describe("#2813 heartbeat margin", () => {
  it("offers six main-loop pings per minute instead of two", () => {
    vi.useFakeTimers(); const ping = vi.fn(); const timer = startSdWatchdog(ping);
    vi.advanceTimersByTime(9_999); expect(ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50_001); expect(ping).toHaveBeenCalledTimes(6);
    expect(ping.mock.calls.every(([state]) => state === "WATCHDOG=1")).toBe(true);
    clearInterval(timer);
  });

  it("retries a failed ping once promptly, logs both failures with full child diagnostics, and stops", () => {
    const h = harness(); h.notify("WATCHDOG=1"); vi.advanceTimersByTime(5_000); h.callbacks[0](timeout());
    expect(h.warn.mock.calls[0][0]).toMatchObject({ code: null, signal: "SIGTERM", killed: true, elapsedMs: 5_000, retry: false });
    vi.advanceTimersByTime(999); expect(h.send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); expect(h.send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000); h.callbacks[1](timeout());
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.warn.mock.calls[1][0]).toMatchObject({ elapsedMs: 5_000, retry: true });
    vi.advanceTimersByTime(60_000); expect(h.send).toHaveBeenCalledTimes(2);
    h.notify("WATCHDOG=1"); h.callbacks[2](Object.assign(new Error("Failed to invoke barrier: Connection timed out"), { code: 1 }));
    expect(h.warn).toHaveBeenCalledTimes(3);
    expect(h.warn.mock.calls[2][0]).toMatchObject({ code: 1, signal: null, killed: false });
  });

  it("a successful retry is quiet, and a synchronous spawn error gets the same bounded retry", () => {
    const h = harness(); h.notify("WATCHDOG=1"); h.callbacks[0](timeout());
    vi.advanceTimersByTime(1_000); h.callbacks[1](null);
    vi.advanceTimersByTime(20_000); expect(h.send).toHaveBeenCalledTimes(2); expect(h.warn).toHaveBeenCalledTimes(1);
    const fail = vi.fn(() => { throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }); });
    const notify = createSdNotifier({ socket: "/scratch/notify", pid: () => 42, recordedPid: () => 42, send: fail, warn: () => h.warn });
    notify("WATCHDOG=1"); vi.advanceTimersByTime(60_000); expect(fail).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledTimes(3);
  });

  it("rechecks ownership on retry and does not retry lifecycle notifications", () => {
    const h = harness(); h.notify("WATCHDOG=1"); h.callbacks[0](timeout()); h.revoke();
    vi.advanceTimersByTime(1_000); expect(h.send).toHaveBeenCalledTimes(1);
    const other = harness(); other.notify("READY=1"); other.callbacks[0](timeout());
    vi.advanceTimersByTime(30_000); expect(other.send).toHaveBeenCalledTimes(1);
  });

  it("stop cancels a pending retry and fences a late in-flight failure", () => {
    const h = harness(); h.notify("WATCHDOG=1"); h.callbacks[0](timeout()); h.notify.cancelRetry();
    vi.advanceTimersByTime(1_000); expect(h.send).toHaveBeenCalledTimes(1);
    h.notify("WATCHDOG=1"); h.notify("STOPPING=1"); h.callbacks[1](timeout()); h.callbacks[2](null);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000); expect(h.send).toHaveBeenCalledTimes(3);
  });

  it("a newer normal ping supersedes an old retry or late callback", () => {
    const h = harness(); h.notify("WATCHDOG=1"); h.notify("WATCHDOG=1"); h.callbacks[0](timeout()); h.callbacks[1](null);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000); expect(h.send).toHaveBeenCalledTimes(2);
  });
});


describe("#2813 real default-notifier shutdown entry point", () => {
  it.each(["pending retry", "in-flight callback"])("sdNotifyBlocking cancels %s", async phase => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "agend-notify-stop-"));
    writeFileSync(join(dir, "fleet.pid"), String(process.pid));
    const callbacks: Array<(error: Error | null) => void> = [];
    const asyncSend = vi.fn((_file: string, _args: string[], _opts: unknown, done: (error: Error | null) => void) => { callbacks.push(done); });
    const blockingSend = vi.fn();
    vi.resetModules();
    vi.doMock("../src/paths.js", () => ({ getAgendHome: () => dir }));
    vi.doMock("../src/child-process.js", () => ({ execFile: asyncSend }));
    vi.doMock("node:child_process", () => ({ execFileSync: blockingSend }));
    vi.stubEnv("NOTIFY_SOCKET", "/scratch/notify");
    try {
      const api = await import("../src/sd-notify.js");
      api.sdNotify("WATCHDOG=1");
      expect(asyncSend).toHaveBeenCalledTimes(1);
      if (phase === "pending retry") { callbacks[0](timeout()); expect(vi.getTimerCount()).toBe(1); }
      api.sdNotifyBlocking("STOPPING=1");
      expect(blockingSend).toHaveBeenCalledWith("systemd-notify", ["STOPPING=1"], expect.objectContaining({ timeout: 5_000 }));
      if (phase === "in-flight callback") callbacks[0](timeout());
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(asyncSend).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("../src/paths.js"); vi.doUnmock("../src/child-process.js"); vi.doUnmock("node:child_process");
      vi.unstubAllEnvs(); vi.resetModules(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
