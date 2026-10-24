/**
 * #2578: an agent sees and directs its own character in the Office view (src/web-office-acts.ts).
 * - The `office` dashboard feature is off unless set true: its tools leave the menu, and every sink refuses them.
 * - office_view: the stored offices the caller is in — members and states, a pack's spots with the office's overrides
 *   on it (a built-in style: none) — its act and cooldown_ms.
 * - office_set: seat / waypoint / person resolved, every refusal (a bad seat, a person elsewhere, say too long, seconds
 *   out of range, nothing to do, two targets, office needed, no office), 6 a minute (cooldown_ms), clear, expiry; an
 *   office drawn as desks (`walks: false`) refuses go at no cost and takes say and pose.
 * - Live: every change is the `office_acts` SSE event; GET /ui/office-acts reads the live ones (signed in, the public
 *   link too; never a guest).
 *
 * Isolation: temp directories; no child process; the fleet's own handlers with its config set in memory.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`office acts: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const { OfficeActs, OfficeActLimiter, officeMembers, officeSpots, OFFICE_ACT_LIMITS } = await import("../src/web-office-acts.js");
const { checkSkinPack } = await import("../src/ui/fleet-office-pack.js");
const { checkOffices } = await import("../src/web-office-store.js");
const { DASHBOARD_FEATURES, DASHBOARD_FEATURE_TOOLS, OFF_UNLESS_ON, dashboardFeaturesOff, dashboardFeaturesOffIn, dashboardRefusal, withoutFeatures } = await import("../src/dashboard-permissions.js");
const { TOOLS } = await import("../src/channel/mcp-tools.js");
const { TOOL_PROFILES, IPC_TYPE_TOOLS, EARLY_AGENT_OP_TOOLS } = await import("../src/tool-permissions.js");
const { dispatchAgentOperation, ToolNotPermittedError } = await import("../src/agent-endpoint.js");
const { prepareSettingsEffect } = await import("../src/settings-effect.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { isPassiveWebRead } = await import("../src/web-auth.js");
const { guestRouteDecision, guestFrameData } = await import("../src/web-guest-access.js");
// @ts-expect-error — a JS module of the app, with no types
const { DASHBOARD_FEATURES: PAGE_FEATURES, dashboardDefault } = await import("../src/ui/settings-model.js");

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-office-acts-")); dirs.push(d); return d; };

const STRIP = { src: "idle.png", frames: 1, w: 16, h: 16, fps: 0, ax: 8, ay: 15 };
const MANIFEST = {
  format: 1, id: "cozy", background: "office.png",
  areas: { desks: { rect: [40, 120, 600, 400], seats: [[120, 220], [260, 220]] }, lounge: { rect: [700, 120, 500, 300], seats: [[760, 260]] } },
  stateZones: { working: "desks", default: "lounge" },
  door: [640, 700],
  waypoints: [{ id: "hall", x: 640, y: 600 }, { id: "east", x: 1000, y: 600 }], edges: [["hall", "east"]],
  furniture: [{ id: "rack", sprite: STRIP, x: 1020, y: 140, label: "Rack" }, { id: "plant", sprite: STRIP, x: 50, y: 50 }],
  characters: { default: { idle: STRIP } },
};
const PACK = (() => { const r = checkSkinPack(MANIFEST); if (!r.ok) throw new Error(r.error); return r.pack; })();
const OVERRIDES = { pack: "cozy", seats: { desks: [[130, 230], [270, 230]] }, furniture: { rack: [1000, 150] }, door: [600, 710],
  waypoints: [{ id: "hall", x: 650, y: 610 }, { id: "nook", x: 300, y: 500 }], edges: [["hall", "nook"]] };
const offices = () => {
  const r = checkOffices([
    { id: "ops", name: "Ops", skin: "cozy", members: ["alpha", "team:web"], overrides: OVERRIDES },
    { id: "lab", name: "Lab", skin: "pixel", members: ["beta"] },
  ], id => (id === "cozy" ? PACK : null));
  if (!r.ok) throw new Error(r.detail);
  return r.offices;
};
const CHART = { names: ["alpha", "beta", "gamma", "delta"], teams: [{ name: "web", members: ["beta", "gamma"] }] };

/** An OfficeActs on fixed offices, chart and states; `sent`: every `office_acts` payload. */
function acts(opts: { offices?: ReturnType<typeof offices>; clock?: { t: number } } = {}) {
  const sent: unknown[] = [];
  const clock = opts.clock ?? { t: 0 };
  const states: Record<string, string> = { alpha: "working", beta: "idle", gamma: "needs" };
  const list = opts.offices ?? offices();
  const a = new OfficeActs({
    offices: () => list, pack: id => (id === "cozy" ? PACK : null), chart: () => CHART,
    people: () => ({ stateOf: n => states[n] ?? "missing", displayName: n => (n === "alpha" ? "Alpha Fox" : undefined) }),
    changed: live => sent.push({ acts: live }),
  }, { limiter: new OfficeActLimiter(() => clock.t) });
  return { a, sent, states, clock };
}

