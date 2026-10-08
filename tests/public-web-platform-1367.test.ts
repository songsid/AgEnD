import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
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
  it("the public dashboard immediately polls without constructing EventSource; local keeps SSE", () => {
    const page = readFileSync(join(process.cwd(), "src/ui/dashboard.html"), "utf8");
    const code = page.slice(page.indexOf("const publicPolling ="), page.indexOf('sse.addEventListener("status"'));
    for (const mode of ["poll", "sse"]) {
      const poll = vi.fn(), schedule = vi.fn(), stream = vi.fn();
      vm.runInNewContext(code, { document: { body: { dataset: { webTransport: mode } } }, EventSource: class { constructor() { stream(); } }, startPolling: poll, setTimeout: schedule, silentTimer: null });
      expect(stream).toHaveBeenCalledTimes(mode === "sse" ? 1 : 0); expect(poll).toHaveBeenCalledTimes(mode === "poll" ? 1 : 0);
      expect(schedule).toHaveBeenCalledTimes(mode === "sse" ? 1 : 0);
    }
  });
});
