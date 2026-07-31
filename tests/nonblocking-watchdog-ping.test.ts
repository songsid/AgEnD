import { describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  sendSystemdNotification,
  sendSystemdNotificationAsync,
  buildNotifyEnvironment,
} from "../src/sd-notify.js";

/**
 * The systemd watchdog ping exists to prove this process is still turning its
 * event loop. It used to prove that with `execFileSync`, which stopped the loop
 * for as long as the fork took — up to its own 5s timeout — every 30 seconds.
 * Forking is slowest exactly when the machine is loaded, which is when the ping
 * matters, so a slow one could push past `WatchdogSec=60` and have systemd
 * SIGABRT a fleet that was working fine.
 */

const execFileP = promisify(execFile);

/** How many times a 10ms interval fires while `work` runs. */
async function ticksDuring(work: () => Promise<unknown>): Promise<number> {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return ticks;
}

describe("watchdog ping does not stall the event loop", () => {
  it("returns before the child has finished", async () => {
    // The point of the async path: sdNotify hands off and returns immediately.
    let childDone = false;
    let returned = false;

    sendSystemdNotificationAsync("WATCHDOG=1", "/run/notify", {}, (_f, _a, _o, cb) => {
      setTimeout(() => { childDone = true; cb(null); }, 50);
      return undefined;
    });
    returned = true;

    expect(returned).toBe(true);
    expect(childDone).toBe(false);
    await new Promise(r => setTimeout(r, 80));
    expect(childDone).toBe(true);
  });

  it("keeps timers running for the duration of a slow ping", async () => {
    const ticks = await ticksDuring(async () => {
      await new Promise<void>(resolve => {
        sendSystemdNotificationAsync("WATCHDOG=1", "/run/notify", {}, (_f, _a, _o, cb) => {
          // Stand in for a fork that takes 300ms on a loaded box.
          void execFileP("sleep", ["0.3"]).then(() => { cb(null); resolve(); });
          return undefined;
        });
      });
    });

    expect(ticks).toBeGreaterThan(5);
  });

  it("shows what the synchronous version did", async () => {
    // Same duration, blocking. Zero timers fired — including, in production, the
    // next watchdog timer and every message delivery.
    const ticks = await ticksDuring(async () => {
      sendSystemdNotification("WATCHDOG=1", "/run/notify", {}, () => {
        execFileSync("sleep", ["0.3"]);
      });
    });

    expect(ticks).toBe(0);
  });

  it("swallows a failed ping instead of surfacing it", () => {
    // A missed ping is systemd's problem to act on via WatchdogSec; an unhandled
    // rejection here would be a worse outcome than the missed ping.
    expect(() => {
      sendSystemdNotificationAsync("WATCHDOG=1", "/run/notify", {}, (_f, _a, _o, cb) => {
        cb(new Error("systemd-notify: command not found"));
        return undefined;
      });
    }).not.toThrow();
  });

  it("still passes NOTIFY_SOCKET only to the helper", () => {
    // The socket is a capability: it is stripped from the ambient environment and
    // handed to the short-lived child alone. The async path must not lose that.
    const execute = vi.fn((_f: string, _a: readonly string[], _o: unknown, cb: (e: Error | null) => void) => { cb(null); });
    const ambient = { PATH: "/usr/bin" };

    sendSystemdNotificationAsync("READY=1", "/run/systemd/notify", ambient, execute as never);

    const [file, args, options] = execute.mock.calls[0];
    expect(file).toBe("systemd-notify");
    expect(args).toEqual(["READY=1"]);
    expect((options as { env: NodeJS.ProcessEnv }).env)
      .toEqual(buildNotifyEnvironment(ambient, "/run/systemd/notify"));
    expect(ambient).not.toHaveProperty("NOTIFY_SOCKET");
  });
});
