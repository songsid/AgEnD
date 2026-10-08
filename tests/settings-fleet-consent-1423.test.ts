import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsExecution, settingsFileResource, settingsLeaseBusy } from "../src/settings-transaction.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { SecretStore } from "../src/secret-store.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { isPassiveWebRead, rotateWebToken } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";

const fixtures: any[] = [];
afterEach(async () => {
  for (const h of fixtures.splice(0)) {
    h.store?.close(); for (const entry of h.fm.pendingNonceButtons.values()) clearTimeout(entry.timer);
    await Promise.allSettled([...h.fm.settingsJobSettlements.values()]); rmSync(h.dir, { recursive: true, force: true });
  } vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
function held<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function adapter(id = "primary") {
  const a = new EventEmitter() as any; Object.assign(a, { id, type: "discord", topology: "channels", start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    getHealthSnapshot: () => ({ status: "connected" }), setChatId: vi.fn(), notifyAlert: vi.fn(async (chatId: string, alert: any, options: any) => ({ chatId, messageId: "prompt", threadId: options?.threadId })),
    editMessageRemoveButtons: vi.fn(async () => {}), sendText: vi.fn(async () => ({ chatId: "100", messageId: "out" })) }); return a;
}
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "agend-test-fleet-consent-")), fm = new FleetManager(dir) as any;
  fm.configPath = join(dir, "fleet.yaml");
  fm.fleetConfig = { defaults: {}, instances: { general: { working_directory: dir, general_topic: true, topic_id: "200", channel_id: "primary" } },
    channels: [{ id: "primary", type: "discord", mode: "topic", bot_token_env: "TEST_BOT_TOKEN", group_id: "100", options: { general_channel_id: "200" }, access: { mode: "locked", allowed_users: ["admin"] } }] };
  writeFileSync(fm.configPath, yaml.dump(fm.fleetConfig)); fm.savedFleetConfigSnapshot = structuredClone(fm.fleetConfig);
  const a = adapter(); fm.adapters.set("primary", a); fm.adapter = a; fm.getInstanceAdapterId = () => "primary";
  fm.daemons.set("general", new EventEmitter()); fm.adapterState.set("primary", { status: "connected", retryCount: 0 });
  fm.getAdapterForInstance = () => fm.adapter; fm.getGroupIdForInstance = () => "100";
  // Only platform transports/lifecycle are replaced; confirmation methods and nonce dispatcher are real.
  fm.startSingleAdapter = vi.fn(async (_cfg: any, _channel: any, started: () => void) => {
    const fresh = adapter(); fm.adapters.set("primary", fresh); fm.adapter = fresh; started?.();
  }); fm.reregisterClassicChannels = vi.fn();
  const h = { fm, dir, adapter: a, store: null as SettingsConfirmationStore | null }; fixtures.push(h); return h;
}
function proposal(h: ReturnType<typeof harness>, options: { now?: () => number; affected?: string[]; unchanged?: () => Promise<boolean> } = {}) {
  const apply = vi.fn(async (_current: () => boolean, execution: SettingsExecution) => execution.commit(() => "applied"));
  const store: SettingsConfirmationStore = new SettingsConfirmationStore({ now: options.now, notify: view => h.fm.promptSettingsChange(store, view), audit: vi.fn() }); h.store = store;
  h.fm.settingsConfirmation = { store };
  const view = store.propose({ session: "browser", key: "request", bytes: 1, source: "web_session", section: "access", requestedBy: "admin browser", fingerprint: "effect",
    summary: ["fleet.channels.primary.access.allowed_users: add fleet admin (F) ID 42"], affectedConnections: options.affected,
    current: () => true, unchanged: options.unchanged ?? (async () => true), snapshot: () => null, apply }).view;
  return { store, view, apply };
}
describe("#1423 retained real web-session authority", () => {
  it.each(["local", "gateway"] as const)("%s uses cookie-only authority and does not touch its idle lifetime", surface => {
    const h = harness(), token = rotateWebToken(h.dir); let now = 1000, exposed = true;
    const sessions = new WebSessionStore({ now: () => now }); h.fm.webSessions = sessions;
    const issued = sessions.create({ tier: "admin", surface, label: "test browser", tokenEpoch: tokenEpoch(token), ...(surface === "gateway" ? { exposureId: "public-owner" } : {}) });
    const gate = h.fm.settingsGate(); h.store = gate.store;
    const req: any = { method: "PUT", headers: { host: "example.test", origin: "https://example.test", cookie: `${surface === "gateway" ? "__Host-agend_session" : "agend_session"}=${issued.sessionId}`, "x-agend-csrf": csrfTokenFor(issued.sessionId) } };
    if (surface === "gateway") bindGatewayRequest(req, { surface, exposureId: "public-owner", expectedOrigin: "https://example.test", isCurrent: () => exposed });
    const idle = issued.record.idleExpiry; now += 1000;
    const principal = gate.options.principal(req);
    expect(principal?.source).toBe(surface === "gateway" ? "public_link" : "web_session"); expect(principal?.current()).toBe(true);
    expect(issued.record.idleExpiry).toBe(idle);
    expect(gate.options.principal({ method: "PUT", headers: { "x-agend-token": token } })).toBeNull();
    if (surface === "gateway") { exposed = false; expect(principal.current()).toBe(false); exposed = true; }
    sessions.revokeById(issued.sessionId); expect(principal.current()).toBe(false);
  });
  it.each(["epoch", "idle", "owner"])("a retained principal rejects %s changes without replaying its cookie", reason => {
    const h = harness(), token = rotateWebToken(h.dir); let now = 1000;
    const sessions = new WebSessionStore({ now: () => now }); h.fm.webSessions = sessions;
    const issued = sessions.create({ tier: "admin", surface: "local", label: "browser", tokenEpoch: tokenEpoch(token) });
    const gate = h.fm.settingsGate(); h.store = gate.store;
    const principal = gate.options.principal({ method: "GET", headers: { cookie: `agend_session=${issued.sessionId}` } }); expect(principal.current()).toBe(true);
    if (reason === "epoch") rotateWebToken(h.dir);
    if (reason === "idle") now = issued.record.idleExpiry;
    if (reason === "owner") h.fm.webSessions = new WebSessionStore();
    expect(principal.current()).toBe(false);
  });
  it("public pending reads are passive and no public confirm route exists", () => {
    for (const path of ["/api/settings/pending", "/api/settings/pending/" + "a".repeat(32)]) {
      expect(isPassiveWebRead("GET", path)).toBe(true); expect(isPublicWebRoute("GET", path)).toBe(true);
    }
    expect(isPublicWebRoute("DELETE", "/api/settings/pending/" + "a".repeat(32))).toBe(true);
    expect(isPublicWebRoute("POST", "/api/settings/pending/" + "a".repeat(32) + "/confirm")).toBe(false);
  });
});
async function promptData(h: ReturnType<typeof harness>, user = "admin") {
  await vi.waitFor(() => expect(h.fm.pendingNonceButtons.size).toBe(1));
  const entry: any = [...h.fm.pendingNonceButtons.values()][0];
  return { entry, data: { callbackData: "settings-confirm:" + entry.nonce + ":confirm", chatId: entry.chatId, threadId: entry.threadId, messageId: entry.messageId, userId: user, ack: vi.fn() } };
}
describe("#1423 actual General nonce handler", () => {
  it("non-admin and wrong General cannot claim; owner F confirms once and it is never web-mirrored", async () => {
    const h = harness(), p = proposal(h), { data } = await promptData(h, "stranger");
    await h.fm.dispatchAdapterCallback(data, "primary", h.adapter);
    expect(p.apply).not.toHaveBeenCalled(); expect(p.store.get(p.view.id, "browser")!.state).toBe("pending");
    await h.fm.dispatchAdapterCallback({ ...data, userId: "admin", chatId: "other" }, "primary", h.adapter); expect(p.apply).not.toHaveBeenCalled();
    expect(h.fm.listWebPrompts()).toEqual([]);
    await h.fm.dispatchAdapterCallback({ ...data, userId: "admin" }, "primary", h.adapter);
    expect(p.apply).toHaveBeenCalledOnce(); expect(p.store.get(p.view.id, "browser")!.state).toBe("applied");
    await h.fm.dispatchAdapterCallback({ ...data, userId: "admin" }, "primary", h.adapter); expect(p.apply).toHaveBeenCalledOnce();
  });
  it("delayed expiry timers and replacement adapters still refuse old nonces", async () => {
    let now = 0; const h = harness(), p = proposal(h, { now: () => now }), { data } = await promptData(h);
    now = 300_000; await h.fm.dispatchAdapterCallback(data, "primary", h.adapter); expect(p.apply).not.toHaveBeenCalled(); expect(p.store.get(p.view.id, "browser")!.state).toBe("expired");
    const second = harness(), q = proposal(second), click = await promptData(second); second.fm.adapter = adapter("primary");
    await second.fm.dispatchAdapterCallback(click.data, "primary", second.fm.adapter); expect(q.apply).not.toHaveBeenCalled();
  });
  it("a changed connection is excluded, so no available other General falls back to host", async () => {
    const h = harness(); proposal(h, { affected: ["primary"] }); await new Promise(resolve => setTimeout(resolve, 5));
    expect(h.adapter.notifyAlert).not.toHaveBeenCalled(); expect(h.fm.pendingNonceButtons.size).toBe(0);
  });
  it("a stopped, stopping or replaced General cannot approve an old prompt", async () => {
    const h = harness(), p = proposal(h), { data } = await promptData(h);
    h.fm.ipcStoppingInstances.add("general");
    await h.fm.dispatchAdapterCallback(data, "primary", h.adapter);
    expect(p.apply).not.toHaveBeenCalled();
    const second = harness(); second.fm.daemons.delete("general"); proposal(second);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(second.adapter.notifyAlert).not.toHaveBeenCalled();
    const third = harness(), q = proposal(third), click = await promptData(third);
    third.fm.daemons.set("general", new EventEmitter());
    await third.fm.dispatchAdapterCallback(click.data, "primary", third.adapter);
    expect(q.apply).not.toHaveBeenCalled();
  });
  it("the approving F must still be an admin after the actual baseline await", async () => {
    let release!: (value: boolean) => void;
    const h = harness(), held = new Promise<boolean>(resolve => { release = resolve; });
    const unchanged = vi.fn(() => held), p = proposal(h, { unchanged }), { data } = await promptData(h);
    const deciding = h.fm.dispatchAdapterCallback(data, "primary", h.adapter);
    await vi.waitFor(() => expect(unchanged).toHaveBeenCalledOnce());
    h.fm.fleetConfig.channels[0].access.allowed_users = ["another-F"];
    release(true); await deciding;
    expect(p.apply).not.toHaveBeenCalled(); expect(p.store.get(p.view.id, "browser")!.state).toBe("stale");
  });
});
describe("#1423 actual queued runners and owned cleanup", () => {
  it("queued authorization loss makes no first secret effect", async () => {
    const h = harness(); writeFileSync(join(h.dir, ".env"), "GROQ_API_KEY=old\n");
    let alive = true; const cap = new SettingsExecution({ current: () => alive, snapshot: () => h.fm.fleetConfig });
    const job: any = { id: "queued", specId: "groq.api_key", envKey: "GROQ_API_KEY", status: "running", result: "applying" };
    h.fm.providerSecretJobs.set(job.id, job); h.fm.queueSettingsOperation(job, [settingsFileResource(join(h.dir, ".env"))], cap,
      (execution: SettingsExecution) => h.fm.runProviderSecretApply(job, "secret-sentinel", execution)); alive = false;
    await h.fm.settingsJobSettlements.get(job.id); cap.close(); expect(job.result).toBe("rolled_back"); expect(readFileSync(join(h.dir, ".env"), "utf8")).toBe("GROQ_API_KEY=old\n");
  });
  it("a held provider hook keeps the lease through revocation and owned rollback", async () => {
    const h = harness(), hold = held(); writeFileSync(join(h.dir, ".env"), "GROQ_API_KEY=old\nKEEP=kept\n");
    vi.stubEnv("GROQ_API_KEY", "old"); h.fm.providerSecretReloadHooks.set("groq.voice", () => hold.promise);
    let alive = true; const cap = new SettingsExecution({ current: () => alive, snapshot: () => h.fm.fleetConfig });
    const job: any = { id: "hook", specId: "groq.api_key", envKey: "GROQ_API_KEY", status: "running", result: "applying" }; h.fm.providerSecretJobs.set(job.id, job);
    const resource = settingsFileResource(join(h.dir, ".env")); h.fm.queueSettingsOperation(job, [resource], cap, (exec: SettingsExecution) => h.fm.runProviderSecretApply(job, "secret-sentinel", exec));
    await vi.waitFor(() => expect(process.env.GROQ_API_KEY).toBe("secret-sentinel")); alive = false;
    try {
      expect(settingsLeaseBusy(resource)).toBe(true); expect(() => new SecretStore(join(h.dir, ".env"), new Set(["KEEP"])).write("KEEP", "newer")).toThrow();
      expect(job.status).toBe("running");
    } finally { hold.resolve(); await h.fm.settingsJobSettlements.get(job.id); cap.close(); }
    expect(job.result).toBe("rolled_back"); expect(process.env.GROQ_API_KEY).toBe("old"); expect(readFileSync(join(h.dir, ".env"), "utf8")).toBe("GROQ_API_KEY=old\nKEEP=kept\n"); expect(settingsLeaseBusy(resource)).toBe(false); vi.unstubAllEnvs();
  });
  it("held binding stop plus fleet shutdown never starts a replacement or commits YAML", async () => {
    const h = harness(), hold = held(); h.adapter.stop.mockImplementation(() => hold.promise);
    const generation = h.fm.settingsGeneration, cap = new SettingsExecution({ current: () => !h.fm.shuttingDown && h.fm.settingsGeneration === generation, snapshot: () => h.fm.fleetConfig });
    const job: any = { id: "binding", connectionId: "primary", result: "applying", status: "running" }; h.fm.connectionBindingJobs.set(job.id, job);
    const resource = "connection:" + h.dir + ":primary"; h.fm.queueSettingsOperation(job, [resource], cap,
      (exec: SettingsExecution) => h.fm.runConnectionBindingApply(job, { group_id: "999", general_channel_id: "888" }, exec));
    await vi.waitFor(() => expect(h.adapter.stop).toHaveBeenCalledOnce()); h.fm.shuttingDown = true; h.fm.settingsGeneration++;
    expect(settingsLeaseBusy(resource)).toBe(true); expect(job.status).toBe("running"); hold.resolve(); await h.fm.settingsJobSettlements.get(job.id); cap.close();
    expect(h.fm.startSingleAdapter).not.toHaveBeenCalled(); expect(readFileSync(h.fm.configPath, "utf8")).not.toContain("999"); expect(settingsLeaseBusy(resource)).toBe(false);
  });
});

