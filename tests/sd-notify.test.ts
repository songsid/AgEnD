import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeNotifySocket,
  isFleetOwner,
  sendSystemdNotification,
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
