/** #2275 R1: the real HTTP confirmation/replay boundary, not a direct settings-handler shortcut. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { isSettingsReplay } from "../src/settings-request-capability.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { authorizeSession } from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch, WebSessionStore, type SessionTier } from "../src/web-session.js";

const roots: string[] = [], servers: Server[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const server of servers.splice(0)) await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const WEB = "/api/settings/fleet/web", TOKEN = "private-confirmation-test-token";
async function fixture(opts: { tier?: SessionTier; gateway?: boolean; proof?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-cw-confirm-")); roots.push(root);
  const path = join(root, "fleet.yaml"), config: any = { defaults: {}, instances: {}, web: { log_tab: false, experimental: { canvas_worker: false } } }, sessions = new WebSessionStore();
  writeFileSync(path, yaml.dump(config));
  const changed = vi.fn(), save = vi.fn(() => writeFileSync(path, yaml.dump(config))), logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  let ctx: any = { fleetConfig: config, dataDir: root, configPath: path, webToken: TOKEN, webSessions: sessions, logger, getRawFleetConfig: () => config, saveFleetConfig: save, canvasWorkerSettingChanged: changed };
  let gate: SettingsHttpConfirmation;
  if (opts.proof === false) {
    const store = new SettingsConfirmationStore({ audit: vi.fn() });
    const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => 0 });
    gate = new SettingsHttpConfirmation(store, {
      principal: req => {
        const auth = authorizeSession(req, TOKEN, sessions, { touch: false });
        if (auth.kind !== "ok") return null;
        const record = auth.session;
        return { id: record.idHash, label: record.label, source: "web_session", current: () => sessions.isCurrent(record, tokenEpoch(TOKEN)) };
      }, baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
    });
  } else {
    // Exercise the product's captured session/capability wiring, without constructing or starting a fleet.
    const fm = Object.create(FleetManager.prototype) as any;
    Object.defineProperty(fm, "webToken", { value: TOKEN, writable: true, configurable: true });
    Object.assign(fm, ctx, { settingsGeneration: 0, settingsRuntimeRevision: 0, shuttingDown: false,
      promptSettingsChange: vi.fn(async () => {}), settingsSelfConfirmation: () => null });
    gate = fm.settingsGate(); ctx = fm;
  }
  const store = gate.store; stores.push(store);

  const responses: Array<{ replay: boolean; cookie: unknown; authorization: unknown; token: unknown; status: number; body: any }> = [];
  const next = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const end = res.end;
    res.end = function (this: ServerResponse, chunk: any, ...rest: any[]) {
      responses.push({ replay: isSettingsReplay(req), cookie: req.headers.cookie, authorization: req.headers.authorization, token: req.headers["x-agend-token"], status: res.statusCode, body: JSON.parse(String(chunk ?? "{}")) });
      return end.call(this, chunk, ...rest as [any]);
    } as typeof res.end;
    return handleSettingsRequest(req, res, url, ctx);
  };
  const server = createServer((req, res) => { if (opts.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://private.invalid", isCurrent: () => true }); const url = new URL(req.url!, "http://localhost"); if (gate.handle(req, res, url, next) || next(req, res, url)) return; res.writeHead(404); res.end('{}'); }); servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const port = (server.address() as { port: number }).port;
  const made = sessions.create({ tier: opts.tier ?? "admin", surface: opts.gateway ? "gateway" : "local", ...(opts.gateway ? { exposureId: "e".repeat(32) } : {}), label: "local administrator", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "discord", userId: "alice" } });
  const put = (body: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "PUT", path: WEB, headers: { cookie: `${opts.gateway ? "__Host-agend_session" : "agend_session"}=${made.sessionId}`, origin: opts.gateway ? "https://private.invalid" : `http://127.0.0.1:${port}`, "x-agend-csrf": csrfTokenFor(made.sessionId), "idempotency-key": "private-key", "content-type": "application/json" } }, res => { let text = ""; res.setEncoding("utf8"); res.on("data", x => { text += x; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) })); });
    req.setTimeout(5000, () => req.destroy(Error("private confirmation HTTP deadline"))); req.on("error", reject); req.end(JSON.stringify(body));
  });
  return { root, path, config, sessions, made, save, changed, store, put, responses };
}
const approvingAdmin = () => ({ label: "confirmed in General", current: () => true });

describe("confirmed experimental settings pass the server-owned replay boundary", () => {
  it("a local admin can enable CW after confirmation without replaying their bearer cookie", async () => {
    const f = await fixture(), before = readFileSync(f.path, "utf8");
    const pending = await f.put({ experimental: { canvas_worker: true } });
    expect([pending.status, pending.body.result, pending.body.pending_change.state]).toEqual([202, "pending_confirmation", "pending"]);
    expect(f.save).not.toHaveBeenCalled(); expect(f.config.web.experimental.canvas_worker).toBe(false); expect(readFileSync(f.path, "utf8")).toBe(before);
    const outcome = await f.store.decide(pending.body.pending_change.id, "confirm", approvingAdmin());
    expect(f.responses).toEqual([{ replay: true, cookie: undefined, authorization: undefined, token: undefined, status: 200, body: expect.objectContaining({ ok: true }) }]);
    expect(outcome.state).toBe("applied"); expect(f.save).toHaveBeenCalledOnce(); expect(f.changed).toHaveBeenCalledOnce(); expect(f.config.web.experimental.canvas_worker).toBe(true);
    expect((yaml.load(readFileSync(f.path, "utf8")) as any).web.experimental.canvas_worker).toBe(true);
  });
  it("ordinary confirmed Log-tab enable remains the working replay control", async () => {
    const f = await fixture(), pending = await f.put({ log_tab: true });
    expect([pending.status, pending.body.result]).toEqual([202, "pending_confirmation"]); expect(f.save).not.toHaveBeenCalled();
    const outcome = await f.store.decide(pending.body.pending_change.id, "confirm", approvingAdmin());
    expect(outcome.state).toBe("applied"); expect(f.responses).toEqual([{ replay: true, cookie: undefined, authorization: undefined, token: undefined, status: 200, body: expect.objectContaining({ ok: true }) }]);
    expect(f.save).toHaveBeenCalledOnce(); expect(f.changed).not.toHaveBeenCalled(); expect(f.config.web.log_tab).toBe(true); expect(f.config.web.experimental.canvas_worker).toBe(false);
  });
  it("revoking the original requester while pending prevents replay even if the same account signs in again", async () => {
    const f = await fixture(), before = readFileSync(f.path, "utf8"), pending = await f.put({ experimental: { canvas_worker: true } });
    expect([pending.status, pending.body.pending_change.state]).toEqual([202, "pending"]);
    f.sessions.revokeById(f.made.sessionId);
    f.sessions.create({ tier: "admin", surface: "local", label: "replacement browser", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "discord", userId: "alice" } });
    const outcome = await f.store.decide(pending.body.pending_change.id, "confirm", approvingAdmin());
    expect(outcome.state).toBe("stale"); expect(outcome.outcome?.reason_code).toBe("request_no_longer_current");
    expect(f.responses).toEqual([]); expect(f.save).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled(); expect(f.config.web.experimental.canvas_worker).toBe(false); expect(readFileSync(f.path, "utf8")).toBe(before);
  });
  it.each(["read", "guest"] as const)("a real %s session's generic pending confirmation cannot grant a local-admin capability", async tier => {
    const f = await fixture({ tier }), before = readFileSync(f.path, "utf8"), pending = await f.put({ experimental: { canvas_worker: true } });
    expect([pending.status, pending.body.pending_change.state]).toEqual([202, "pending"]);
    const outcome = await f.store.decide(pending.body.pending_change.id, "confirm", approvingAdmin());
    expect(outcome.state).toBe("failed"); expect(f.responses).toEqual([{ replay: true, cookie: undefined, authorization: undefined, token: undefined, status: 403, body: { error: "canvas_worker_setting_needs_local_admin" } }]);
    expect(f.save).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled(); expect(readFileSync(f.path, "utf8")).toBe(before);
  });
  it("a public admin's request is refused before any pending confirmation is created", async () => {
    const f = await fixture({ gateway: true }), before = readFileSync(f.path, "utf8"), denied = await f.put({ experimental: { canvas_worker: true } });
    expect(denied).toEqual({ status: 403, body: { error: "web_settings_not_over_public_link" } });
    expect(f.store.list(f.made.record.idHash)).toEqual([]); expect(f.responses).toEqual([]); expect(f.save).not.toHaveBeenCalled(); expect(readFileSync(f.path, "utf8")).toBe(before);
  });
  it("an ordinary server-owned replay with no local-admin proof cannot enable the experiment", async () => {
    const f = await fixture({ proof: false }), before = readFileSync(f.path, "utf8"), pending = await f.put({ experimental: { canvas_worker: true } });
    expect(pending.status).toBe(202);
    const outcome = await f.store.decide(pending.body.pending_change.id, "confirm", approvingAdmin());
    expect(outcome.state).toBe("failed"); expect(f.responses[0]).toMatchObject({ replay: true, cookie: undefined, status: 403, body: { error: "canvas_worker_setting_needs_local_admin" } });
    expect(f.save).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled(); expect(readFileSync(f.path, "utf8")).toBe(before);
  });
  it.each(["tier", "surface"] as const)("a pending proof rechecks the captured session's %s instead of caching its old privilege", async field => {
    const f = await fixture(), before = readFileSync(f.path, "utf8"), pending = await f.put({ experimental: { canvas_worker: true } });
    expect(pending.status).toBe(202);
    // Inert server-owned metadata downgrade: no browser field supplies or changes this record.
    Object.defineProperty(f.made.record, field, { value: field === "tier" ? "read" : "gateway" });
    const outcome = await f.store.decide(pending.body.pending_change.id, "confirm", approvingAdmin());
    expect(outcome.state).toBe("failed"); expect(f.responses[0]).toMatchObject({ replay: true, cookie: undefined, status: 403, body: { error: "canvas_worker_setting_needs_local_admin" } });
    expect(f.save).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled(); expect(readFileSync(f.path, "utf8")).toBe(before);
  });

});
