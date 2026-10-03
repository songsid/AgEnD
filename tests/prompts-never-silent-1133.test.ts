/**
 * #1133: in the escape-hatch `/login` flow, a prompt that
 * cannot be posted and a click that is refused must never be silent.
 *
 *  - Discord: buttons in rows of five (one row of seven made a seven-backend
 *    chooser impossible to post); more than 25 is an error.
 *  - A chooser that cannot be posted says so — never "chooser posted".
 *  - A refused click (expired, wrong place, not an admin) tells the clicker why:
 *    Discord ephemeral follow-up, Telegram callback answer.
 *  - Telegram answers after the fleet decides; a failed answer no longer drops
 *    the click.
 *  - An outcome whose message edit fails is posted instead; an unhandled click
 *    is logged.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAdapter, buttonRows } from "../src/channel/adapters/discord.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { LoginController, type LoginControllerDeps } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { t } from "../src/locale.js";

const GUILD = "primary-guild";
const dirs: string[] = [];
const adapters: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map(a => a.stop().catch(() => {})));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (tag: string) => {
  const d = join(tmpdir(), `agend-1133-${tag}-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
};
const access = (dir: string) => new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(dir, "access.json"));

/** A real DiscordAdapter whose channel behaves like Discord: a row of more than five buttons is rejected. */
function discordFleet(opts: { sendError?: Error; admin?: boolean } = {}) {
  const dir = scratch("dc");
  const adapter = new DiscordAdapter({ id: "discord", botToken: "test-token", accessManager: access(dir), inboxDir: dir, guildId: GUILD, registerCommands: false });
  adapters.push(adapter);
  const posted: Array<{ rows: string[][] }> = [];
  vi.spyOn(adapter as any, "_fetchTextChannel").mockImplementation(async () => ({
    send: async (payload: any) => {
      if (opts.sendError) throw opts.sendError;
      const rows: string[][] = (payload.components ?? []).map((row: any) => row.components.map((b: any) => b.data.custom_id));
      if (rows.some(r => r.length > 5)) throw new Error("Invalid Form Body: components[0].components[BASE_TYPE_BAD_LENGTH]");
      posted.push({ rows });
      return { id: `msg-${posted.length}` };
    },
    messages: { fetch: async () => ({ edit: vi.fn().mockResolvedValue(undefined) }) },
  }));
  const fm = new FleetManager(scratch("fm"));
  fm.fleetConfig = { defaults: {}, instances: {} } as any;
  vi.spyOn(fm as any, "isFleetAdmin").mockReturnValue(opts.admin ?? true);
  vi.spyOn(fm as any, "configuredBackendInstanceNames").mockReturnValue([]);
  vi.spyOn(fm as any, "probeInstalledBackends").mockReturnValue(new Set(["codex"]));
  const startLogin = vi.spyOn(fm, "startLoginSession").mockResolvedValue("login started");
  const startInstall = vi.spyOn(fm, "startInstallSession").mockResolvedValue("install started");
  const handled: Promise<unknown>[] = [];
  adapter.on("callback_query", data => {
    handled.push((fm as any).receiveAdapterCallback(data, "discord", adapter, () => true));
  });
  const click = async (customId: string, where: { channelId: string; messageId: string; userId?: string }) => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    (adapter as any).client.emit("interactionCreate", {
      isButton: () => true, isStringSelectMenu: () => false,
      customId, guildId: GUILD, channelId: where.channelId,
      message: { id: where.messageId }, user: { id: where.userId ?? "admin" },
      deferUpdate, followUp,
    });
    await vi.waitFor(() => expect(deferUpdate).toHaveBeenCalledOnce());
    await new Promise(r => setTimeout(r, 0));
    await Promise.all(handled);
    await new Promise(r => setTimeout(r, 0));
    return followUp;
  };
  const slash = (channelId: string) => ({ userId: "admin", channelId, respond: vi.fn().mockResolvedValue(undefined) });
  return { adapter, fm, posted, startLogin, startInstall, click, slash };
}

