import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function harness() {
  const root = mkdtempSync(join(tmpdir(), "agend-test-confirm-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, instances: {}, channels: [{ id: "dc", type: "discord", mode: "topic", bot_token_env: "DISCORD_TOKEN", group_id: "100",
    access: { mode: "locked", allowed_users: ["1"] } }] };
  writeFileSync(path, yaml.dump(config));
  let alive = true, session = "session-a", revision = 0;
  let afterDispatch: (() => void) | undefined;
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); revision++; });
  const ctx = { fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => config, saveFleetConfig: save, lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() } } as unknown as SettingsApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => revision });
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => req.headers.cookie ? { id: session, label: "browser", source: "web_session", current: () => alive } : null,
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  async function request(method: string, target: string, body?: unknown, cookie = true, key = "same-request-key") {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new EventEmitter() as any;
      req.method = method; req.url = target; req.headers = { "idempotency-key": key, ...(cookie ? { cookie: "opaque" } : {}) };
      req.destroy = () => undefined;
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => { const accepted = handleSettingsRequest(r, s, u, ctx); afterDispatch?.(); return accepted; };
      try { expect(gate.handle(req, res, new URL(target, "http://localhost"), next) || next(req, res, new URL(target, "http://localhost"))).toBe(true);
        queueMicrotask(() => { if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); }
      catch (err) { reject(err); }
    });
  }
  return { config, save, store, gate, ctx, request, afterDispatch: (hook: () => void) => { afterDispatch = hook; }, stop: () => { alive = false; }, foreign: () => { session = "foreign"; }, path };
}
const actor = () => ({ label: "F", current: () => true });
const candidate = (h: ReturnType<typeof harness>) => [{ ...h.config.channels[0], access: { mode: "locked", allowed_users: ["2"] } }];
describe("#1423 actual Settings handler behind confirmation", () => {
  it("does not write a sensitive access edit until its actual confirmed replay, exactly once", async () => {
    const h = harness(); const response = await h.request("PUT", "/api/settings/fleet/channels", candidate(h));
    expect(response.status).toBe(202); expect(h.save).not.toHaveBeenCalled(); expect(h.config.channels[0].access.allowed_users).toEqual(["1"]);
    const id = response.body.pending_change.id;
    const outcome = await h.store.decide(id, "confirm", actor());
    expect(outcome.state).toBe("applied"); expect(outcome.outcome?.result).toMatchObject({ ok: true });
    expect(h.config.channels[0].access.allowed_users).toEqual(["2"]); expect(h.save).toHaveBeenCalledOnce();
    await expect(h.store.decide(id, "confirm", actor())).rejects.toThrow("confirmation_not_pending");
  });
  it("requires a browser session for sensitive writes, while a model-only edit remains immediate", async () => {
    const h = harness();
    expect((await h.request("PUT", "/api/settings/fleet/channels", candidate(h), false)).status).toBe(401);
    expect(h.save).not.toHaveBeenCalled();
    const response = await h.request("PUT", "/api/settings/fleet/defaults", { model: "new" }, false);
    expect(response.status).toBe(200); expect(h.config.defaults.model).toBe("new"); expect(h.save).toHaveBeenCalledOnce();
  });
  it("rejects non-admin, revoked session and a changed actual baseline without writing", async () => {
    const h = harness(), first = await h.request("PUT", "/api/settings/fleet/channels", candidate(h));
    await expect(h.store.decide(first.body.pending_change.id, "confirm", { label: "not F", current: () => false })).rejects.toThrow("admin_required");
    h.config.defaults.model = "newer"; h.save(); const writes = h.save.mock.calls.length;
    expect((await h.store.decide(first.body.pending_change.id, "confirm", actor())).state).toBe("stale"); expect(h.save.mock.calls.length).toBe(writes);
    const second = await h.request("PUT", "/api/settings/fleet/channels", candidate(h), true, "another-key"); h.stop();
    expect((await h.store.decide(second.body.pending_change.id, "confirm", actor())).state).toBe("stale"); expect(h.save.mock.calls.length).toBe(writes);
  });
  it("returns the same pending on a retry and does not reveal another session's pending", async () => {
    const h = harness(), proposed = candidate(h);
    const first = await h.request("PUT", "/api/settings/fleet/channels", proposed);
    const again = await h.request("PUT", "/api/settings/fleet/channels", proposed);
    expect(again.body.pending_change.id).toBe(first.body.pending_change.id);
    expect((await h.request("GET", "/api/settings/pending")).body).toHaveLength(1);
    expect((await h.request("PUT", "/api/settings/fleet/channels", h.config.channels)).status).toBe(409);
    h.foreign(); expect((await h.request("GET", `/api/settings/pending/${first.body.pending_change.id}`)).status).toBe(404);
    expect((await h.request("DELETE", `/api/settings/pending/${first.body.pending_change.id}`)).status).toBe(404);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("withdraws without running the handler and never returns secret material in the view", async () => {
    const h = harness(); const response = await h.request("PUT", "/api/settings/fleet/channels", candidate(h));
    const id = response.body.pending_change.id;
    expect((await h.request("DELETE", `/api/settings/pending/${id}`)).body.state).toBe("rejected");
    await expect(h.store.decide(id, "confirm", actor())).rejects.toThrow(); expect(h.save).not.toHaveBeenCalled();
  });
});

it("an immediate full replacement is fenced if an approved ACL changes before handler admission", async () => {
  const h = harness(), body = [{ ...h.config.channels[0], name: "display edit" }];
  h.afterDispatch(() => { h.config.channels[0].access.allowed_users = ["newly-approved"]; h.save(); });
  const response = await h.request("PUT", "/api/settings/fleet/channels", body);
  expect(response.status).toBeGreaterThanOrEqual(400); expect(h.config.channels[0].access.allowed_users).toEqual(["newly-approved"]); expect(h.save).toHaveBeenCalledOnce();
});
it("unsupported instance nulls cannot hide a credential/permission change in projection", async () => {
  const h = harness(); h.config.defaults.skipPermissions = false; h.config.instances.worker = { working_directory: h.ctx.dataDir }; h.save();
  const response = await h.request("PATCH", "/api/settings/fleet/instances/worker", { skipPermissions: null });
  expect(response.status).toBe(400); expect(h.config.instances.worker).not.toHaveProperty("skipPermissions"); expect(h.save).toHaveBeenCalledOnce();
});
