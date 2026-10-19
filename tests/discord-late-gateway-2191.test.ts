import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { protectDiscordClientRetirement, retireDiscordClient } from "../src/channel/adapters/discord-client-retirement.js";

// Real Client.login, manager and default SimpleShardingStrategy. Only transport,
// REST gateway response and dependency clocks are inert; no network/process policy.
function fixture({ protect = true, expireGateway = false, blockDestroy = false } = {}) {
  const sockets: InertSocket[] = [];
  class InertSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    listener: ((error: Error) => void) | null = null;
    onmessage: unknown; onclose: unknown; onopen: unknown;
    set onerror(handler: ((event: { error: Error }) => void) | null) {
      if (this.listener) this.removeListener("error", this.listener);
      this.listener = handler ? error => handler({ error }) : null;
      if (this.listener) this.on("error", this.listener);
    }
    constructor() { super(); sockets.push(this); }
    terminate = vi.fn(() => { this.readyState = 3; this.emit("close"); });
  }
  const require = createRequire(import.meta.url);
  const dependency = require.resolve("@discordjs/ws");
  const dependencyRequire = createRequire(dependency);
  const original = readFileSync(dependency, "utf8");
  const source = original.replace(/var WebSocketConstructor = [^;]+;/, "var WebSocketConstructor = InertSocket;");
  expect(source).not.toBe(original);
  const wsModule = { exports: {} as any };
  let recoverySleeps = 0;
  runInNewContext(source, { module: wsModule, exports: wsModule.exports, InertSocket,
    require: (name: string) => {
      const builtin = name.replace(/^node:/, "");
      if (builtin === "timers") return { ...dependencyRequire(name), setTimeout, clearTimeout };
      if (builtin === "timers/promises") return { ...dependencyRequire(name), setTimeout: (delay: number) => {
        if (delay === 500) recoverySleeps++;
        return new Promise(resolve => setTimeout(resolve, delay));
      } };
      return dependencyRequire(name);
    }, AbortController, URLSearchParams, Buffer, TextDecoder, TextEncoder, console, setTimeout, clearTimeout });
  const root = dirname(require.resolve("discord.js"));
  const clientFile = join(root, "client/Client.js");
  const managerFile = join(root, "client/websocket/WebSocketManager.js");
  function load(file: string): any {
    const localRequire = createRequire(file);
    const mod = { exports: {} };
    const wrapper = runInNewContext(`(function(require,module,exports,__filename,__dirname){${readFileSync(file, "utf8")}\n})`);
    wrapper((name: string) => {
      if (name === "@discordjs/ws") return wsModule.exports;
      if (localRequire.resolve(name) === managerFile) return load(managerFile);
      return localRequire(name);
    }, mod, mod.exports, file, dirname(file));
    return mod.exports;
  }
  const Client = load(clientFile);
  const client = new Client({ intents: [], shards: [0], shardCount: 1, sweepers: { ...require("discord.js").Options.DefaultSweeperSettings } });
  let release!: (value: unknown) => void;
  const gateway = new Promise(resolve => { release = resolve; });
  let releaseSpawn!: (value: unknown) => void;
  const spawning = new Promise(resolve => { releaseSpawn = resolve; });
  const get = vi.spyOn(client.rest, "get").mockReturnValueOnce(gateway).mockReturnValue(spawning);
  const shardErrors = vi.fn();
  client.on("shardError", shardErrors);
  const report = vi.fn();
  let releaseDestroy!: () => void;
  const destroying = new Promise<void>(resolve => { releaseDestroy = resolve; });
  const originalDestroy = client.destroy.bind(client);
  const destroy = vi.fn(async () => {
    if (blockDestroy) await destroying;
    await originalDestroy();
  });
  client.destroy = destroy;
  if (protect) protectDiscordClientRetirement(client, report);
  const login = client.login("inert-test-token");
  void login.catch(() => {});
  const gatewayData = (resetAfter: number) => ({ url: "wss://inert.invalid", shards: 1,
    session_start_limit: { total: 100, remaining: 100, reset_after: resetAfter, max_concurrency: 1 } });
  const releaseGateway = () => release(gatewayData(expireGateway ? -1 : 60000));
  const releaseSpawning = () => releaseSpawn(gatewayData(60000));
  return { client, sockets, get, login, releaseGateway, releaseSpawning, report, shardErrors, destroy, releaseDestroy, get recoverySleeps() { return recoverySleeps; } };
}
afterEach(() => vi.useRealTimers());

