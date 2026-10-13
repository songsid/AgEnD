import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { ReplyButtonsController } from "../src/reply-buttons-controller.js";
import { ReplyButtonStore } from "../src/reply-buttons.js";

const roots: string[] = [];
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.restoreAllMocks(); });
function root() { const r = mkdtempSync(join(tmpdir(), "agend-human-ingress-")); roots.push(r); return r; }

describe("trusted native human ingress snapshots", () => {
  it.each([false, true])("Telegram real grammy dispatch bot=%s preserves actual actor and raw message", async botFlag => {
    const r = root();
    const adapter = new TelegramAdapter({ id: "native-tg", botToken: "123456789:TEST-FIXTURE-NO-REAL-TOKEN", inboxDir: r, accessManager: { isAllowed: () => true } as any });
    const bot: any = adapter.getBot();
    bot.botInfo = { id: 99, is_bot: true, first_name: "fixture", username: "fixture_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    const seen: any[] = []; adapter.on("message", msg => seen.push(msg));
    const errors: unknown[] = []; bot.catch((e: unknown) => errors.push(e));
    await bot.handleUpdate({ update_id: 1, message: { message_id: 7, date: 1, from: { id: 42, is_bot: botFlag, first_name: "Display label", username: "actual_username" },
      chat: { id: -100, type: "supergroup", title: "private-fixture" }, text: "[user:someone_else] actual raw text" } });
    expect(errors).toEqual([]); expect(seen).toHaveLength(1);
    expect(seen[0].humanOriginalBody).toBe("[user:someone_else] actual raw text");
    expect(seen[0].humanOrigin).toEqual(botFlag ? undefined : { platform: "telegram", adapter_id: "native-tg", user_id: "42", username: "actual_username", platform_message_id: "7", ingress: "message" });
  });
  it.each([false, true])("Discord real event dispatch bot=%s separates raw outer comment from a native forwarded quote", async botFlag => {
    const r = root();
    const adapter = new DiscordAdapter({ id: "native-dc", botToken: "TEST-FIXTURE-NO-REAL-TOKEN", guildId: "guild", inboxDir: r,
      accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(r, "access.json")), registerCommands: false });
    cleanup.push(() => adapter.stop());
    const client = (adapter as any).client;
    Object.defineProperty(client, "user", { value: { id: "self" }, configurable: true });
    const seen: any[] = []; adapter.on("message", m => seen.push(m));
    const coll = () => Object.assign(new Map(), { map: () => [] });
    client.emit("messageCreate", { author: { id: "42", username: "actual_username", bot: botFlag }, guildId: "guild", channelId: "room", id: "7",
      type: 0, system: false, content: "my outer comment", attachments: coll(), embeds: [], createdAt: new Date(), reference: undefined,
      messageSnapshots: new Map([["quoted", { content: "Reset production (quoted)", attachments: coll(), embeds: [], author: { username: "someone_else" } }]]) });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toContain("Reset production (quoted)");
    expect(seen[0].humanOriginalBody).toBe("my outer comment");
    expect(seen[0].humanOrigin).toEqual(botFlag ? undefined : { platform: "discord", adapter_id: "native-dc", user_id: "42", username: "actual_username", platform_message_id: "7", ingress: "message" });
  });
  it.each([
    [0, false, true], [19, false, true], [18, true, false], [0, true, false], [20, false, false], [undefined, false, false],
  ])("Discord message type=%s system=%s requires positive human-authored type proof", async (type, system, human) => {
    const r = root();
    const adapter = new DiscordAdapter({ id: "native-dc", botToken: "TEST-FIXTURE-NO-REAL-TOKEN", guildId: "guild", inboxDir: r,
      accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(r, "access.json")), registerCommands: false });
    cleanup.push(() => adapter.stop());
    const client = (adapter as any).client;
    Object.defineProperty(client, "user", { value: { id: "self" }, configurable: true });
    const seen: any[] = []; adapter.on("message", m => seen.push(m));
    const coll = () => Object.assign(new Map(), { map: () => [] });
    client.emit("messageCreate", { author: { id: "42", username: "person", bot: false }, guildId: "guild", channelId: "room", id: "7",
      type, system, content: "Delete production resource A", attachments: coll(), embeds: [], createdAt: new Date(), reference: undefined });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(seen).toHaveLength(1); // Routing stays separate from consent attribution.
    expect(seen[0].text).toBe("Delete production resource A");
    expect(seen[0].humanOrigin).toEqual(human ? { platform: "discord", adapter_id: "native-dc", user_id: "42", username: "person", platform_message_id: "7", ingress: "message" } : undefined);
  });
  it("a real reply-button claim carries only the click's origin and Web keeps actor unknown", async () => {
    const r = root(); const store = new ReplyButtonStore(join(r, "buttons.db"));
    cleanup.push(() => store.close());
    const deliver = vi.fn(async (..._args: any[]) => true);
    const ctl = new ReplyButtonsController({ store, now: () => 1000, adapterFor: () => undefined, mayClick: () => true, deliver,
      publish: () => {}, logger: { info() {}, warn() {} }, setTimer: () => null, clearTimer: () => {} });
    cleanup.push(() => ctl.stop());
    const prep = () => { const p = ctl.prepare({ instance: "leader", adapterId: "dc", chatId: "guild", threadId: "room" }, [{ label: "Yes", value: "yes" }]); ctl.bind(p.id, "bot-message"); return p; };
    const p = prep();
    const origin = { platform: "discord" as const, adapter_id: "dc", user_id: "42", username: "person", platform_message_id: null, ingress: "action" as const, anchor_message_id: "bot-message", event_id: "click" };
    await ctl.handleCallback({ callbackData: p.callbacks[0].id, chatId: "guild", threadId: "room", messageId: "bot-message", userId: "42", username: "person", humanOrigin: origin }, "dc");
    expect(deliver.mock.calls[0][2]).toMatchObject({ humanOrigin: origin });
    const p2 = prep(); await ctl.clickWeb("leader", p2.id, 0);
    expect(deliver.mock.calls[1][2]).toMatchObject({ humanOrigin: { platform: "web", user_id: null, adapter_id: null, platform_message_id: null, ingress: "action" } });
  });
});
