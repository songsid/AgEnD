import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeNotifySocket,
  createSdNotifier,
  isFleetOwner,
  recordedFleetPid,
  SD_NOTIFY_WARN_INTERVAL_MS,
  sendSystemdNotification,
  sendSystemdNotificationAsync,
} from "../src/sd-notify.js";

describe("systemd notification capability containment", () => {
  it("removes NOTIFY_SOCKET from the ambient environment", () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
    };

    expect(consumeNotifySocket(environment)).toBe("/run/user/1000/systemd/notify");
    expect(environment).toEqual({ PATH: "/usr/bin" });
  });

  it("passes NOTIFY_SOCKET only in the helper environment", () => {
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const execute = vi.fn();

    sendSystemdNotification(
      "READY=1",
      "/run/user/1000/systemd/notify",
      environment,
      execute,
    );

    expect(environment.NOTIFY_SOCKET).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      "systemd-notify",
      ["READY=1"],
      expect.objectContaining({
        env: {
          PATH: "/usr/bin",
          NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
        },
        stdio: "ignore",
        timeout: 5000,
      }),
    );
  });

  it("deletes an explicitly empty socket at module-load-equivalent consumption", () => {
    const environment: NodeJS.ProcessEnv = { NOTIFY_SOCKET: "" };
    expect(consumeNotifySocket(environment)).toBeUndefined();
    expect(environment.NOTIFY_SOCKET).toBeUndefined();
  });

  it("only recognizes the PID recorded as the fleet owner", () => {
    const dataDir = join(tmpdir(), `agend-sd-notify-${process.pid}-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(join(dataDir, "fleet.pid"), String(process.pid));
      expect(isFleetOwner(dataDir, process.pid)).toBe(true);
      expect(isFleetOwner(dataDir, process.pid + 1)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("a notification that is not sent says so — once per kind per window", () => {
  function notifier(over: { socket?: string | undefined; recorded?: number | null; fail?: Error | "throw" | null } = {}) {
    let clock = 0;
    const warn = vi.fn();
    const send = vi.fn((_state: string, _socket: string, onDone: (e: Error | null) => void) => {
      if (over.fail === "throw") throw new Error("spawn EAGAIN");
      onDone(over.fail ?? null);
    });
    const notify = createSdNotifier({
      socket: "socket" in over ? over.socket : "/run/notify",
      pid: () => 100,
      recordedPid: () => ("recorded" in over ? over.recorded! : 100),
      send,
      warn: () => warn,
      now: () => clock,
    });
    return { notify, warn, send, tick: (ms: number) => { clock += ms; } };
  }

  it("the owner pings, and a ping that works says nothing", () => {
    const n = notifier();
    n.notify("WATCHDOG=1");
    expect(n.send).toHaveBeenCalledWith("WATCHDOG=1", "/run/notify", expect.any(Function));
    expect(n.warn).not.toHaveBeenCalled();
  });

  it("not under systemd (no socket): nothing is sent and nothing is said", () => {
    const n = notifier({ socket: undefined, recorded: 7 });
    n.notify("WATCHDOG=1");
    expect([n.send.mock.calls.length, n.warn.mock.calls.length]).toEqual([0, 0]);
  });

  it("fleet.pid naming another process (or none): not sent, and warned — then quiet for the window, then again", () => {
    for (const recorded of [7, null]) {
      const n = notifier({ recorded });
      n.notify("WATCHDOG=1");
      expect(n.send).not.toHaveBeenCalled();
      expect(n.warn).toHaveBeenCalledTimes(1);
      expect(n.warn.mock.calls[0]![0]).toEqual({ state: "WATCHDOG=1", pid: 100, recordedPid: recorded });
      expect(String(n.warn.mock.calls[0]![1])).toMatch(/fleet\.pid/);
      n.tick(SD_NOTIFY_WARN_INTERVAL_MS - 1); n.notify("WATCHDOG=1");
      expect(n.warn).toHaveBeenCalledTimes(1);
      n.tick(1); n.notify("WATCHDOG=1");
      expect(n.warn).toHaveBeenCalledTimes(2);
    }
  });

  it("systemd-notify failing, or not starting at all: warned, rate-limited the same way", () => {
    for (const fail of [Object.assign(new Error("Command failed"), { code: 1 }), "throw" as const]) {
      const n = notifier({ fail });
      n.notify("WATCHDOG=1"); n.notify("WATCHDOG=1");
      expect(n.warn).toHaveBeenCalledTimes(1);
      expect(String(n.warn.mock.calls[0]![1])).toMatch(/systemd-notify/);
    }
  });

  it("the async sender hands the child's error to its caller", () => {
    const onDone = vi.fn();
    const failure = new Error("exit 1");
    sendSystemdNotificationAsync("WATCHDOG=1", "/run/notify", {}, (_f, _a, _o, cb) => { cb(failure); return undefined; }, onDone);
    expect(onDone).toHaveBeenCalledWith(failure);
  });

  it("recordedFleetPid reads the pid, and null when there is none", () => {
    const dataDir = join(tmpdir(), `agend-sd-notify-rec-${process.pid}-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    try {
      expect(recordedFleetPid(dataDir)).toBeNull();
      writeFileSync(join(dataDir, "fleet.pid"), "4242\n");
      expect(recordedFleetPid(dataDir)).toBe(4242);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
