/** Shutdown is receive-only first: leave Telegram's offset queue intact for the next fleet. */
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramAdapter, telegramLastUpdateIdPath } from "../src/channel/adapters/telegram.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { ChannelAdapter, InboundMessage } from "../src/channel/types.js";
const roots: string[] = [], cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch() { mkdirSync(".artifacts", { recursive: true }); const root = mkdtempSync(join(process.cwd(), ".artifacts/tg2411-")); roots.push(root); return root; }
const GROUP = -10012345, USER = 111, BOT = 12345;
function update(id: number, text: string) { return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: GROUP, type: "supergroup" }, from: { id: USER, is_bot: false, first_name: "fixture" }, text } }; }
async function rig() {
  const root = scratch(), inbox = join(root, "inbox"); mkdirSync(inbox);
  const pending: ReturnType<typeof update>[] = [], calls: Array<{ method: string; body: any }> = [];
  const reply = (res: ServerResponse, value: unknown) => { if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result: value })); } };
  const server = createServer(async (req, res) => {
    let bytes = ""; for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes || "{}"), method = req.url!.split("/").pop()!; calls.push({ method, body });
    if (method === "getMe") reply(res, { id: BOT, is_bot: true, first_name: "fixture", username: "fixture_bot" });
    else if (method === "getUpdates") {
      // Real Bot API semantics: a fetch alone does not delete updates; only a later higher offset confirms them.
      const offset = Number(body.offset ?? 0); while (pending[0] && pending[0].update_id < offset) pending.shift();
      const values = pending.slice(0, Number(body.limit ?? 100));
      if (values.length || !body.timeout) reply(res, values); else setTimeout(() => reply(res, []), 15);
    } else if (method === "sendMessage") reply(res, { message_id: 99, date: Math.floor(Date.now() / 1000), chat: { id: GROUP, type: "supergroup" }, text: body.text });
    else reply(res, true);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const make = () => {
    const access = new AccessManager({ mode: "locked", allowed_users: [USER], max_pending_codes: 5, code_expiry_minutes: 10 }, join(root, "access.json"));
    const a = new TelegramAdapter({ id: "fixture", botToken: "12345:FAKE_TOKEN", accessManager: access, inboxDir: inbox, apiRoot: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    a.on("handler_error", () => {}); cleanups.push(() => a.stop().catch(() => {})); return a;
  };
  return { root, inbox, calls, pending, make };
}

it("stops receiving before daemon shutdown while preserving outbound retirement work", async () => {
  const fm = new FleetManager(scratch()), events: string[] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = { stopReceiving: vi.fn(() => { events.push("receive-fenced"); return gate; }), stop: vi.fn(async () => { events.push("transport-closed"); }) } as unknown as ChannelAdapter;
  vi.spyOn(fm as any, "observeWorkingState").mockImplementation(() => {});
  const daemon = { stop: vi.fn(async () => { events.push("daemon-stopped"); }) };
  (fm as any).daemons.set("fixture", daemon); fm.adapters.set("fixture", adapter);
  (fm as any).worlds.set("fixture", { adapter, stop: () => adapter.stop() });
  const stopped = fm.stopAll();
  expect(events).toEqual(["receive-fenced"]); expect(daemon.stop).not.toHaveBeenCalled();
  await new Promise(resolve => setImmediate(resolve)); expect(daemon.stop).not.toHaveBeenCalled();
  release(); await stopped;
  expect(events).toEqual(["receive-fenced", "daemon-stopped", "transport-closed"]);
});

it("late updates after the receive fence advance neither local floor nor remote offset, and restart delivers them once", async () => {
  const r = await rig(), a = r.make(), seen: string[] = [];
  a.on("message", (m: InboundMessage) => seen.push(m.text)); await a.start();
  await vi.waitFor(() => expect(r.calls.some(c => c.method === "getUpdates")).toBe(true));
  r.pending.push(update(1, "accepted-before-stop")); await vi.waitFor(() => expect(seen).toEqual(["accepted-before-stop"]));
  await (a as any).stopReceiving();
  const before = r.calls.filter(c => c.method === "getUpdates").length;
  r.pending.push(update(2, "during-stop")); await a.getBot().handleUpdate(update(2, "during-stop") as never);
  // Even a final SDK ACK with a higher last-tried id must not reach Telegram after the receive fence.
  await expect(a.getBot().api.getUpdates({ offset: 3, timeout: 0 })).resolves.toEqual([]);
  expect(r.pending.map(u => u.update_id)).toContain(2);
  await expect(a.sendText(String(GROUP), "shutdown-notice")).resolves.toHaveProperty("messageId", "99");
  await a.stop(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(seen).toEqual(["accepted-before-stop"]);
  expect(JSON.parse(readFileSync(telegramLastUpdateIdPath(r.inbox, "fixture"), "utf8")).update_id).toBe(1);
  expect(r.calls.filter(c => c.method === "getUpdates")).toHaveLength(before);
  const b = r.make(), next: string[] = []; b.on("message", (m: InboundMessage) => next.push(m.text)); await b.start();
  await vi.waitFor(() => expect(next).toEqual(["during-stop"])); await new Promise(resolve => setTimeout(resolve, 50)); expect(next).toEqual(["during-stop"]);
});

it("a fetched batch released after shutdown is not persisted, dispatched or acknowledged", async () => {
  const r = await rig(), a = r.make(), seen: string[] = []; let release!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  a.getBot().api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    if (method === "getUpdates" && Array.isArray((response as any).result) && (response as any).result.length && !held) { held = true; await gate; }
    return response;
  });
  a.on("message", (m: InboundMessage) => seen.push(m.text)); await a.start(); r.pending.push(update(7, "held-during-stop"));
  await vi.waitFor(() => expect(held).toBe(true)); await (a as any).stopReceiving(); release();
  await new Promise(resolve => setTimeout(resolve, 50)); await a.stop();
  expect(seen).toEqual([]); expect(r.pending.map(u => u.update_id)).toEqual([7]);
  expect(r.calls.filter(c => c.method === "getUpdates").every(c => Number(c.body.offset ?? 0) <= 7)).toBe(true);
  const b = r.make(), next: string[] = []; b.on("message", (m: InboundMessage) => next.push(m.text)); await b.start();
  await vi.waitFor(() => expect(next).toEqual(["held-during-stop"]));
});

it("a polling reconnect delay cannot restart the old receiver after stop", async () => {
  const r = await rig(), a = r.make();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); vi.spyOn(console, "warn").mockImplementation(() => {});
  const start = vi.spyOn(a.getBot(), "start").mockRejectedValue(Error("inert network failure"));
  await a.start(); await Promise.resolve(); expect(start).toHaveBeenCalledTimes(1);
  await a.stopReceiving(); await vi.advanceTimersByTimeAsync(6_000); expect(start).toHaveBeenCalledTimes(1);
  await a.start(); await Promise.resolve(); expect(start).toHaveBeenCalledTimes(2);
  await a.stopReceiving(); await vi.advanceTimersByTimeAsync(6_000); expect(start).toHaveBeenCalledTimes(2);
  await a.stop();
});

it("a stopped receiver suppresses an SDK offset acknowledgement without deleting the pending queue", async () => {
  const r = await rig(), a = r.make(); await a.stopReceiving(); r.pending.push(update(17, "not-accepted"));
  await expect(a.getBot().api.getUpdates({ offset: 18, timeout: 0 })).resolves.toEqual([]);
  expect(r.pending.map(u => u.update_id)).toEqual([17]); expect(r.calls.filter(c => c.method === "getUpdates")).toEqual([]);
});
