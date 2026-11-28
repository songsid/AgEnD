/**
 * M-3916: a slash command acknowledged in time ("thinking…") whose answer Discord did not take used to leave the user
 * waiting with nothing logged: the reply was `try { … } catch { return undefined }`. Now the failure is logged with the
 * command, error code and channel, the answer is tried once more, and if that fails too a short notice (never the
 * answer itself — slash replies are often private) goes to the channel.
 *
 * Real DiscordAdapter (its own interactionCreate handler) with a fake interaction; no gateway, no network.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";

const GUILD = "primary-guild";
const dirs: string[] = [];
const adapters: DiscordAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map(a => a.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = join(tmpdir(), `agend-3916-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const adapter = new DiscordAdapter({
    id: "discord", botToken: "test-token", inboxDir: dir, guildId: GUILD, registerCommands: false,
    accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(dir, "access.json")),
  } as any);
  adapters.push(adapter);
  const commands: any[] = [];
  adapter.on("slash_command", data => commands.push(data));
  return { adapter, commands };
}

function slash(commandName: string) {
  const editReply = vi.fn(async (_opts: unknown) => ({ id: "answer-1" }));
  const send = vi.fn(async (_text: string) => undefined);
  const interaction = {
    isButton: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => true,
    commandName, guildId: GUILD, channelId: "ops-channel", createdTimestamp: Date.now() - 100,
    channel: { name: "ops", send }, user: { id: "u-1", username: "alice" },
    options: { data: [], getString: () => "hello" },
    deferReply: vi.fn(async () => undefined), followUp: vi.fn(async () => undefined), editReply,
  };
  return { interaction, editReply, send };
}
const emit = (adapter: DiscordAdapter, interaction: unknown) => (adapter as any).client.emit("interactionCreate", interaction);
const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

describe("an acknowledged slash command's answer is never silently lost (M-3916)", () => {
  it.each(["ctx", "chat"])("/%s: a failed answer is logged and tried once more; the retry lands, so no notice", async command => {
    const { adapter, commands } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = slash(command);
    s.editReply.mockRejectedValueOnce(reset());
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    await expect(commands[0].respond("Context 12% used")).resolves.toBe("answer-1");
    expect(s.editReply).toHaveBeenCalledTimes(2);
    expect(s.send).not.toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain(`/${command} in channel ops-channel`);
    expect(logged).toContain("ECONNRESET");
    expect(logged).toContain("trying once more");
  });

  it("failed twice: the channel is told (the user mentioned, the command named, the answer itself not posted)", async () => {
    const { adapter, commands } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = slash("ctx");
    s.editReply.mockRejectedValue(reset());
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    await expect(commands[0].respond("Context 12% used — private detail")).resolves.toBeUndefined();
    expect(s.editReply).toHaveBeenCalledTimes(2);
    expect(s.send).toHaveBeenCalledOnce();
    const notice = s.send.mock.calls[0]![0];
    expect(notice).toContain("<@u-1>");
    expect(notice).toContain("/ctx");
    expect(notice).not.toContain("private detail");
    expect(JSON.stringify(warn.mock.calls)).toContain("failed again (ECONNRESET)");
  });

  it("the channel notice failing too is logged, and respond still settles", async () => {
    const { adapter, commands } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = slash("status");
    s.editReply.mockRejectedValue(reset());
    s.send.mockRejectedValue(Object.assign(new Error("Missing Access"), { code: 50001 }));
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    await expect(commands[0].respond("x")).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).toContain("could not tell the channel either (50001)");
  });

  it("a first answer that lands: one call, nothing logged, no notice", async () => {
    const { adapter, commands } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = slash("ctx");
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    await expect(commands[0].respond("ok")).resolves.toBe("answer-1");
    expect(s.editReply).toHaveBeenCalledOnce();
    expect(s.send).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
