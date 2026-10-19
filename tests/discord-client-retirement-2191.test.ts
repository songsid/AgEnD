import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { protectDiscordClientRetirement, retireDiscordClient } from "../src/channel/adapters/discord-client-retirement.js";

// Exercise the installed @discordjs/ws implementation with inert socket
// construction and a controlled clock. No network, fleet, CLI, or process handlers.
async function connectingShard(waitForHello = false) {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    handler: ((event: { error: Error }) => void) | null = null;
    listener: ((error: Error) => void) | null = null;
    onmessage: unknown;
    onclose: unknown;
    onopen: unknown;
    constructor() { super(); sockets.push(this); }
    set onerror(handler: ((event: { error: Error }) => void) | null) {
      if (this.listener) this.removeListener("error", this.listener);
      this.handler = handler;
      this.listener = handler ? error => handler({ error }) : null;
      if (this.listener) this.on("error", this.listener);
    }
    get onerror() { return this.handler; }
    terminate = vi.fn(() => {
      queueMicrotask(() => {
        this.emit("error", new Error("WebSocket was closed before the connection was established"));
        this.readyState = 3;
        this.emit("close");
      });
    });
  }
  const require = createRequire(import.meta.url);
  const dependencyPath = require.resolve("@discordjs/ws");
  const original = readFileSync(dependencyPath, "utf8");
  const source = original.replace(/var WebSocketConstructor = [^;]+;/, "var WebSocketConstructor = FakeSocket;");
  expect(source).not.toBe(original);
  const mod = { exports: {} as any };
  const dependencyRequire = createRequire(dependencyPath);
  let recoverySleeps = 0;
  // The dependency imports node:timers, so replacing VM globals alone does not
  // put its timers under Vitest's clock. Keep the real logic, inject its clock.
  const clockRequire = (name: string) => {
    const builtin = name.replace(/^node:/, "");
    if (builtin === "timers") return { ...dependencyRequire(name), setTimeout, clearTimeout };
    if (builtin === "timers/promises") return { ...dependencyRequire(name), setTimeout: (delay: number) => {
      if (delay === 500) recoverySleeps++;
      return new Promise(resolve => setTimeout(resolve, delay));
    } };
    return dependencyRequire(name);
  };
  runInNewContext(source, { module: mod, exports: mod.exports, require: clockRequire, FakeSocket,
    AbortController, URLSearchParams, Buffer, TextDecoder, TextEncoder, console, setTimeout, clearTimeout });
  const shard = new mod.exports.WebSocketShard({
    options: { gatewayInformation: { url: "wss://inert.invalid" }, encoding: "json", version: "10", compression: null, helloTimeout: 60_000 },
    retrieveSessionInfo: async () => null,
    updateSessionInfo: async () => {},
  }, 0);
  // Hold at the pre-HELLO connection state without real timers or identify.
  if (!waitForHello) shard.waitForEvent = async () => ({ ok: false });
  const connected = shard.internalConnect();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const client = { ws: { _ws: { strategy: { shards: new Map([[0, shard]]) } } }, destroy: () => shard.destroy() } as unknown as Client;
  return { client, socket: sockets[0], sockets, connected, get recoverySleeps() { return recoverySleeps; } };
}

afterEach(() => vi.useRealTimers());

describe("Discord connecting gateway retirement (#2191)", () => {
  it("reproduces the pinned dependency leaving a bare handshake timeout after destroy", async () => {
    const { client, socket, connected } = await connectingShard();
    await client.destroy();
    await connected;
    expect(socket.readyState).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(() => socket.emit("error", new Error("Opening handshake has timed out"))).toThrow("Opening handshake has timed out");
  });

  it("contains the retired socket error, terminates its handshake, and releases the listener at close", async () => {
    const { client, socket, connected } = await connectingShard();
    const report = vi.fn();
    const first = retireDiscordClient(client, report);
    expect(retireDiscordClient(client, report)).toBe(first);
    await first;
    await connected;
    await Promise.resolve();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "WebSocket was closed before the connection was established" }));
    expect(socket.readyState).toBe(3);
    expect(socket.listenerCount("error")).toBe(0);
  });

  it("does not let an already scheduled native HELLO recovery resurrect the retired shard", async () => {
    vi.useFakeTimers();
    const fixture = await connectingShard(true);
    // Drive the actual HELLO timeout into destroy(recover), then retire while
    // its native 500ms reconnect sleep is pending. It must stay retired.
    await vi.advanceTimersByTimeAsync(60_000);
    await fixture.connected;
    expect(fixture.recoverySleeps).toBe(1);
    expect(fixture.sockets).toHaveLength(1);
    await retireDiscordClient(fixture.client, vi.fn());
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.sockets).toHaveLength(1);
    expect(fixture.sockets[0].readyState).toBe(3);
  });

  it("also protects destruction initiated internally by Client.login on failure", async () => {
    const { client, socket, connected } = await connectingShard();
    const report = vi.fn();
    protectDiscordClientRetirement(client, report);
    await client.destroy();
    await connected;
    await Promise.resolve();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
  });
});