describe("the `office` feature: off unless set true", () => {
  it("a feature with its two tools, in the profiles a worker's appearance tools are in; the page lists it too", () => {
    expect(DASHBOARD_FEATURES).toContain("office");
    expect([...OFF_UNLESS_ON]).toEqual(["office"]);
    expect(DASHBOARD_FEATURE_TOOLS.office).toEqual(["office_view", "office_set"]);
    const names = TOOLS.map(t => t.name);
    for (const t of ["office_view", "office_set"]) {
      expect(names, t).toContain(t);
      for (const p of ["full", "worker", "coordinator", "general", "standard"] as const) expect(TOOL_PROFILES[p], `${p} ${t}`).toContain(t);
      expect(TOOL_PROFILES.minimal).not.toContain(t);
    }
    expect([IPC_TYPE_TOOLS.fleet_office_view, IPC_TYPE_TOOLS.fleet_office_set, EARLY_AGENT_OP_TOOLS["office-view"], EARLY_AGENT_OP_TOOLS["office-set"]])
      .toEqual(["office_view", "office_set", "office_view", "office_set"]);
    expect(PAGE_FEATURES).toEqual([...DASHBOARD_FEATURES]);
  });

  it("unset (or null, or false) is off, true is on; the refusal says how it is switched on", () => {
    expect(dashboardFeaturesOff(undefined)).toEqual(["office"]);
    expect(dashboardFeaturesOff({ office: null })).toEqual(["office"]);
    expect(dashboardFeaturesOff({ office: false, task_board: false })).toEqual(["task_board", "office"]);
    expect(dashboardFeaturesOff({ office: true })).toEqual([]);
    expect(dashboardRefusal({}, "office_set")).toMatch(/office_set is not available.*"office" is off until the person switches it on \(office_access: true\).*Do not retry/);
    expect(dashboardRefusal({ office: true }, "office_view")).toBeNull();
    // Its own switch, else the default's.
    const fleet = { defaults: { dashboard: { office: true } }, instances: { a: { dashboard: { office: false } }, b: {} } };
    expect([dashboardFeaturesOffIn(fleet, "a"), dashboardFeaturesOffIn(fleet, "b"), dashboardFeaturesOffIn({ instances: {} }, "c")]).toEqual([["office"], [], ["office"]]);
  });

  it("left out of the tool menu while off", () => {
    const worker = TOOLS.filter(t => TOOL_PROFILES.worker.includes(t.name));
    expect(withoutFeatures(worker, dashboardFeaturesOff(undefined)).map(t => t.name)).not.toContain("office_set");
    expect(withoutFeatures(worker, dashboardFeaturesOff({ office: true })).map(t => t.name)).toEqual(expect.arrayContaining(["office_view", "office_set"]));
  });

  it("refused at the IPC sink and the agent endpoint until switched on, read at each call", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = { fleetConfig: { defaults: {}, instances: { dev: { working_directory: "/tmp/d" } as Record<string, unknown> } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }, canvasWorkerEnabled: () => false };
    const check = (FleetManager.prototype as any).checkToolPermission.bind(fm);
    expect(check("ipc-typed", "dev", "office_set")).toEqual({ allowed: false, message: dashboardRefusal({}, "office_set") });
    fm.fleetConfig.instances.dev.office_access = true;
    expect(check("ipc-typed", "dev", "office_set").allowed).toBe(true);

    const handled = vi.fn(async () => ({ offices: [] }));
    const ctx = { dataDir: scratch(), fleetConfig: { defaults: {}, instances: { dev: { working_directory: "/tmp/d" } as Record<string, unknown> } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }, handleWebThemeHttp: handled };
    const err = await dispatchAgentOperation(ctx as never, "dev", "office-view", {}).catch(e => e as Error);
    expect(err).toBeInstanceOf(ToolNotPermittedError);
    expect(handled).not.toHaveBeenCalled();
    ctx.fleetConfig.instances.dev.office_access = true;
    await expect(dispatchAgentOperation(ctx as never, "dev", "office-set", { say: "hi" })).resolves.toEqual({ offices: [] });
    expect(handled).toHaveBeenCalledWith("dev", "office_set", { say: "hi" });
  }, 30_000);

  it("Settings: the page's default is off; switching it on is confirmed, off is direct", () => {
    expect([dashboardDefault({}, "office"), dashboardDefault({ dashboard: { office: true } }, "office"), dashboardDefault({}, "appearance")]).toEqual([false, true, true]);
    const config = () => ({ defaults: { backend: "claude-code" } as Record<string, any>,
      channels: [{ id: "main", type: "telegram", mode: "topic", group_id: "-1001", bot_token_env: "BOT", access: { mode: "locked", allowed_users: ["1"] } }],
      instances: { dev: { working_directory: "/tmp/dev" } as Record<string, any> } });
    const gate = (path: string, method: string, body: unknown, cfg: any) => { const { diff } = prepareSettingsEffect(method, path, body, { config: cfg, classic: {} }); return diff ? [...diff.summary] : "direct"; };
    expect(gate("/api/settings/fleet/instances/dev", "PATCH", { dashboard: { office: true } }, config()))
      .toEqual([expect.any(String), "instances.dev.office\\_access \\(in effect\\): false → true"]);
    expect(gate("/api/settings/fleet/instances/dev", "PATCH", { dashboard: { office: false } }, config())).toBe("direct");
    expect(gate("/api/settings/fleet/defaults", "PUT", { dashboard: { office: true } }, config()))
      .toEqual([expect.any(String), expect.stringMatching(/^defaults\.office\\_access \\\(in effect\\\): false → true — 1 agent\(s\) inherit it: dev/)]);
  });

  it("the settings labels, in English and zh-TW", () => {
    const src = readFileSync(join(process.cwd(), "src/ui/settings-strings.js"), "utf8");
    expect(src).toContain('dashboard_office: "Office: walk, speak and act in the Office view"');
    expect(src).toContain('dashboard_office: "辦公室：在辦公室畫面走動、說話、做動作"');
  });
});

