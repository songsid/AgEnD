/**
 * #1629 r4-5c: effects travel in exported mods — through a real FleetManager and the real effect library (CW1).
 * - A person's export carries every effect placed on the instance (the library's reference check), with the
 *   placement's non-default params; the file imports again, effects and all.
 * - An agent's export carries only effects the agent may read (its own, or shared): a person's private effect placed
 *   on its instance stays out and is counted as effects_omitted.
 * - Two effects of one name get distinct paths.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = () => { throw Error("mod effect tests must not spawn any process"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
// #1778 shape: a real FleetManager's pino transport opens <AGEND_HOME>/daemon.log late, racing the scratch home's removal (ENOTEMPTY).
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const { WebAppearance } = await import("../src/web-appearance.js");
const { AppearanceLimiter } = await import("../src/web-appearance-policy.js");
const { sendEffectInParts } = await import("../src/web-effect-upload.js");
const { dispatchAgentOperation } = await import("../src/agent-endpoint.js");
const { OPERATOR } = await import("../src/web-prefs.js");
const B = await import("../src/web-mod-bundle.js");
const { buildModBundle } = await import("../src/web-mod-export.js");

const roots: string[] = [], removed: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); removed.push(r); } });
// The pin for the logger mock: nothing writes into a scratch home once it is removed — without the mock, logger.ts's
// home is the first test's, and every later fleet recreates it and pino opens daemon.log there.
afterAll(async () => {
  await new Promise(r => setTimeout(r, 300));
  expect(removed.filter(r => existsSync(r))).toEqual([]);
});
const manifest = (name = "fixture") => ({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name, title: "Fixture", regions: ["chat"], layer: "front", wants: ["state"], params: { size: { type: "number", min: 1, max: 5, default: 2 } } });
/** #2017: an effect that plays only in the header, not in a chat. */
const headerFiles = (code = "agend.ready()//header", name = "glow") => new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify({ ...manifest(name), regions: ["header"] }))], ["worker.js", Buffer.from(code)]]);
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
/** A person's own claim on an effect (the library's stage + commit under their principal). Same content: same id. */
function claim(f: Awaited<ReturnType<typeof fixture>>, person: string, code = "agend.ready()", name = "fixture") {
  const lib = f.fm.effectLibrary, st = lib.stage(files(code, name), { kind: "human", id: person });
  if (!st.ok) throw Error(st.error);
  const c = lib.commit(st.stageId); if (!c.ok) throw Error(c.error);
  return c.ids[0] as string;
}
const ctx = () => ({ agendVersion: "2.3.0", limits: { portrait: { max_width: 1024, max_height: 1536, max_kib: 1536 }, banner: { max_width: 1600, max_height: 600, max_kib: 768 }, quota: { files: 8, bytes: 4 * 1024 * 1024 } } as any, effects: B.cw1EffectChecker() });

