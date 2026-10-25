/**
 * #2642: an outbound request on a Discord bot whose gateway is still on its first connect — the startup login, or a
 * rebuild that has logged in and is still receiving its guilds — waits for it; it never rebuilds it. A rebuild there
 * destroyed the startup client mid-login (start() never settled, fleet startup stopped before the ClassicBot starts),
 * and each "successful" rebuild was rebuilt again by the next request, so the bot never became ready.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Status, type Client } from "discord.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

/** discord.js 14's shape: login() resolves on the gateway READY dispatch; isReady() turns true once every guild arrived. */
class FakeClient extends EventEmitter {
  ready = false; destroyed = false; sent: string[] = [];
  loginGate: Promise<void> | null = null; guildsGate: Promise<void> | null = null; loginError: Error | null = null;
  user = { id: "bot-id", username: "bot", setActivity: vi.fn() };
  application = { commands: { set: vi.fn(async () => []) } };
  ws = { status: Status.Connecting, shards: new Map([[0, { id: 0, status: Status.Connecting, lastPingTimestamp: -1, ping: -1 }]]) };
  channels = { fetch: vi.fn(async () => ({ isTextBased: () => true,
    send: async (v: string | { content?: string }) => { this.sent.push(typeof v === "string" ? v : v.content ?? ""); return { id: `m-${this.sent.length}` }; } })) };
  guilds = { fetch: vi.fn() }; rest = { put: vi.fn() };
  isReady(): boolean { return this.ready && !this.destroyed; }
  async login(): Promise<string> {
    if (this.loginGate) await this.loginGate;
    if (this.destroyed) await new Promise(() => {});           // destroyed mid-connect: this login never settles
    if (this.loginError) throw this.loginError;
    void (this.guildsGate ?? Promise.resolve()).then(() => {
      if (this.destroyed) return;
      this.ready = true; this.ws.status = Status.Ready;
      for (const shard of this.ws.shards.values()) shard.status = Status.Ready;
      this.emit("clientReady", this);
    });
    return "redacted";
  }
  destroy(): void { this.destroyed = true; this.ready = false; }
}

const adapters: DiscordAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.stop(); });

function harness(setup: (client: FakeClient, index: number) => void = () => {}, overrides: Record<string, unknown> = {}) {
  const clients: FakeClient[] = [];
  let now = 1_000;
  const adapter = new DiscordAdapter({
    id: "main", botToken: "secret", accessManager: {} as any, inboxDir: "/tmp/agend-discord-2642", guildId: "guild", registerCommands: false,
    clientFactory: () => { const c = new FakeClient(); setup(c, clients.length); clients.push(c); return c as unknown as Client; },
    now: () => now, reconnectBaseDelayMs: 10, ...overrides,
  } as any);
  adapters.push(adapter);
  // clients[0] is the constructor's placeholder; logins start at clients[1].
  return { adapter, clients, advance: (ms: number) => { now += ms; } };
}

const CHANNEL = "123456789012345678";
const settle = () => new Promise(r => setTimeout(r, 20));

describe("#2642 Discord first connect", () => {
  it("a send during the startup login waits for it: no rebuild, start() settles, the send goes out once ready", async () => {
    const login = deferred();
    const h = harness((c, i) => { if (i === 1) c.loginGate = login.promise; });
    const start = h.adapter.start();
    await settle();
    const send = h.adapter.sendText(CHANNEL, "hello");
    await settle();
    login.resolve();
    await start;
    await expect(send).resolves.toMatchObject({ messageId: expect.any(String) });
    expect(h.clients).toHaveLength(2);
    expect(h.clients[1].destroyed).toBe(false);
    expect(h.clients[1].sent).toEqual(["hello"]);
    expect(h.adapter.getHealthSnapshot()).toMatchObject({ status: "connected", generation: 1, isReady: true });
  });

  it("a send in the gap before the startup Client exists (the old one is being retired) also waits", async () => {
    const h = harness();
    const start = h.adapter.start();          // no await: loginFreshClient is still retiring the placeholder
    const send = h.adapter.sendText(CHANNEL, "early");
    await start;
    await expect(send).resolves.toBeTruthy();
    expect(h.clients).toHaveLength(2);
  });

  it("logged in but guilds still arriving: a send waits for ready instead of rebuilding", async () => {
    const guilds = deferred();
    const h = harness((c, i) => { if (i === 1) c.guildsGate = guilds.promise; });
    await h.adapter.start();
    expect(h.clients[1].isReady()).toBe(false);
    const sends = [h.adapter.sendText(CHANNEL, "a"), h.adapter.sendText(CHANNEL, "b")];
    await settle();
    expect(h.clients).toHaveLength(2);
    guilds.resolve();
    await Promise.all(sends);
    expect(h.clients).toHaveLength(2);
    expect(h.clients[1].sent.sort()).toEqual(["a", "b"]);
  });

  it("a rebuild whose login resolved before its guilds is waited for, not rebuilt again by the next request", async () => {
    const guilds = deferred();
    const h = harness((c, i) => { if (i === 2) c.guildsGate = guilds.promise; });
    await h.adapter.start();
    await h.adapter.reconnectGateway("test: drop");
    expect(h.clients).toHaveLength(3);
    const sends = [h.adapter.sendText(CHANNEL, "x"), h.adapter.sendText(CHANNEL, "y")];
    await settle();
    expect(h.clients).toHaveLength(3);
    guilds.resolve();
    await Promise.all(sends);
    expect(h.clients).toHaveLength(3);
    expect(h.clients[2].sent.sort()).toEqual(["x", "y"]);
  });

  it("a failed startup login releases the waiting send at once (no 30 s wait)", async () => {
    const login = deferred();
    const h = harness((c, i) => { if (i === 1) { c.loginGate = login.promise; c.loginError = new Error("401: Unauthorized"); } });
    const start = h.adapter.start();
    await settle();
    const send = h.adapter.sendText(CHANNEL, "x");
    await settle();
    const t0 = performance.now();
    login.resolve();
    await expect(start).rejects.toThrow("401");
    await expect(send).rejects.toThrow();
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("a generation still not ready past the watchdog's stale threshold is rebuilt as before", async () => {
    const guilds = deferred();
    const h = harness((c, i) => { if (i === 1) c.guildsGate = guilds.promise; }, { staleThresholdMs: 1_000 });
    await h.adapter.start();
    h.advance(1_001);
    await h.adapter.sendText(CHANNEL, "after rebuild");
    expect(h.clients).toHaveLength(3);
    expect(h.clients[1].destroyed).toBe(true);
    expect(h.clients[2].sent).toEqual(["after rebuild"]);
  });

  it("a stop releases a waiting send", async () => {
    const guilds = deferred();
    const h = harness((c, i) => { if (i === 1) c.guildsGate = guilds.promise; });
    await h.adapter.start();
    const send = h.adapter.sendText(CHANNEL, "x");
    await settle();
    await h.adapter.stop();
    await expect(send).rejects.toThrow();
  });
});
