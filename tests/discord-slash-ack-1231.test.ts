/**
 * #1231: Discord slash commands often showed "The application did not respond".
 *
 * A slash command must be acknowledged within 3 s of being sent. The adapter
 * now acknowledges before anything else, never drops a failed acknowledgement
 * silently (it says so and does not run the command, which a retry would
 * otherwise run twice), logs where a slow acknowledgement spent its time, and
 * the fleet logs event-loop stalls long enough to eat that window.
 *
 * Real DiscordAdapter (its own interactionCreate handler) with a fake
 * interaction; no gateway, no network. The event-loop watch is fed a fake
 * histogram.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { startEventLoopWatch, type LoopDelayHistogram } from "../src/event-loop-watch.js";
import { validateFleetConfig } from "../src/config-validator.js";

const GUILD = "primary-guild";
const NOW = 1_800_000_000_000;
const dirs: string[] = [];
const adapters: DiscordAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(adapters.splice(0).map(a => a.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(now: () => number = () => NOW) {
  const dir = join(tmpdir(), `agend-1231-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const adapter = new DiscordAdapter({
    id: "discord",
    botToken: "test-token",
    accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(dir, "access.json")),
    inboxDir: dir,
    guildId: GUILD,
    registerCommands: false,
    now,
  } as any);
  adapters.push(adapter);
  const commands: any[] = [];
  adapter.on("slash_command", data => commands.push(data));
  return { adapter, commands };
}

/** A slash command whose every read is recorded, in order, next to the acknowledgement. */
function slash(commandName: string, over: Record<string, unknown> = {}) {
  const order: string[] = [];
  const deferReply = vi.fn(async (_opts?: unknown) => { order.push("defer"); });
  const followUp = vi.fn(async (_opts: unknown) => undefined);
  const send = vi.fn(async (_text: string) => undefined);
  const interaction: Record<string, unknown> = {
    isButton: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => true,
    commandName,
    guildId: GUILD,
    channelId: "ops-channel",
    createdTimestamp: NOW - 200,
    get channel() { order.push("channel"); return { name: "ops", send }; },
    get user() { order.push("user"); return { id: "u-1", username: "alice" }; },
    options: {
      get data() { order.push("options.data"); return [{ name: "mode", value: "x" }]; },
      getString: (name: string) => { order.push(`getString:${name}`); return name === "mode" ? "full" : "hello"; },
    },
    deferReply,
    followUp,
    ...over,
  };
  return { interaction, order, deferReply, followUp, send };
}

const emit = (adapter: DiscordAdapter, interaction: unknown) => (adapter as any).client.emit("interactionCreate", interaction);

describe("the acknowledgement comes first (#1231)", () => {
  it.each(["status", "chat", "restart"])("/%s: nothing but its kind is read before deferReply", async command => {
    const { adapter, commands } = setup();
    const s = slash(command);
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const deferAt = s.order.indexOf("defer");
    expect(deferAt).toBeGreaterThanOrEqual(0);
    // Before it: at most the restart mode, which decides public vs private.
    expect(s.order.slice(0, deferAt).every(r => r === "getString:mode")).toBe(true);
    expect(s.order.slice(deferAt)).toEqual(expect.arrayContaining(["channel", "user"]));
  });

  it("which commands are public is unchanged: /chat, /update and a full /restart; the rest private", async () => {
    const kinds: Record<string, unknown> = {};
    for (const [command, mode] of [["chat", null], ["update", null], ["restart", "full"], ["restart", "instance"], ["status", null], ["login", null]] as const) {
      const { adapter, commands } = setup();
      const s = slash(command, { options: { data: [], getString: (n: string) => (n === "mode" ? mode : "x") } });
      emit(adapter, s.interaction);
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      kinds[`${command}${mode ? `:${mode}` : ""}`] = s.deferReply.mock.calls[0]![0];
    }
    expect(kinds).toEqual({
      chat: {}, update: {}, "restart:full": {},
      "restart:instance": { flags: MessageFlags.Ephemeral },
      status: { flags: MessageFlags.Ephemeral },
      login: { flags: MessageFlags.Ephemeral },
    });
  });
});

