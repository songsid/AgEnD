import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { HubSocket } from "../src/hub/socket.js";
import { HUB_LIMITS } from "../src/hub/protocol.js";

class Peer extends EventEmitter {
  readyState: number = WebSocket.OPEN; bufferedAmount = 0;
  callbacks: Array<(error?: Error) => void> = [];
  send(_text: string, done: (error?: Error) => void) { this.callbacks.push(done); }
  ping(_a: unknown, _b: unknown, done: (error?: Error) => void) { this.emit("pong"); done(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close", 1008, Buffer.from("replaced")); }
  terminate() { this.readyState = WebSocket.CLOSED; }
}
let link: HubSocket<string, string>;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { link?.end(); vi.clearAllTimers(); vi.useRealTimers(); });
function world() {
  const peer = new Peer(), closed = vi.fn();
  link = new HubSocket(peer as unknown as WebSocket, { current: () => true, parse: b => b.toString(), encode: s => s, receive: async () => {}, closed });
  return { peer, closed };
}
it("bounds a stalled write even when the peer still answers heartbeats, and ignores its late callback", async () => {
  const { peer, closed } = world(); let result = "pending";
  const pending = link.send("metadata").then(() => { result = "sent"; }, error => { result = error.code; });
  await vi.advanceTimersByTimeAsync(HUB_LIMITS.rpcTimeout - 1); expect(result).toBe("pending");
  peer.emit("pong"); await vi.advanceTimersByTimeAsync(1);
  expect(result).toBe("uncertain"); expect(closed).toHaveBeenCalledOnce(); expect(link.current()).toBe(false);
  peer.callbacks[0]!(); await pending; expect(result).toBe("uncertain"); expect(closed).toHaveBeenCalledOnce();
});
it.each(["end", "retire"] as const)("%s settles an admitted write without waiting for its callback", async how => {
  const { peer } = world(); let result = "pending";
  const pending = link.send("answer").then(() => { result = "sent"; }, error => { result = error.code; });
  if (how === "end") link.end(); else link.retire("replaced");
  await Promise.resolve(); await Promise.resolve();
  expect(result).toBe("uncertain"); peer.callbacks[0]!(); await pending; expect(result).toBe("uncertain");
});
it("a completed callback releases its timer and does not close the healthy link", async () => {
  const { peer, closed } = world(); const pending = link.send("metadata"); peer.callbacks[0]!(); await pending; peer.callbacks[0]!(Error("late duplicate"));
  await vi.advanceTimersByTimeAsync(HUB_LIMITS.rpcTimeout); expect(closed).not.toHaveBeenCalled(); expect(link.current()).toBe(true);
});

it("bounds outstanding write ownership before admitting another frame", async () => {
  const { peer } = world();
  const pending = Array.from({ length: HUB_LIMITS.pending }, () => link.send("metadata").catch(error => error.code));
  await expect(link.send("overflow")).rejects.toMatchObject({ code: "backpressure" });
  expect(peer.callbacks).toHaveLength(HUB_LIMITS.pending); link.end();
  expect(await Promise.all(pending)).toEqual(Array(HUB_LIMITS.pending).fill("uncertain"));
});
