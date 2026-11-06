/** Inert local IPC events: no fork, native process, CLI, socket, account or file reads. */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeUpdateIpc, parseRuntimeUpdateIpc, type RuntimeUpdateIpcMessage } from "../src/runtime-update-ipc.js";
const id = randomUUID();
const init: RuntimeUpdateIpcMessage = { v: 1, id, type: "init", role: "helper", ownerId: randomUUID(), profile: resolve("fixture-profile") };
const armed: RuntimeUpdateIpcMessage = { v: 1, id, type: "armed" };
class Peer extends EventEmitter {
  connected = true;
  sent: RuntimeUpdateIpcMessage[] = [];
  transmit: (value: RuntimeUpdateIpcMessage, callback: (error: Error | null) => void) => unknown = (_, callback) => { callback(null); return true; };
  send(value: RuntimeUpdateIpcMessage, callback: (error: Error | null) => void): unknown { this.sent.push(value); return this.transmit(value, callback); }
}
const channels: RuntimeUpdateIpc[] = [];
function fixture(expected: string | null = id) { const peer = new Peer(), channel = new RuntimeUpdateIpc(peer, expected ?? undefined); channels.push(channel); return { peer, channel }; }
afterEach(() => { for (const channel of channels.splice(0)) channel.close(); vi.useRealTimers(); });
it("accepts the closed versioned messages without sharing references", () => {
  const messages: RuntimeUpdateIpcMessage[] = [init, armed, { v: 1, id, type: "failure", reason: "uncertain" }];
  for (const message of messages) { const parsed = parseRuntimeUpdateIpc(message); expect(parsed).toEqual(message); expect(parsed).not.toBe(message); }
});
it("refuses extra authority, commands, URLs, unbound identities and invalid initialization", () => {
  for (const value of [{ ...init, credential: "secret" }, { ...init, server: "https://outside.example.test" }, { ...init, command: "anything" },
    { ...init, profile: "relative" }, { ...init, profile: "bad\nprofile" }, { ...init, role: "trial" }, { ...init, ownerId: "not-an-id" },
    { ...armed, generation: 1 }, { ...armed, bootId: "unknown" }, { ...armed, v: 2 }, { ...armed, id: "unknown" },
    { v: 1, id, type: "failure", reason: "raw exception or path" }, { v: 1, id, type: "armed", padding: "x".repeat(16 * 1024) }]) expect(() => parseRuntimeUpdateIpc(value)).toThrow();
});
it("requires an inherited connected channel, and an unbound child accepts init first only", async () => {
  const peer = new Peer(); peer.connected = false; expect(() => new RuntimeUpdateIpc(peer, id)).toThrow(/Inherited/);
  const good = fixture(null), wait = good.channel.next(["init"]); good.peer.emit("message", init); await expect(wait).resolves.toEqual(init);
  const bad = fixture(null), refused = expect(bad.channel.next(["init"])).rejects.toThrow(/refused/);
  bad.peer.emit("message", armed); await refused;
});
it("owns its response wait before a synchronous send callback can deliver handoff initialization", async () => {
  const f = fixture(); f.peer.transmit = (_, callback) => { f.peer.emit("message", armed); callback(null); };
  await expect(f.channel.exchange(init, ["armed"])).resolves.toEqual(armed); expect(f.peer.sent).toEqual([init]);
});
it("a different attempt permanently refuses the channel and sends nothing further", async () => {
  const f = fixture(), wait = expect(f.channel.next(["armed"])).rejects.toThrow(/refused/);
  f.peer.emit("message", { ...init, type: "armed", id: randomUUID() }); await wait;
  await expect(f.channel.send(init)).rejects.toThrow(); expect(f.peer.sent).toEqual([]);
});
it("an unexpected phase fails closed rather than consuming it as an acknowledgement", async () => {
  const f = fixture(), wait = expect(f.channel.next(["armed"])).rejects.toThrow(/phase/);
  f.peer.emit("message", { v: 1, id, type: "failure", reason: "uncertain" }); await wait;
  await expect(f.channel.next(["failure"])).rejects.toThrow(/phase/);
});
it("keeps a backpressured send pending until its physical callback, independently of a response", async () => {
  const f = fixture(); let flushed!: (error: Error | null) => void, finished = false;
  f.peer.transmit = (_, callback) => { flushed = callback; return false; };
  const work = f.channel.exchange(init, ["armed"]).then(value => { finished = true; return value; });
  f.peer.emit("message", armed); await Promise.resolve(); await Promise.resolve(); expect(finished).toBe(false);
  flushed(null); await expect(work).resolves.toEqual(armed);
});
it("disconnect is uncertainty, clears its owned timer and refuses later commands", async () => {
  vi.useFakeTimers(); const f = fixture(), wait = expect(f.channel.next(["armed"])).rejects.toThrow(/disconnected/);
  expect(vi.getTimerCount()).toBe(1); f.peer.connected = false; f.peer.emit("disconnect"); await wait;
  expect(vi.getTimerCount()).toBe(0); await expect(f.channel.send(init)).rejects.toThrow(); expect(f.peer.sent).toEqual([]);
});
it("a deadline closes the attempt without retrying a send or granting handoff initialization", async () => {
  vi.useFakeTimers(); const f = fixture(), wait = expect(f.channel.exchange(init, ["armed"], 10)).rejects.toThrow(/unconfirmed/);
  await vi.advanceTimersByTimeAsync(10); await wait;
  f.peer.emit("message", armed); await expect(f.channel.next(["armed"])).rejects.toThrow(/unconfirmed/);
  expect(f.peer.sent).toEqual([init]); expect(vi.getTimerCount()).toBe(0);
});
it("does not send when an exchange cannot reserve its response wait", async () => {
  const f = fixture(), original = f.channel.next(["init"]), refused = expect(original).rejects.toThrow(/closed/);
  await expect(f.channel.exchange(init, ["armed"])).rejects.toThrow(/refused/);
  expect(f.peer.sent).toEqual([]); f.channel.close(); await refused;
  const second = fixture(); await expect(second.channel.exchange(init, [], 0)).rejects.toThrow(/refused/); expect(second.peer.sent).toEqual([]);
});
it("bounds queued messages and closes without leaving listeners or pending timers", async () => {
  const f = fixture();
  for (let i = 0; i < 17; i++) f.peer.emit("message", { v: 1, id, type: "armed" });
  await expect(f.channel.next(["armed"])).rejects.toThrow(/refused/);
  f.channel.close(); expect(["message", "disconnect", "error"].map(event => f.peer.listenerCount(event))).toEqual([0, 0, 0]);
});
it("a synchronous transport error rejects the pre-owned exchange and its pending wait", async () => {
  vi.useFakeTimers(); const f = fixture(); f.peer.transmit = () => { throw Error("raw private error"); };
  await expect(f.channel.exchange(init, ["armed"])).rejects.toThrow(/unavailable/);
  expect(vi.getTimerCount()).toBe(0); await expect(f.channel.next(["init"])).rejects.toThrow(/unavailable/);
});