describe("a failed acknowledgement is never silent, and the command is not run (#1231)", () => {
  it("expired (10062): not run; the user is told privately, or in the channel if that fails too", async () => {
    const { adapter, commands } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const expired = Object.assign(new Error("Unknown interaction"), { code: 10062 });
    const s = slash("status", { createdTimestamp: NOW - 3_400 });
    s.deferReply.mockRejectedValue(expired);
    s.followUp.mockRejectedValue(new Error("Unknown Webhook"));
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledOnce());
    expect(commands).toEqual([]);
    expect(s.followUp).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    const notice = s.send.mock.calls[0]![0];
    expect(notice).toContain("<@u-1>");
    expect(notice).toContain("/status");
    expect(notice).toContain("3.4");
    expect(JSON.stringify(warn.mock.calls)).toContain("could not be acknowledged");
  });

  it("a private follow-up that lands is enough: nothing is posted in the channel", async () => {
    const { adapter, commands } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = slash("status");
    s.deferReply.mockRejectedValue(new Error("socket hang up"));
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(s.followUp).toHaveBeenCalledOnce());
    await new Promise(r => setTimeout(r, 10));
    expect(s.send).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it("already acknowledged (40060) by another session of this bot: not run here, and no notice", async () => {
    const { adapter, commands } = setup();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const s = slash("status");
    s.deferReply.mockRejectedValue(Object.assign(new Error("already acknowledged"), { code: 40060 }));
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(JSON.stringify(info.mock.calls)).toContain("another session"));
    await new Promise(r => setTimeout(r, 10));
    expect(commands).toEqual([]);
    expect(s.followUp).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });
});

describe("a slow acknowledgement says where the time went (#1231)", () => {
  it("over half the window: logged with the delivery and acknowledgement shares", async () => {
    let now = NOW;
    const { adapter, commands } = setup(() => now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = slash("status", { createdTimestamp: NOW - 1_200 });
    s.deferReply.mockImplementation(async () => { now += 500; });
    emit(adapter, s.interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const line = JSON.stringify(warn.mock.calls);
    expect(line).toContain("acknowledged 1700ms after it was sent");
    expect(line).toContain("1200ms before AgEnD saw it");
    expect(line).toContain("500ms to acknowledge");
  });

  it("a fast one is quiet", async () => {
    const { adapter, commands } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    emit(adapter, slash("status").interaction);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("acknowledged");
  });
});

describe("event-loop stalls are logged (#1231)", () => {
  function histogram(maxMs: number): LoopDelayHistogram & { resets: number } {
    return {
      max: maxMs * 1e6, mean: 5e6, percentile: () => maxMs * 0.9 * 1e6,
      resets: 0, reset() { this.resets++; }, enable: () => true, disable: () => true,
    };
  }

  it("a stall of a second or more is a warning with its length; shorter ones are not", () => {
    const warn = vi.fn();
    const long = histogram(1_400);
    const watch = startEventLoopWatch({ logger: { warn }, histogram: long, intervalMs: 3_600_000 });
    expect(watch.check()).toBe(1_400);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ maxMs: 1_400 }), expect.stringContaining("Event loop stalled for 1400ms"));
    expect(long.resets).toBe(1);
    watch.stop();
    const quiet = vi.fn();
    const short = histogram(999);
    const watch2 = startEventLoopWatch({ logger: { warn: quiet }, histogram: short, intervalMs: 3_600_000 });
    watch2.check();
    expect(quiet).not.toHaveBeenCalled();
    expect(short.resets).toBe(1);
    watch2.stop();
  });

  it("a real loop blocked for 1.2s is caught by the real histogram", () => {
    const warn = vi.fn();
    const watch = startEventLoopWatch({ logger: { warn }, intervalMs: 3_600_000 });
    return new Promise<void>(resolve => setTimeout(() => {
      const until = Date.now() + 1_200;
      while (Date.now() < until) { /* block the loop */ }
      setTimeout(() => {
        expect(watch.check()).toBeGreaterThanOrEqual(1_000);
        expect(warn).toHaveBeenCalledOnce();
        watch.stop();
        resolve();
      }, 50);
    }, 50));
  });
});

describe("one bot token per connection (#1231)", () => {
  const config = (envs: string[]) => ({
    channels: envs.map((env, i) => ({ id: `c${i}`, type: "discord", bot_token_env: env, group_id: "1" })),
    instances: {},
  });
  const tokenWarnings = (cfg: unknown) => validateFleetConfig(cfg as any).warnings?.filter((w: any) => /same bot token/.test(w.message)) ?? [];

  it("two connections naming the same token env: warned", () => {
    expect(tokenWarnings(config(["A_TOKEN", "A_TOKEN"]))).toHaveLength(1);
  });

  it("two env vars holding the same token: warned too", () => {
    vi.stubEnv("A_TOKEN_1231", "same-value");
    vi.stubEnv("B_TOKEN_1231", "same-value");
    expect(tokenWarnings(config(["A_TOKEN_1231", "B_TOKEN_1231"]))).toHaveLength(1);
  });

  it("different tokens: no warning", () => {
    vi.stubEnv("A_TOKEN_1231", "one");
    vi.stubEnv("B_TOKEN_1231", "two");
    expect(tokenWarnings(config(["A_TOKEN_1231", "B_TOKEN_1231"]))).toEqual([]);
  });
});
