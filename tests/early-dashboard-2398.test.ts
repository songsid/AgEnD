/** Real boot ordering and ephemeral HTTP, with every process/tmux/provider boundary inert. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ children: [] as string[], notify: [] as string[], readyStates: [] as unknown[], readyProbe: null as null | (() => unknown) }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const refuse = (...args: unknown[]) => { calls.children.push(`${String(args[0])}\n${new Error().stack}`); throw Error("native children forbidden in startup tests"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
vi.mock("../src/logger.js", async original => {
  const silent: any = { info() {}, debug() {}, warn() {}, error() {}, child: () => silent };
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
vi.mock("../src/sd-notify.js", () => ({ sdNotify: (s: string) => { calls.notify.push(s); if (s === "READY=1") calls.readyStates.push(calls.readyProbe?.()); }, sdNotifyBlocking: vi.fn(), setSdNotifyWarn: vi.fn() }));
vi.mock("../src/tmux-exec-helper.js", () => ({ tmuxExecHelper: { reopen() {}, start() {}, maintain() {}, async stop() {} } }));

const { FleetManager } = await import("../src/fleet-manager.js");
const { TmuxManager } = await import("../src/tmux-manager.js");
const { TmuxControlClient } = await import("../src/tmux-control.js");
const { FleetStartup } = await import("../src/fleet-startup.js");
const { WebSessionStore, tokenEpoch } = await import("../src/web-session.js");
const { loadOrCreateWebToken, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { fleetCookieName } = await import("../src/web-cookie-names.js");
const { AccessManager } = await import("../src/channel/access-manager.js");
const visitor = { adapterId: "telegram", userId: "synthetic-visitor" };
const { setUsageFetcherForTests } = await import("../src/usage/usage-api.js");

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const fleets: Array<{ fm: any; dir: string; release: () => void; boot: Promise<void> }> = [];
afterEach(async () => {
  for (const f of fleets.splice(0)) {
    f.release(); await f.boot.catch(() => {});
    await f.fm.stopAll();
    f.fm.memoryPressure.stop(); f.fm.spawnGate.shutdown(); f.fm.stormWindow.shutdown();
    rmSync(f.dir, { recursive: true, force: true });
  }
  setUsageFetcherForTests(null);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  const unexpected = calls.children.splice(0); calls.notify.length = 0; calls.readyStates.length = 0; calls.readyProbe = null;
  expect(unexpected).toEqual([]);
});

async function get(fm: any, path: string, method = "GET", authorized = true, headers: Record<string, string> = {}) {
  const address = (fm.healthServer as Server).address();
  if (!address || typeof address === "string") throw Error("dashboard has not bound its socket");
  return new Promise<{ status: number; headers: Record<string, unknown>; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: address.port, path, method,
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${address.port}`,
        ...(authorized ? { "X-Agend-Token": fm.webToken } : {}), ...headers } }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => { let body: unknown; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, headers: res.headers, body }); });
    });
    req.on("error", reject); req.end(method === "POST" ? "{}" : undefined);
  });
}

async function heldBoot(holdListen = false, guests = false) {
  const dir = mkdtempSync(join(tmpdir(), "early-dashboard-2398-"));
  vi.stubEnv("AGEND_HOME", dir); vi.stubEnv("HOME", dir);
  const general = join(dir, "workspaces/general"), worker = join(dir, "workspaces/worker");
  mkdirSync(general, { recursive: true }); mkdirSync(worker, { recursive: true });
  const config = join(dir, "fleet.yaml");
  writeFileSync(config, `defaults:
  locale: en
  startup:
    concurrency: 2
    stagger_delay_ms: 0
web:
  preview: false
  guests:
    enabled: ${guests}
channel:
  type: telegram
  mode: topic
  bot_token_env: TEST_BOOT_TOKEN
  group_id: -123456
instances:
  general:
    working_directory: ${general}
    general_topic: true
    topic_id: 1
  worker:
    working_directory: ${worker}
    topic_id: 2
  paused:
    working_directory: ${dir}/workspaces/paused
`);
  // Mint on disk before constructing/booting the fleet: this is a returning cookie, not a new login during boot.
  const guestSession = guests ? new WebSessionStore({ dataDir: dir }).create({ tier: "guest", surface: "local",
    label: "synthetic visitor", tokenEpoch: tokenEpoch(loadOrCreateWebToken(dir)), owner: visitor }) : null;
  const fm: any = new FleetManager(dir);
  calls.readyProbe = () => ({ complete: fm.startupComplete, startup: fm.startupDashboard, names: [...fm.daemons.keys()] });
  vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
  vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([]);
  vi.spyOn(TmuxControlClient.prototype, "start").mockImplementation(() => {});
  vi.spyOn(TmuxControlClient.prototype, "stop").mockImplementation(() => {});
  vi.spyOn(fm.memoryPressure, "start").mockImplementation(() => {});
  vi.spyOn(fm.lifecycle, "primeAuthVerification").mockImplementation(() => {});
  vi.spyOn(fm.lifecycle, "isPaused").mockImplementation((...args: unknown[]) => args[0] === "paused");
  for (const name of ["startAvailabilityRefresh", "ensureGeneralInstructions", "syncRoleSkills", "startSearchIndex",
    "startDiscordUsagePresence", "requestDiscordUsagePresenceRefresh", "startStatuslineWatcher", "resolveTopicIcons",
    "refreshAllGuestRooms", "announceWebChatOnce", "startNeedsYou", "announceToolPermissionsChange", "sendFleetStartCompletionFallback"]) {
    vi.spyOn(fm, name).mockImplementation(() => undefined);
  }
  vi.spyOn(fm, "startSharedAdapter").mockResolvedValue(undefined);
  vi.spyOn(fm, "resolveKnowledgeWorkDir").mockImplementation((...args: unknown[]) => args[0]);
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
  vi.spyOn(fm.topicCommands, "autoCreateTopics").mockResolvedValue(undefined);
  vi.spyOn(fm.topicArchiver, "startPoller").mockImplementation(() => {});
  vi.spyOn(fm.lifecycle, "stop").mockImplementation(async (...args: unknown[]) => { fm.daemons.delete(args[0]); });
  setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [] }));
  const listen = fm.startHealthServer.bind(fm);
  const bound = deferred(), listenRelease = deferred();
  vi.spyOn(fm, "startHealthServer").mockImplementation(async () => {
    await listen(0); bound.resolve(); if (holdListen) await listenRelease.promise;
  });
  const entered = deferred(), release = deferred(), workerEntered = deferred(), workerRelease = deferred();
  vi.spyOn(fm.lifecycle, "start").mockImplementation(async (...args: unknown[]) => {
    const name = args[0];
    if (name === "general") { entered.resolve(); await release.promise; }
    if (name === "worker") { workerEntered.resolve(); await workerRelease.promise; }
    fm.daemons.set(name, { getProcessStatus: () => "running", getInteractionSnapshot: () => null });
  });
  const boot = fm.startAll(config);
  const releaseAll = () => { release.resolve(); workerRelease.resolve(); listenRelease.resolve(); };
  fleets.push({ fm, dir, release: releaseAll, boot });
  await Promise.race([holdListen ? bound.promise : entered.promise, boot.then(() => { throw Error("boot did not reach the held startup boundary"); })]);
  return { fm, boot, guestSession, release: releaseAll, releaseGeneral: release.resolve, workerEntered: workerEntered.promise,
    releaseWorker: workerRelease.resolve, releaseListen: listenRelease.resolve, generalEntered: entered.promise };
}

function initializeVisitorWorld(fm: any, allowed = true) {
  fm.worlds.set(visitor.adapterId, { stop: async () => {}, adapter: { type: "telegram", stop: async () => {}, removeAllListeners() {} },
    accessManager: new AccessManager({ mode: "locked", allowed_users: allowed ? [visitor.userId] : [],
      max_pending_codes: 3, code_expiry_minutes: 5 }, join(fm.dataDir, "synthetic-access.json")) });
}

describe("dashboard before agents (#2398)", () => {
  it("waits for listener admission before entering the first instance", async () => {
    const { fm, boot, release, releaseListen, generalEntered } = await heldBoot(true);
    expect(fm.healthServer.listening).toBe(true);
    expect(fm.lifecycle.start).not.toHaveBeenCalled();
    expect(calls.notify).not.toContain("READY=1");
    expect((await get(fm, "/ui/poll")).body.status.instances[0].startup_phase).toBe("queued");
    releaseListen(); await generalEntered;
    expect(fm.lifecycle.start).toHaveBeenCalledOnce();
    release(); await boot;
  });

  it("binds before the held General, serves early reads, and keeps READY last", async () => {
    const { fm, boot, releaseGeneral, workerEntered, releaseWorker } = await heldBoot();
    expect(fm.healthServer, "listener must exist before General startup").not.toBeNull();
    expect(fm.healthServer.listening).toBe(true);
    expect(calls.notify).not.toContain("READY=1");
    const poll = await get(fm, "/ui/poll");
    expect(poll.status).toBe(200);
    expect(poll.body.status.startup).toEqual({ phase: "starting", ready: 0, total: 2, failed: 0 });
    expect(poll.body.status.instances.map((i: any) => [i.name, i.startup_phase])).toEqual([["general", "starting"], ["worker", "queued"], ["paused", undefined]]);
    expect(poll.body.needs).toEqual([]);
    expect((await get(fm, "/ui")).status).toBe(200);
    expect((await get(fm, "/api/settings/fleet")).status).toBe(200);
    expect((await get(fm, "/ui/needs")).status).toBe(200);
    expect((await get(fm, "/ui/tasks/board")).status).toBe(200);
    expect((await get(fm, "/api/ai-usage")).status).toBe(200);
    const health = await get(fm, "/health", "GET", false);
    expect(health.status).toBe(503);
    expect(health.body.problems).toContain("startup has not completed");
    releaseGeneral(); await workerEntered;
    expect((await get(fm, "/ui/poll")).body.status.startup).toEqual({ phase: "starting", ready: 1, total: 2, failed: 0 });
    expect(calls.notify).not.toContain("READY=1");
    releaseWorker(); await boot;
    expect(calls.notify.filter(s => s === "READY=1")).toEqual(["READY=1"]);
    expect(calls.readyStates).toEqual([{ complete: true, startup: null, names: ["general", "worker"] }]);
    expect((await get(fm, "/ui/poll")).body.status.startup).toBeNull();
    expect((await get(fm, "/ui/poll")).body.status.instances.every((i: any) => (i.status === "running" || i.status === "paused") && i.startup_phase === undefined)).toBe(true);
  });

  it("refuses early mutations with a retry hint, without bypassing authentication", async () => {
    const { fm, boot, release } = await heldBoot();
    const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
    const start = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue(undefined);
    for (const path of ["/ui/send", "/api/settings/apply", "/api/instance/worker/start", "/restart/worker", "/ui/tasks", "/agent"]) {
      const res = await get(fm, path, "POST");
      expect(res.status, path).toBe(503);
      expect(res.body.code, path).toBe("fleet_starting");
      expect(res.body.error, path).toContain("still starting");
      expect(res.headers["retry-after"], path).toBe("2");
    }
    expect(deliver).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect((await get(fm, "/ui/send", "POST", false)).status).toBe(401);
    expect((await get(fm, "/auth/session")).status).toBe(401); // this endpoint requires a browser cookie
    expect((await get(fm, "/auth/login", "POST")).status).toBe(400); // normal code validation, not a boot refusal
    release(); await boot;
    // It reaches normal validation after boot; no blanket startup refusal survives.
    expect((await get(fm, "/ui/send", "POST")).status).toBe(400);
  });

  it("retains a persisted guest cookie while its startup world is missing, then admits the same cookie", async () => {
    const { fm, guestSession } = await heldBoot(false, true);
    const saved = guestSession!;
    const cookie = { Cookie: `${fleetCookieName(WEB_SESSION_COOKIE, fm.webToken)}=${saved.sessionId}` };
    expect(fm.worlds.size).toBe(0);
    const pending = await get(fm, "/ui/poll", "GET", false, cookie);
    expect(pending.status).toBe(503);
    expect(pending.body).toEqual({ error: "guest_scope_pending" });
    expect(pending.headers["retry-after"]).toBe("5");
    expect(fm.webSessions.authenticate(saved.sessionId, tokenEpoch(fm.webToken), { touch: false })).not.toBeNull();
    expect(new WebSessionStore({ dataDir: fm.dataDir }).authenticate(saved.sessionId, tokenEpoch(fm.webToken), { touch: false })).not.toBeNull();
    initializeVisitorWorld(fm);
    const admitted = await get(fm, "/ui/poll", "GET", false, cookie);
    expect(admitted.status).toBe(200);
    expect(admitted.body.status.instances.map((i: any) => i.name)).toContain("worker");
    expect(admitted.body.status.startup).toBeUndefined(); // no global counts granted to guests
    expect(fm.webSessions.authenticate(saved.sessionId, tokenEpoch(fm.webToken), { touch: false })).not.toBeNull();
  });

  it.each(["disabled", "revoked", "unconfigured", "denied", "narrowed"])("startup does not rescue genuinely %s guest access", async reason => {
    const { fm, guestSession } = await heldBoot(false, true);
    const saved = guestSession!;
    const cookie = { Cookie: `${fleetCookieName(WEB_SESSION_COOKIE, fm.webToken)}=${saved.sessionId}` };
    if (reason === "disabled") fm.fleetConfig.web.guests.enabled = false;
    if (reason === "revoked") fm.webSessions.revokeByHandle(saved.record.handle);
    if (reason === "unconfigured") fm.fleetConfig.channel.id = "replacement";
    if (reason === "denied") initializeVisitorWorld(fm, false);
    if (reason === "narrowed") {
      initializeVisitorWorld(fm);
      fm.fleetConfig.web.guests.narrow = { [`${visitor.adapterId}:${visitor.userId}`]: [] };
    }
    expect((await get(fm, "/ui/poll", "GET", false, cookie)).status).toBe(401);
    expect(fm.webSessions.authenticate(saved.sessionId, tokenEpoch(fm.webToken), { touch: false })).toBeNull();
  });

  it("an old boot cannot finish the replacement boot's progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-owner-2398-"));
    try {
      const fm: any = new FleetManager(dir), held = deferred();
      const old = new FleetStartup(["worker"]), replacement = new FleetStartup(["worker"]);
      fm.startupDashboard = old;
      vi.spyOn(fm, "publishStartupStatus").mockImplementation(() => {});
      const starting = fm.trackStartupInstance("worker", () => held.promise);
      fm.startupDashboard = replacement;
      held.resolve(); await starting;
      expect(replacement.snapshot()).toEqual({ phase: "starting", ready: 0, total: 1, failed: 0 });
      expect(fm.publishStartupStatus).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
