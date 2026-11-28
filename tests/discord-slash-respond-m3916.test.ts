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

  it("a long answer whose second chunk fails once: that chunk alone is retried; every chunk is accepted exactly once (Prism #4612)", async () => {
    const { adapter, commands } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = slash("status");
    const accepted: string[] = [];
    let failChunkTwo = 1;
    s.interaction.followUp = vi.fn(async (opts: any) => {
      const d = opts.embeds[0].description as string;
      if (d.startsWith("B") && failChunkTwo-- > 0) throw reset();
      accepted.push(d[0]!);
      return undefined;
    }) as any;
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const long = "A".repeat(4000) + "\n" + "B".repeat(4000) + "\n" + "C".repeat(4000);
    await expect(commands[0].respond(long)).resolves.toBe("answer-1");
    expect(s.editReply).toHaveBeenCalledOnce();
    expect(accepted).toEqual(["B", "C"]);
    expect(s.send).not.toHaveBeenCalled();
  });

  it("a long answer whose second chunk fails twice: the rest is not sent, the channel is told, the first part's id is kept", async () => {
    const { adapter, commands } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = slash("status");
    const sent: string[] = [];
    s.interaction.followUp = vi.fn(async (opts: any) => {
      const d = opts.embeds[0].description as string;
      if (d.startsWith("B")) throw reset();
      sent.push(d[0]!);
      return undefined;
    }) as any;
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const long = "A".repeat(4000) + "\n" + "B".repeat(4000) + "\n" + "C".repeat(4000);
    await expect(commands[0].respond(long)).resolves.toBe("answer-1");
    expect(sent).toEqual([]);
    expect(s.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).toContain("(part 2/3) failed again");
  });

  it("an effectful command (/collab toggles before it answers): the notice does not say it ran or ask for a plain rerun; it says to check first", async () => {
    const { adapter, commands } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = slash("collab");
    s.editReply.mockRejectedValue(reset());
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    await commands[0].respond("Collaboration on");
    const notice = s.send.mock.calls[0]![0];
    expect(notice).toContain("/collab");
    expect(notice).not.toMatch(/\bran\b|Please run it again/);
    expect(notice).toMatch(/check whether it already did before running it again/);
    expect(notice).not.toContain("Collaboration on");
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
