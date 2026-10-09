/**
 * #1366: someone upgrading from 2.1 is told, once per chat platform, that web chat exists; and `/dashboard` on a
 * loopback dashboard says where the way in from a phone is documented.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { WEB_CHAT_NOTICE, WEB_REMOTE_DOCS_URL, claimNotice, hasWebChat, releaseNotice, upgradeNoticesPath } from "../src/upgrade-notices.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-1366-")); });
afterEach(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });

describe("which versions have web chat", () => {
  it("2.2 and later, the 2.2 betas included; 2.1, a dev checkout and an unknown version do not", () => {
    for (const v of ["2.2.0", "2.2.0-beta.3", "2.2.1", "2.3.0", "3.0.0", "2.10.0"]) expect(hasWebChat(v), v).toBe(true);
    for (const v of ["2.1.12-beta.8", "2.1.12", "1.22.0", "unknown", "", "v2.2.0", "2.2"]) expect(hasWebChat(v), v).toBe(false);
  });
});

describe("the notice ledger (upgrade-notices.json)", () => {
  const path = () => upgradeNoticesPath(dir);
  const read = () => JSON.parse(readFileSync(path(), "utf8"));

  it("claims once per adapter, and a release lets the next start claim it again", () => {
    expect(claimNotice(path(), WEB_CHAT_NOTICE, "telegram")).toBe(true);
    expect(claimNotice(path(), WEB_CHAT_NOTICE, "telegram")).toBe(false);
    expect(claimNotice(path(), WEB_CHAT_NOTICE, "discord")).toBe(true);
    expect(read()).toEqual({ [WEB_CHAT_NOTICE]: ["telegram", "discord"] });
    expect(releaseNotice(path(), WEB_CHAT_NOTICE, "telegram")).toBe(true);
    expect(read()).toEqual({ [WEB_CHAT_NOTICE]: ["discord"] });
    expect(claimNotice(path(), WEB_CHAT_NOTICE, "telegram")).toBe(true);
  });

  it("keeps other notices it does not know about", () => {
    writeFileSync(path(), JSON.stringify({ "some-later-notice": ["telegram"] }));
    expect(claimNotice(path(), WEB_CHAT_NOTICE, "telegram")).toBe(true);
    expect(read()).toEqual({ "some-later-notice": ["telegram"], [WEB_CHAT_NOTICE]: ["telegram"] });
  });

  it("a damaged or unreadable ledger claims nothing and is left as it was — never a notice on every restart", () => {
    for (const damaged of ["{not json", "[]", "null", JSON.stringify({ [WEB_CHAT_NOTICE]: "telegram" }), JSON.stringify({ [WEB_CHAT_NOTICE]: [1] })]) {
      writeFileSync(path(), damaged);
      expect(claimNotice(path(), WEB_CHAT_NOTICE, "telegram"), damaged).toBe(false);
      expect(readFileSync(path(), "utf8")).toBe(damaged);
    }
    rmSync(path());
    mkdirSync(path());                                         // EISDIR: exists, cannot be read
    expect(claimNotice(path(), WEB_CHAT_NOTICE, "telegram")).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("a ledger that exists but cannot be read is not replaced, although it could be", () => {
    writeFileSync(path(), JSON.stringify({ [WEB_CHAT_NOTICE]: ["telegram"] }));
    chmodSync(path(), 0o000);                                  // EACCES on read; the directory still allows a rename over it
    expect(claimNotice(path(), WEB_CHAT_NOTICE, "discord")).toBe(false);
    chmodSync(path(), 0o600);
    expect(read()).toEqual({ [WEB_CHAT_NOTICE]: ["telegram"] });
  });

  it("a ledger that cannot be written claims nothing", () => {
    chmodSync(dir, 0o500);
    expect(claimNotice(path(), WEB_CHAT_NOTICE, "telegram")).toBe(false);
    expect(existsSync(path())).toBe(false);
  });
});

describe("the one-time web chat notice in General", () => {
  const telegramCfg = { id: "telegram", type: "telegram", mode: "topic", group_id: "-100777" };
  const discordCfg = { id: "discord", type: "discord", mode: "topic", group_id: "guild-1" };

  function makeFleet(channels: any[], instances: Record<string, any>) {
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = { defaults: {}, channels, instances };
    for (const cfg of channels) {
      fm.worlds.set(cfg.id, {
        id: cfg.id, adapter: { id: cfg.id, sendText: vi.fn().mockResolvedValue({}) },
        channelConfig: cfg, groupId: String(cfg.group_id),
      });
    }
    fm.adapter = fm.worlds.get(channels[0].id)?.adapter;
    return fm;
  }
  const sends = (fm: any, id: string) => fm.worlds.get(id).adapter.sendText.mock.calls;
  const twoPlatforms = () => makeFleet([telegramCfg, discordCfg], {
    "tg-general": { general_topic: true, topic_id: 1, channel_id: "telegram" },
    "dc-general": { general_topic: true, topic_id: "chan-general", channel_id: "discord" },
  });

  it("each platform's own General gets it once; the next start sends nothing", async () => {
    const fm = twoPlatforms();
    await fm.announceWebChatOnce("2.2.0-beta.1");
    expect(sends(fm, "telegram")).toHaveLength(1);
    expect(sends(fm, "discord")).toHaveLength(1);
    const [tgChat, tgText, tgOpts] = sends(fm, "telegram")[0];
    expect([tgChat, tgOpts]).toEqual(["-100777", { threadId: "1" }]);
    const [dcChat, , dcOpts] = sends(fm, "discord")[0];
    expect([dcChat, dcOpts]).toEqual(["guild-1", { threadId: "chan-general" }]);
    expect(tgText).toMatch(/web chat/i);
    expect(tgText).toContain("/dashboard");
    expect(tgText).toContain(WEB_REMOTE_DOCS_URL);

    const next = twoPlatforms();                               // a restart: same AGEND_HOME, fresh process
    await next.announceWebChatOnce("2.2.0");
    expect([sends(next, "telegram"), sends(next, "discord")]).toEqual([[], []]);
  });

  it("before 2.2 nothing is sent and nothing is recorded", async () => {
    const fm = twoPlatforms();
    await fm.announceWebChatOnce("2.1.12-beta.8");
    expect([sends(fm, "telegram"), sends(fm, "discord")]).toEqual([[], []]);
    expect(existsSync(upgradeNoticesPath(dir))).toBe(false);
  });

  it("a send that fails is released and tried again at the next start; the other platform is not repeated", async () => {
    const fm = twoPlatforms();
    fm.worlds.get("discord").adapter.sendText.mockRejectedValueOnce(new Error("Missing Access"));
    await fm.announceWebChatOnce("2.2.0");
    expect(JSON.parse(readFileSync(upgradeNoticesPath(dir), "utf8"))).toEqual({ [WEB_CHAT_NOTICE]: ["telegram"] });

    const next = twoPlatforms();
    await next.announceWebChatOnce("2.2.0");
    expect([sends(next, "telegram").length, sends(next, "discord").length]).toEqual([0, 1]);
  });

  it("a platform with nowhere to post fleet notices is skipped, not recorded, and told once it has a General", async () => {
    const fm = makeFleet([discordCfg], {});                    // a Discord fleet with no General: no postable channel
    await fm.announceWebChatOnce("2.2.0");
    expect(sends(fm, "discord")).toEqual([]);
    expect(existsSync(upgradeNoticesPath(dir))).toBe(false);

    const later = makeFleet([discordCfg], { gen: { general_topic: true, topic_id: "chan-general" } });
    await later.announceWebChatOnce("2.2.0");
    expect(sends(later, "discord")).toHaveLength(1);
  });

  it("a fleet that is shutting down sends nothing", async () => {
    const fm = twoPlatforms();
    fm.shuttingDown = true;
    await fm.announceWebChatOnce("2.2.0");
    expect([sends(fm, "telegram"), sends(fm, "discord")]).toEqual([[], []]);
  });

  it("an unreadable ledger sends nothing at all", async () => {
    writeFileSync(upgradeNoticesPath(dir), "{not json");
    const fm = twoPlatforms();
    await fm.announceWebChatOnce("2.2.0");
    expect([sends(fm, "telegram"), sends(fm, "discord")]).toEqual([[], []]);
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