describe("office_view", () => {
  it("members from names and teams (none: everyone listed); a pack's spots with the overrides on; a built-in style none", () => {
    const [ops, lab] = offices();
    expect(officeMembers(ops!, CHART)).toEqual(["alpha", "beta", "gamma"]);
    expect(officeMembers({ members: [] }, CHART)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(officeMembers({ members: ["ghost", "team:none"] }, CHART)).toEqual([]);
    expect(officeSpots(ops!, PACK)).toEqual({
      seats: [{ area: "desks", index: 0, x: 130, y: 230 }, { area: "desks", index: 1, x: 270, y: 230 }, { area: "lounge", index: 0, x: 760, y: 260 }],
      waypoints: [{ id: "hall", x: 650, y: 610 }, { id: "nook", x: 300, y: 500 }],
      npcs: [{ id: "rack", label: "Rack", x: 1000, y: 150 }, { id: "plant", label: null, x: 50, y: 50 }],
      door: { x: 600, y: 710 },
    });
    expect(officeSpots(lab!, null)).toEqual({ seats: [], waypoints: [], npcs: [], door: null });
  });

  it("the offices it is in, its act and cooldown; one office by id; not one of its own refused", () => {
    const { a } = acts();
    const view = a.view("beta", {});
    expect(view).toEqual({
      offices: [
        { id: "ops", name: "Ops", skin: "cozy", walks: true, members: [{ name: "alpha", display_name: "Alpha Fox", state: "working" }, { name: "beta", state: "idle" }, { name: "gamma", state: "needs" }],
          spots: officeSpots(offices()[0]!, PACK) },
        { id: "lab", name: "Lab", skin: "pixel", walks: false, members: [{ name: "beta", state: "idle" }], spots: { seats: [], waypoints: [], npcs: [], door: null } },
      ],
      act: null, cooldown_ms: 0,
    });
    expect((a.view("beta", { office: "lab" }).offices as Array<{ id: string }>).map(o => o.id)).toEqual(["lab"]);
    expect(a.view("alpha", { office: "lab" })).toMatchObject({ error: "office", message: expect.stringContaining("ops (Ops)") });
    expect(a.view("delta", {})).toEqual({ offices: [], act: null, cooldown_ms: 0 });
    expect(a.view("beta", { bogus: 1 })).toMatchObject({ error: "invalid" });
    a.set("alpha", { say: "hi" });
    expect(a.view("alpha", {})).toMatchObject({ act: { instance: "alpha", office: "ops", say: "hi" }, cooldown_ms: 0 });
  });
});

describe("office_set", () => {
  it("resolves a seat, a waypoint and a person; keeps say, pose, seconds and the state it was set in", () => {
    const { a, clock } = acts();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(a.set("alpha", { go: { seat: "desks:1" }, say: "On it", pose: "working", seconds: 10 })).toEqual({
      act: { instance: "alpha", office: "ops", x: 270, y: 230, say: "On it", pose: "working", since: 1_000_000, until: 1_010_000, state: "working" }, cooldown_ms: 0 });
    clock.t += 1;
    expect(a.set("alpha", { go: { waypoint: "nook" } })).toMatchObject({ act: { x: 300, y: 500, until: 1_030_000 } });
    expect(a.set("alpha", { go: { person: "gamma" }, say: "  Review ready " })).toMatchObject({ act: { person: "gamma", say: "Review ready" } });
    expect((a.set("alpha", { go: { person: "gamma" } }) as { act: object }).act).not.toHaveProperty("x");
    expect(a.set("beta", { office: "lab", pose: "paused" })).toMatchObject({ act: { instance: "beta", office: "lab", pose: "paused", state: "idle" } });
    now.mockRestore();
  });

  it.each([
    ["a seat it does not have", { go: { seat: "desks:2" } }, "seat"],
    ["a seat not area:index", { go: { seat: "desks" } }, "seat"],
    ["a waypoint it does not have", { go: { waypoint: "east" } }, "waypoint"],                 // replaced by the overrides
    ["a person in no such office", { go: { person: "delta" } }, "person"],
    ["itself", { go: { person: "alpha" } }, "person"],
    ["say too long", { say: "x".repeat(41) }, "invalid"],
    ["say blank", { say: "   " }, "say"],
    ["say with a control character", { say: "a\nb" }, "say"],
    ["seconds under 5", { say: "hi", seconds: 4 }, "invalid"],
    ["seconds over 120", { say: "hi", seconds: 121 }, "invalid"],
    ["nothing to do", {}, "nothing"],
    ["only seconds", { seconds: 30 }, "nothing"],
    ["two go targets", { go: { seat: "desks:0", waypoint: "hall" } }, "go"],
    ["an empty go", { go: {} }, "go"],
    ["clear with something else", { clear: true, say: "hi" }, "clear"],
    ["an unknown key", { say: "hi", dance: true }, "invalid"],
    ["a pose it does not know", { pose: "sleeping" }, "invalid"],
  ])("refuses %s, and costs nothing", (_what, args, error) => {
    const { a, sent } = acts();
    expect(a.set("alpha", args as Record<string, unknown>)).toMatchObject({ error, message: expect.any(String) });
    expect([a.live(), sent, a.limiter.waitMs("alpha")]).toEqual([[], [], 0]);
  });

  it("an office drawn as desks (a built-in style, a pack without stateZones): go refused at no cost; say and pose accepted (review)", () => {
    const { a, sent } = acts();
    for (const go of [{ seat: "desks:0" }, { waypoint: "hall" }, { person: "gamma" }]) {
      expect(a.set("beta", { office: "lab", go, say: "hi" })).toMatchObject({ error: "go", message: expect.stringContaining("drawn as desks") });
    }
    expect([a.live(), sent, a.limiter.waitMs("beta")]).toEqual([[], [], 0]);
    expect(a.set("beta", { office: "lab", say: "Desk hello", pose: "working" })).toMatchObject({ act: { office: "lab", say: "Desk hello", pose: "working" } });
    // A pack without stateZones draws desks too: no spots, walks false, go refused.
    const { stateZones: _z, ...flat } = MANIFEST;
    const DESKS = (() => { const r = checkSkinPack({ ...flat, id: "flat" }); if (!r.ok) throw new Error(r.error); return r.pack; })();
    const list = (() => { const r = checkOffices([{ id: "den", name: "Den", skin: "flat", members: ["alpha"] }], id => (id === "flat" ? DESKS : null)); if (!r.ok) throw new Error(r.detail); return r.offices; })();
    const b = new OfficeActs({ offices: () => list, pack: id => (id === "flat" ? DESKS : null), chart: () => CHART,
      people: () => ({ stateOf: () => "idle", displayName: () => undefined }), changed: () => {} }, { limiter: new OfficeActLimiter(() => 0) });
    expect(b.view("alpha", {})).toMatchObject({ offices: [{ id: "den", walks: false, spots: { seats: [], waypoints: [], npcs: [], door: null } }] });
    expect(b.set("alpha", { go: { seat: "desks:0" } })).toMatchObject({ error: "go" });
    expect(b.set("alpha", { say: "Here" })).toMatchObject({ act: { office: "den", say: "Here" } });
  });

  it("office is needed only in more than one (the refusal lists them); none at all is refused", () => {
    const { a } = acts();
    expect(a.set("beta", { say: "hi" })).toEqual({ error: "office_required", message: "You are in 2 offices; name one with office: ops (Ops), lab (Lab)." });
    expect(a.set("beta", { office: "nope", say: "hi" })).toMatchObject({ error: "office" });
    expect(a.set("beta", { clear: true })).toMatchObject({ cleared: false });                     // its one act: no office needed
    expect(a.set("beta", { clear: true, office: "nope" })).toMatchObject({ cleared: false });     // clearing names nothing
    expect(a.set("delta", { say: "hi" })).toMatchObject({ error: "no_office" });
    expect(a.set("delta", { clear: true })).toMatchObject({ cleared: false });                    // in none: it may still clear
    expect(acts({ offices: [] }).a.set("alpha", { say: "hi" })).toMatchObject({ error: "no_office" });
  });

  it("taken out of every office after acting: it can still clear its act (review)", () => {
    const list = offices(), { a } = acts({ offices: list });
    expect(a.set("alpha", { say: "hi" })).toMatchObject({ act: { instance: "alpha" } });
    list.length = 0;                                                          // a person removed every office
    expect(a.set("alpha", { clear: true })).toMatchObject({ cleared: true, act: null });
    expect(a.live()).toEqual([]);
  });
  it("say: no invisible or direction-changing characters either (zero-width, bidi embeddings and isolates)", () => {
    const { a } = acts();
    for (const bad of ["a\u200bb", "\u202eevil", "x\u2066y\u2069", "h\ufeffi"]) expect(a.set("alpha", { say: bad })).toMatchObject({ error: "say" });
  });
  it("6 a minute: the 7th is refused with cooldown_ms; a minute on it may again; 60 an hour", () => {
    const { a, clock } = acts();
    for (let i = 0; i < OFFICE_ACT_LIMITS.perMinute; i++) { expect(a.set("alpha", { say: `hi ${i}` })).toHaveProperty("act"); clock.t += 1000; }
    const refused = a.set("alpha", { say: "again" });
    expect(refused).toEqual({ error: "rate_limited", message: expect.stringContaining("6 a minute"), cooldown_ms: 54_000 });
    expect(a.view("alpha", {})).toMatchObject({ cooldown_ms: 54_000 });
    expect(a.set("gamma", { say: "mine" })).toHaveProperty("act");                                   // per instance
    clock.t += 54_000;
    expect(a.set("alpha", { say: "again" })).toHaveProperty("act");
    const hourly = new OfficeActLimiter(() => clock.t);
    for (let i = 0; i < OFFICE_ACT_LIMITS.perHour; i++) { hourly.record("x"); clock.t += 60_000 / OFFICE_ACT_LIMITS.perMinute + 1; }
    expect(hourly.waitMs("x")).toBeGreaterThan(60_000);
  });

  it("clear removes it (and is announced); clearing nothing is fine", () => {
    const { a, sent } = acts();
    a.set("alpha", { say: "hi" });
    expect(a.set("alpha", { clear: true })).toEqual({ cleared: true, act: null, cooldown_ms: 0 });
    expect([a.live(), a.view("alpha", {}).act]).toEqual([[], null]);
    expect(sent.at(-1)).toEqual({ acts: [] });
    expect(a.set("alpha", { clear: true })).toMatchObject({ cleared: false });
    expect(sent).toHaveLength(2);
  });

  it("a new act replaces the old; an expired one is not returned, and its end is announced", () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const { a, sent } = acts();
    a.set("alpha", { say: "one", seconds: 5 });
    a.set("alpha", { say: "two", seconds: 5 });
    a.set("gamma", { pose: "idle", seconds: 20 });
    expect(a.live().map(x => [x.instance, x.say ?? x.pose])).toEqual([["alpha", "two"], ["gamma", "idle"]]);
    vi.advanceTimersByTime(5_100);
    expect(a.live().map(x => x.instance)).toEqual(["gamma"]);
    expect(a.view("alpha", {}).act).toBeNull();
    expect(sent.at(-1)).toEqual({ acts: [expect.objectContaining({ instance: "gamma" })] });
    vi.advanceTimersByTime(15_000);
    expect([a.live(), sent.at(-1)]).toEqual([[], { acts: [] }]);
    a.close();
  });
});

