/**
 * #1366: `/dashboard` on a loopback dashboard says where the way in from a phone is documented. The once-per-platform
 * "2.2 adds web chat" notice in General was removed in #2783.
 */
import { describe, it, expect } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands, WEB_REMOTE_DOCS_URL } from "../src/topic-commands.js";
import { setLocale, t } from "../src/locale.js";

describe("#2783: the one-time web chat notice is gone", () => {
  it("nothing is left to send it: no method, no copy, no notice ledger", async () => {
    expect((FleetManager.prototype as any).announceWebChatOnce).toBeUndefined();
    setLocale("en"); expect(t("upgrade.web_chat")).toBe("upgrade.web_chat");
    setLocale("zh-TW"); expect(t("upgrade.web_chat")).toBe("upgrade.web_chat");
    setLocale("en");
    await expect(import("../src/upgrade-notices.js" as string)).rejects.toThrow();
  });
});

describe("/dashboard on a loopback dashboard says where the way in from a phone is", () => {
  const dashboard = (hostname?: string) => new TopicCommands({
    fleetConfig: { health_port: 19280, ...(hostname !== undefined ? { hostname } : {}) },
    getDashboardAccess: () => ({ ready: true, token: "a".repeat(48) }),
    issueDashboardLogin: () => ({ display: "ABCD-EFGH", expiresAt: Date.now() + 300_000, ttlMinutes: 5 }),
  } as any).getDashboardText();

  it("localhost (the default), 127.0.0.1 and ::1 get the hint as the last line", () => {
    for (const host of [undefined, "localhost", "LOCALHOST", "127.0.0.1", "::1"]) {
      const lines = dashboard(host).split("\n");
      expect(lines.at(-1), String(host)).toContain(WEB_REMOTE_DOCS_URL);
      expect(lines.at(-2), String(host)).toBe("");
    }
  });

  it("a dashboard reached by another name does not", () => {
    for (const host of ["fleet.example", "100.64.0.7", "my-pc.tailnet.ts.net"]) {
      expect(dashboard(host), host).not.toContain(WEB_REMOTE_DOCS_URL);
    }
  });
});
