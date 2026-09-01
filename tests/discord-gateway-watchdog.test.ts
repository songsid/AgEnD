import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Status, type Client } from "discord.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";

class FakeDiscordClient extends EventEmitter {
  ready = false;
  destroyed = false;
  loginError: Error | null = null;
  loginGate: Promise<void> | null = null;
  sent: string[] = [];
  user = { id: "bot-id", username: "bot" };
  application = { commands: { set: vi.fn(async () => []) } };
  ws = {
    status: Status.Disconnected,
    shards: new Map([[0, { id: 0, status: Status.Disconnected, lastPingTimestamp: -1, ping: -1 }]]),
  };
  channels = {
    fetch: vi.fn(async () => ({
      isTextBased: () => true,
      send: async (value: string | { content?: string }) => {
        const text = typeof value === "string" ? value : value.content ?? "";
        this.sent.push(text);
        return { id: `m-${this.sent.length}` };
      },
    })),
  };
  guilds = { fetch: vi.fn() };
  rest = { put: vi.fn() };

  isReady(): boolean { return this.ready; }
  async login(): Promise<string> {
    if (this.loginGate) await this.loginGate;
    if (this.loginError) throw this.loginError;
    this.ready = true;
    this.ws.status = Status.Ready;
    for (const shard of this.ws.shards.values()) shard.status = Status.Ready;
    this.emit("ready", this);
    return "redacted-token";
  }
  destroy(): void {
    this.destroyed = true;
    this.ready = false;
    this.ws.status = Status.Disconnected;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function harness(overrides: Record<string, unknown> = {}) {
  const clients: FakeDiscordClient[] = [];
  let now = 1_000;
  const adapter = new DiscordAdapter({
    id: "persona-2",
    botToken: "secret-must-not-leak",
    accessManager: {} as any,
    inboxDir: "/tmp/agend-discord-gateway-test",
    guildId: "guild",
    registerCommands: false,
    clientFactory: () => {
      const client = new FakeDiscordClient();
      clients.push(client);
      return client as unknown as Client;
    },
    now: () => now,
    watchdogIntervalMs: 100,
    staleThresholdMs: 180,
    reconnectBaseDelayMs: 10,
    ...overrides,
  });
  return { adapter, clients, now: () => now, setNow: (value: number) => { now = value; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Discord gateway watchdog", () => {
  it("uses a fresh Client at startup and leaves a normally idle, ACKing shard alone", async () => {
    const h = harness();
    await h.adapter.start();
    expect(h.clients).toHaveLength(2);
    expect(h.clients[0].destroyed).toBe(true);
    h.clients[1].ws.shards.get(0)!.lastPingTimestamp = h.now();
    h.setNow(h.now() + 150);
    (h.adapter as any).checkGatewayLiveness();
    expect(h.clients).toHaveLength(2);
    expect(h.adapter.getHealthSnapshot()).toMatchObject({ status: "connected", isReady: true, generation: 1 });
    await h.adapter.stop();
  });

  it("rebuilds exactly one fresh generation for a Ready shard with a stale ACK", async () => {
    const h = harness();
    await h.adapter.start();
    h.clients[1].ws.shards.get(0)!.lastPingTimestamp = 700;
    h.setNow(1_200);
    (h.adapter as any).checkGatewayLiveness();
    await vi.waitFor(() => expect(h.clients).toHaveLength(3));
    expect(h.clients[1].destroyed).toBe(true);
    expect(h.clients[2].ready).toBe(true);
    expect(h.adapter.getHealthSnapshot().reconnectCount).toBe(1);
    await h.adapter.stop();
  });

  it("honours the -1 startup grace and treats a host-sleep timer jump as drift", async () => {
    const h = harness();
    await h.adapter.start();
    expect(h.clients[1].ws.shards.get(0)!.lastPingTimestamp).toBe(-1);
    h.setNow(1_150);
    (h.adapter as any).checkGatewayLiveness();
    expect(h.clients).toHaveLength(2);
    h.setNow(10_000); // >3 watchdog intervals: suspend/drift, not a zombie signal
    (h.adapter as any).checkGatewayLiveness();
    expect(h.clients).toHaveLength(2);
    await h.adapter.stop();
  });

  it("rebuilds a shard that remains Connecting beyond the liveness threshold", async () => {
    const h = harness();
    await h.adapter.start();
    const shard = h.clients[1].ws.shards.get(0)!;
    shard.status = Status.Connecting;
    h.setNow(1_100);
    (h.adapter as any).checkGatewayLiveness(); // starts the sustained-state clock
    h.setNow(1_281);
    (h.adapter as any).checkGatewayLiveness();
    await vi.waitFor(() => expect((h.adapter as any).client).not.toBe(h.clients[1]));
    expect(h.adapter.getHealthSnapshot()).toMatchObject({ status: "connected", isReady: true });
    await h.adapter.stop();
  });

  it("coalesces watchdog/error/manual triggers and a stop fences off the pending login", async () => {
    const h = harness();
    await h.adapter.start();
    const gate = deferred();
    const next = new FakeDiscordClient();
    next.loginGate = gate.promise;
    (h.adapter as any).clientFactory = () => next;
    const p1 = h.adapter.reconnectGateway("manual");
    const p2 = h.adapter.reconnectGateway("watchdog");
    expect(p2).toBe(p1);
    h.clients[1].emit("error", new Error("socket stalled"));
    await h.adapter.stop();
    gate.resolve();
    await expect(p1).rejects.toThrow(/cancelled|superseded/);
    expect(next.ready).toBe(false);
    expect((h.adapter as any).client).not.toBe(next);
    expect(h.adapter.getHealthSnapshot().status).toBe("stopped");
  });

  it("holds outbound work on the reconnect promise and sends through the new Client", async () => {
    const h = harness();
    await h.adapter.start();
    const gate = deferred();
    const next = new FakeDiscordClient();
    next.loginGate = gate.promise;
    (h.adapter as any).clientFactory = () => next;
    const reconnect = h.adapter.reconnectGateway("test");
    const send = h.adapter.sendText("channel", "after reconnect");
    await Promise.resolve();
    expect(next.sent).toEqual([]);
    gate.resolve();
    await reconnect;
    await expect(send).resolves.toMatchObject({ messageId: "m-1" });
    expect(next.sent).toEqual(["after reconnect"]);
    await h.adapter.stop();
  });

  it("backs off failed IDENTIFY attempts and eventually recovers", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.adapter.start();
    let attempts = 0;
    (h.adapter as any).clientFactory = () => {
      const client = new FakeDiscordClient();
      if (attempts++ < 2) client.loginError = new Error("identify failed");
      return client;
    };
    const reconnect = h.adapter.reconnectGateway("outage");
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await reconnect;
    expect(attempts).toBe(3);
    expect(h.adapter.getHealthSnapshot()).toMatchObject({ status: "connected", reconnectCount: 1 });
    await h.adapter.stop();
  });

  it("rebuilds only the stale bot in a multi-bot fleet", async () => {
    const a = harness();
    const b = harness();
    await Promise.all([a.adapter.start(), b.adapter.start()]);
    a.clients[1].ws.shards.get(0)!.lastPingTimestamp = 700;
    a.setNow(1_200);
    (a.adapter as any).checkGatewayLiveness();
    await vi.waitFor(() => expect(a.clients).toHaveLength(3));
    expect(b.clients).toHaveLength(2);
    await Promise.all([a.adapter.stop(), b.adapter.stop()]);
  });

  it("health snapshots expose liveness but never the bot token", async () => {
    const h = harness();
    await h.adapter.start();
    h.clients[1].ws.shards.get(0)!.lastPingTimestamp = 990;
    const serialized = JSON.stringify(h.adapter.getHealthSnapshot());
    expect(serialized).toContain("persona-2");
    expect(serialized).toContain("heartbeatAgeMs");
    expect(serialized).not.toContain("secret-must-not-leak");
    await h.adapter.stop();
  });
});
