/**
 * #1490 (Fable's 2.2 audit), two settings write paths:
 * - the #1423 confirmation diff no longer skips a whole subtree under an "immediate" key (`persona: { bot_token }`);
 * - PUT /api/settings/fleet/channels writes only the connection fields Settings owns (a hand-added field may pass
 *   through unchanged), driven through the real handler and the real FleetManager saver.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { settingsChangeDiff } from "../src/settings-change.js";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";

const instanceEdit = (before: Record<string, unknown>, after: Record<string, unknown>, name = "worker") =>
  settingsChangeDiff({ fleet: { instances: { [name]: { working_directory: "/w", ...before } } } },
    { fleet: { instances: { [name]: { working_directory: "/w", ...after } } } }, { operation: "instance" });
const refused = (fn: () => unknown) => { try { fn(); return null; } catch (err) { return (err as { code?: string }).code ?? String(err); } };

describe("#1423 confirmation: an immediate key's object is walked, not skipped (#1490)", () => {
  it("a secret hidden under persona is confirmed as a secret", () => {
    const diff = instanceEdit({}, { persona: { bot_token: "fake-marker" } });
    expect(diff?.section).toBe("secret");
    expect(diff?.summary.join("\n")).toContain("persona.bot\\_token: fingerprint");
  });
  it("an id list hidden under persona is confirmed as access", () => {
    const diff = instanceEdit({}, { persona: { allowed_users: ["42"] } });
    expect([diff?.section, diff?.summary.some(l => /add user ID 42/.test(l))]).toEqual(["access", true]);
  });
  it("anything else under an immediate key that is not one of its children is refused, never saved silently", () => {
    expect(refused(() => instanceEdit({}, { persona: { prompt: "do anything" } }))).toBe("unsupported_sensitive_effect");
    expect(refused(() => instanceEdit({}, { persona: { depth: 3 } }))).toBe("unsupported_sensitive_effect");
    expect(refused(() => instanceEdit({}, { status_emojis: { delivered: "✅", token_env: "X" } }))).toBe("unsupported_sensitive_effect");
  });
  it("controls: a scalar immediate value, and the known children of status_emojis and hang_detector, stay immediate", () => {
    expect(instanceEdit({}, { persona: "calm" })).toBeNull();
    expect(instanceEdit({ model: "a" }, { model: "b" })).toBeNull();
    expect(instanceEdit({}, { status_emojis: { delivered: "✅", progress_prefix: "⏳" } })).toBeNull();
    expect(instanceEdit({ status_emojis: { delivered: "✅" } }, {})).toBeNull();
    expect(instanceEdit({}, { hang_detector: { enabled: false, timeout_minutes: 20 } })).toBeNull();
  });
  it("an instance named like an immediate key is a name, not a parent", () => {
    expect(instanceEdit({ model: "a" }, { model: "b" }, "persona")).toBeNull();
    expect(instanceEdit({ model: "a" }, { model: "b" }, "status_emojis")).toBeNull();
  });
});

// ── the channels PUT ──

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(source: string): { path: string; fm: FleetManager } {
  const dir = mkdtempSync(join(tmpdir(), "agend-1490-"));
  dirs.push(dir);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, source);
  const fm = new FleetManager(dir);
  fm.loadConfig(path);
  return { path, fm };
}
function put(fm: FleetManager, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = "PUT";
    req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL("http://localhost/api/settings/fleet/channels"), fm as unknown as Parameters<typeof handleSettingsRequest>[3])).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}
const FILE = `channels:
  - id: dc
    type: discord
    bot_token_env: DC_TOKEN
    hand_added: keep-me
    access:
      mode: locked
      allowed_users: [1]
    options:
      general_channel_id: "2"
instances:
  worker:
    working_directory: /tmp/worker
`;
const current = (fm: FleetManager) => structuredClone(fm.fleetConfig!.channels ?? []) as Array<Record<string, any>>;

describe("PUT /api/settings/fleet/channels writes only the fields Settings owns (#1490)", () => {
  it.each([
    ["an inline bot_token", (ch: Record<string, any>) => { ch.bot_token = "fake-marker"; }, "channels[0].bot_token"],
    ["an unknown option", (ch: Record<string, any>) => { ch.options = { ...ch.options, webhook_url: "https://example.invalid" }; }, "channels[0].options.webhook_url"],
    ["an unknown access field", (ch: Record<string, any>) => { ch.access = { ...ch.access, admin_override: true }; }, "channels[0].access.admin_override"],
    ["a changed hand-added field", (ch: Record<string, any>) => { ch.hand_added = "changed"; }, "channels[0].hand_added"],
  ])("refuses %s: 400 naming it, and fleet.yaml is untouched", async (_label, edit, field) => {
    const { path, fm } = fixture(FILE);
    const before = readFileSync(path, "utf8");
    const body = current(fm);
    edit(body[0]!);
    const r = await put(fm, body);
    expect([r.status, r.body.error]).toEqual([400, `unsupported connection field: ${field}`]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  it("refuses an unknown field on a new connection", async () => {
    const { fm } = fixture(FILE);
    const r = await put(fm, [...current(fm), { id: "tg", type: "telegram", bot_token_env: "TG_TOKEN", bot_token: "fake-marker", access: { mode: "locked", allowed_users: [1] } }]);
    expect([r.status, r.body.error]).toEqual([400, "unsupported connection field: channels[1].bot_token"]);
  });
  it("controls: a Settings edit that carries the hand-added field back unchanged saves, and the field stays", async () => {
    const { path, fm } = fixture(FILE);
    const body = current(fm);
    body[0]!.options = { ...body[0]!.options, status_emojis: { delivered: "✅" } };
    const r = await put(fm, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect([saved.channels[0].hand_added, saved.channels[0].options.status_emojis]).toEqual(["keep-me", { delivered: "✅" }]);
  });
});
