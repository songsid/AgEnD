/**
 * #1131: on Discord, the `/login` backend picker posted by the native slash
 * command did nothing when clicked (an escape-hatch blocker for 2.1.10).
 *
 * A. The slash command addresses its channel as the chat, so the prompt was
 *    bound to chatId = <channel>; the adapter reports every button click as
 *    chatId = <guild>, threadId = <channel>, and the nonce check rejected the
 *    click as "mismatched".
 * B. A button outside the primary guild or a known open channel was
 *    acknowledged and then dropped without a word, although the slash command
 *    that posted it is accepted from anywhere.
 *
 * Real DiscordAdapter (send/click through its own code) + real FleetManager
 * handlers; only the Discord channel object and the session starters are fakes.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { FleetManager } from "../src/fleet-manager.js";

const GUILD = "primary-guild";
const dirs: string[] = [];
const adapters: DiscordAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map(a => a.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (tag: string) => {
  const d = join(tmpdir(), `agend-1131-${tag}-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
};

function setup(guildId = GUILD) {
  const dir = scratch("a");
  const adapter = new DiscordAdapter({
    id: "discord",
    botToken: "test-token",
    accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(dir, "access.json")),
    inboxDir: dir,
    guildId,
    registerCommands: false,
  });
  adapters.push(adapter);
  // The Discord channel: records what was posted, lets prompts be edited.
  const posted: Array<{ channelId: string; ids: string[] }> = [];
  const edit = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(adapter as any, "_fetchTextChannel").mockImplementation(async (channelId: any) => ({
    send: async (payload: any) => {
      const ids = typeof payload === "object" && payload.components
        ? payload.components.flatMap((row: any) => row.components.map((b: any) => b.data.custom_id))
        : [];
      posted.push({ channelId, ids });
      return { id: `msg-${posted.length}` };
    },
    messages: { fetch: async () => ({ edit }) },
  }));

  const fm = new FleetManager(scratch("fm"));
  fm.fleetConfig = { defaults: {}, instances: {} } as any;
  const warn = vi.spyOn(fm.logger, "warn");
  vi.spyOn(fm as any, "isFleetAdmin").mockReturnValue(true);
  vi.spyOn(fm as any, "configuredBackendInstanceNames").mockReturnValue([]);
  vi.spyOn(fm as any, "probeInstalledBackends").mockReturnValue(new Set(["codex"]));
  const startLogin = vi.spyOn(fm, "startLoginSession").mockResolvedValue("login started");
  const startInstall = vi.spyOn(fm, "startInstallSession").mockResolvedValue("install started");
  // The production dispatch: every callback_query goes to the fleet's handlers.
  const handled: Promise<unknown>[] = [];
  adapter.on("callback_query", data => {
    handled.push((async () => {
      if (await (fm as any).handleLoginBackendSelect(data, "discord", adapter)) return;
      await (fm as any).handleInstallBackendSelect(data, "discord", adapter);
    })());
  });

  const click = async (customId: string, where: { guildId: string; channelId: string; messageId: string }) => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    (adapter as any).client.emit("interactionCreate", {
      isButton: () => true,
      isStringSelectMenu: () => false,
      customId,
      guildId: where.guildId,
      channelId: where.channelId,
      message: { id: where.messageId },
      user: { id: "admin" },
      deferUpdate,
    });
    await vi.waitFor(() => expect(deferUpdate).toHaveBeenCalledOnce());
    await new Promise(r => setTimeout(r, 0));
    await Promise.all(handled);
  };
  const slash = (channelId: string) => ({ userId: "admin", channelId, respond: vi.fn().mockResolvedValue(undefined) });
  return { adapter, fm, posted, warn, startLogin, startInstall, click, slash };
}

describe("A: a picker posted by a Discord slash command is clickable (#1131)", () => {
  it("/login: the backend button starts that backend's login, answering in the slash command's channel", async () => {
    const { adapter, fm, posted, warn, startLogin, click, slash } = setup();
    await (fm as any).handleLoginSlash(slash("ops-channel"), "discord", adapter);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.channelId).toBe("ops-channel");
    const button = posted[0]!.ids.find(id => id.endsWith(":codex"))!;
    expect(button).toMatch(/^login:[0-9a-f]{32}:codex$/);

    await click(button, { guildId: GUILD, channelId: "ops-channel", messageId: "msg-1" });

    expect(warn).not.toHaveBeenCalledWith(expect.anything(), "Rejected unauthorized or mismatched button callback");
    expect(startLogin).toHaveBeenCalledOnce();
    expect(startLogin).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: GUILD, threadId: "ops-channel" }));
  });

  it("the click is still bound to its prompt: the same button in another channel is rejected", async () => {
    const { adapter, fm, posted, warn, startLogin, click, slash } = setup();
    await (fm as any).handleLoginSlash(slash("ops-channel"), "discord", adapter);
    const button = posted[0]!.ids[0]!;
    await click(button, { guildId: GUILD, channelId: "other-channel", messageId: "msg-1" });
    expect(startLogin).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ mismatchedFields: "threadId" }), "Rejected unauthorized or mismatched button callback");
  });
});

describe("A without a configured group_id (group_id is optional; the adapter's guild is then \"\")", () => {
  it("/login: the picker's button still starts the login", async () => {
    const { adapter, fm, posted, warn, startLogin, click, slash } = setup("");
    await (fm as any).handleLoginSlash(slash("ops-channel"), "discord", adapter);
    const button = posted[0]!.ids.find(id => id.endsWith(":codex"))!;
    await click(button, { guildId: "the-real-guild", channelId: "ops-channel", messageId: "msg-1" });
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), "Rejected unauthorized or mismatched button callback");
    expect(startLogin).toHaveBeenCalledWith("codex", expect.objectContaining({ threadId: "ops-channel" }));
  });

});

describe("B: a prompt button outside the primary guild is not dropped silently (#1131)", () => {
  it("/login run in a channel of another guild: the picker's button works", async () => {
    const { adapter, fm, posted, startLogin, click, slash } = setup();
    await (fm as any).handleLoginSlash(slash("classic-channel-elsewhere"), "discord", adapter);
    const button = posted[0]!.ids.find(id => id.endsWith(":codex"))!;
    await click(button, { guildId: "secondary-guild", channelId: "classic-channel-elsewhere", messageId: "msg-1" });
    expect(startLogin).toHaveBeenCalledWith("codex", expect.objectContaining({ threadId: "classic-channel-elsewhere" }));
  });

  it("any other button from there is still ignored, and the drop is logged", async () => {
    const { adapter, click } = setup();
    const callback = vi.fn();
    adapter.on("callback_query", callback);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await click("cancel:some-instance", { guildId: "secondary-guild", channelId: "closed-channel", messageId: "m" });
    expect(callback).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("ignored a button outside the primary guild"));
  });
});

describe("slash replies use flags, not the deprecated ephemeral option (#1131)", () => {
  it("a private command defers with MessageFlags.Ephemeral; /update stays public", async () => {
    const { adapter } = setup();
    const { MessageFlags } = await import("discord.js");
    const deferred: Record<string, unknown> = {};
    for (const commandName of ["login", "update"]) {
      const deferReply = vi.fn().mockResolvedValue(undefined);
      (adapter as any).client.emit("interactionCreate", {
        isButton: () => false,
        isStringSelectMenu: () => false,
        isChatInputCommand: () => true,
        commandName,
        guildId: GUILD,
        channelId: "ops-channel",
        channel: { name: "ops" },
        user: { id: "admin", username: "admin" },
        options: { data: [], getString: () => null },
        deferReply,
      });
      await vi.waitFor(() => expect(deferReply).toHaveBeenCalledOnce());
      deferred[commandName] = deferReply.mock.calls[0]![0];
    }
    expect(deferred.login).toEqual({ flags: MessageFlags.Ephemeral });
    expect(deferred.update).toEqual({});
  });
});
