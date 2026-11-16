/**
 * Telegram updates queued while the fleet was down, too old to inject, are listed in Needs you as "missed while AgEnD was
 * offline" — but only where live delivery would have taken them. Seen on a 2.4.0-beta.2 fleet: after a night offline, an
 * ordinary post (no @mention) in a Telegram group the bot is in, whose ClassicBot room had been stopped, was filed under
 * general. Live, that post is ignored: a chat other than the fleet's group is a ClassicBot candidate, an unregistered one is
 * ignored, and a registered group room takes only an @mention of the bot.
 *
 * The events come from the real adapter reading the Telegram mock's queue (e2e/mock-servers/telegram-mock.ts); the fleet
 * files them through recordMissedOffline, the handler the adapter's missed_offline event is wired to.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramMock, type TelegramMock } from "../e2e/mock-servers/telegram-mock.js";
import { getFreePort, waitFor } from "../e2e/mock-servers/shared.js";
import { TELEGRAM_PENDING_LIVE_MAX_MS, TelegramAdapter, type MissedOfflineInbound } from "../src/channel/adapters/telegram.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";

const FLEET_GROUP = -1001000000001, OTHER_GROUP = -1001000000002, ROOM_GROUP = -1001000000003;
const USER = 111222333, DM = 444555666;
const BOT = "fleet_test_bot";

let mock: TelegramMock, dir: string, adapter: TelegramAdapter | undefined;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tg-missed-route-"));
  mkdirSync(join(dir, "inbox"), { recursive: true });
  mock = createTelegramMock({ port: await getFreePort(), botUsername: BOT });
  await mock.start();
});
afterEach(async () => {
  await adapter?.stop().catch(() => {});
  adapter = undefined;
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

const hoursAgo = (h: number) => Math.floor(Date.now() / 1000) - Math.ceil(TELEGRAM_PENDING_LIVE_MAX_MS / 1000) - h * 3600;

/** Queue `posts` while the fleet is down, start the adapter, and return the missed_offline events it raises. */
async function missedFrom(posts: Array<{ chatId: number; text: string; threadId?: number; userId?: number }>): Promise<MissedOfflineInbound[]> {
  for (const p of posts) mock.injectMessage({ chatId: p.chatId, userId: p.userId ?? USER, username: "colleague", text: p.text, date: hoursAgo(1), ...(p.threadId ? { threadId: p.threadId } : {}) });
  const access = new AccessManager({ mode: "locked", allowed_users: [USER], max_pending_codes: 5, code_expiry_minutes: 10 }, join(dir, "access.json"));
  adapter = new TelegramAdapter({ id: "tg", botToken: "123456:FAKE_TOKEN", accessManager: access, inboxDir: join(dir, "inbox"), apiRoot: `http://localhost:${mock.port}` });
  const missed: MissedOfflineInbound[] = [];
  adapter.on("missed_offline", (m: MissedOfflineInbound) => missed.push(m));
  await adapter.start();
  await waitFor(() => missed.length === posts.length, { timeout: 5000, interval: 20, label: "missed offline" });
  return missed;
}

/** A Telegram topic-mode fleet: general and `dev` (topic 7) in the fleet group; a ClassicBot room `room-bot` in ROOM_GROUP and a DM. */
function fleet(): FleetManager {
  const fm = new FleetManager(dir);
  fm.fleetConfig = { defaults: {}, channels: [{ id: "tg", type: "telegram", mode: "topic", group_id: FLEET_GROUP, bot_token_env: "X", access: { mode: "locked", allowed_users: [USER] } }],
    instances: { general: { working_directory: dir, general_topic: true, channel_id: "tg" }, dev: { working_directory: dir, topic_id: 7, channel_id: "tg" } } } as any;
  fm.routing.rebuild(fm.fleetConfig!);
  fm.classicChannels = new ClassicChannelManager(dir, fm.logger);
  fm.classicChannels.register(String(ROOM_GROUP), "tg", "room-bot", "Room group", String(USER));
  fm.classicChannels.register(String(DM), "tg", "dm-bot", "DM", String(USER));
  return fm;
}
const filed = (fm: FleetManager, events: MissedOfflineInbound[]) => {
  for (const ev of events) (fm as any).recordMissedOffline(ev);
  return ((fm as any).missedOfflineStore?.list(Date.now()) ?? []).map((m: any) => [m.instance, m.preview]);
};

describe("Telegram missed-offline: listed only where live delivery would have taken the message", () => {
  it("a plain post in a group with no room is not listed (it was filed under general)", async () => {
    const fm = fleet();
    expect(filed(fm, await missedFrom([{ chatId: OTHER_GROUP, text: "lunch at noon?" }]))).toEqual([]);
  });
  it("an @mention in a group with no room is not listed either — live, it only gets the no-agent reply", async () => {
    const fm = fleet();
    expect(filed(fm, await missedFrom([{ chatId: OTHER_GROUP, text: `@${BOT} are you there?` }]))).toEqual([]);
  });
  it("a group whose ClassicBot room was stopped is not listed", async () => {
    const fm = fleet();
    fm.classicChannels!.unregister(String(ROOM_GROUP), "tg");
    expect(filed(fm, await missedFrom([{ chatId: ROOM_GROUP, text: `@${BOT} status?` }]))).toEqual([]);
  });
  it("a ClassicBot group room lists an @mention of the bot under the room, not a plain post", async () => {
    const fm = fleet();
    // The mention sits past the 160-character preview: it is judged on the whole message.
    const long = `${"x".repeat(200)} @${BOT.toUpperCase()} please look`;
    expect(filed(fm, await missedFrom([{ chatId: ROOM_GROUP, text: "just chatting" }, { chatId: ROOM_GROUP, text: long }])))
      .toEqual([["room-bot", `${"x".repeat(159)}…`]]);
  });
  it("a ClassicBot DM lists every message under its room; an unregistered DM is not listed", async () => {
    const fm = fleet();
    expect(filed(fm, await missedFrom([{ chatId: DM, userId: DM, text: "ping" }, { chatId: 777888999, userId: 777888999, text: "hello?" }])))
      .toEqual([["dm-bot", "ping"]]);
  });
  it("the fleet group is unchanged: its root goes to general, a bound topic to its instance; an unbound topic to nobody", async () => {
    const fm = fleet();
    const got = filed(fm, await missedFrom([{ chatId: FLEET_GROUP, text: "root post" }, { chatId: FLEET_GROUP, threadId: 7, text: "for dev" },
      { chatId: FLEET_GROUP, threadId: 99, text: "unbound topic" }]));
    expect(got.sort()).toEqual([["dev", "for dev"], ["general", "root post"]]);
  });
});
