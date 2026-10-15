import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/locale.js";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execSync: vi.fn(() => { throw Error("no process in setup test"); }), execFileSync: vi.fn(() => { throw Error("no probe process"); }), spawn: vi.fn(() => { throw Error("no fleet"); }),
}));
let runDiscordFlow: typeof import("../src/quickstart.js").runDiscordFlow;
let buildChannelConfig: typeof import("../src/quickstart.js").buildChannelConfig;
let home: string;
const GUILD = "111111111111111111", USER = "222222222222222222", GENERAL = "333333333333333333";
class Socket extends EventTarget {
  send = vi.fn(); close = vi.fn();
  packet(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  human() {
    this.packet({ op: 10, d: { heartbeat_interval: 60_000 } });
    this.packet({ op: 0, t: "READY", s: 1, d: {} });
    this.packet({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { type: 0, id: "444444444444444444", channel_id: GENERAL, guild_id: GUILD, author: { id: USER, username: "alice" } } });
  }
}
let socket: Socket;
beforeAll(async () => {
  mkdirSync(join(process.cwd(), ".artifacts"), { recursive: true }); home = mkdtempSync(join(process.cwd(), ".artifacts", "admin-home-"));
  vi.stubEnv("HOME", home); vi.stubEnv("AGEND_HOME", home);
  ({ runDiscordFlow, buildChannelConfig } = await import("../src/quickstart.js"));
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  vi.useFakeTimers(); setLocale("en"); socket = new Socket(); vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("WebSocket", vi.fn(function () { return socket; }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => {
    if (url.endsWith("/users/@me")) return { username: "fixture_bot", id: "555555555555555555" };
    if (url.endsWith("/users/@me/guilds")) return [{ id: GUILD, name: "Fixture" }];
    if (url.endsWith("/gateway")) return { url: "wss://gateway.discord.gg" };
    throw Error("unexpected REST call");
  } })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setLocale("en"); });
const readline = (answers: string[]) => Object.assign(new EventEmitter(), { question: vi.fn(async (_prompt: string) => { if (!answers.length) throw Error("unexpected prompt"); return answers.shift()!; }) });

describe.each(["en", "zh-TW"] as const)("real CLI Discord setup in %s", locale => {
  it("observes a gateway author, requires confirmation and writes the exact locked ID", async () => {
    setLocale(locale); const rl = readline(["probe-token", "yes", GENERAL]);
    const pending = runDiscordFlow(rl as never); await vi.advanceTimersByTimeAsync(0);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining(locale === "en" ? "Send a message in server" : "請在伺服器"));
    socket.human();
    const platform = await pending;
    expect(platform.userId).toBe(USER); expect(buildChannelConfig(platform).access).toEqual({ mode: "locked", allowed_users: [USER] });
    expect(rl.question.mock.calls.map(x => x[0])).toContainEqual(expect.stringContaining(locale === "en" ? "Is this your account?" : "這是你的帳號嗎？"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`@alice`));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(locale === "en" ? "Send a message in server" : "請在伺服器"));
    expect(rl.question.mock.calls).toHaveLength(3); expect(socket.close).toHaveBeenCalledOnce();
    expect(rl.listenerCount("close")).toBe(0);
  });

  it.each(["", "no"])("confirmation %j never grants the observed person; manual fallback is required and validated", async confirmation => {
    setLocale(locale); const manual = "666666666666666666";
    const rl = readline(["probe-token", confirmation, "", "42", "name", "1".repeat(21), manual, GENERAL]);
    const pending = runDiscordFlow(rl as never); await vi.advanceTimersByTimeAsync(0); socket.human();
    const platform = await pending;
    expect(platform.userId).toBe(manual); expect(buildChannelConfig(platform).access.allowed_users).toEqual([manual]);
    expect(rl.question.mock.calls).toHaveLength(8);
    const output = vi.mocked(console.log).mock.calls.map(x => x.join(" ")).join("\n");
    expect(output).toContain(locale === "en" ? "Your Discord user ID is required" : "Discord 使用者 ID 必填");
    expect(output).not.toContain(`User: ${USER}`);
  });

  it("timeout enters a validated manual fallback without granting an empty ID", async () => {
    setLocale(locale); const rl = readline(["probe-token", "", "-10042", USER, GENERAL]);
    const pending = runDiscordFlow(rl as never); await vi.advanceTimersByTimeAsync(30_000);
    const platform = await pending;
    expect(platform.userId).toBe(USER); expect(rl.question.mock.calls).toHaveLength(5); expect(socket.close).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(locale === "en" ? "Could not detect your account" : "無法偵測你的帳號"));
  });

  it("closing the interactive setup retires the detector and selects no admin", async () => {
    setLocale(locale); const rl = readline(["probe-token"]);
    const pending = runDiscordFlow(rl as never); const failure = expect(pending).rejects.toThrow(locale === "en" ? "Setup cancelled" : "設定已取消");
    await vi.advanceTimersByTimeAsync(0); rl.emit("close"); await failure;
    expect(rl.question.mock.calls).toHaveLength(1); expect(rl.listenerCount("close")).toBe(0); expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each(["", "42", "-1001", "1".repeat(21), 222222222222222222])("the actual CLI config boundary refuses invalid Discord ID %j", userId => {
  expect(() => buildChannelConfig({ type: "discord", userId, token: "probe-token", tokenEnvName: "AGEND_DISCORD_TOKEN", botUsername: "fixture_bot", groupId: GUILD } as never)).toThrow(/Discord user ID is required/);
});
