/**
 * #2208: fleet.yaml anchors and aliases. A Settings write changes the place it names and nothing else — whichever side
 * holds the anchor — and the confirmation's scope is what is written.
 * - unshareParsed: one value per place at load; a recursive alias and an alias "bomb" refuse.
 * - detachForWrite / changedOutside on documents: an alias on the path, an anchor on the path, an anchor inside what
 *   is replaced or deleted, a shared mapping, a shared scalar; untouched anchors stay.
 * - FleetManager.saveFleetConfig (real load and save, scratch home): the issue's cases A–D, a nested shared mapping,
 *   a shared value outside `channels`, and the round trip that keeps an anchor nothing touches (B).
 * - The confirmation: the held change's scope for an edit of one connection is that connection.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseDocument } from "yaml";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const home = mkdtempSync(join(tmpdir(), "agend-2208-home-")); roots.push(home);
process.env.AGEND_HOME = home;                                                  // before fleet-manager is imported
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));

import { changedOutside, detachForWrite, unshareParsed, UNSHARE_MAX_VALUES } from "../src/yaml-shared-nodes.js";
import { loadFleetConfig, loadRawFleetConfig } from "../src/config.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";

let FleetManager: typeof import("../src/fleet-manager.js").FleetManager;
beforeAll(async () => { ({ FleetManager } = await import("../src/fleet-manager.js")); });
afterEach(() => { for (const r of roots.splice(1)) rmSync(r, { recursive: true, force: true }); });

describe("unshareParsed: one value per place", () => {
  it("an anchor and its alias become two equal copies; other values are kept as they are", () => {
    const parsed = yaml.load("a: &x [1, {k: 2}]\nb: *x\nwhen: 2026-10-19\n") as any;
    expect(parsed.a).toBe(parsed.b);                                           // what js-yaml gives
    const out = unshareParsed(parsed);
    expect([out.a === out.b, out.a[1] === out.b[1], out.a, out.b, out.when instanceof Date]).toEqual([false, false, [1, { k: 2 }], [1, { k: 2 }], true]);
    out.a.push(3);
    expect(out.b).toEqual([1, { k: 2 }]);
  });
  it("a key named __proto__ stays a key", () => {
    const out = unshareParsed(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}')) as any;
    expect([Object.keys(out), ({} as any).polluted, Object.getPrototypeOf(out) === Object.prototype]).toEqual([["__proto__", "a"], undefined, true]);
  });
  it("a value that contains itself refuses, naming the file", () => {
    const loop: any[] = []; loop.push(loop);
    expect(() => unshareParsed({ a: loop }, "fleet.yaml")).toThrow(/fleet\.yaml has a value that contains itself/);
  });
  it("an alias bomb refuses instead of filling memory", () => {
    let level: unknown = ["x"];
    for (let i = 0; i < 8; i++) level = Array(10).fill(level);                // 10^8 places, 10 objects
    expect(() => unshareParsed(level, "fleet.yaml")).toThrow(new RegExp(`more than ${UNSHARE_MAX_VALUES} values`));
  });
});

const doc = (text: string) => parseDocument(text);
describe("detachForWrite: a write changes the place it names", () => {
  it("an alias on the path becomes its own copy; the anchor and its other aliases stay", () => {
    const d = doc("a: &x [1]\nb: *x\nc: *x\n");
    detachForWrite(d, ["b", 1]); d.setIn(["b", 1], 2);
    expect([d.toJS(), String(d)]).toEqual([{ a: [1], b: [1, 2], c: [1] }, "a: &x [ 1 ]\nb: [ 1, 2 ]\nc: *x\n"]);
  });
  it("an anchor on the path: every other alias gets a copy of it as it was, and the anchor goes", () => {
    const d = doc("a: &x [1]\nb: *x\nc: *x\n");
    detachForWrite(d, ["a", 1]); d.setIn(["a", 1], 2);
    expect([d.toJS(), String(d).includes("&x")]).toEqual([{ a: [1, 2], b: [1], c: [1] }, false]);
  });
  it("a shared mapping, edited deep inside on either side", () => {
    const text = "one:\n  access: &acc\n    mode: locked\n    users: [u1]\ntwo:\n  access: *acc\n";
    const viaAlias = doc(text); detachForWrite(viaAlias, ["two", "access", "users", 1]); viaAlias.setIn(["two", "access", "users", 1], "u2");
    const viaAnchor = doc(text); detachForWrite(viaAnchor, ["one", "access", "mode"]); viaAnchor.setIn(["one", "access", "mode"], "open");
    expect([viaAlias.toJS(), viaAnchor.toJS()]).toEqual([
      { one: { access: { mode: "locked", users: ["u1"] } }, two: { access: { mode: "locked", users: ["u1", "u2"] } } },
      { one: { access: { mode: "open", users: ["u1"] } }, two: { access: { mode: "locked", users: ["u1"] } } }]);
  });
  it("a shared scalar changed in place", () => {
    const d = doc("port: &p 80\nother: *p\n");
    detachForWrite(d, ["port"]);
    (d.getIn(["port"], true) as any).value = 81;
    expect(d.toJS()).toEqual({ port: 81, other: 80 });
  });
  it("an anchor inside what is deleted: its aliases elsewhere keep their value", () => {
    const d = doc("instances:\n  a:\n    roots: &r [x]\n  b:\n    roots: *r\n");
    detachForWrite(d, ["instances", "a"]); d.deleteIn(["instances", "a"]);
    expect([d.toJS(), d.errors, String(d)]).toEqual([{ instances: { b: { roots: ["x"] } } }, [], "instances:\n  b:\n    roots: [ x ]\n"]);
  });
  it("an alias inside the anchored value is copied too, so nothing dangles", () => {
    const d = doc("base: &b {m: 1}\none: &o {inner: *b}\ntwo: *o\n");
    detachForWrite(d, ["one", "inner", "m"]); d.setIn(["one", "inner", "m"], 2);
    expect([d.toJS(), d.errors, String(d).includes("*")]).toEqual([{ base: { m: 1 }, one: { inner: { m: 2 } }, two: { inner: { m: 1 } } }, [], false]);
  });
  it("an anchor whose value holds an alias of itself: kept as it is (its own alias is not copied into itself)", () => {
    const d = doc("a: &x [1, *x]\n");
    detachForWrite(d, ["a", 0]); d.setIn(["a", 0], 2);
    expect(String(d)).toBe("a: &x [ 2, *x ]\n");
  });
  it("aliases nested more than 64 deep refuse instead of recursing on", () => {
    const text = ["a0: &a0 [1]", ...Array.from({ length: 69 }, (_, i) => `a${i + 1}: &a${i + 1} [*a${i}]`), "last: *a69", ""].join("\n");
    const d = doc(text);
    expect(() => detachForWrite(d, ["a69", 0])).toThrow(/nests its aliases too deeply/);
  });
  it("a write nowhere near a shared value leaves the anchors as written", () => {
    const d = doc("a: &x [1]\nb: *x\nc: 1\n");
    detachForWrite(d, ["c"]); d.setIn(["c"], 2);
    expect(String(d)).toBe("a: &x [ 1 ]\nb: *x\nc: 2\n");                         // reprinted, anchor and alias kept
  });
});

describe("changedOutside: what a save may change", () => {
  it("covered, unrelated, and a change outside every write", () => {
    const before = { channels: [{ id: "a", u: [1] }, { id: "b", u: [1] }], x: 1 };
    expect(changedOutside(before, { ...before, channels: [{ id: "a", u: [1, 2] }, { id: "b", u: [1] }] }, [["channels", 0, "u", 1]])).toBeNull();
    expect(changedOutside(before, { ...before, channels: [{ id: "a", u: [1, 2] }, { id: "b", u: [1, 2] }] }, [["channels", 0, "u", 1]])).toBe("channels.1.u");          // as deep as it differs (a list that grew: the list)
    expect(changedOutside(before, { ...before, x: 2 }, [["channels", 0]])).toBe("x");
    expect(changedOutside(before, { y: 1 }, [[]])).toBeNull();
  });
});

// ── The fleet's own load and save ──
const FLEET = `channels:
  - id: main
    type: telegram
    bot_token_env: MAIN_BOT_TOKEN
    group_id: "-1001"
    access:
      mode: locked
      allowed_users: &admins ["111"]
  - id: side
    type: telegram
    bot_token_env: SIDE_BOT_TOKEN
    group_id: "-1002"
    access:
      mode: locked
      allowed_users: *admins
instances:
  general:
    working_directory: /tmp
    general_topic: true
  worker:
    working_directory: /tmp
`;
function fleetOn(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2208-")); roots.push(dir);
  const path = join(dir, "fleet.yaml"); writeFileSync(path, text);
  const fm = new FleetManager(dir) as any;
  fm.loadConfig(path);
  const file = () => readFileSync(path, "utf8");
  const users = () => (loadRawFleetConfig(path).channels as any[]).map(c => c.access.allowed_users);
  return { fm, path, file, users };
}
const freshChannels = (fm: any, i: number, users: string[]) => {
  const list = JSON.parse(JSON.stringify(fm.fleetConfig.channels)); list[i].access.allowed_users = users; fm.fleetConfig.channels = list;
};

describe("FleetManager: a Settings save through a shared node changes only the place it names (#2208 A–D)", () => {
  it("loaded, the two connections' lists are two arrays (in the config and the raw config)", () => {
    const f = fleetOn(FLEET);
    expect([f.fm.fleetConfig.channels[0].access.allowed_users === f.fm.fleetConfig.channels[1].access.allowed_users,
      f.fm.rawFleetConfig.channels[0].access.allowed_users === f.fm.rawFleetConfig.channels[1].access.allowed_users]).toEqual([false, false]);
    const cfg = loadFleetConfig(f.path);
    expect(cfg.channels![0]!.access!.allowed_users === cfg.channels![1]!.access!.allowed_users).toBe(false);
  });
  it.each([
    ["A: main's list edited in place", (fm: any) => fm.fleetConfig.channels[0].access.allowed_users.push("222"), [["111", "222"], ["111"]]],
    ["C: a fresh list for main (the anchor holder), as a Settings PUT sends", (fm: any) => freshChannels(fm, 0, ["111", "222"]), [["111", "222"], ["111"]]],
    ["D: a fresh list for side (the alias holder)", (fm: any) => freshChannels(fm, 1, ["111", "222"]), [["111"], ["111", "222"]]],
  ] as const)("%s", (_n, change, expected) => {
    const f = fleetOn(FLEET);
    change(f.fm);
    f.fm.saveFleetConfig();
    expect(f.users()).toEqual(expected);
    expect(parseDocument(f.file()).errors).toEqual([]);
  });
  it("B: deleting an agent, nothing else — saved, and the anchor stays as written", () => {
    const f = fleetOn(FLEET);
    delete f.fm.fleetConfig.instances.worker;
    f.fm.saveFleetConfig();
    expect([f.users(), /allowed_users: &admins \[ ?"111" ?\]/.test(f.file()), f.file().includes("allowed_users: *admins"), Object.keys(loadRawFleetConfig(f.path).instances!)])
      .toEqual([[["111"], ["111"]], true, true, ["general"]]);
  });
  it("a whole shared access mapping: the mode changed on one connection only", () => {
    const f = fleetOn(FLEET.replace("    access:\n      mode: locked\n      allowed_users: &admins [\"111\"]", "    access: &acc\n      mode: locked\n      allowed_users: [\"111\"]")
      .replace("    access:\n      mode: locked\n      allowed_users: *admins", "    access: *acc"));
    expect(f.fm.fleetConfig.channels[1].access).toEqual({ mode: "locked", allowed_users: ["111"] });
    f.fm.fleetConfig.channels = JSON.parse(JSON.stringify(f.fm.fleetConfig.channels));
    f.fm.fleetConfig.channels[1].access.mode = "open";
    f.fm.saveFleetConfig();
    expect((loadRawFleetConfig(f.path).channels as any[]).map(c => c.access.mode)).toEqual(["locked", "open"]);
  });
  it("a value shared between two agents: one agent's edit leaves the other's", () => {
    const f = fleetOn(FLEET.replace("  general:\n    working_directory: /tmp\n    general_topic: true\n  worker:\n    working_directory: /tmp\n",
      "  general:\n    working_directory: /tmp\n    general_topic: true\n  worker:\n    working_directory: /tmp\n    description: &d shared words\n  helper:\n    working_directory: /tmp\n    description: *d\n"));
    f.fm.fleetConfig.instances.helper.description = "its own words";
    f.fm.saveFleetConfig();
    const raw = loadRawFleetConfig(f.path).instances as any;
    expect([raw.worker.description, raw.helper.description]).toEqual(["shared words", "its own words"]);
  });
});

describe("FleetManager: deletes keep what other places share with the deleted value", () => {
  const AGENTS = FLEET.replace("  worker:\n    working_directory: /tmp\n", "  worker:\n    working_directory: /tmp\n    description: &d shared words\n    log_level: &lvl info\n  helper:\n    working_directory: /tmp\n    description: *d\n    tags_note: *lvl\n");
  it("an explicit removal of an agent holding the anchor", () => {
    const f = fleetOn(AGENTS);
    delete f.fm.fleetConfig.instances.worker;
    f.fm.saveFleetConfig([{ path: ["instances", "worker"], remove: true }]);
    const raw = loadRawFleetConfig(f.path).instances as any;
    expect([Object.keys(raw), raw.helper.description, raw.helper.tags_note, parseDocument(f.file()).errors]).toEqual([["general", "helper"], "shared words", "info", []]);
  });
  it("an explicit removal alone (memory unchanged): the value it removes stays where another place shares it", () => {
    const f = fleetOn(FLEET.replace("  worker:\n    working_directory: /tmp\n", "  worker:\n    working_directory: /tmp\n    log_level: &lvl debug\n  helper:\n    working_directory: /tmp\n    tags_note: *lvl\n"));
    f.fm.saveFleetConfig([{ path: ["instances", "worker", "log_level"], remove: true }]);
    const raw = loadRawFleetConfig(f.path).instances as any;
    expect([raw.worker.log_level, raw.helper.tags_note, parseDocument(f.file()).errors]).toEqual([undefined, "debug", []]);
  });
  it("a value equal to the default, removed on save, that another place shares", () => {
    const f = fleetOn(AGENTS);
    f.fm.fleetConfig.instances.general.description = "something else changed";        // any save
    f.fm.saveFleetConfig();
    const raw = loadRawFleetConfig(f.path).instances as any;
    expect([raw.worker.log_level, raw.helper.tags_note]).toEqual([undefined, "info"]);
  });
  it("the last connection removed while a later place shares one of its values", () => {
    const f = fleetOn(FLEET.replace('group_id: "-1002"', 'group_id: &g "-1002"').replace("  worker:\n    working_directory: /tmp\n", "  worker:\n    working_directory: /tmp\n    description: *g\n"));
    f.fm.fleetConfig.channels = JSON.parse(JSON.stringify(f.fm.fleetConfig.channels.slice(0, 1)));
    f.fm.saveFleetConfig();
    const raw = loadRawFleetConfig(f.path) as any;
    expect([raw.channels.map((c: any) => c.id), raw.instances.worker.description]).toEqual([["main"], "-1002"]);
  });
});

describe("the confirmation's scope is what is written", () => {
  it("adding a user to main's list (the anchor holder) is a change to main only — and only main changes on disk", () => {
    const f = fleetOn(FLEET);
    const body = JSON.parse(JSON.stringify(f.fm.fleetConfig.channels)); body[0].access.allowed_users = ["111", "222"];
    const effect = prepareSettingsEffect("PUT", "/api/settings/fleet/channels", body, { config: f.fm.fleetConfig, classic: {} });
    expect([effect.diff?.affectedConnections, effect.diff?.authority?.connections]).toEqual([["main"], ["main"]]);
    f.fm.fleetConfig.channels = body;
    f.fm.saveFleetConfig();
    expect(f.users()).toEqual([["111", "222"], ["111"]]);
  });
});
