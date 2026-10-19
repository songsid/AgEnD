/**
 * #2211: a key fleet.yaml leaves to its default (a connection's `mode` → topic, its `id` → its type) is not "changed" by
 * being absent from a channels write. The Settings page sends the raw list (GET /api/settings/fleet/raw has no
 * defaults), so one connection's edit was held as a change to every connection (`mode: topic → absent`), and its
 * confirmation asked the admins of all of them.
 * - The held change (prepareSettingsEffect): the edited connection only; a real mode change is still one.
 * - The real PUT handler and FleetManager saver: memory keeps the defaults a load gives, fleet.yaml gains no `mode:`.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { channelWithDefaults, loadFleetConfig, loadRawFleetConfig } from "../src/config.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function file(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2211-")); dirs.push(dir);
  const path = join(dir, "fleet.yaml"); writeFileSync(path, text);
  return { dir, path };
}
const FLEET = (main = "", side = "") => `channels:
  - id: main
    type: telegram
${main}    bot_token_env: MAIN_BOT_TOKEN
    group_id: "-1001"
    access: { mode: locked, allowed_users: ["111"] }
  - id: side
    type: telegram
${side}    bot_token_env: SIDE_BOT_TOKEN
    group_id: "-1002"
    access: { mode: locked, allowed_users: ["111"] }
instances: {}
`;
/** What the Settings page sends: the raw channels (no defaults filled in), changed by `edit`. */
function held(text: string, edit: (channels: any[]) => void) {
  const { path } = file(text);
  const body = structuredClone((loadRawFleetConfig(path) as any).channels); edit(body);
  const diff = prepareSettingsEffect("PUT", "/api/settings/fleet/channels", body, { config: loadFleetConfig(path), classic: {} }).diff;
  return { affected: diff?.affectedConnections, lines: diff?.summary.slice(1) ?? [] };
}
const addUser = (channels: any[]) => channels[0].access.allowed_users.push("222");

describe("the held change names what changed, not what was left to its default", () => {
  it("no mode in fleet.yaml: adding a user to main is a change to main only", () => {
    expect(held(FLEET(), addUser)).toEqual({ affected: ["main"], lines: ["fleet.channels.main.access.allowed\\_users: add fleet admin (F) ID 222"] });
  });
  it("mode: topic written out, then left out of the write: no change", () => {
    expect(held(FLEET("    mode: topic\n", "    mode: topic\n"), (chs) => { for (const ch of chs) delete ch.mode; addUser(chs); }).affected).toEqual(["main"]);
  });
  it("mode: group written out, then left out of the write: a change — to the default, topic — on that connection only", () => {
    expect(held(FLEET("", "    mode: group\n"), (chs) => { delete chs[1].mode; })).toEqual({ affected: ["side"], lines: ["fleet.channels.side.mode: group → topic"] });
  });
  it("no id written (it is its type): no id change", () => {
    const text = FLEET().replace("  - id: side\n    type: telegram\n", "  - type: discord\n").replace('group_id: "-1002"', 'group_id: "777"');
    expect(held(text, addUser)).toEqual({ affected: ["main"], lines: ["fleet.channels.main.access.allowed\\_users: add fleet admin (F) ID 222"] });
  });
  it("channelWithDefaults is the load's own rule", () => {
    expect([channelWithDefaults({ type: "discord" }), channelWithDefaults({ id: "x", type: "telegram", mode: "group" })])
      .toEqual([{ type: "discord", id: "discord", mode: "topic" }, { id: "x", type: "telegram", mode: "group" }]);
  });
});

function settingsRequest(fm: FleetManager, path: string, method: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method; req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), fm as unknown as Parameters<typeof handleSettingsRequest>[3])).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}

describe("the real PUT handler and saver", () => {
  it("memory keeps the defaults a load gives; fleet.yaml gets the user and no mode: line", async () => {
    const { dir, path } = file(FLEET());
    const fm = new FleetManager(dir); fm.loadConfig(path);
    const body = structuredClone((loadRawFleetConfig(path) as any).channels); addUser(body);
    const r = await settingsRequest(fm, "/api/settings/fleet/channels", "PUT", body);
    expect(r.status).toBe(200);
    expect(fm.fleetConfig!.channels!.map(c => [c.id, c.mode])).toEqual([["main", "topic"], ["side", "topic"]]);
    const text = readFileSync(path, "utf8");
    expect([/mode: topic/.test(text), (loadRawFleetConfig(path) as any).channels[0].access.allowed_users]).toEqual([false, ["111", "222"]]);
  });
});
