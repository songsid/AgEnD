/**
 * #1490 (row 18): GET /api/settings/fleet and /api/settings/fleet/raw never return a credential written inline in
 * fleet.yaml; a save built from that read carries the placeholder back, and the stored credential stays as it was.
 * Driven through the real handler and the real FleetManager loader and saver.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { REDACTED_SECRET } from "../src/settings-redaction.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(source: string): { path: string; fm: FleetManager } {
  const dir = mkdtempSync(join(tmpdir(), "agend-1490-redact-"));
  dirs.push(dir);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, source);
  const fm = new FleetManager(dir);
  fm.loadConfig(path);
  return { path, fm };
}
function call(fm: FleetManager, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method;
    req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${route}`), fm as unknown as Parameters<typeof handleSettingsRequest>[3])).toBe(true);
      if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}
const FILE = `channels:
  - id: dc
    type: discord
    bot_token_env: DC_TOKEN
    bot_token: fake-marker-channel
    access:
      mode: locked
      allowed_users: [1]
    options:
      general_channel_id: "2"
defaults:
  api_key: fake-marker-defaults
instances:
  worker:
    working_directory: /tmp/worker
    persona:
      bot_token: fake-marker-persona
`;
const MARKERS = /fake-marker/;

describe("the fleet reads redact inline credentials (#1490 row 18)", () => {
  it.each(["/api/settings/fleet/raw", "/api/settings/fleet"])("GET %s returns no inline credential", async (route) => {
    const { fm } = fixture(FILE);
    const r = await call(fm, "GET", route);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(MARKERS);
    expect([r.body.channels[0].bot_token, r.body.instances.worker.persona.bot_token]).toEqual([REDACTED_SECRET, REDACTED_SECRET]);
  });
  it("shows that a credential is configured, and leaves everything else as written", async () => {
    const { fm } = fixture(FILE);
    const r = await call(fm, "GET", "/api/settings/fleet/raw");
    expect(r.body.defaults.api_key).toBe(REDACTED_SECRET);
    expect([r.body.channels[0].bot_token_env, r.body.channels[0].options.general_channel_id, r.body.instances.worker.working_directory])
      .toEqual(["DC_TOKEN", "2", "/tmp/worker"]);
  });
});

describe("a save built from the redacted read keeps the stored credential (#1490 row 18)", () => {
  it("PUT channels: the placeholder comes back, fleet.yaml keeps the token and takes the edit", async () => {
    const { path, fm } = fixture(FILE);
    const channels = (await call(fm, "GET", "/api/settings/fleet/raw")).body.channels;
    channels[0].options = { ...channels[0].options, status_emojis: { delivered: "✅" } };
    const r = await call(fm, "PUT", "/api/settings/fleet/channels", channels);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect([saved.channels[0].bot_token, saved.channels[0].options.status_emojis]).toEqual(["fake-marker-channel", { delivered: "✅" }]);
    expect((fm.fleetConfig!.channels![0] as unknown as Record<string, unknown>).bot_token).toBe("fake-marker-channel");
  });
  it("a reordered list puts each connection's own token back, matched by id, never by position", async () => {
    const two = FILE.replace("defaults:", `  - id: tg
    type: telegram
    bot_token_env: TG_TOKEN
    bot_token: fake-marker-second
    access:
      mode: locked
      allowed_users: [1]
defaults:`);
    const { path, fm } = fixture(two);
    const channels = (await call(fm, "GET", "/api/settings/fleet/raw")).body.channels;
    const r = await call(fm, "PUT", "/api/settings/fleet/channels", [...channels].reverse());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect(saved.channels.map((ch: any) => [ch.id, ch.bot_token])).toEqual([["tg", "fake-marker-second"], ["dc", "fake-marker-channel"]]);
  });
  it("PATCH an instance with its whole redacted config: the persona token stays, the edit lands", async () => {
    const { path, fm } = fixture(FILE);
    const worker = (await call(fm, "GET", "/api/settings/fleet/raw")).body.instances.worker;
    const r = await call(fm, "PATCH", "/api/settings/fleet/instances/worker", { ...worker, description: "edited" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect([saved.instances.worker.persona.bot_token, saved.instances.worker.description]).toEqual(["fake-marker-persona", "edited"]);
  });
  it("PUT defaults with the redacted defaults: the stored key stays", async () => {
    const { path, fm } = fixture(FILE);
    const defaults = (await call(fm, "GET", "/api/settings/fleet/raw")).body.defaults;
    const r = await call(fm, "PUT", "/api/settings/fleet/defaults", { ...defaults, locale: "en" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect([saved.defaults.api_key, saved.defaults.locale]).toEqual(["fake-marker-defaults", "en"]);
  });
  it.each([
    ["a new connection", "PUT", "/api/settings/fleet/channels", (raw: any) => [...raw.channels, { id: "tg", type: "telegram", bot_token_env: "TG_TOKEN", bot_token: REDACTED_SECRET }], "channels[1].bot_token"],
    ["a new instance key", "PATCH", "/api/settings/fleet/instances/worker", () => ({ token: REDACTED_SECRET }), "instances.worker.token"],
    ["a new defaults key", "PUT", "/api/settings/fleet/defaults", () => ({ password: REDACTED_SECRET }), "defaults.password"],
  ])("refuses the placeholder with no credential behind it on %s: 400, fleet.yaml untouched", async (_label, method, route, body, at) => {
    const { path, fm } = fixture(FILE);
    const before = readFileSync(path, "utf8");
    const raw = (await call(fm, "GET", "/api/settings/fleet/raw")).body;
    const r = await call(fm, method, route, body(raw));
    expect([r.status, r.body.error]).toEqual([400, `redacted value has no stored credential: ${at}`]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
