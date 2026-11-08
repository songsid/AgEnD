import { expect, it } from "vitest";
import { RoomReadPacer, ROOM_READ_BURST, ROOM_READ_INFLIGHT, ROOM_READ_SESSIONS } from "../src/hub/room-read-pacer.js";
const step = 10_000 / ROOM_READ_BURST;
function clock() { let now = 0; return { advance: (ms: number) => { now += ms; }, set: (value: number) => { now = value; }, pacer: new RoomReadPacer(step, () => now) }; }
it("allows a reload burst then only replenished reads, without extending the clock on refusals", () => {
  const c = clock();
  for (let i = 0; i < ROOM_READ_BURST; i++) c.pacer.enter("session")();
  expect(() => c.pacer.enter("session")).toThrow("backpressure");
  c.advance(step - 1); expect(() => c.pacer.enter("session")).toThrow("backpressure");
  c.advance(1); c.pacer.enter("session")();
  expect(() => c.pacer.enter("session")).toThrow("backpressure");
  c.advance(10_000); for (let i = 0; i < ROOM_READ_BURST; i++) c.pacer.enter("session")();
  expect(() => c.pacer.enter("session")).toThrow("backpressure");
});
it("two ordinary tabs keep polling and reopening without exhausting the session", () => {
  const c = clock();
  for (let i = 0; i < 30; i++) { c.pacer.enter("session")(); c.pacer.enter("session")(); c.advance(5000); }
});
it("retains physical slots through a held read even after tokens refill, and releases exactly once", () => {
  const c = clock(), held = Array.from({ length: ROOM_READ_INFLIGHT }, () => c.pacer.enter("session"));
  c.advance(80_000);
  expect(() => c.pacer.enter("session")).toThrow("backpressure");
  held[0]!(); held[0]!();
  const replacement = c.pacer.enter("session");
  expect(() => c.pacer.enter("session")).toThrow("backpressure");
  replacement(); held[1]!();
  c.pacer.enter("session")();
});
it("session allowances are independent, while a backward clock never grants more tokens", () => {
  const c = clock();for (let i = 0; i < ROOM_READ_BURST; i++) c.pacer.enter("a")();
  c.pacer.enter("b")(); c.set(-100_000);
  expect(() => c.pacer.enter("a")).toThrow("backpressure");
});
it("bounds retained sessions and never evicts a spent or active allowance", () => {
  const c = clock(), held = c.pacer.enter("active");
  for (let i = 1; i < ROOM_READ_SESSIONS; i++) c.pacer.enter(String(i))();
  expect(() => c.pacer.enter("new")).toThrow("backpressure");
  c.advance(step); c.pacer.enter("new")();
  // Fully replenished idle buckets were pruned; the physically held bucket still owns its slot.
  const second = c.pacer.enter("active");
  expect(() => c.pacer.enter("active")).toThrow("backpressure");
  held(); second();
});
it("an old completion cannot release a replacement bucket after server teardown", () => {
  const c = clock(), old = c.pacer.enter("same");c.pacer.clear();
  const a = c.pacer.enter("same"), b = c.pacer.enter("same");old();
  expect(() => c.pacer.enter("same")).toThrow("backpressure");a();b();
});
