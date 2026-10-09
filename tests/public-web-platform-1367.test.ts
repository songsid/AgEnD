import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — a shipped ESM module with no types (the app's own file; tests/helpers/app-harness.ts does the same)
import { createStream } from "../src/ui/shared/app-stream.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { MessageFlags } from "discord.js";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw Error("No processes"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); } }));
const dirs: string[] = [], adapters: DiscordAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
function discord() {
  const dir = mkdtempSync(join(tmpdir(), "agend-public-platform-")); dirs.push(dir);
  const adapter = new DiscordAdapter({ id: "owner", botToken: "fixture", guildId: "G", registerCommands: false, inboxDir: dir,
    accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(dir, "access.json")) });
  adapters.push(adapter); return adapter;
}
const choice = { id: `dashboard:${"a".repeat(32)}:close`, label: "Close" };
describe("private platform API boundary, no platform connections", () => {
  it("Telegram real sendDirect uses private chat, no previews, canonical close keyboard", async () => {
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    const sendMessage = vi.fn(async () => ({ message_id: 42 })); (adapter as any).bot = { api: { sendMessage } };
    expect(await adapter.sendDirect("123", "private code", { disablePreview: true, choices: [choice] })).toEqual({ chatId: "123", messageId: "42" });
    expect(sendMessage).toHaveBeenCalledWith(123, "private code", { link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: "Close", callback_data: choice.id }]] } });
  });
  it("Discord real DM keeps code/buttons private and suppresses previews/mentions", async () => {
    const adapter = discord(); const send = vi.fn(async (_payload: unknown) => ({ id: "dm-message" }));
    vi.spyOn((adapter as any).client.users, "fetch").mockResolvedValue({ createDM: async () => ({ id: "DM", send }) });
    expect(await adapter.sendDirect("123", "private code", { disablePreview: true, choices: [choice] })).toEqual({ chatId: "DM", messageId: "dm-message" });
    const args = send.mock.calls[0] as any; expect(args[0]).toMatchObject({ content: "private code", flags: MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] } });
    expect(args[0].components[0].components[0].data.custom_id).toBe(choice.id);
  });
  it.each([undefined, "G"])("real Discord button at %s provides an awaited ephemeral fallback and canonical address", async guildId => {
    const adapter = discord(), callback = vi.fn(); adapter.on("callback_query", callback);
    let resolve!: (v: { id: string }) => void;
    const followUp = vi.fn((_payload: unknown) => new Promise<{ id: string }>(yes => { resolve = yes; }));
    (adapter as any).client.emit("interactionCreate", { isButton: () => true, isStringSelectMenu: () => false, customId: choice.id,
      guildId, channelId: guildId ? "T" : "DM", message: { id: "m" }, user: { id: "admin" }, deferUpdate: async () => {}, followUp });
    await vi.waitFor(() => expect(callback).toHaveBeenCalled()); const data = callback.mock.calls[0][0];
    expect(data.chatId).toBe(guildId ? "G" : "DM"); expect(data.threadId).toBe(guildId ? "T" : undefined);
    let finished = false; const sent = data.respondPrivate("secret", [choice]).then(() => { finished = true; }); await Promise.resolve(); expect(finished).toBe(false);
    expect(followUp.mock.calls[0]?.[0]).toMatchObject({ content: "secret", flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] } });
    resolve({ id: "ephemeral" }); await sent; expect(finished).toBe(true);
  });
  it("the public link polls at once and never constructs EventSource; the local page streams, and polls only when the stream is silent", () => {
    // app.js hands createStream the body's mode and transport (data-web-transport="poll" on the public link).
    expect(readFileSync(join(process.cwd(), "src/ui/shared/app.js"), "utf8")).toContain("createStream({ mode, transport: boot.webTransport })");
    for (const transport of ["poll", undefined] as const) {
      let streams = 0; const urls: string[] = []; const intervals: number[] = []; const silent: number[] = [];
      class FakeSource { constructor(public url: string) { streams++; } addEventListener() {} close() {} }
      const env = {
        EventSource: FakeSource,
        fetch: async (url: string) => { urls.push(url); return { ok: true, json: async () => ({}) }; },
        setInterval: (_fn: () => void, ms: number) => { intervals.push(ms); return 1; },
        setTimeout: (_fn: () => void, ms: number) => { silent.push(ms); return 2; },
        clearInterval() {}, clearTimeout() {},
      };
      const stream = createStream({ mode: "full", transport, env });
      stream.start();
      if (transport === "poll") {
        expect(streams, "no EventSource on the public link").toBe(0);
        expect(urls, "the first poll goes out at once").toEqual(["/ui/poll?after="]);
        expect(intervals).toEqual([5000]);
        expect(stream.connection()).toBe("polling");
      } else {
        expect(streams, "the local page opens one stream").toBe(1);
        expect(urls, "no poll while the stream is connecting").toEqual([]);
        expect(silent, "the poll fallback waits 15 s for the stream to speak").toEqual([15000]);
      }
    }
  });
});
