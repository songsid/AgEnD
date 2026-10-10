import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => { throw Error("no actual binary discovery in this test"); }),
}));
import { handleWebRequest } from "../src/web-api.js";
import { handleQuickstartRequest } from "../src/quickstart-api.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsExecution, noteSettingsWrite } from "../src/settings-transaction.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { setupPayload } from "./helpers/setup-confirmation-1423.js";

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function harness() {
  const root = mkdtempSync(join(tmpdir(), "agend-test-replay-paths-")); roots.push(root);
  const path = join(root, "fleet.yaml"), channel = { id: "primary", type: "telegram", mode: "topic", group_id: "-100123", bot_token_env: "AGEND_BOT_TOKEN", access: { mode: "locked", allowed_users: ["42"] } };
  const config: any = { defaults: {}, instances: { worker: { working_directory: root }, owner_a: { working_directory: "/old/a" }, owner_b: { working_directory: "/old/b" } }, channel, channels: [channel] };
  writeFileSync(path, yaml.dump(config));
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); });
  const create = vi.fn(async (input: any, respond: any, _adapter: unknown, execution: SettingsExecution) => {
    execution.commit(() => { config.instances.created = { working_directory: input.directory }; save(); }); respond({ name: "created" });
  });
  const remove = vi.fn(async (name: string, _auth: unknown, execution: SettingsExecution) => execution.commit(() => { delete config.instances[name]; save(); }));
  const ctx: any = { fleetConfig: config, dataDir: root, configPath: path, webToken: "t".repeat(48), webSessions: undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, getRawFleetConfig: () => config, saveFleetConfig: save,
    lifecycle: { handleCreate: create }, removeInstance: remove, emitSseEvent: vi.fn(), getUiStatus: () => ({}) };
  const baseline = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => null });
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const gate = new SettingsHttpConfirmation(store, { principal: req => req.headers.cookie ? { id: "browser", label: "browser", source: "web_session", current: () => true } : null,
    baseline: () => baseline.read(), snapshot: () => baseline.snapshot() });
  const next = (req: any, res: any, url: URL) => handleWebRequest(req, res, url, ctx) || handleQuickstartRequest(req, res, url, ctx);
  const request = (target: string, body: any, cookie = true, guarded = true) => new Promise<any>((resolve, reject) => {
    const req: any = new EventEmitter(); req.method = "POST"; req.url = target; req.headers = { ...(cookie ? { cookie: "opaque" } : {}), "idempotency-key": target + JSON.stringify(body) }; req.destroy = vi.fn();
    const res: any = { destroyed: false, headersSent: false, setHeader: vi.fn(), writeHead(status: number) { this.status = status; this.headersSent = true; }, end(text: string) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    try { expect(guarded && gate.handle(req, res, new URL(target, "http://localhost"), next) || next(req, res, new URL(target, "http://localhost"))).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); } catch (error) { reject(error); }
  });
  return { root, config, save, create, remove, store, request };
}
const actor = { label: "F", current: () => true };
it.each([
  ["/ui/config", { channel: { access: { mode: "locked", allowed_users: ["99"] } } }],
  ["/ui/instances", { directory: "/tmp/new-worker", topic_name: "created" }],
  ["/ui/instances/worker/delete", { confirm: "delete worker" }],
])("real confirmation replay reaches the actual %s handler and effect exactly once", async (path, body) => {
  const h = harness(), pending = await h.request(path as string, body);
  expect(pending.status).toBe(202); expect(h.save).not.toHaveBeenCalled();
  const outcome = await h.store.decide(pending.body.pending_change.id, "confirm", actor);
  expect(outcome.state).toBe("applied"); expect(h.save).toHaveBeenCalledOnce();
  if (path === "/ui/config") expect(h.config.channel.access.allowed_users).toEqual(["99"]);
  if (path === "/ui/instances") expect(h.config.instances.created.working_directory).toBe("/tmp/new-worker");
  if (path.endsWith("/delete")) expect(h.config.instances).not.toHaveProperty("worker");
});
it("ordinary cached capabilities do not bypass external /ui authentication", async () => {
  const h = harness();
  expect((await h.request("/ui/config", { defaults: { model: "ordinary" } }, false)).status).toBe(401);
  expect((await h.request("/ui/config", { defaults: { model: "ordinary" } }, false, false)).status).toBe(401);
  expect(h.save).not.toHaveBeenCalled();
});
it("Quickstart's target-keyed writer draft names the agent it binds and the full connection order", async () => {
  // #1519 P1 (S1): the wizard always adds a connection, under a token env no connection holds. #1519 P7: it never
  // overwrites an agent — an existing one is connected as it is (only its channel_id changes).
  const h = harness(), body = { ...setupPayload, token_env: "NEW_BOT_TOKEN", instance_name: "owner_a", existing_agent: true };
  h.config.channels.unshift({ ...h.config.channels[0], id: "other", bot_token_env: "OTHER_BOT_TOKEN", group_id: "-100999" }); h.save(); h.save.mockClear();
  const effectA = prepareSettingsEffect("POST", "/api/settings/quickstart/commit", body, { config: h.config, classic: {} });
  const effectB = prepareSettingsEffect("POST", "/api/settings/quickstart/commit", { ...body, instance_name: "owner_b" }, { config: h.config, classic: {} });
  const summary = effectA.diff!.summary.join("\n");
  expect(summary).toContain("instances.owner\\_a.channel\\_id");
  expect(summary).not.toContain("working\\_directory");
  // The same name as a new agent is refused: it would overwrite owner_a.
  expect(() => prepareSettingsEffect("POST", "/api/settings/quickstart/commit", { ...body, existing_agent: undefined, working_directory: "/new/approved" }, { config: h.config, classic: {} }))
    .toThrow(expect.objectContaining({ status: 409, message: "agent_conflict" }));
  expect(effectA.diff!.summary).not.toEqual(effectB.diff!.summary);
  expect(summary).toContain("ordered connections / primary");
  // The token env another connection holds is refused, never proposed as a replacement.
  expect(() => prepareSettingsEffect("POST", "/api/settings/quickstart/commit", { ...body, token_env: "AGEND_BOT_TOKEN" }, { config: h.config, classic: {} }))
    .toThrow(expect.objectContaining({ status: 409 }));
  const pending = await h.request("/api/settings/quickstart/commit", body);
  expect(pending.status).toBe(202); expect(pending.body.pending_change.summary).toEqual(effectA.diff!.summary);
  expect((await h.store.decide(pending.body.pending_change.id, "confirm", actor)).state).toBe("applied");
  expect([h.config.instances.owner_a.working_directory, h.config.instances.owner_a.channel_id]).toEqual(["/old/a", "telegram"]);
  expect(h.config.instances.owner_b).toEqual({ working_directory: "/old/b" });
  expect(h.config.channels.map((item: any) => item.id)).toEqual(["other", "primary", "telegram"]);
});
