/**
 * #1629 r4-5c: effects travel in exported mods — through a real FleetManager and the real effect library (CW1).
 * - A person's export carries every effect placed on the instance (the library's reference check), with the
 *   placement's non-default params; the file imports again, effects and all.
 * - An agent's export carries only effects the agent may read (its own, or shared): a person's private effect placed
 *   on its instance stays out and is counted as effects_omitted.
 * - Two effects of one name get distinct paths.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = () => { throw Error("mod effect tests must not spawn any process"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});

const { WebAppearance } = await import("../src/web-appearance.js");
const { AppearanceLimiter } = await import("../src/web-appearance-policy.js");
const { sendEffectInParts } = await import("../src/web-effect-upload.js");
const { dispatchAgentOperation } = await import("../src/agent-endpoint.js");
const { OPERATOR } = await import("../src/web-prefs.js");
const B = await import("../src/web-mod-bundle.js");
const { buildModBundle } = await import("../src/web-mod-export.js");

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const manifest = (name = "fixture") => ({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name, title: "Fixture", regions: ["chat"], layer: "front", wants: ["state"], params: { size: { type: "number", min: 1, max: 5, default: 2 } } });
const files = (code = "agend.ready()", name = "fixture") => new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify(manifest(name)))], ["worker.js", Buffer.from(code)]]);

async function fixture() {
  const parent = join(process.cwd(), ".artifacts"); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "mod-effects-")); roots.push(dir); vi.stubEnv("AGEND_HOME", dir);
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(dir) as any;
  fm.logger = pino({ level: "silent" });
  fm.fleetConfig = { defaults: {}, instances: Object.fromEntries(["own", "other"].map(n => [n, { working_directory: dir, tool_set: "standard" }])), web: { themes: { agent_edit: true } } };
  vi.spyOn(fm, "startAll").mockRejectedValue(Error("no fleet")); vi.spyOn(fm, "startInstance").mockRejectedValue(Error("no spawn"));
  vi.spyOn(fm, "getUiStatus").mockReturnValue({}); vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});
  let now = 0;
  fm.webAppearanceService = new WebAppearance(fm.themeStore, () => fm.fleetConfig.web, () => {}, new AppearanceLimiter(() => now));
  const op = (name: string, tool: string, args = {}) => dispatchAgentOperation(fm, name, tool, args) as Promise<Record<string, any>>;
  return { fm, dir, op, advance(ms = 31_000) { now += ms; } };
}
async function upload(f: Awaited<ReturnType<typeof fixture>>, name = "own", input = files()) {
  const r = await sendEffectInParts(input, args => f.op(name, "effect-upload", args));
  expect(r.id, JSON.stringify(r)).toEqual(expect.any(String));
  return r.id as string;
}
const ctx = () => ({ agendVersion: "2.3.0", limits: { portrait: { max_width: 1024, max_height: 1536, max_kib: 1536 }, banner: { max_width: 1600, max_height: 600, max_kib: 768 }, quota: { files: 8, bytes: 4 * 1024 * 1024 } } as any, effects: B.cw1EffectChecker() });

describe("effects in a person's export", () => {
  it("every effect placed on the instance, with its params; the file imports again onto another agent, effects and all", async () => {
    const f = await fixture();
    const id = await upload(f);
    expect(await f.op("own", "effect-apply", { id, params: { size: 4 } })).toMatchObject({ id });
    f.fm.themeStore.setTheme("own", { v: 1, accent: "#8b5cf6" }, "agent");
    const { exportMod } = await import("../src/web-api.js");
    const r = exportMod(f.fm, OPERATOR, { instance: "own", name: "with-fx", version: "1.0.0", title: "With fx", include: { theme: true } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const doc = JSON.parse(r.text);
    expect(doc.manifest.contents.effects).toEqual(["effects/fixture"]);
    expect(Object.keys(doc.files).filter((p: string) => p.startsWith("effects/")).sort()).toEqual(["effects/fixture/effect.json", "effects/fixture/worker.js"]);
    expect(JSON.parse(Buffer.from(doc.files["theme.json"].b64, "base64").toString()).effects).toEqual([{ effect: "effects/fixture", params: { size: 4 } }]);
    const checked = B.checkModBundle(r.text, ctx());
    expect(checked.ok, JSON.stringify(!checked.ok && checked.problems)).toBe(true);
    if (checked.ok) expect(checked.mod.effects.map(e => e.summary.id)).toEqual([id]);       // the same entry: the same id
    // And back in, onto the other agent, as a person.
    const staged = f.fm.mods.stage(OPERATOR, r.text);
    expect(staged.ok, JSON.stringify(staged)).toBe(true);
    expect(f.fm.mods.commit(OPERATOR, { stage: staged.stage, plan_hash: staged.plan_hash, include: { theme: true, effects: true }, target: "other" })).toMatchObject({ ok: true });
    expect(f.fm.themeStore.get("other").placements.effects).toMatchObject([{ id, by: "human", params: { size: 4 } }]);
  });
  it("two effects of one name get distinct paths", () => {
    const one = files("agend.ready()"), two = files("agend.ready();");
    const r = buildModBundle({ name: "x", version: "1.0.0", title: "x" }, { theme: { theme: { v: 1 }, picture: () => null, effects: [{ name: "fixture", files: one, params: {} }, { name: "fixture", files: two, params: { size: 3 } }] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = JSON.parse(r.text);
    expect(doc.manifest.contents.effects).toEqual(["effects/fixture", "effects/fixture-2"]);
    expect(B.checkModBundle(r.text, ctx()).ok).toBe(true);
  });
});

describe("effects in an agent's export", () => {
  it("its own effect travels; a person's private effect placed on it stays out (effects_omitted)", async () => {
    const f = await fixture();
    const own = await upload(f);
    const lib = f.fm.effectLibrary;
    const stage = lib.stage(files("// a person's", "private"), { kind: "human", id: OPERATOR });
    if (!stage.ok) throw Error(stage.error);
    const committed = lib.commit(stage.stageId);
    if (!committed.ok) throw Error(committed.error);
    const theirs = committed.ids[0]!;
    expect(f.fm.themeStore.setPlacements("own", { effects: [{ id: own }, { id: theirs }] }, "human", () => null).ok).toBe(true);
    f.fm.themeStore.setTheme("own", { v: 1, accent: "#8b5cf6" }, "agent");
    const r = f.fm.agentMods.handle("own", "export_web_mod", { name: "mine", version: "1.0.0" }) as any;
    expect(r.effects_omitted).toBe(1);
    const text = Buffer.from(r.files[0].data_b64, "base64").toString("utf8");
    const checked = B.checkModBundle(text, ctx());
    expect(checked.ok, JSON.stringify(!checked.ok && checked.problems)).toBe(true);
    if (checked.ok) expect(checked.mod.effects.map(e => e.summary.id)).toEqual([own]);
    expect(Object.keys(JSON.parse(text).files).filter((p: string) => p.startsWith("effects/")), "only its own entry's files").toEqual(["effects/fixture/effect.json", "effects/fixture/worker.js"]);
  });
});