describe("Discord lays buttons out in rows of five", () => {
  it("rows of at most five; more than 25 is an error, not a truncation", () => {
    const choices = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x:${i}`, label: `b${i}` }));
    expect(buttonRows(choices(7)).map(r => r.components.length)).toEqual([5, 2]);
    expect(buttonRows(choices(25)).map(r => r.components.length)).toEqual([5, 5, 5, 5, 5]);
    expect(buttonRows([])).toEqual([]);
    expect(() => buttonRows(choices(26))).toThrow(/at most 25 buttons/);
  });

  it("/login's chooser of every installable backend (more than five) is posted and its last button works", async () => {
    const { adapter, fm, posted, startLogin, click, slash } = discordFleet();
    const data = slash("ops");
    await (fm as any).handleLoginSlash(data, "discord", adapter);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.rows.flat().length).toBeGreaterThan(5);
    expect(posted[0]!.rows.every(r => r.length <= 5)).toBe(true);
    expect(data.respond).toHaveBeenCalledWith(t("login.chooser_posted"));
    const last = posted[0]!.rows.flat().at(-1)!;
    await click(last, { channelId: "ops", messageId: "msg-1" });
    expect(startLogin).toHaveBeenCalledWith(last.split(":")[2], expect.anything());
  });
});

describe("a chooser that cannot be posted says so", () => {
  it("Discord slash /login answers with the failure, not \"chooser posted\"", async () => {
    const { adapter, fm, slash } = discordFleet({ sendError: new Error("Missing Permissions") });
    const login = slash("ops");
    await (fm as any).handleLoginSlash(login, "discord", adapter);
    expect(login.respond).toHaveBeenCalledWith(t("buttons.post_failed", "Missing Permissions"));
  });

  it("text /login posts the failure in the chat", async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: "m" });
    const adapter = { id: "telegram", type: "telegram", sendText };
    const ctx = {
      adapter, fleetConfig: { defaults: {}, instances: {} }, isFleetAdmin: () => true,
      promptLoginBackends: vi.fn(async () => "⚠️ login chooser failed"),
      startLoginSession: vi.fn(), cancelLoginSession: vi.fn(),
    } as any;
    const commands = new TopicCommands(ctx);
    const msg = (text: string) => ({ text, chatId: "chat", threadId: "topic", userId: "u1", adapterId: "telegram", username: "admin" }) as any;
    await commands.handleGeneralCommand(msg("/login"));
    expect(sendText.mock.calls.map(c => c[1])).toEqual(["⚠️ login chooser failed"]);
  });

  it("the web login's button poster rejects when the prompt cannot be posted (the controller reports it)", async () => {
    const fm = new FleetManager(scratch("fm"));
    const adapter = { id: "discord", type: "discord", notifyAlert: vi.fn().mockRejectedValue(new Error("Missing Access")) } as any;
    const postButtons = (fm as any).webLogin.deps.postButtons;
    await expect(postButtons({
      prefix: "login-confirm:", instanceName: "codex",
      chat: { adapter, adapterId: "discord", chatId: GUILD, threadId: "ops" },
      message: "confirm?", choices: [{ action: "go", label: "Go" }], expiredText: "expired",
    })).rejects.toThrow("Missing Access");
  });
});

describe("a refused click tells the clicker why (Discord: ephemeral follow-up)", () => {
  const ephemeral = (followUp: ReturnType<typeof vi.fn>, text: string) =>
    expect(followUp).toHaveBeenCalledWith({ content: text, flags: 64 });

  it("an expired prompt", async () => {
    const { click } = discordFleet();
    const followUp = await click(`login:${"0".repeat(32)}:codex`, { channelId: "ops", messageId: "old" });
    ephemeral(followUp, t("buttons.stale_notice"));
  });

  it("a click by someone who is not a fleet admin", async () => {
    const { adapter, fm, posted, startLogin, click, slash } = discordFleet({ admin: false });
    (fm as any).isFleetAdmin.mockReturnValueOnce(true); // the admin opens the chooser
    await (fm as any).handleLoginSlash(slash("ops"), "discord", adapter);
    const followUp = await click(posted[0]!.rows[0]![0]!, { channelId: "ops", messageId: "msg-1", userId: "visitor" });
    ephemeral(followUp, t("buttons.admin_only"));
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("the right button in the wrong place", async () => {
    const { adapter, fm, posted, startLogin, click, slash } = discordFleet();
    await (fm as any).handleLoginSlash(slash("ops"), "discord", adapter);
    const followUp = await click(posted[0]!.rows[0]![0]!, { channelId: "elsewhere", messageId: "msg-1" });
    ephemeral(followUp, t("buttons.wrong_place"));
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("an accepted click gets no notice", async () => {
    const { adapter, fm, posted, startLogin, click, slash } = discordFleet();
    await (fm as any).handleLoginSlash(slash("ops"), "discord", adapter);
    const followUp = await click(posted[0]!.rows[0]![0]!, { channelId: "ops", messageId: "msg-1" });
    expect(followUp).not.toHaveBeenCalled();
    expect(startLogin).toHaveBeenCalledOnce();
  });
});

describe("Telegram answers a click once the fleet has decided", () => {
  const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
  function telegram(answerFails = false) {
    const dir = scratch("tg");
    const adapter = new TelegramAdapter({ id: "telegram", botToken: TOKEN, accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: dir });
    adapters.push({ stop: async () => { (adapter as any).httpAgent?.destroy(); (adapter as any).httpsAgent?.destroy(); } });
    const bot = adapter.getBot() as any;
    bot.botInfo = { id: 42, is_bot: true, first_name: "agend", username: "agend_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    const answers: unknown[] = [];
    bot.api.config.use(async (_prev: unknown, method: string, payload: any) => {
      if (method === "answerCallbackQuery") {
        answers.push(payload);
        if (answerFails) throw new Error("query is too old");
      }
      return { ok: true, result: true };
    });
    const update = (data: string) => bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "q1", chat_instance: "ci", data,
        from: { id: 7, is_bot: false, first_name: "admin" },
        message: { message_id: 9, date: 1, chat: { id: -100123, type: "supergroup", title: "fleet", is_forum: true }, message_thread_id: 5 },
      },
    });
    return { adapter, answers, update };
  }

  it("a refusal is the answer's text, answered exactly once", async () => {
    const { adapter, answers, update } = telegram();
    adapter.on("callback_query", (data: any) => { data.ack("⛔ not for you"); data.ack(); });
    await update("login:abc:codex");
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ callback_query_id: "q1", text: "⛔ not for you" });
  });

  it("an unanswered click is answered anyway", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { answers, update } = telegram();
    await update("login:abc:codex");
    expect(answers).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(answers).toHaveLength(1);
    expect(answers[0]).not.toHaveProperty("text");
  });

  it("a failed answer does not lose the click", async () => {
    const { adapter, update } = telegram(true);
    const seen = vi.fn((data: any) => data.ack());
    adapter.on("callback_query", seen);
    await update("login:abc:codex");
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ callbackData: "login:abc:codex", chatId: "-100123", threadId: "5" }));
  });
});

describe("a real Discord edit that fails reaches the outcome fallback (#1134 review)", () => {
  async function cancelThroughDiscord(editError: Error | null) {
    const { adapter, fm, click } = discordFleet();
    const edit = editError ? vi.fn().mockRejectedValue(editError) : vi.fn().mockResolvedValue(undefined);
    (adapter as any)._fetchTextChannel.mockImplementation(async () => ({
      send: async () => ({ id: "msg-1" }),
      messages: { fetch: async () => ({ edit }) },
    }));
    // The guild scan finds no other channel holding the message.
    vi.spyOn(adapter as any, "readyClient").mockResolvedValue({ guilds: { fetch: async () => ({ channels: { cache: { filter: () => new Map() } } }) } });
    const sendText = vi.spyOn(adapter, "sendText").mockResolvedValue({ messageId: "out", chatId: GUILD } as any);
    await (fm as any).postNonceButtonPrompt({
      prefix: "login-confirm:", alertType: "login", instanceName: "codex", adapter, adapterId: "discord",
      chatId: GUILD, threadId: "ops", message: "Sign in?", choices: [{ action: "cancel", label: "Cancel" }], expiredText: "expired",
    });
    const nonce = [...(fm as any).pendingNonceButtons.keys()][0];
    await click(`login-confirm:${nonce}:cancel`, { channelId: "ops", messageId: "msg-1" });
    const second = await click(`login-confirm:${nonce}:cancel`, { channelId: "ops", messageId: "msg-1" });
    return { edit, sendText, second };
  }

  it.each([["Unknown Message"], ["Missing Permissions"]])("edit rejected (%s), scan finds nothing: the cancel result is posted once", async (reason) => {
    const { sendText, second } = await cancelThroughDiscord(new Error(reason));
    expect(sendText.mock.calls.filter(c => c[1] === t("login.cancelled", "codex"))).toHaveLength(1);
    // The nonce was consumed by the first click only.
    expect(second).toHaveBeenCalledWith({ content: t("buttons.stale_notice"), flags: 64 });
  });

  it("edit succeeds: nothing is posted again", async () => {
    const { edit, sendText } = await cancelThroughDiscord(null);
    expect(edit).toHaveBeenCalled();
    expect(sendText.mock.calls.filter(c => c[1] === t("login.cancelled", "codex"))).toHaveLength(0);
  });
});

describe("outcomes and unhandled clicks are never lost silently", () => {
  it("an outcome whose message edit fails is posted as a message instead", async () => {
    const fm = new FleetManager(scratch("fm"));
    const sendText = vi.fn().mockResolvedValue({ messageId: "n" });
    const adapter = { id: "discord", sendText, editMessageRemoveButtons: vi.fn().mockRejectedValue(new Error("Unknown Message")) };
    await (fm as any).retireNonceButtons({ adapter, chatId: GUILD, threadId: "ops", instanceName: "codex", prefix: "login-confirm:" }, "m1", "❎ codex login cancelled");
    expect(sendText).toHaveBeenCalledWith(GUILD, "❎ codex login cancelled", { threadId: "ops" });
  });

  it("a click no handler owns is logged and still acknowledged", async () => {
    const fm = new FleetManager(scratch("fm"));
    const info = vi.spyOn(fm.logger, "info");
    const ack = vi.fn();
    await (fm as any).receiveAdapterCallback({ callbackData: "mystery:123", chatId: "c", messageId: "m", ack }, "discord", undefined, () => true);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ prefix: "mystery:" }), expect.stringContaining("not handled"));
    expect(ack).toHaveBeenCalledOnce();
  });

  it("a click from a replaced adapter is logged and acknowledged", async () => {
    const fm = new FleetManager(scratch("fm"));
    const info = vi.spyOn(fm.logger, "info");
    const ack = vi.fn();
    await (fm as any).receiveAdapterCallback({ callbackData: "login:x:codex", chatId: "c", messageId: "m", ack }, "discord", undefined, () => false);
    expect(info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("replaced adapter"));
    expect(ack).toHaveBeenCalledOnce();
  });
});

describe("the web login's auth pre-check", () => {
  it("a probe that throws is an unknown answer: the confirmation is still posted", async () => {
    const buttons: unknown[] = [];
    const lock = new LoginWindowLock();
    const deps: LoginControllerDeps = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "fleet.example" }) as never,
      isFleetAdmin: () => true,
      eventLog: () => ({ insert: () => {} }),
      recoverBackendInstances: async () => ({ woken: [], restarted: [], pending: [] }),
      postButtons: async o => { buttons.push(o); },
      claimWindow: backend => lock.tryClaim("web", backend),
      releaseWindow: c => { lock.release(c); },
      isClaimCurrent: c => lock.isCurrent(c),
      windowBusyMessage: () => lock.busyMessage(),
      checkAuth: async () => { throw new Error("probe crashed"); },
    } as LoginControllerDeps;
    const controller = new LoginController(deps);
    const adapter = { id: "telegram", type: "telegram", sendText: vi.fn() } as any;
    const result = await controller.start("claude-code", { adapter, adapterId: "telegram", chatId: "chat", threadId: "topic", userId: "admin" });
    expect(result).toBeNull();
    expect(buttons).toHaveLength(1);
  });
});