// ── The fleet: the IPC door, the stream and GET /ui/office-acts ──

interface Res { status: number; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); r.end();
  });
}
async function fleet() {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const dir = scratch();
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp", dashboard: { office: true } }, beta: { working_directory: "/tmp" } }, defaults: {}, teams: {} };
  vi.spyOn(fm.officeSkins, "pack").mockImplementation((id: unknown) => (id === "cozy" ? PACK : null));
  expect(fm.officeStore.replace([{ id: "ops", name: "Ops", skin: "cozy", members: ["alpha", "beta"], overrides: OVERRIDES }])).toMatchObject({ ok: true });
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port;
  const session = () => {
    const { sessionId } = fm.webSessions.create({ tier: "read", surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
    return { cookie: `agend_session=${sessionId}`, csrf: csrfTokenFor(sessionId) };
  };
  const stop = () => { fm.officeActsInstance?.close(); return new Promise<void>(r => (fm.healthServer as Server).close(() => r())); };
  return { fm, port, session, stop };
}

describe("the fleet", () => {
  it("office_set over IPC: the connection's instance, answered as a web theme tool; announced as `office_acts`; GET /ui/office-acts", async () => {
    const f = await fleet();
    try {
      const sent: Array<[string, unknown]> = [];
      vi.spyOn(f.fm, "emitSseEvent").mockImplementation((...a: unknown[]) => { sent.push([a[0] as string, a[1]]); });
      const send = vi.fn(() => true);
      f.fm.instanceIpcClients.set("alpha", { send });
      (f.fm as any).dispatchTypedIpc("alpha", { type: "fleet_office_set", fleetRequestId: "r1", payload: { go: { seat: "desks:0" }, say: "Hello" }, meta: { instance_name: "beta" } });
      const answer = (send.mock.calls[0] as unknown as [Record<string, any>])[0];
      expect(answer).toMatchObject({ type: "fleet_web_theme_response", fleetRequestId: "r1", result: { act: { instance: "alpha", office: "ops", x: 130, y: 230, say: "Hello" }, cooldown_ms: 0 } });
      expect(typeof answer.result.act.state).toBe("string");
      expect(sent).toEqual([["office_acts", { acts: [answer.result.act], now: expect.any(Number) }]]);

      (f.fm as any).dispatchTypedIpc("alpha", { type: "fleet_office_view", fleetRequestId: "r2", payload: {} });
      const view = (send.mock.calls[1] as unknown as [Record<string, any>])[0].result;
      expect(view.offices.map((o: any) => [o.id, o.members.map((m: any) => m.name), o.spots.seats.length])).toEqual([["ops", ["alpha", "beta"], 3]]);
      expect(view.offices[0].members.every((m: any) => typeof m.state === "string")).toBe(true);
      expect(view.act).toMatchObject({ say: "Hello" });

      // Refused before the handler while beta's feature is off (unset): answered on the same response type.
      (f.fm as any).refuseTypedIpc("alpha", { type: "fleet_office_set", fleetRequestId: "r3" }, "nope");
      expect((send.mock.calls[2] as unknown as [Record<string, any>])[0]).toEqual({ type: "fleet_web_theme_response", fleetRequestId: "r3", error: "nope" });

      expect((await raw(f.port, "GET", "/ui/office-acts")).status).toBe(401);
      const r = await raw(f.port, "GET", "/ui/office-acts", { cookie: f.session().cookie });
      expect([r.status, JSON.parse(r.body)]).toEqual([200, { acts: [answer.result.act], now: expect.any(Number) }]);

      expect(await f.fm.handleWebThemeHttp("alpha", "office_set", { clear: true })).toEqual({ cleared: true, act: null, cooldown_ms: 0 });
      expect(sent.at(-1)).toEqual(["office_acts", { acts: [], now: expect.any(Number) }]);
      expect(JSON.parse((await raw(f.port, "GET", "/ui/office-acts", { cookie: f.session().cookie })).body)).toEqual({ acts: [], now: expect.any(Number) });
    } finally { await f.stop(); }
  }, 30_000);

  it("read as the offices are: a passive read, on the public link, never a guest's; the page's stream hears `office_acts`", () => {
    expect([isPassiveWebRead("GET", "/ui/office-acts"), isPublicWebRoute("GET", "/ui/office-acts"), isPublicWebRoute("POST", "/ui/office-acts")]).toEqual([true, true, false]);
    expect(guestRouteDecision("GET", new URL("http://h/ui/office-acts"), new Set(["alpha"]))).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
    expect(guestFrameData("office_acts", { acts: [] }, new Set(["alpha"]), { owner: { adapterId: "a", userId: "u" } } as never)).toBeUndefined();
    const stream = readFileSync(join(process.cwd(), "src/ui/shared/app-stream.js"), "utf8");
    expect(stream).toMatch(/const EVENTS = \[[^\]]*"office_acts"[^\]]*\]/);
  });
});
