import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitDiscordUserMessage, isAdminUserId, isDiscordSnowflake, type DiscordProbeSocket } from "../src/provider-probe.js";

const GUILD = "111111111111111111", USER = "222222222222222222";
class Socket implements DiscordProbeSocket {
  listeners = new Map<string, Set<(e: any) => void>>();
  sent: any[] = [];
  close = vi.fn();
  send = vi.fn((data: string) => { this.sent.push(JSON.parse(data)); });
  addEventListener(type: string, fn: (e: any) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(fn); }
  removeEventListener(type: string, fn: (e: any) => void) { this.listeners.get(type)?.delete(fn); }
  emit(type: string, event: any = {}) { for (const fn of [...this.listeners.get(type) ?? []]) fn(event); }
  packet(p: unknown) { this.emit("message", { data: JSON.stringify(p) }); }
  ready(interval = 1000) { this.packet({ op: 10, d: { heartbeat_interval: interval } }); this.packet({ op: 11 }); this.packet({ op: 0, t: "READY", s: 1, d: {} }); }
  human(overrides: Record<string, unknown> = {}) { this.packet({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { type: 0, id: "333333333333333333", channel_id: "444444444444444444", guild_id: GUILD, author: { id: USER, username: "alice" }, ...overrides } }); }
}
const reply = (url = "wss://gateway.discord.gg") => ({ ok: true, json: async () => ({ url }) }) as Response;
const flush = () => vi.advanceTimersByTimeAsync(0);
async function rig(opts: Partial<Parameters<typeof awaitDiscordUserMessage>[2]> = {}) {
  const socket = new Socket();
  const makeSocket = vi.fn(() => socket), doFetch = vi.fn(async () => reply());
  const pending = awaitDiscordUserMessage("probe-token", GUILD, { deadlineMs: 30_000, makeSocket, doFetch, ...opts });
  await flush();
  return { socket, pending, makeSocket, doFetch };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("shared setup user ID validation", () => {
  it.each([undefined, null, "", " ", 222222222222222222, "42", "-123456789012345678", "1234567890123456", "1".repeat(21), "0".repeat(18), "012345678901234567", "12345678901234567\n", "<@222222222222222222>"])("Discord refuses %j", value => expect(isDiscordSnowflake(value)).toBe(false));
  it.each(["1".repeat(17), USER, "1".repeat(19), "1".repeat(20)])("Discord keeps exact snowflake bytes: %s", value => expect(isAdminUserId("discord", value)).toBe(true));
  it("Telegram requires a positive string ID, not a group ID or empty/coerced value", () => {
    for (const value of ["42", "1".repeat(20)]) expect(isAdminUserId("telegram", value)).toBe(true);
    for (const value of [undefined, "", "0", "-10042", "01", 42, "1".repeat(21)]) expect(isAdminUserId("telegram", value)).toBe(false);
  });
});

describe("new Discord gateway message → candidate, never an automatic grant", () => {
  it.each(["guild", "dm", "reply"])("accepts a human %s without reading content and closes the socket", async mode => {
    const h = await rig(); h.socket.ready(); h.socket.human({ guild_id: mode === "dm" ? undefined : GUILD, type: mode === "reply" ? 19 : 0 });
    expect(await h.pending).toEqual({ userId: USER, username: "alice" });
    expect(h.makeSocket).toHaveBeenCalledWith("wss://gateway.discord.gg/?v=10&encoding=json");
    expect(h.socket.sent[0]).toMatchObject({ op: 2, d: { token: "probe-token", intents: 4608 } });
    expect(h.socket.sent[0].d.intents & (1 << 15)).toBe(0);
    expect(h.socket.close).toHaveBeenCalledOnce();
    expect([...h.socket.listeners.values()].every(x => x.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["other guild", { guild_id: "555555555555555555" }],
    ["unknown/null guild", { guild_id: null }],
    ["bot", { author: { id: USER, username: "bot", bot: true } }],
    ["system user", { author: { id: USER, username: "system", system: true } }],
    ["unknown bot flag", { author: { id: USER, username: "alice", bot: "false" } }],
    ["webhook", { webhook_id: "666666666666666666" }],
    ["system message", { type: 18 }],
    ["unknown message type", { type: 999 }],
    ["missing message type", { type: undefined }],
    ["malformed author", { author: { id: 42, username: "alice" } }],
    ["missing username", { author: { id: USER } }],
    ["terminal control in username", { author: { id: USER, username: "\u001b[31mevil" } }],
    ["invalid message id", { id: "12" }],
    ["invalid channel id", { channel_id: "12" }],
  ])("ignores %s; a later supported human still works", async (_name, invalid) => {
    const h = await rig(); h.socket.ready(); let result: unknown = "pending"; void h.pending.then(x => { result = x; });
    h.socket.human(invalid as Record<string, unknown>); await flush();
    expect(result).toBe("pending"); expect(h.socket.close).not.toHaveBeenCalled();
    h.socket.human(); expect(await h.pending).toEqual({ userId: USER, username: "alice" });
  });

  it("ignores messages before READY and uses only the new connection", async () => {
    const h = await rig(); h.socket.human(); h.socket.packet({ op: 0, t: "READY", d: {} }); h.socket.human();
    expect(h.socket.close).not.toHaveBeenCalled();
    h.socket.ready(); h.socket.human(); expect((await h.pending)?.userId).toBe(USER);
  });

  it.each(["timeout", "abort", "error", "close", "reconnect", "invalid-session"])("%s settles null with no remaining heartbeat/listener", async event => {
    const abort = new AbortController(), h = await rig({ signal: abort.signal }); h.socket.ready(60_000);
    if (event === "timeout") {
      await vi.advanceTimersByTimeAsync(29_999); expect(h.socket.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    else if (event === "abort") abort.abort();
    else if (event === "error" || event === "close") h.socket.emit(event);
    else h.socket.packet({ op: event === "reconnect" ? 7 : 9 });
    expect(await h.pending).toBeNull(); expect(h.socket.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    h.socket.human(); expect(h.socket.close).toHaveBeenCalledOnce();
  });

  it("discovery that resolves after the budget cannot create a gateway connection", async () => {
    let answer!: (r: Response) => void;
    const makeSocket = vi.fn(() => new Socket()), doFetch = vi.fn((_url: unknown, init?: RequestInit) => { expect(init?.signal).toBeDefined(); return new Promise<Response>(r => { answer = r; }); });
    const pending = awaitDiscordUserMessage("probe-token", GUILD, { deadlineMs: 100, makeSocket, doFetch: doFetch as typeof fetch });
    await vi.advanceTimersByTimeAsync(100); expect(await pending).toBeNull();
    expect(doFetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    answer(reply()); await flush(); expect(makeSocket).not.toHaveBeenCalled();
  });

  it("a socket created during cancellation is retired before installing listeners or sending credentials", async () => {
    const abort = new AbortController(), socket = new Socket();
    const h = await rig({ signal: abort.signal, makeSocket: () => { abort.abort(); return socket; } });
    expect(await h.pending).toBeNull(); expect(socket.close).toHaveBeenCalledOnce(); expect(socket.send).not.toHaveBeenCalled(); expect(socket.listeners.size).toBe(0);
  });

  it("rejects a message exactly at the monotonic deadline before its timeout callback", async () => {
    let now = 0; const h = await rig({ deadlineMs: 100, now: () => now }); h.socket.ready(); now = 100; h.socket.human();
    expect(await h.pending).toBeNull(); expect(h.socket.close).toHaveBeenCalledOnce();
  });

  it("rechecks the budget after parsing, before publishing the observed candidate", async () => {
    const reads: number[] = [];
    const h = await rig({ deadlineMs: 100, now: () => reads.shift() ?? 0 }); h.socket.ready();
    reads.push(99, 100); h.socket.human();
    expect(await h.pending).toBeNull(); expect(h.socket.close).toHaveBeenCalledOnce();
  });

  it("a failed identify send cannot leave a heartbeat behind", async () => {
    const h = await rig(); h.socket.send.mockImplementation(() => { throw Error("private-token-detail"); }); h.socket.ready();
    expect(await h.pending).toBeNull(); expect(h.socket.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps heartbeats/ACKs in this scope and refuses a lost ACK", async () => {
    const h = await rig(); h.socket.ready(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.socket.sent.at(-1)).toEqual({ op: 1, d: 1 }); h.socket.packet({ op: 11 });
    await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(1000);
    expect(await h.pending).toBeNull(); expect(h.socket.close).toHaveBeenCalledOnce();
  });

  it.each(["https://gateway.discord.gg", "wss://elsewhere.invalid", "wss://name:secret@gateway.discord.gg", "wss://gateway.discord.gg:444"])("refuses an unexpected gateway URL %s", async url => {
    const h = await rig({ doFetch: async () => reply(url) }); expect(await h.pending).toBeNull(); expect(h.makeSocket).not.toHaveBeenCalled();
  });

  it("uses the runtime WebSocket by default, with no dependency or real network", async () => {
    const socket = new Socket(); vi.stubGlobal("WebSocket", vi.fn(function () { return socket; }));
    const pending = awaitDiscordUserMessage("probe-token", GUILD, { deadlineMs: 1000, doFetch: async () => reply() });
    await flush(); socket.ready(); socket.human(); expect((await pending)?.userId).toBe(USER); expect(socket.close).toHaveBeenCalledOnce();
  });
});
