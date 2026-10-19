import type { Client } from "discord.js";

interface GatewaySocket {
  readyState: number;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  terminate(): void;
}

const retirements = new WeakMap<Client, Promise<void>>();
const destroyers = new WeakMap<Client, () => unknown>();

/** Client.login() also calls this.destroy() internally when gateway startup fails. */
export function protectDiscordClientRetirement(client: Client, report: (error: Error) => void): void {
  if (destroyers.has(client)) return;
  destroyers.set(client, client.destroy.bind(client));
  client.destroy = () => retireDiscordClient(client, report);
}

/** Contain a retired gateway's errors until its underlying socket actually closes. */
export function retireDiscordClient(client: Client, report: (error: Error) => void): Promise<void> {
  const pending = retirements.get(client);
  if (pending) return pending;
  // discord.js 14 / @discordjs/ws 1.2.3 destroy() clears connection.onerror,
  // but leaves CONNECTING sockets and their ws handshake timers running. Their
  // later timeout then emits an unhandled EventEmitter error in the fleet.
  // These are deliberately scoped private internals of the default in-process
  // strategy; a Client without a gateway (including before login) has no sockets.
  const strategy = (client.ws as unknown as {
    _ws?: { strategy?: {
      shards?: Map<number, { connection?: GatewaySocket; internalConnect?: () => Promise<void> }>;
      spawn?: (...args: unknown[]) => Promise<void>;
      connect?: () => Promise<void>;
    } };
  })?._ws?.strategy;
  // A pending GET gateway/bot can resume Client.login after destroy has finished.
  // Fence the strategy permanently before our first await: spawning/connecting
  // after retirement would create sockets outside the snapshot below. A spawn
  // already awaiting gateway info may still finish, but cannot connect them.
  if (strategy) {
    strategy.spawn = async () => {};
    strategy.connect = async () => {};
  }
  const shards = strategy?.shards;
  for (const shard of shards?.values() ?? []) {
    // A HELLO timeout can already have scheduled native recovery in 1.2.3's
    // 500ms backoff. A retired shard must never open another socket after the
    // manager has forgotten it. This instance is never reused.
    if (typeof shard.internalConnect === "function") shard.internalConnect = async () => {};
  }
  const sockets = [...(shards?.values() ?? [])].flatMap(shard => shard.connection ? [shard.connection] : []);
  for (const socket of sockets) {
    socket.on("error", report);
    socket.once("close", () => socket.removeListener("error", report));
  }
  const retirement = (async () => {
    try {
      await (destroyers.get(client) ?? client.destroy.bind(client))();
    } finally {
      // Destroy first: it disconnects shard callbacks, so terminating a pending
      // handshake cannot start the retired shard's native reconnect loop.
      for (const socket of sockets) if (socket.readyState === 0) socket.terminate();
    }
  })();
  retirements.set(client, retirement);
  return retirement;
}
