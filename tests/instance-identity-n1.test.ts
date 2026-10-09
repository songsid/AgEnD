/**
 * alpha.2, docs/design/web-unified-instance-nav.md §3.1 (review r1): an instance's identity — alias, description,
 * role, tags — is resolved by one rule for both lanes: the status frame (SSE/poll: the sidebar on every page, Chat,
 * Fleet) and /api/profiles (View and its anonymous reader). A profile alias that differs from the config, a profile
 * description over the config's, and ClassicBot rooms are the same in both. Real FleetManager.getUiStatus and the real
 * /api/profiles handler on a scratch data dir; nothing forks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn(() => { throw new Error("a status read must not fork"); }),
  execFileSync: vi.fn(() => { throw new Error("a status read must not fork"); }),
  spawn: vi.fn(() => { throw new Error("a status read must not fork"); }),
  spawnSync: vi.fn(() => { throw new Error("a status read must not fork"); }),
}));

const { FleetManager } = await import("../src/fleet-manager.js");
const { handleViewRequest, resolveInstanceIdentity } = await import("../src/view-api.js");

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function writeProfiles(dir: string, rows: Array<[string, string | null, string | null, string | null]>) {
  const db = new Database(join(dir, "profiles.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS instance_profile (instance_name TEXT PRIMARY KEY, display_name TEXT, avatar_path TEXT, role TEXT, description TEXT, updated_at INTEGER);`);
  const put = db.prepare("INSERT INTO instance_profile (instance_name, display_name, role, description, updated_at) VALUES (?, ?, ?, ?, 0)");
  for (const r of rows) put.run(...r);
  db.close();
}
function fleet(dir: string) {
  const fm = new FleetManager(dir);
  fm.fleetConfig = { defaults: { backend: "claude-code" }, instances: {
    "web-dev": { working_directory: dir, display_name: "Config alias", description: "config description", tags: ["platform"] },
    plain: { working_directory: dir, display_name: "Only config", description: "config only" },
    bare: { working_directory: dir },
  } } as never;
  fm.classicChannels = {
    getAll: () => [{ instanceName: "room-1", channelId: "c1", name: "Room", displayName: "Room One" }, { instanceName: "room-2", channelId: "c2", name: "Room 2", displayName: "Room Two" }],
    getChannelIdByInstance: () => undefined,
    getBackendByInstance: () => "claude-code",
    getModel: () => undefined,
  } as never;
  vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
  return fm;
}
function profilesOf(fm: InstanceType<typeof FleetManager>, dir: string): Array<Record<string, unknown>> {
  let body = "";
  const res = { writeHead() { return res; }, setHeader() {}, end(b?: string) { body = b ?? ""; } } as unknown as ServerResponse;
  handleViewRequest({ method: "GET", headers: {} } as IncomingMessage, res, new URL("http://localhost/api/profiles"), {
    webToken: null, dataDir: dir, fleetConfig: fm.fleetConfig, classicChannels: fm.classicChannels,
    logger: { debug() {}, info() {}, warn() {}, error() {} }, getInstanceStatus: () => "running",
    getUiStatus: () => fm.getUiStatus(), resolveInstanceModel: () => ({ model: "" }),
  } as never);
  return JSON.parse(body);
}
const pick = (r: Record<string, unknown>) => ({ display_name: r.display_name ?? null, description: r.description ?? null, role: r.role ?? null, tags: r.tags });

describe("one identity rule for the status frame and /api/profiles", () => {
  it("profile alias over the config's, profile description over the config's, ClassicBot rooms — the same in both lanes", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-identity-")); dirs.push(dir);
    writeProfiles(dir, [["web-dev", "Profile alias", "builder", "profile description"], ["room-2", "Profiled room", null, null]]);
    const fm = fleet(dir);
    const status = new Map((fm.getUiStatus() as { instances: Array<Record<string, unknown>> }).instances.map(i => [i.name as string, pick(i)]));
    const profiles = new Map(profilesOf(fm, dir).map(r => [r.instance_name as string, pick(r)]));
    const expected = {
      "web-dev": { display_name: "Profile alias", description: "profile description", role: "builder", tags: ["platform"] },
      plain: { display_name: "Only config", description: "config only", role: null, tags: [] },
      bare: { display_name: null, description: null, role: null, tags: [] },
      "room-1": { display_name: "Room One", description: null, role: null, tags: ["classic"] },
      "room-2": { display_name: "Profiled room", description: null, role: null, tags: ["classic"] },
    };
    expect(Object.fromEntries(status), "the status frame").toEqual(expected);
    expect(Object.fromEntries(profiles), "/api/profiles").toEqual(expected);
  });

  it("a status read never creates profiles.db", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-identity-")); dirs.push(dir);
    const fm = fleet(dir);
    const rows = (fm.getUiStatus() as { instances: Array<Record<string, unknown>> }).instances;
    expect([rows.find(r => r.name === "web-dev")?.display_name, existsSync(join(dir, "profiles.db"))]).toEqual(["Config alias", false]);
  });

  it("the rule itself: profile → config → ClassicBot room for the alias; non-string tags dropped", () => {
    expect(resolveInstanceIdentity({ cfg: { display_name: "c", tags: ["a", 1, "b"] }, classic: { displayName: "r" }, profile: { display_name: null, description: null, role: null } }))
      .toEqual({ display_name: "c", description: null, role: null, tags: ["a", "b"] });
    expect(resolveInstanceIdentity({ classic: { displayName: "r" } })).toEqual({ display_name: "r", description: null, role: null, tags: ["classic"] });
  });
});