describe("effects in a person's export", () => {
  it("the person's own effect placed on the instance travels with its params; the file imports again onto another agent", async () => {
    const f = await fixture();
    const id = claim(f, OPERATOR);
    expect(f.fm.themeStore.setPlacements("own", { effects: [{ id, params: { size: 4 } }] }, "human", () => null).ok).toBe(true);
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
  it("#2017 (Fable P3): an older placement of a non-chat effect stays out of the export, counted; the file imports again", async () => {
    const f = await fixture();
    const chat = claim(f, OPERATOR), header = (() => { const st = f.fm.effectLibrary.stage(headerFiles(), { kind: "human", id: OPERATOR }); if (!st.ok) throw Error(st.error); const c = f.fm.effectLibrary.commit(st.stageId); if (!c.ok) throw Error(c.error); return c.ids[0] as string; })();
    expect(f.fm.themeStore.setPlacements("own", { effects: [{ id: header }, { id: chat }] }, "human", () => null).ok, "placed before #2017").toBe(true);
    f.fm.themeStore.setTheme("own", { v: 1, accent: "#8b5cf6" }, "agent");
    const { exportMod } = await import("../src/web-api.js");
    const r = exportMod(f.fm, OPERATOR, { instance: "own", name: "old-fx", version: "1.0.0", title: "Old fx", include: { theme: true } });
    if (!r.ok) throw Error(JSON.stringify(r));
    expect([r.omitted, JSON.parse(r.text).manifest.contents.effects]).toEqual([1, ["effects/fixture"]]);
    expect(f.fm.mods.stage(OPERATOR, r.text).ok, "what this fleet exports, it imports").toBe(true);
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
  it("#2017 (Fable P3): its own older non-chat placement stays out (effects_omitted); the file still checks", async () => {
    const f = await fixture();
    const header = await upload(f, "own", headerFiles());
    expect(f.fm.themeStore.setPlacements("own", { effects: [{ id: header }] }, "agent", () => null).ok, "placed before #2017").toBe(true);
    f.fm.themeStore.setTheme("own", { v: 1, accent: "#8b5cf6" }, "agent");
    const r = f.fm.agentMods.handle("own", "export_web_mod", { name: "mine", version: "1.0.0" }) as any;
    expect(r.effects_omitted).toBe(1);
    const text = Buffer.from(r.files[0].data_b64, "base64").toString("utf8");
    expect(JSON.parse(text).manifest.contents.effects).toBeUndefined();
    expect(B.checkModBundle(text, ctx()).ok).toBe(true);
  });
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
    expect(Object.keys(JSON.parse(text).files).filter((p: string) => p.startsWith("effects/")).sort(), "only its own entry's files").toEqual(["effects/fixture/effect.json", "effects/fixture/worker.js"]);
  });
});

describe("Sol's export ACL (#1910 review): only what this person may carry away travels", () => {
  const A = "person:discord:1", B = "person:discord:2";
  async function placed(f: Awaited<ReturnType<typeof fixture>>, id: string) {
    expect(f.fm.themeStore.setPlacements("own", { effects: [{ id }] }, "human", () => null).ok).toBe(true);
    f.fm.themeStore.setTheme("own", { v: 1, accent: "#8b5cf6" }, "human");
    const { exportMod } = await import("../src/web-api.js");
    const r = exportMod(f.fm, A, { instance: "own", name: "x", version: "1.0.0", title: "x", include: { theme: true } });
    if (!r.ok) throw Error(JSON.stringify(r));
    return { omitted: r.omitted, effects: JSON.parse(r.text).manifest.contents.effects ?? [] };
  }
  it("B's private effect placed on the instance: A's export leaves it out (and says so)", async () => {
    const f = await fixture();
    expect(await placed(f, claim(f, B, "// b"))).toEqual({ omitted: 1, effects: [] });
  });
  it("A holds the same effect (the same content): it travels", async () => {
    const f = await fixture();
    const id = claim(f, B, "// same");
    expect(claim(f, A, "// same")).toBe(id);
    expect(await placed(f, id)).toEqual({ omitted: 0, effects: ["effects/fixture"] });
  });
  it("B shared it: it travels", async () => {
    const f = await fixture();
    const id = claim(f, B, "// shared");
    expect(f.fm.effectLibrary.setShared(id, { kind: "human", id: B }, true)).toMatchObject({ ok: true });
    expect(await placed(f, id)).toEqual({ omitted: 0, effects: ["effects/fixture"] });
  });
  /** The real route, through admin sessions owned by Discord users 1 (A) and 2 (B). */
  async function http(f: Awaited<ReturnType<typeof fixture>>) {
    const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
    const { request } = await import("node:http");
    f.fm.initializeWebAuthTokens(); f.fm.startHealthServer(0);
    await vi.waitFor(() => expect(f.fm.getDashboardAccess().ready).toBe(true));
    const port = f.fm.healthServer.address().port;
    const headers = (userId: string, write = false) => {
      const { sessionId } = f.fm.webSessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(f.fm.webToken), owner: { adapterId: "discord", userId } });
      return { cookie: `agend_session=${sessionId}`, ...(write ? { origin: `http://127.0.0.1:${port}`, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } : {}) };
    };
    const call = (method: string, path: string, userId: string, body?: unknown) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, method, path, headers: headers(userId, body !== undefined) }, res => {
        let b = ""; res.setEncoding("utf8"); res.on("data", (c: string) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
      });
      r.on("error", reject); r.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const get = async (path: string, userId: string) => (await call("GET", path, userId)).status;
    const stop = () => new Promise<void>(r => f.fm.healthServer.close(() => r()));
    return { call, get, stop };
  }
  const file = (s: string) => ({ sha256: createHash("sha256").update(s).digest("hex"), b64: Buffer.from(s).toString("base64") });
  const withFx = (code: string, contents: Record<string, unknown> = { theme: "theme.json" }) => JSON.stringify({ format: "agend-mod", v: 1, manifest: { name: "fx", version: "1.0.0", title: "Fx", contents: { ...contents, effects: ["effects/fixture"] } }, files: {
    ...(contents.theme ? { "theme.json": file(JSON.stringify({ v: 1, effects: [{ effect: "effects/fixture" }] })) } : {}),
    ...(contents.identity ? { "identity.json": file(JSON.stringify({ tagline: "hi" })) } : {}),
    "effects/fixture/effect.json": file(JSON.stringify(manifest())), "effects/fixture/worker.js": file(code) } });
  const plain = JSON.stringify({ format: "agend-mod", v: 1, manifest: { name: "plain", version: "1.0.0", title: "Plain", contents: { identity: "identity.json" } }, files: { "identity.json": file(JSON.stringify({ tagline: "hi" })) } });
  const install = (f: Awaited<ReturnType<typeof fixture>>, person: string, text: string, include: Record<string, unknown>) => {
    const st = f.fm.mods.stage(person, text); if (!st.ok) throw Error(JSON.stringify(st));
    const c = f.fm.mods.commit(person, { stage: st.stage, plan_hash: st.plan_hash, include, target: "own" }); if (!c.ok) throw Error(JSON.stringify(c));
    return c.id as string;
  };
  it("an installed mod's file, effects and all, downloads only for the person whose claim holds them; one without effects, for any admin", async () => {
    const f = await fixture(), h = await http(f);
    try {
      const fx = install(f, B, withFx("// installed"), { theme: true, effects: true }), pl = install(f, B, plain, { identity: true });
      expect(await h.get(`/ui/mods/file/${fx}`, "1"), "A: not theirs").toBe(403);
      expect(await h.get(`/ui/mods/file/${fx}`, "2"), "B: theirs").toBe(200);
      expect(await h.get(`/ui/mods/file/${pl}`, "1"), "no effects: any admin").toBe(200);
    } finally { await h.stop(); }
  }, 30_000);
  it("Prism #1921 P2-1: an import that left the effects out still keeps them in the file — the file judges by what it carries", async () => {
    const f = await fixture(), h = await http(f);
    try {
      const code = "// b's private worker";
      const id = install(f, B, withFx(code, { identity: "identity.json" }), { identity: true });
      expect(f.fm.mods.list().mods.find((m: { id: string }) => m.id === id)?.effects, "nothing was installed").toEqual([]);
      expect(await h.get(`/ui/mods/file/${id}`, "1"), "A: the file's effect is nobody's they may read").toBe(403);
      expect(await h.get(`/ui/mods/file/${id}`, "2"), "B installed none of it: no claim either").toBe(403);
      const own = claim(f, B, code);
      expect(await h.get(`/ui/mods/file/${id}`, "2"), "B's own claim on that content").toBe(200);
      expect(await h.get(`/ui/mods/file/${id}`, "1"), "still not A's").toBe(403);
      expect(f.fm.effectLibrary.setShared(own, { kind: "human", id: B }, true)).toMatchObject({ ok: true });
      expect(await h.get(`/ui/mods/file/${id}`, "1"), "B shared it").toBe(200);
    } finally { await h.stop(); }
  }, 30_000);
  it("#2017 (Fable P2): a mod installed before the rule, its theme placing a non-chat effect, still downloads for its owner", async () => {
    const f = await fixture(), h = await http(f);
    try {
      const glow = JSON.stringify({ format: "agend-mod", v: 1, manifest: { name: "glow", version: "1.0.0", title: "Glow", contents: { theme: "theme.json", effects: ["effects/glow"] } }, files: {
        "theme.json": file(JSON.stringify({ v: 1, effects: [{ effect: "effects/glow" }] })),
        "effects/glow/effect.json": file(JSON.stringify({ ...manifest("glow"), regions: ["header"] })), "effects/glow/worker.js": file("agend.ready()//glow") } });
      expect(f.fm.mods.stage(B, glow), "a new import is refused").toMatchObject({ ok: false, error: "mod_invalid" });
      const deps = (f.fm.mods as any).deps, context = deps.context;
      deps.context = () => ({ ...context(), placementRegions: false });       // installed by a version before #2017
      const id = install(f, B, glow, { theme: true, effects: true });
      deps.context = context;
      expect(f.fm.mods.bundleEffects(id), "the installed file still checks").toHaveLength(1);
      expect(await h.get(`/ui/mods/file/${id}`, "2"), "its owner downloads it").toBe(200);
      expect(await h.get(`/ui/mods/file/${id}`, "1"), "not someone else").toBe(403);
    } finally { await h.stop(); }
  }, 30_000);
  it("a file that lists effects but no longer checks here is nobody's to download; one listing none still is any admin's", async () => {
    const f = await fixture(), h = await http(f);
    try {
      const fx = install(f, B, withFx("// installed"), { theme: true, effects: true }), pl = install(f, B, plain, { identity: true });
      expect(await h.get(`/ui/mods/file/${fx}`, "2")).toBe(200);
      const deps = (f.fm.mods as any).deps, context = deps.context;
      deps.context = () => ({ ...context(), effects: null });                // this fleet's effect runtime gone: effects_unavailable
      expect(f.fm.mods.bundleEffects(fx)).toBe("unknown");
      expect(await h.get(`/ui/mods/file/${fx}`, "2"), "fails closed, even for the claim holder").toBe(403);
      expect(await h.get(`/ui/mods/file/${pl}`, "1")).toBe(200);
      // An effect-free file that no longer checks either (an unknown key): it lists no effects, so still any admin's.
      const at = (f.fm.mods as any).file(pl) as string;
      writeFileSync(at, JSON.stringify({ ...JSON.parse(readFileSync(at, "utf8")), later: 1 }));
      expect(f.fm.mods.bundleEffects(pl)).toEqual([]);
      expect(await h.get(`/ui/mods/file/${pl}`, "1")).toBe(200);
    } finally { await h.stop(); }
  }, 30_000);
  it("the person's export route says how many effects it left out (X-AgEnD-Effects-Omitted)", async () => {
    const f = await fixture(), h = await http(f);
    try {
      expect(f.fm.themeStore.setPlacements("own", { effects: [{ id: claim(f, B, "// b") }] }, "human", () => null).ok).toBe(true);
      f.fm.themeStore.setTheme("own", { v: 1, accent: "#8b5cf6" }, "human");
      const body = { instance: "own", name: "x", version: "1.0.0", title: "x", include: { theme: true } };
      const a = await h.call("POST", "/ui/mods/export", "1", body);
      expect(a.status, a.body).toBe(200);
      expect(a.headers["x-agend-effects-omitted"]).toBe("1");
      expect(JSON.parse(a.body).manifest.contents.effects).toBeUndefined();
      const b = await h.call("POST", "/ui/mods/export", "2", body);
      expect(b.headers["x-agend-effects-omitted"]).toBe("0");
      expect(JSON.parse(b.body).manifest.contents.effects).toEqual(["effects/fixture"]);
    } finally { await h.stop(); }
  }, 30_000);
});

describe("an agent's export (#1910 review)", () => {
  it("its effect's params travel; effects alone (a default look) still make the theme part", async () => {
    const f = await fixture();
    const id = await upload(f);
    expect(await f.op("own", "effect-apply", { id, params: { size: 4 } })).toMatchObject({ id });
    const r = f.fm.agentMods.handle("own", "export_web_mod", { name: "fx-only", version: "1.0.0" }) as any;
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    const doc = JSON.parse(Buffer.from(r.files[0].data_b64, "base64").toString("utf8"));
    expect(JSON.parse(Buffer.from(doc.files["theme.json"].b64, "base64").toString()).effects).toEqual([{ effect: "effects/fixture", params: { size: 4 } }]);
  });
  it("a default look whose placed effects are all someone else's: nothing_to_export, with the count left out", async () => {
    const f = await fixture();
    const theirs = claim(f, OPERATOR, "// a person's");
    expect(f.fm.themeStore.setPlacements("own", { effects: [{ id: theirs }] }, "human", () => null).ok).toBe(true);
    expect(f.fm.agentMods.handle("own", "export_web_mod", { name: "x", version: "1.0.0" })).toMatchObject({ error: "nothing_to_export", effects_omitted: 1 });
  });
});