describe("#1423 ordinary writers preserve concurrent configuration", () => {
  it("a cached Classic chat grant unions the fresh allowlist, without duplicate diagnostics", () => {
    const h = harness(), path = join(h.dir, "classicBot.yaml"); writeFileSync(path, "defaults:\n  allowed_users: [A]\nchannels: {}\n");
    const manager = new ClassicChannelManager(h.dir, { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any);
    writeFileSync(path, "defaults:\n  allowed_users: [A, B]\nchannels: {}\n"); manager.allowUser("C");
    expect((yaml.load(readFileSync(path, "utf8")) as any).defaults.allowed_users).toEqual(["A", "B", "C"]);
  });
  it("a second writer's connection reorder never redirects a stale indexed binding edit", () => {
    const h = harness(), other = { ...h.fm.fleetConfig.channels[0], id: "other", group_id: "999" };
    h.fm.fleetConfig.channels.push(other); h.fm.saveFleetConfig();
    const fresh = structuredClone(h.fm.fleetConfig); fresh.channels.reverse(); writeFileSync(h.fm.configPath, yaml.dump(fresh));
    h.fm.fleetConfig.channels[0].group_id = "123";
    expect(() => h.fm.saveFleetConfig()).toThrow("Connection order changed");
    expect((yaml.load(readFileSync(h.fm.configPath, "utf8")) as any).channels[0]).toMatchObject({ id: "other", group_id: "999" });
  });
});