it("fences pending gateway startup after retirement, including a repeated retirement", async () => {
  vi.useFakeTimers();
  const f = fixture();
  expect(f.get).toHaveBeenCalledTimes(1);
  await retireDiscordClient(f.client, f.report);
  f.releaseGateway();
  await vi.advanceTimersByTimeAsync(0);
  await f.login;
  await retireDiscordClient(f.client, f.report);
  await vi.advanceTimersByTimeAsync(60_500);
  expect(f.sockets).toHaveLength(0);
  expect(f.client.ws._ws.strategy.shards.size).toBe(0);
  expect(f.recoverySleeps).toBe(0);
  expect(f.report).not.toHaveBeenCalled();
});

it("still connects a current client and contains its later retirement errors", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.releaseGateway();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(1);
  const socket = f.sockets[0];
  expect(socket.listenerCount("error")).toBe(1);
  expect(() => socket.emit("error", new Error("current transport error"))).not.toThrow();
  expect(f.shardErrors).toHaveBeenCalledTimes(1);
  await retireDiscordClient(f.client, f.report);
  expect(socket.terminate).toHaveBeenCalledTimes(1);
  expect(socket.readyState).toBe(3);
  await vi.advanceTimersByTimeAsync(60_500);
  expect(f.sockets).toHaveLength(1);
});

it("fences connect when strategy.spawn was already awaiting another gateway response", async () => {
  vi.useFakeTimers();
  const f = fixture({ expireGateway: true });
  f.releaseGateway();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.sockets).toHaveLength(0);
  await retireDiscordClient(f.client, f.report);
  f.releaseSpawning();
  await vi.advanceTimersByTimeAsync(0);
  // Assert before awaiting login: without the connect fence, login waits for
  // READY and the contract should fail on the new socket, not a test timeout.
  expect(f.client.ws._ws.strategy.shards.size).toBe(1);
  expect(f.sockets).toHaveLength(0);
  await f.login;
  await vi.advanceTimersByTimeAsync(60_500);
  expect(f.sockets).toHaveLength(0);
  expect(f.recoverySleeps).toBe(0);
});

it("proves raw Client.destroy leaves a late socket that can emit an uncaught handshake error", async () => {
  vi.useFakeTimers();
  const f = fixture({ protect: false });
  await f.client.destroy();
  f.releaseGateway();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(1);
  const socket = f.sockets[0];
  expect(socket.listenerCount("error")).toBe(1);
  expect(() => socket.emit("error", new Error("initial transport error"))).not.toThrow();
  expect(f.shardErrors).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.recoverySleeps).toBe(1);
  expect(socket.listenerCount("error")).toBe(0);
  expect(socket.readyState).toBe(0);
  expect(() => socket.emit("error", new Error("Opening handshake has timed out"))).toThrow("Opening handshake has timed out");
});

it("fences gateway startup while the original destroy is still pending", async () => {
  vi.useFakeTimers();
  const f = fixture({ blockDestroy: true });
  expect(f.get).toHaveBeenCalledTimes(1);
  const retiring = retireDiscordClient(f.client, f.report);
  expect(f.destroy).toHaveBeenCalledTimes(1);
  // The original destroy is blocked before it can touch the manager. Release
  // the gateway and execute login's continuations inside that retirement await.
  f.releaseGateway();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(0);
  expect(f.client.ws._ws.strategy.shards.size).toBe(0);
  expect(f.shardErrors).not.toHaveBeenCalled();
  f.releaseDestroy();
  await retiring;
  await f.login;
  await vi.advanceTimersByTimeAsync(60_500);
  expect(f.sockets).toHaveLength(0);
  expect(f.shardErrors).not.toHaveBeenCalled();
  expect(f.recoverySleeps).toBe(0);
});
