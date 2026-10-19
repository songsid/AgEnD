import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelConfig, FleetConfig } from "../src/types.js";
const provider = vi.hoisted(() => ({ failures: new Map<string, number>(), calls: new Map<string, number>(), made: [] as any[], held: null as null | Promise<void> }));
vi.mock("../src/channel/factory.js", () => ({ createAdapter: vi.fn(async (cfg: ChannelConfig) => {
  const id = cfg.id ?? cfg.type;
  const adapter = Object.assign(new EventEmitter(), { id, type: cfg.type, setChatId: vi.fn(), stop: vi.fn(async () => {}),
    start: vi.fn(async () => {
      const calls = (provider.calls.get(id) ?? 0) + 1; provider.calls.set(id, calls);
      if (provider.held) await provider.held;
      if (calls <= (provider.failures.get(id) ?? 0)) throw new Error("connect ETIMEDOUT (fake adapter)");
      adapter.emit("started", `demo_${id}`, `bot_${id}`);
    }),
  });
  provider.made.push(adapter); return adapter;
}) }));
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { evaluateWebRequest } from "../src/web-auth.js";

const roots: string[] = [], stores: Array<{ close(): void }> = [];
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  provider.failures.clear(); provider.calls.clear(); provider.made.length = 0; provider.held = null;
});
const channel = (id: string): ChannelConfig => ({ id, type: "discord", mode: "topic", bot_token_env: "AGEND_TEST_RECOVERY_TOKEN", access: { mode: "locked", allowed_users: [], max_pending_codes: 5, code_expiry_minutes: 10 } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-network-2191-")); roots.push(root);
  vi.stubEnv("AGEND_HOME", root); vi.stubEnv("AGEND_TEST_RECOVERY_TOKEN", "fake-no-network");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network access"); }));
  const fm = new FleetManager(root) as any;
  fm.fleetConfig = { channels: [channel("discord"), channel("persona")], defaults: {}, instances: {
    source: { working_directory: root, backend: "codex", tool_set: "worker" },
    target: { working_directory: root, backend: "codex", tool_set: "worker" },
    outsider: { working_directory: root, backend: "codex", tool_set: "worker" },
  } } as unknown as FleetConfig;
  // Private fake adapter; these unrelated hooks must never spawn CLIs, poll a provider or schedule topic cleanup.
  for (const name of ["probeCliEnvs", "startTopicCleanupPoller", "notifyAdapterFailure", "notifyAdapterRecovery", "touchActivity", "setTopicIcon", "publishTraffic", "scheduleDeliveryOutboxPump", "queueMirrorMessage", "emitSseEvent"]) vi.spyOn(fm, name).mockImplementation(() => {});
  vi.spyOn(fm, "sendCancelButton").mockResolvedValue(undefined);
  return { fm, root };
}

describe("adapter startup recovers beyond the old ten-retry limit", () => {
  it("restores primary wiring after twelve failures while the other bot remains live", async () => {
    const { fm } = fixture(); vi.useFakeTimers(); provider.failures.set("discord", 12);
    await fm.startSharedAdapter(fm.fleetConfig);
    expect(provider.calls.get("persona")).toBe(1);
    expect(fm.adapter).toBeNull();
    for (let retry = 0; retry < 12; retry++) {
      const delay = Math.min(5000 * 2 ** retry, 300000);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(provider.calls.get("discord")).toBe(retry + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(provider.calls.get("discord")).toBe(retry + 2);
    }
    expect(fm.adapter).toBe(fm.adapters.get("discord"));
    expect(fm.worlds.get("discord").botUsername).toBe("demo_discord");
    expect(fm.adapter.listenerCount("message")).toBe(1);
    expect(fm.adapterState.get("discord")).toMatchObject({ status: "connected", retryCount: 12 });
    expect(provider.calls.get("persona")).toBe(1);
    await vi.advanceTimersByTimeAsync(600000);
    expect(provider.calls.get("discord")).toBe(13);
  });

  it("coalesces Retry now with an in-flight login and replaces the pending backoff", async () => {
    const { fm } = fixture(); vi.useFakeTimers(); provider.failures.set("discord", 1);
    await fm.startSharedAdapter(fm.fleetConfig);
    let release!: () => void; provider.held = new Promise<void>(r => { release = r; });
    expect(fm.retryAdapterNow("discord")).toEqual({ queued: true });
    expect(fm.retryAdapterNow("discord")).toEqual({ queued: true, already_running: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(provider.calls.get("discord")).toBe(2);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(fm.adapterState.get("discord").status).toBe("connected");
    expect(fm.retryAdapterNow("discord")).toEqual({ queued: false });
    await vi.advanceTimersByTimeAsync(300000);
    expect(provider.calls.get("discord")).toBe(2);
    expect(() => fm.retryAdapterNow("missing")).toThrow("Connection not found");
  });

  it("does not resurrect a removed connection or schedule work after shutdown", async () => {
    const { fm } = fixture(); vi.useFakeTimers(); provider.failures.set("discord", 99);
    await fm.startSharedAdapter(fm.fleetConfig);
    fm.fleetConfig.channels.shift();
    await vi.advanceTimersByTimeAsync(300000);
    expect(provider.calls.get("discord")).toBe(1);
    fm.shuttingDown = true;
    expect(() => fm.retryAdapterNow("persona")).toThrow("stopping");
    await vi.advanceTimersByTimeAsync(300000);
    expect(provider.calls.get("persona")).toBe(1);
  });

  it("uses Telegram polling readiness even when the startup record still says connected", async () => {
    const { fm } = fixture(); vi.useFakeTimers();
    fm.fleetConfig.channels = [{ ...channel("telegram"), type: "telegram" }];
    let ready = true;
    const adapter = Object.assign(new EventEmitter(), { type: "telegram",
      connectionEvidence: () => ({ ready, authRejected: false }),
      stop: vi.fn(async () => { ready = false; }), start: vi.fn(async () => { ready = true; }),
    });
    fm.adapter = adapter; fm.adapters.set("telegram", adapter);
    fm.worlds.set("telegram", { adapter, botUserId: "demo-telegram", botUsername: "demo_telegram" });
    fm.adapterState.set("telegram", { status: "connected", retryCount: 0 });
    expect(fm.listSecureConnections()[0].status).toBe("connected");
    expect(fm.retryAdapterNow("telegram")).toEqual({ queued: false });
    expect(adapter.stop).not.toHaveBeenCalled();
    ready = false; // Polling failed after start() resolved, without a fatal error event.
    expect(fm.adapterState.get("telegram").status).toBe("connected");
    expect(fm.listSecureConnections()[0].status).toBe("retrying");
    expect(fm.retryAdapterNow("telegram")).toEqual({ queued: true });
    expect(fm.retryAdapterNow("telegram")).toEqual({ queued: true, already_running: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(adapter.stop).toHaveBeenCalledOnce(); expect(adapter.start).toHaveBeenCalledOnce();
    expect(fm.listSecureConnections()[0].status).toBe("connected");
    expect(fm.retryAdapterNow("telegram")).toEqual({ queued: false });
    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it.each(["removed", "changed", "stopping"])("retires an in-flight login whose configuration is %s", async change => {
    const { fm } = fixture(); vi.useFakeTimers(); provider.failures.set("discord", 1);
    await fm.startSharedAdapter(fm.fleetConfig);
    let release!: () => void; provider.held = new Promise<void>(r => { release = r; });
    fm.retryAdapterNow("discord"); await vi.advanceTimersByTimeAsync(0);
    const old = fm.adapters.get("discord"); expect(old).toBeDefined();
    if (change === "removed") fm.fleetConfig.channels.shift();
    if (change === "changed") fm.fleetConfig.channels[0].group_id = "replacement-group";
    if (change === "stopping") fm.shuttingDown = true;
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(old.stop).toHaveBeenCalledOnce();
    expect(fm.adapters.has("discord")).toBe(false);
    expect(fm.worlds.has("discord")).toBe(false);
    if (change !== "changed") {
      await vi.advanceTimersByTimeAsync(600000);
      expect(provider.calls.get("discord")).toBe(2);
    }
  });
});

describe("internal fleet tools need no channel reply context", () => {
  it.each([false, true])("durably sends, describes and queries ownership with missing context world (other adapter=%s)", async other => {
    const { fm, root } = fixture();
    if (other) fm.worlds.set("telegram", { adapter: {} });
    fm.daemons.set("source", { bootId: "source-boot" });
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    const outbox = new DeliveryOutbox(join(root, "outbox.db"), "manager"); stores.push(outbox); fm.deliveryOutbox = outbox;
    const responses: any[] = [];
    fm.instanceIpcClients.set("source", { send: (r: any) => { responses.push(r); return true; } });
    const call = async (tool: string, args: object) => {
      await fm.handleOutboundFromInstance("source", { tool, args, adapterId: "discord", operationId: `op-${responses.length}`, sourceDaemonBootId: "source-boot", fleetRequestId: `r-${responses.length}` });
      return responses.at(-1);
    };
    const sent = await call("send_to_instance", { instance_name: "target", message: "local work" });
    expect(sent.error).toBeUndefined(); expect(sent.result).toMatchObject({ sent: true, queued: true, durable: true });
    const id = sent.result.delivery_id;
    expect((await call("delivery_status", { delivery_id: id })).result.items).toMatchObject([{ delivery_id: id, target_instance: "target" }]);
    expect((await call("describe_instance", { name: "target" })).result).toMatchObject({ name: "target", type: "instance" });
    // Spoofing a sender label does not change the authenticated socket's delivery visibility.
    const spy = vi.fn(() => true); fm.instanceIpcClients.set("outsider", { send: spy });
    await fm.handleOutboundFromInstance("outsider", { tool: "delivery_status", args: { delivery_id: id }, adapterId: "discord", senderSessionName: "source", fleetRequestId: "hidden" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ error: "Delivery not found" }));
    expect((await call("reply", { text: "channel response" })).error).toMatch(/not ready|world unavailable/);
    const db = new SchedulerDb(join(root, "scheduler.db")); stores.push(db); fm.scheduler = { db };
    db.createTask({ title: "local task", created_by: "source" });
    fm.dispatchTypedIpc("source", { type: "fleet_task", payload: { action: "list" }, fleetRequestId: "tasks" });
    expect(responses.at(-1)).toMatchObject({ type: "fleet_task_response", result: [{ title: "local task" }] });
  });

  it("still enforces the worker capability boundary without an adapter", async () => {
    const { fm } = fixture(); const send = vi.fn(() => true); fm.instanceIpcClients.set("source", { send });
    await fm.handleOutboundFromInstance("source", { tool: "create_instance", args: {}, fleetRequestId: "denied" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/not allowed|not available|cannot|coordinator|refused/i) }));
  });
});

describe("operator retry route", () => {
  it("admits only an admin token and returns an accepted retry without waiting on a provider", () => {
    const { fm } = fixture(); vi.spyOn(fm, "webToken", "get").mockReturnValue("x".repeat(48));
    const retry = vi.spyOn(fm, "retryAdapterNow").mockReturnValue({ queued: true });
    const sessions = new WebSessionStore(); fm.webSessions = sessions;
    const guest = sessions.create({ tier: "guest", surface: "local", label: "guest", tokenEpoch: tokenEpoch(fm.webToken), owner: { adapterId: "discord", userId: "demo" } }).sessionId;
    const publicAdmin = sessions.create({ tier: "admin", surface: "gateway", exposureId: "demo", label: "public admin", tokenEpoch: tokenEpoch(fm.webToken) }).sessionId;
    const call = (token?: string, cookie?: string, gateway = false) => {
      const req = Object.assign(new EventEmitter(), { method: "POST", url: "/api/settings/connections/discord/retry", headers: { origin: gateway ? "https://demo.example" : "http://localhost", host: gateway ? "demo.example" : "localhost", ...(token ? { "x-agend-token": token } : {}), ...(cookie ? { "x-agend-csrf": csrfTokenFor(cookie), cookie: `${gateway ? "__Host-agend_session" : "agend_session"}=${cookie}` } : {}) } });
      if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "demo", expectedOrigin: "https://demo.example", isCurrent: () => true });
      if (cookie === publicAdmin) expect(evaluateWebRequest(req, new URL(req.url, "https://demo.example"), fm.webToken, sessions)).toMatchObject({ kind: "allow", session: { tier: "admin" } });
      let answer: any; const res = { writeHead: vi.fn(), end: (s: string) => { answer = JSON.parse(s); }, setHeader() {} };
      expect(handleSettingsRequest(req as any, res as any, new URL(req.url, "http://localhost"), fm)).toBe(true);
      return { answer, res };
    };
    expect(call().res.writeHead).toHaveBeenCalledWith(403, expect.anything()); expect(retry).not.toHaveBeenCalled();
    expect(call(undefined, guest).res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(call(fm.webToken, undefined, true).res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(call(undefined, publicAdmin, true).res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(retry).not.toHaveBeenCalled();
    expect(call(fm.webToken).answer).toEqual({ queued: true }); expect(retry).toHaveBeenCalledOnce();
  });
});
