import { describe, expect, it } from "vitest";
import { buildNotifyEnvironment, consumeNotifySocket } from "../src/sd-notify.js";

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
    const helperEnvironment = buildNotifyEnvironment(
      environment,
      "/run/user/1000/systemd/notify",
    );

    expect(environment.NOTIFY_SOCKET).toBeUndefined();
    expect(helperEnvironment.NOTIFY_SOCKET).toBe("/run/user/1000/systemd/notify");
    expect(helperEnvironment.PATH).toBe("/usr/bin");
  });
});
