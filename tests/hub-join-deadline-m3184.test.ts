import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const control = vi.hoisted(() => ({ end: null as null | ((req: any, response: (res: any) => void) => void), requests: [] as any[] }));
vi.mock("node:https", async original => ({ ...await original<typeof import("node:https")>(), request: (_url: string, _opts: unknown, response: (res: any) => void) => {
  const req: any = new EventEmitter(); req.setTimeout = vi.fn();
  req.destroy = vi.fn(() => { req.emit("error", Error("closed")); });
  req.end = () => control.end?.(req, response);
  control.requests.push(req); return req;
} }));
import { CompanyJoinClient } from "../src/hub/join/client.js";
import { HUB_LIMITS } from "../src/hub/protocol.js";
const query = (current = () => true) => (new CompanyJoinClient() as any).json("https://hub.example.test", "/probe", undefined, current) as Promise<unknown>;
beforeEach(() => { vi.useFakeTimers(); control.end = null; control.requests = []; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it("bounds DNS/connect time before any socket inactivity timeout can start", async () => {
  let outcome = "pending"; const pending = query().then(() => { outcome = "ok"; }, error => { outcome = error.code; });
  await vi.advanceTimersByTimeAsync(HUB_LIMITS.rpcTimeout - 1); expect(outcome).toBe("pending");
  await vi.advanceTimersByTimeAsync(1); expect(outcome).toBe("unavailable"); expect(control.requests[0].destroy).toHaveBeenCalled(); await pending;
});
it("bounds a response that keeps trickling bytes, and destroys both response and request", async () => {
  const res: any = new EventEmitter(); res.statusCode = 200; res.headers = { "content-type": "application/json" }; res.destroy = vi.fn();
  control.end = (_req, response) => response(res);
  let outcome = "pending"; const pending = query().then(() => { outcome = "ok"; }, error => { outcome = error.code; });
  for (let n = 0; n < 5; n++) { res.emit("data", Buffer.from(" ")); await vi.advanceTimersByTimeAsync(1000); }
  expect(outcome).toBe("unavailable"); expect(res.destroy).toHaveBeenCalled(); expect(control.requests[0].destroy).toHaveBeenCalled(); await pending;
});
it("retires an owner's streaming response before accepting another byte", async () => {
  const res: any = new EventEmitter(); res.statusCode = 200; res.headers = { "content-type": "application/json" }; res.destroy = vi.fn();
  control.end = (_req, response) => response(res);
  let current = true, outcome = "pending"; const pending = query(() => current).then(() => { outcome = "ok"; }, error => { outcome = error.code; });
  current = false; res.emit("data", Buffer.from("{}")); await vi.advanceTimersByTimeAsync(0);
  expect(outcome).toBe("stale"); expect(res.destroy).toHaveBeenCalled(); await pending;
});
it("finishes successful JSON and clears its absolute deadline", async () => {
  const res: any = new EventEmitter(); res.statusCode = 200; res.headers = { "content-type": "application/json" }; res.destroy = vi.fn();
  control.end = (_req, response) => { response(res); res.emit("data", Buffer.from('{"ok":true}')); res.emit("end"); };
  expect(await query()).toEqual({ ok: true }); await vi.advanceTimersByTimeAsync(HUB_LIMITS.rpcTimeout);
  expect(control.requests[0].destroy).not.toHaveBeenCalled(); expect(res.destroy).not.toHaveBeenCalled();
});
