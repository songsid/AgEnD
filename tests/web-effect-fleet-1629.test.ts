import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const refuse = () => { throw Error("effect tests must not spawn any process"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
import { AppearanceLimiter } from "../src/web-appearance-policy.js";
import { WebAppearance } from "../src/web-appearance.js";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { sendEffectInParts } from "../src/web-effect-upload.js";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { OPERATOR } from "../src/web-prefs.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const manifest = { v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["chat"], layer: "front", wants: ["state"], params: { size: { type: "number", min: 1, max: 5, default: 2 } } };
const files = (code = "agend.ready()") => new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify(manifest))], ["worker.js", Buffer.from(code)]]);
async function fixture() {
  const parent = join(process.cwd(), ".artifacts"); mkdirSync(parent, { recursive: true }); const dir = mkdtempSync(join(parent, "effect-fleet-")); roots.push(dir); vi.stubEnv("AGEND_HOME", dir);
  const { FleetManager } = await import("../src/fleet-manager.js"); const fm = new FleetManager(dir) as any;
  fm.logger = pino({ level: "silent" }); fm.fleetConfig = { defaults: {}, instances: Object.fromEntries(["own", "other", "constructor"].map(name => [name, { working_directory: dir, tool_set: "standard" }])), web: { themes: { agent_edit: true } } };
  vi.spyOn(fm, "startAll").mockRejectedValue(Error("test must not start a fleet")); vi.spyOn(fm, "startInstance").mockRejectedValue(Error("test must not spawn an instance"));
  vi.spyOn(fm, "getUiStatus").mockReturnValue({}); const events = vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});
  let now = 0; fm.webAppearanceService = new WebAppearance(fm.themeStore, () => fm.fleetConfig.web, () => {}, new AppearanceLimiter(() => now));
  return { fm, dir, events, advance(ms = 30000) { now += ms; }, op: (name: string, tool: string, args = {}) => dispatchAgentOperation(fm, name, tool, args) as Promise<Record<string, any>> };
}
async function upload(f: Awaited<ReturnType<typeof fixture>>, name = "own", input = files()) {
  const r = await sendEffectInParts(input, args => f.op(name, "effect-upload", args)); expect(r.id, JSON.stringify(r)).toEqual(expect.any(String)); return r.id as string;
}
function human(f: Awaited<ReturnType<typeof fixture>>, code = "// human") {
  const lib: WebEffectLibrary = f.fm.effectLibrary, stage = lib.stage(files(code), { kind: "human", id: OPERATOR });
  if (!stage.ok) throw Error(stage.error); const r = lib.commit(stage.stageId); if (!r.ok) throw Error(r.error); return r.ids[0]!;
}
function mod(version = "1.0.0", code = "agend.ready()") {
  const file = (s: string) => ({ sha256: createHash("sha256").update(s).digest("hex"), b64: Buffer.from(s).toString("base64") });
  return JSON.stringify({ format: "agend-mod", v: 1, manifest: { name: "fixture", version, title: "Fixture", contents: { theme: "theme.json", effects: ["effects/fixture"] } }, files: {
    "theme.json": file(JSON.stringify({ v: 1, accent: "#8b5cf6", effects: [{ effect: "effects/fixture", params: { size: 3 } }] })),
    "effects/fixture/effect.json": file(JSON.stringify(manifest)), "effects/fixture/worker.js": file(code),
  } });
}
function install(f: Awaited<ReturnType<typeof fixture>>, version = "1.0.0", code = "agend.ready()", replace = false) {
  const staged = f.fm.mods.stage(OPERATOR, mod(version, code)); expect(staged.ok, JSON.stringify(staged)).toBe(true);
  const r = f.fm.mods.commit(OPERATOR, { stage: staged.stage, plan_hash: staged.plan_hash, target: "own", include: { theme: true, effects: true, replace } });
  return r;
}
describe("#1629 real Fleet effect tool integration", () => {
  it("agent endpoint → Fleet → real library/ThemeStore, scoped by caller and typed params", async () => {
    const f = await fixture(), id = await upload(f);
    expect(await f.op("other", "effect-apply", { id })).toMatchObject({ error: "not_found" });
    expect(await f.op("own", "effect-apply", { id, params: { size: 4 } })).toMatchObject({ id, region: "chat", params: { size: 4 } });
    expect(f.fm.themeStore.get("own").placements.effects).toEqual([{ id, params: { size: 4 }, by: "agent", at: expect.any(Number) }]);
    expect(f.fm.themeStore.get("other").placements.effects).toEqual([]);
    expect(await f.op("own", "theme-get")).toMatchObject({ effects: [{ id, by: "agent", params: { size: 4 } }] });
    expect(f.fm.startAll).not.toHaveBeenCalled(); expect(f.fm.startInstance).not.toHaveBeenCalled();
  });
  it("typed IPC owns the same caller and returns a correlated response", async () => {
    const f = await fixture(), id = await upload(f); const send = vi.fn(); f.fm.instanceIpcClients.set("own", { send });
    f.fm.dispatchTypedIpc("own", { type: "fleet_apply_web_effect", fleetRequestId: "request", payload: { id, instance: "other" } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce()); expect(send.mock.calls[0]![0]).toMatchObject({ type: "fleet_web_theme_response", fleetRequestId: "request", result: { error: "effect_args" } });
    f.fm.dispatchTypedIpc("own", { type: "fleet_apply_web_effect", fleetRequestId: "valid", payload: { id } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2)); expect(send.mock.calls[1]![0]).toMatchObject({ fleetRequestId: "valid", result: { id, region: "chat" } });
    expect(f.fm.themeStore.get("other").placements.effects).toEqual([]);
  });
  it("doesn't return a held asynchronous answer to a replacement IPC connection", async () => {
    const f = await fixture(), id = await upload(f), old = { send: vi.fn() }, next = { send: vi.fn() };
    let release!: (v: unknown) => void; const held = new Promise(r => { release = r; });
    vi.spyOn(f.fm, "handleWebThemeHttp").mockReturnValue(held); f.fm.instanceIpcClients.set("own", old);
    f.fm.dispatchTypedIpc("own", { type: "fleet_preview_web_effect", fleetRequestId: "held", payload: { id } });
    f.fm.instanceIpcClients.set("own", next); release({ accepted: true }); await held; await Promise.resolve();
    expect(old.send).not.toHaveBeenCalled(); expect(next.send).not.toHaveBeenCalled();
  });
  it("uses the existing theme switch/lock/limiter and never spends quota on a refusal", async () => {
    const f = await fixture(), id = await upload(f);
    f.fm.fleetConfig.web.themes.agent_edit = false; expect(await f.op("own", "effect-apply", { id })).toMatchObject({ error: "theme_editing_off" });
    f.fm.fleetConfig.web.themes.agent_edit = true; f.fm.themeStore.setLocked("own", true);
    expect(await f.op("own", "effect-apply", { id })).toMatchObject({ error: "locked" }); f.fm.themeStore.setLocked("own", false);
    expect(await f.op("own", "effect-apply", { id, params: { size: 9 } })).toMatchObject({ error: "effect_params" });
    expect(f.fm.webAppearance.limiter.remaining("own").changes).toBe(10);
    expect(await f.op("own", "effect-apply", { id })).toMatchObject({ id });
    expect(await f.op("own", "theme-set", { set: { font: "mono" } })).toMatchObject({ error: "rate_limited" });
    f.advance(); expect(await f.op("own", "theme-set", { set: { font: "mono" } })).toMatchObject({ theme: { font: "mono" } });
    expect(await f.op("own", "effect-remove")).toMatchObject({ error: "rate_limited" });
  });
  it("retains a human-private effect without granting its bytes or changing its provenance", async () => {
    const f = await fixture(), privateId = human(f), ownId = await upload(f);
    f.fm.themeStore.setPlacements("own", { effects: [{ id: privateId, params: { size: 3 } }] }, "human", () => null);
    const before = f.fm.themeStore.get("own").placements.effects[0];
    expect(await f.op("own", "effect-apply", { id: ownId })).toMatchObject({ id: ownId });
    expect(f.fm.themeStore.get("own").placements.effects[0]).toEqual(before);
    expect(f.fm.effectLibrary.read(privateId, { kind: "agent", id: "own" }).ok).toBe(false);
    f.advance(); expect(await f.op("own", "effect-remove", { id: ownId })).toMatchObject({ removed: [ownId] });
    expect(f.fm.themeStore.get("own").placements.effects).toEqual([before]);
  });
  it("a deliberate agent re-apply of a shared human effect restamps agent provenance", async () => {
    const f = await fixture(), id = human(f); f.fm.effectLibrary.setShared(id, { kind: "human", id: OPERATOR }, true);
    f.fm.themeStore.setPlacements("own", { effects: [{ id }] }, "human", () => null);
    expect(await f.op("own", "effect-apply", { id })).toMatchObject({ id }); expect(f.fm.themeStore.get("own").placements.effects[0].by).toBe("agent");
  });
  it("refuses unknown callers, malformed payloads and private previews; never fabricates a card/profile", async () => {
    const f = await fixture(), id = await upload(f);
    expect(await f.fm.handleWebThemeHttp("missing", "list_web_effects", {})).toEqual({ error: "unknown_instance" });
    expect(await f.op("own", "effect-list", { instance: "other" })).toMatchObject({ error: "effect_args" });
    expect(await f.op("other", "effect-preview", { id })).toEqual({ error: "not_found" });
    expect(await f.op("own", "effect-preview", { id })).toMatchObject({ error: "effects_unavailable" });
    expect(await f.op("own", "effect-profile", { id })).toEqual({ records: [], status: "unavailable" });
    expect(f.events.mock.calls.some(c => c[0] === "message")).toBe(false);
  });
  it.each(["web-themes.json", "web-prefs.json", "web-mods.json"])("refuses unknown references from %s instead of publishing new claims", async file => {
    const f = await fixture(); writeFileSync(join(f.dir, file), "not JSON");
    const r = await sendEffectInParts(files(), args => f.op("own", "effect-upload", args));
    expect(r.error).toEqual(expect.any(String)); expect(f.fm.effectLibrary.list({ kind: "agent", id: "own" })).toMatchObject({ entries: [] });
    expect(f.fm.webAppearance.limiter.remaining("own").uploads).toBe(3);
    // The library provider is an independent fence, including human/mod callers that do not use agent authorization.
    const staged = f.fm.effectLibrary.stage(files(), { kind: "human", id: OPERATOR }); expect(staged.ok).toBe(true);
    expect(f.fm.effectLibrary.commit(staged.stageId)).toMatchObject({ ok: false, error: "references_unreadable" });
    expect(f.fm.effectLibrary.list({ kind: "human", id: OPERATOR })).toMatchObject({ entries: [] });
  });
  it("does not publish a library whose reference registration failed", async () => {
    const f = await fixture(), original = WebEffectLibrary.prototype.registerReferenceSource; let calls = 0;
    const spy = vi.spyOn(WebEffectLibrary.prototype, "registerReferenceSource").mockImplementation(function (this: WebEffectLibrary, ...args) { if (++calls === 2) throw Error("registration failed"); return original.apply(this, args); });
    expect(() => f.fm.effectLibrary).toThrow("registration failed"); expect(f.fm.effectLibraryInstance).toBeUndefined(); spy.mockRestore();
    expect(await upload(f)).toEqual(expect.any(String));
  });
});
describe("#1629 actual mod participant and collection", () => {
  it("installs using the real checker/library, releases only its holder and collects after the last placement drops", async () => {
    const f = await fixture(), r = install(f); expect(r.ok, JSON.stringify(r)).toBe(true);
    const entry = f.fm.mods.list().mods[0], id = entry.effects[0].id;
    expect(f.fm.themeStore.get("own").placements.effects).toEqual([{ id, params: { size: 3 }, by: "human", at: expect.any(Number) }]);
    expect(f.fm.effectLibrary.read(id, { kind: "human", id: OPERATOR }).ok).toBe(true);
    expect(f.fm.mods.uninstall(entry.id)).toMatchObject({ ok: true, released: [id] });
    await Promise.resolve(); expect(f.fm.effectLibrary.readReferenced(id, "instance:own").ok).toBe(true);
    expect(f.fm.effectLibrary.read(id, { kind: "human", id: OPERATOR }).ok).toBe(false);
    f.fm.webAppearance.humanReset("own"); await vi.waitFor(() => expect(existsSync(join(f.dir, "web-effects", id))).toBe(false));
  });
  it("uninstall and reset retain an independent direct upload claim", async () => {
    const f = await fixture(), id = human(f, "agend.ready()"), r = install(f); expect(r.ok).toBe(true);
    expect(f.fm.mods.uninstall(r.id)).toMatchObject({ ok: true }); f.fm.webAppearance.humanReset("own"); await Promise.resolve();
    expect(f.fm.effectLibrary.read(id, { kind: "human", id: OPERATOR }).ok).toBe(true); expect(existsSync(join(f.dir, "web-effects", id))).toBe(true);
  });
  it("rolls real library claims and placements back when the mod index write fails", async () => {
    const f = await fixture(), before = f.fm.themeStore.get("own");
    vi.spyOn(f.fm.mods, "commitIndex").mockReturnValue({ ok: false, status: 503, error: "index_failure" });
    const r = install(f); expect(r).toMatchObject({ ok: false });
    expect(f.fm.themeStore.get("own")).toEqual(before); expect(f.fm.mods.list().mods).toEqual([]);
    expect(f.fm.effectLibrary.list({ kind: "human", id: OPERATOR })).toMatchObject({ entries: [] });
  });
  it("restores an old version if the final holder release refuses", async () => {
    const f = await fixture(), old = install(f); expect(old.ok).toBe(true);
    const before = f.fm.themeStore.get("own"), oldId = f.fm.mods.list().mods[0].effects[0].id;
    vi.spyOn(f.fm.effectLibrary, "releaseHolder").mockReturnValue({ ok: false, error: "provider_failure" });
    const r = install(f, "2.0.0", "// next", true); expect(r).toMatchObject({ ok: false });
    expect(f.fm.themeStore.get("own")).toEqual(before); expect(f.fm.mods.list().mods.map((x: { id: string }) => x.id)).toEqual([old.id]);
    expect(f.fm.effectLibrary.list({ kind: "human", id: OPERATOR }).entries.map((x: { id: string }) => x.id)).toEqual([oldId]);
  });
});
