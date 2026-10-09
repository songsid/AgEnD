/**
 * #1056 (with Fable's 2.2 audit): a Settings connection save on a legacy `channel:` fleet.yaml, driven through the
 * real PUT /api/settings/fleet/channels handler and the real FleetManager saver — and the saver's last check: a
 * result that would not load, or would add a config error, never replaces fleet.yaml.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { validateFleetConfig } from "../src/config-validator.js";

const dirs: string[] = [];
function fixture(source: string): { dir: string; path: string; fm: FleetManager } {
  const dir = mkdtempSync(join(tmpdir(), "agend-save-guard-"));
  dirs.push(dir);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, source);
  const fm = new FleetManager(dir);
  fm.loadConfig(path);
  return { dir, path, fm };
}
function settingsRequest(fm: FleetManager, path: string, method: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method;
    req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), fm as unknown as Parameters<typeof handleSettingsRequest>[3])).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LEGACY = `channel:
  type: discord
  bot_token_env: DC_TOKEN
  group_id: "123456789012345678"
  access:
    mode: locked
    allowed_users: [1]
instances:
  worker:
    working_directory: /tmp/worker
`;
const reloadErrors = (dir: string, path: string) => {
  const fm = new FleetManager(dir);
  fm.loadConfig(path);
  return validateFleetConfig(fm.fleetConfig!).errors;
};

describe("a legacy channel: and the Settings channels PUT (#1056)", () => {
  it("adding a second connection writes two complete connections — no null, no bare entry — and the file loads", async () => {
    const { dir, path, fm } = fixture(LEGACY);
    const current = (fm.fleetConfig!.channels ?? []).map(c => ({ ...c }));
    const telegram = { id: "tg", type: "telegram", bot_token_env: "TG_TOKEN", group_id: "-100123", access: { mode: "locked", allowed_users: [1] } };
    const r = await settingsRequest(fm, "/api/settings/fleet/channels", "PUT", [...current, telegram]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect(saved.channel).toBeUndefined();
    expect(saved.channels.map((c: any) => c === null ? null : c?.type)).toEqual(["discord", "telegram"]);
    expect(saved.channels[0]).toMatchObject({ bot_token_env: "DC_TOKEN", group_id: "123456789012345678", access: { mode: "locked", allowed_users: [1] } });
    expect(saved.channels[1]).toMatchObject(telegram);
    expect(reloadErrors(dir, path)).toEqual([]);
  });

  it("an emoji-only edit, the same way: the whole connection plus its emojis", async () => {
    const { dir, path, fm } = fixture(LEGACY);
    const next = (fm.fleetConfig!.channels ?? []).map(c => ({ ...c, options: { status_emojis: { delivered: "✅" } } }));
    const r = await settingsRequest(fm, "/api/settings/fleet/channels", "PUT", next);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect(saved.channels).toHaveLength(1);
    expect(saved.channels[0]).toMatchObject({ type: "discord", bot_token_env: "DC_TOKEN", options: { status_emojis: { delivered: "✅" } } });
    expect(reloadErrors(dir, path)).toEqual([]);
  });
});

describe("the saver never commits a file that would not load or adds an error (#1056 audit)", () => {
  it("a patch that would leave a bare channels[0]: refused, fleet.yaml byte-identical, memory back to what the file says", async () => {
    const { path, fm } = fixture(LEGACY);
    const before = readFileSync(path, "utf8");
    const memoryBefore = structuredClone({ channels: fm.fleetConfig!.channels, channel: fm.fleetConfig!.channel });
    // The pre-fix patcher, in effect: only the changed leaf reaches a new channels list.
    const internals = fm as unknown as { patchFleetDocument: (doc: any, path: unknown[], before: unknown, after: unknown) => void };
    const real = internals.patchFleetDocument.bind(fm);
    vi.spyOn(internals, "patchFleetDocument").mockImplementation((doc: any, p: unknown[], b: unknown, a: unknown) => {
      if (p.length === 0) {
        doc.deleteIn(["channel"]);
        doc.setIn(["channels"], doc.createNode([{ options: { status_emojis: { delivered: "✅" } } }]));
        return;
      }
      real(doc, p, b, a);
    });
    const next = (fm.fleetConfig!.channels ?? []).map(c => ({ ...c, options: { status_emojis: { delivered: "✅" } } }));
    const r = await settingsRequest(fm, "/api/settings/fleet/channels", "PUT", next);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/^Refusing to save fleet\.yaml: it would be invalid \(channels\[0\]\.type: required/);
    expect(readFileSync(path, "utf8"), "fleet.yaml untouched").toBe(before);
    expect({ channels: fm.fleetConfig!.channels, channel: fm.fleetConfig!.channel }, "memory restored").toEqual(memoryBefore);
  });

  it("a result that would not load at all (a null connection) is refused too", () => {
    const { path, fm } = fixture(LEGACY);
    const before = readFileSync(path, "utf8");
    const internals = fm as unknown as { patchFleetDocument: (doc: any, path: unknown[], before: unknown, after: unknown) => void };
    vi.spyOn(internals, "patchFleetDocument").mockImplementation((doc: any) => {
      doc.deleteIn(["channel"]);
      doc.setIn(["channels"], doc.createNode([null, { type: "telegram", bot_token_env: "TG" }]));
    });
    fm.fleetConfig!.instances.worker.description = "changed";
    expect(() => fm.saveFleetConfig()).toThrow(/^Refusing to save fleet\.yaml/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("control: an error already in the file does not block an unrelated save", () => {
    const { path, fm } = fixture(`channels:
  - type: discord
    group_id: "1"
instances:
  worker:
    working_directory: /tmp/worker
`);
    expect(validateFleetConfig(fm.fleetConfig!).errors.map(e => e.path), "the fixture already has the error").toContain("channels[0].bot_token_env");
    fm.fleetConfig!.instances.worker.description = "still saves";
    expect(() => fm.saveFleetConfig()).not.toThrow();
    expect((yaml.load(readFileSync(path, "utf8")) as any).instances.worker.description).toBe("still saves");
  });
});
