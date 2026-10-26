/**
 * #2692: agents check, upload, replace, delete and restore the Office view's skin packs (src/web-office-pack-tools.ts,
 * src/web-office-pack-read.ts, src/web-office-skins.ts), behind the `office_packs` feature (office_pack_access).
 * - Off by default: the tools leave the menu and every sink refuses them; switching on is confirmed in Settings.
 * - The agent's side reads a pack: a dir resolved with realpath inside the working directory or the shared folder; only
 *   manifest.json and the files the manifest names.
 * - The web upload's checks and refusals; an upload that would leave an office's overrides invalid is refused with the
 *   office named, and drop_invalid_overrides drops exactly those entries; a replace is atomic (a failure mid-way keeps
 *   the old version and puts the offices back), keeps one previous version, and restore brings it back.
 * - Approval mode holds a change until an admin approves it (the page, the notice's buttons); the log and the notice;
 *   the rate limit by batch and bytes.
 *
 * Isolation: temp directories; no child process; the fleet's own handlers with its config set in memory.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`office packs: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const { OfficePackTools, OfficePackBatchLimiter, OfficePackUploads, overrideConflicts, dropConflicts, dropsText, OFFICE_PACK_TOOL_LIMITS } = await import("../src/web-office-pack-tools.js");
const { readPackSources, encodePackBatch, sendPackBatchInParts, sendPackSources } = await import("../src/web-office-pack-read.js");
const { OfficeSkinStore, checkSkinUpload, PREVIOUS_FILE } = await import("../src/web-office-skins.js");
const { OfficeStore } = await import("../src/web-office-store.js");
const { checkSkinPack } = await import("../src/ui/fleet-office-pack.js");
const { DASHBOARD_FEATURE_TOOLS, OFF_UNLESS_ON, SEPARATE_FEATURE_KEYS, dashboardFeaturesOff, dashboardFeaturesOffIn, dashboardRefusal, normalizeOfficeStorage, withoutFeatures } = await import("../src/dashboard-permissions.js");
const { validateFleetConfig } = await import("../src/config-validator.js");
const { TOOLS } = await import("../src/channel/mcp-tools.js");
const { TOOL_PROFILES, IPC_TYPE_TOOLS, EARLY_AGENT_OP_TOOLS } = await import("../src/tool-permissions.js");
const { dispatchAgentOperation, ToolNotPermittedError } = await import("../src/agent-endpoint.js");
const { prepareSettingsEffect } = await import("../src/settings-effect.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { guestRouteDecision, guestFrameData } = await import("../src/web-guest-access.js");
// @ts-expect-error — a JS module of the app, with no types
const { DASHBOARD_FEATURES: PAGE_FEATURES, dashboardDefault, agentForm, agentPatch } = await import("../src/ui/settings-model.js");

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-pack-tools-")); dirs.push(d); return d; };
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** A tiny valid PNG of w×h; `seed` changes its bytes (a new version of the same picture). */
function png(w: number, h: number, seed = 0): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h, seed);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const STRIP = (src: string) => ({ src, frames: 1, w: 16, h: 16, fps: 0, ax: 8, ay: 15 });
/** v1: two desks seats, a rack (with a night place) and a plant. `seats`/`rack` vary it. */
const MANIFEST = (o: { id?: string; desks?: number; rack?: boolean } = {}) => ({
  format: 1, id: o.id ?? "snug", background: "bg.png",
  areas: { desks: { rect: [40, 120, 600, 400], seats: [[120, 220], [260, 220], [400, 220]].slice(0, o.desks ?? 2) }, lounge: { rect: [700, 120, 500, 300], seats: [[760, 260]] } },
  stateZones: { working: "desks", default: "lounge" },
  furniture: [...(o.rack === false ? [] : [{ id: "rack", sprite: STRIP("rack.png"), x: 1020, y: 140, night: { sprite: STRIP("rack.png"), x: 300, y: 420 } }]), { id: "plant", sprite: STRIP("plant.png"), x: 50, y: 50 }],
  characters: { default: { idle: STRIP("idle.png") } },
});
const PICTURES = (seed = 0, rack = true) => new Map<string, Buffer>([["bg.png", png(32, 18, seed)], ["idle.png", png(16, 16, seed)], ["plant.png", png(16, 16, seed + 1)], ...(rack ? [["rack.png", png(16, 16, seed + 2)] as [string, Buffer]] : [])]);
const SOURCE = (o: Parameters<typeof MANIFEST>[0] & { seed?: number } = {}) => ({ manifest: MANIFEST(o), files: PICTURES(o.seed ?? 0, o.rack !== false) });
const OPS = { pack: "snug", seats: { desks: [[130, 230], [270, 230]], lounge: [[770, 270]] }, furniture: { rack: [1000, 150], plant: [60, 60] }, furnitureNight: { rack: [310, 430] }, door: [600, 710] };
const DEN = { pack: "snug", seats: { lounge: [[780, 280]] } };
const OFFICES = [
  { id: "ops", name: "Ops", skin: "snug", members: [], overrides: OPS },
  { id: "den", name: "Den", skin: "snug", members: [], overrides: DEN },
  { id: "lab", name: "Lab", skin: "pixel", members: [] },
];

/** A store, offices and the tools over one temp data dir; `notices` and `changes` record what the fleet would do. */
function tools(o: { approval?: "apply" | "approve"; limiter?: InstanceType<typeof OfficePackBatchLimiter>; hooks?: { beforeSwap?(id: string): void }; offices?: unknown[] } = {}) {
  const dir = scratch();
  const skins = new OfficeSkinStore(dir, () => 1_000, o.hooks);
  const offices = new OfficeStore(dir, id => skins.pack(id));
  const notices: Array<{ text: string; pending?: { id: string } }> = [], settled: Array<[string, string]> = [], changed: unknown[] = [];
  const t = new OfficePackTools({ skins, offices, allowedAgents: () => ["alpha"], notice: (text, pending) => notices.push({ text, ...(pending ? { pending } : {}) }),
    settled: (id, text) => settled.push([id, text]), changed: what => changed.push(what) }, { ...(o.limiter ? { limiter: o.limiter } : {}) });
  if (o.approval) expect(t.setApproval(o.approval, "admin")).toMatchObject({ ok: true });
  return { dir, skins, offices, t, notices, settled, changed };
}
/** Send packs as the agent's side does (encoded, in parts), to `tool`. */
async function send(t: InstanceType<typeof OfficePackTools>, tool: "office_pack_check" | "office_pack_upload", packs: Array<{ manifest: unknown; files: Map<string, Buffer>; name?: string }>, opts: Record<string, unknown> = {}, who = "alpha") {
  const bytes = encodePackBatch(packs as never)!;
  return sendPackBatchInParts(bytes, opts, async args => t.handle(who, tool, args) as Record<string, unknown>);
}
const putOffices = (offices: InstanceType<typeof OfficeStore>, list = OFFICES) => expect(offices.replace(list, offices.rev(), { packOf: () => null })).toMatchObject({ ok: true });

describe("the `office_packs` feature: off unless set true", () => {
  it("its six tools, in the profiles a worker's Office tools are in; stored as office_pack_access beside dashboard", () => {
    const six = ["office_pack_check", "office_pack_upload", "office_pack_delete", "office_pack_restore", "office_pack_list", "office_set_style"];
    expect(DASHBOARD_FEATURE_TOOLS.office_packs).toEqual(six);
    expect([...OFF_UNLESS_ON]).toContain("office_packs");
    expect(SEPARATE_FEATURE_KEYS.office_packs).toBe("office_pack_access");
    const names = TOOLS.map(x => x.name);
    for (const tool of six) {
      expect(names, tool).toContain(tool);
      for (const p of ["full", "worker", "coordinator", "general", "standard"] as const) expect(TOOL_PROFILES[p], `${p} ${tool}`).toContain(tool);
      expect(TOOL_PROFILES.minimal).not.toContain(tool);
      expect(IPC_TYPE_TOOLS[`fleet_${tool}`]).toBe(tool);
    }
    expect(Object.entries(EARLY_AGENT_OP_TOOLS).filter(([op]) => op.startsWith("office-pack") || op === "office-packs" || op === "office-style").map(([, t]) => t).sort()).toEqual([...six].sort());
    expect(PAGE_FEATURES).toContain("office_packs");
  });

  it("unset, null or false is off — out of the menu and refused, naming office_pack_access; its own switch, else the default's", () => {
    expect(dashboardFeaturesOff({ office: true })).toEqual(["office_packs"]);
    expect(dashboardFeaturesOff({ office: true, office_packs: true })).toEqual([]);
    const worker = TOOLS.filter(x => TOOL_PROFILES.worker.includes(x.name));
    expect(withoutFeatures(worker, dashboardFeaturesOff({ office: true })).map(x => x.name)).not.toContain("office_pack_upload");
    expect(withoutFeatures(worker, dashboardFeaturesOff({ office_packs: true })).map(x => x.name)).toEqual(expect.arrayContaining(["office_pack_upload", "office_pack_list"]));
    expect(dashboardRefusal({}, "office_pack_upload")).toMatch(/office_pack_upload is not available.*"office_packs" is off until the person switches it on \(office_pack_access: true\).*Do not retry/);
    const fleet = { defaults: { office_pack_access: true }, instances: { a: { office_pack_access: false }, b: {} } };
    expect([dashboardFeaturesOffIn(fleet, "a").includes("office_packs"), dashboardFeaturesOffIn(fleet, "b").includes("office_packs"), dashboardFeaturesOffIn({}, "c").includes("office_packs")]).toEqual([true, false, true]);
  });

  it("fleet.yaml: a boolean; a transitional dashboard.office_packs moves to office_pack_access (published validators never see it in the closed map)", () => {
    const bad = validateFleetConfig({ defaults: {}, instances: { a: { working_directory: "/tmp", office_pack_access: "yes" } } });
    expect(bad.errors.map(e => e.path)).toContain("instances.a.office_pack_access");
    const cfg: any = { defaults: { dashboard: { office_packs: true, task_board: false } }, instances: { a: { dashboard: { office_packs: false } } } };
    normalizeOfficeStorage(cfg);
    expect([cfg.defaults.dashboard, cfg.defaults.office_pack_access, cfg.instances.a.dashboard, cfg.instances.a.office_pack_access]).toEqual([{ task_board: false }, true, {}, false]);
  });

  it("refused at the IPC sink and the agent endpoint until switched on, read at each call", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = { fleetConfig: { defaults: {}, instances: { dev: { working_directory: "/tmp/d" } as Record<string, unknown> } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }, canvasWorkerEnabled: () => false };
    const check = (FleetManager.prototype as any).checkToolPermission.bind(fm);
    expect(check("ipc-typed", "dev", "office_pack_upload")).toEqual({ allowed: false, message: dashboardRefusal({}, "office_pack_upload") });
    fm.fleetConfig.instances.dev.office_access = true;                                    // the other Office switch opens nothing here
    expect(check("ipc-typed", "dev", "office_pack_upload").allowed).toBe(false);
    fm.fleetConfig.instances.dev.office_pack_access = true;
    expect(check("ipc-typed", "dev", "office_pack_upload").allowed).toBe(true);

    const handled = vi.fn(async () => ({ packs: [] }));
    const ctx = { dataDir: scratch(), fleetConfig: { defaults: {}, instances: { dev: { working_directory: "/tmp/d" } as Record<string, unknown> } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }, handleWebThemeHttp: handled };
    expect(await dispatchAgentOperation(ctx as never, "dev", "office-packs", {}).catch(e => e)).toBeInstanceOf(ToolNotPermittedError);
    expect(handled).not.toHaveBeenCalled();
    ctx.fleetConfig.instances.dev.office_pack_access = true;
    await expect(dispatchAgentOperation(ctx as never, "dev", "office-pack-delete", { id: "snug" })).resolves.toEqual({ packs: [] });
    expect(handled).toHaveBeenCalledWith("dev", "office_pack_delete", { id: "snug" });
  }, 30_000);

  it("Settings: off by default on the page; switching it on is confirmed, off is direct; its label in English and zh-TW", () => {
    expect([dashboardDefault({}, "office_packs"), dashboardDefault({ office_pack_access: true }, "office_packs")]).toEqual([false, true]);
    const inst = { working_directory: "/w" }, form = agentForm(inst, {});
    expect(form.dashboard.office_packs).toBe("inherit");
    form.dashboard.office_packs = "on";
    expect(agentPatch(form, inst, {}, null, null)).toEqual({ office_pack_access: true });
    const config = () => ({ defaults: { backend: "claude-code" } as Record<string, any>,
      channels: [{ id: "main", type: "telegram", mode: "topic", group_id: "-1001", bot_token_env: "BOT", access: { mode: "locked", allowed_users: ["1"] } }],
      instances: { dev: { working_directory: "/tmp/dev" } as Record<string, any> } });
    const gate = (path: string, method: string, body: unknown) => { const { diff } = prepareSettingsEffect(method, path, body, { config: config() as any, classic: {} }); return diff ? [...diff.summary] : "direct"; };
    expect(gate("/api/settings/fleet/instances/dev", "PATCH", { office_pack_access: true })).toEqual([expect.any(String), "instances.dev.office\\_pack\\_access \\(in effect\\): false → true"]);
    expect(gate("/api/settings/fleet/instances/dev", "PATCH", { dashboard: { office_packs: true } })).toEqual([expect.any(String), "instances.dev.office\\_pack\\_access \\(in effect\\): false → true"]);
    expect(gate("/api/settings/fleet/instances/dev", "PATCH", { office_pack_access: false })).toBe("direct");
    const src = readFileSync(join(process.cwd(), "src/ui/settings-strings.js"), "utf8");
    expect(src).toContain('dashboard_office_packs: "Office skin packs: check, upload, replace and restore them (everyone sees them)"');
    expect(src).toContain('dashboard_office_packs: "辦公室外觀包：檢查、上傳、取代與還原（全 fleet 都看得到）"');
  });
});

describe("the agent's side: reading a pack", () => {
  /** A working directory and an AgEnD home with a shared folder; a pack folder written into `at`. */
  function places() {
    const work = scratch(), state = scratch(), outside = scratch();
    mkdirSync(join(state, "shared"), { recursive: true });
    const write = (at: string, src = SOURCE()) => {
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, "manifest.json"), JSON.stringify(src.manifest));
      for (const [k, v] of src.files) writeFileSync(join(at, k), v);
      return at;
    };
    return { work, state, outside, write, ctx: { workspace: work, stateDir: state, instance: "alpha" } };
  }

  it("a folder in the working directory: manifest.json and only the files it names (anything else in the folder is never read)", async () => {
    const p = places();
    p.write(join(p.work, "packs", "snug"));
    writeFileSync(join(p.work, "packs", "snug", "notes.txt"), "secret");
    writeFileSync(join(p.work, "packs", "snug", "spare.png"), png(4, 4));
    const r = await readPackSources({ dir: "packs/snug" }, p.ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.packs[0]!.files.keys()].sort()).toEqual(["bg.png", "idle.png", "plant.png", "rack.png"]);
    expect(encodePackBatch(r.packs)!.toString("utf8")).not.toMatch(/spare|notes|secret/);
  });

  it("the fleet's shared folder too; a symlink is followed, and must end inside an allowed root", async () => {
    const p = places();
    p.write(join(p.state, "shared", "packs", "snug"));
    expect((await readPackSources({ dir: join(p.state, "shared", "packs", "snug") }, p.ctx)).ok).toBe(true);
    // A link inside the working directory to a folder in it: followed.
    p.write(join(p.work, "real"));
    symlinkSync(join(p.work, "real"), join(p.work, "linked"));
    expect((await readPackSources({ dir: "linked" }, p.ctx)).ok).toBe(true);
    // A link out of it: refused.
    p.write(join(p.outside, "snug"));
    symlinkSync(join(p.outside, "snug"), join(p.work, "away"));
    expect(await readPackSources({ dir: "away" }, p.ctx)).toEqual({ ok: false, reason: expect.stringMatching(/outside your working directory and the fleet's shared folder/) });
    // A folder outside, by its path: refused.
    expect(await readPackSources({ dir: join(p.outside, "snug") }, p.ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) });
    // A picture inside the folder that links out: refused.
    p.write(join(p.work, "sly"));
    rmSync(join(p.work, "sly", "idle.png"));
    symlinkSync(join(p.outside, "snug", "idle.png"), join(p.work, "sly", "idle.png"));
    expect(await readPackSources({ dir: "sly" }, p.ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/idle\.png leads outside/) });
    // And nothing in the folder named by the manifest: refused with what is missing.
    p.write(join(p.work, "short"));
    rmSync(join(p.work, "short", "rack.png"));
    expect(await readPackSources({ dir: "short" }, p.ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/rack\.png — named by the manifest, not in the folder/) });
  });

  it("manifest + files (each path checked the same way), and packs: [...] as one batch", async () => {
    const p = places();
    p.write(join(p.work, "art"));
    const files = { "bg.png": "art/bg.png", "idle.png": "art/idle.png", "plant.png": "art/plant.png", "rack.png": "art/rack.png" };
    const one = await readPackSources({ manifest: MANIFEST(), files }, p.ctx);
    expect(one.ok && [...one.packs[0]!.files.keys()].length).toBe(4);
    expect(await readPackSources({ manifest: MANIFEST(), files: { ...files, "x.png": "art/bg.png" } }, p.ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/x\.png — the manifest does not name it/) });
    expect(await readPackSources({ manifest: MANIFEST(), files: { ...files, "bg.png": join(p.outside, "bg.png") } }, p.ctx)).toMatchObject({ ok: false });
    p.write(join(p.work, "b"), SOURCE({ id: "other" }));
    const batch = await readPackSources({ packs: [{ dir: "art" }, { dir: "b", name: "Other" }] }, p.ctx);
    expect(batch.ok && batch.packs.map(x => [x.manifest.id, x.name])).toEqual([["snug", undefined], ["other", "Other"]]);
    expect(await readPackSources({ dir: "art", packs: [{ dir: "b" }] }, p.ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/goes alone/) });
  });

  it("the fleet takes parts of bytes only: a path or a manifest sent to it directly is refused", () => {
    const u = new OfficePackUploads(() => 0);
    expect(u.accept("alpha", "office_pack_upload", { dir: "/etc" })).toMatchObject({ done: false, answer: { error: "pack_part", message: expect.stringMatching(/never a path/) } });
    expect(u.accept("alpha", "office_pack_upload", { manifest: {}, files: {} })).toMatchObject({ done: false, answer: { error: "pack_part" } });
  });
});

describe("check and upload: the web upload's checks", () => {
  it("office_pack_check: PACK OK, nothing stored, not counted; the web upload's refusals, with the same errors", async () => {
    const { t, skins, notices } = tools({ approval: "apply" });
    expect(await send(t, "office_pack_check", [SOURCE()])).toMatchObject({ result: "PACK OK", packs: [{ id: "snug", files: 4, replaces: null }] });
    expect([skins.list().packs, notices, t.limiter.left("alpha").batches]).toEqual([[], [], OFFICE_PACK_TOOL_LIMITS.batchesPerHour]);
    // The same bodies through the web upload's check refuse with the same codes.
    const strip = SOURCE(); strip.files.set("idle.png", png(32, 16));
    const notPng = SOURCE(); notPng.files.set("plant.png", Buffer.from("GIF89a not a png"));
    const badManifest = { manifest: { ...MANIFEST(), format: 2 }, files: PICTURES() };
    for (const [body, code] of [[strip, "skin_strip_dimensions"], [notPng, "skin_not_png"], [badManifest, "skin_manifest_invalid"]] as const) {
      const web = checkSkinUpload({ manifest: body.manifest, files: Object.fromEntries([...body.files].map(([k, v]) => [k, v.toString("base64")])) }, "me", 1);
      expect(web.ok ? null : web.error).toBe(code);
      expect(await send(t, "office_pack_check", [body])).toMatchObject({ error: code });
      expect(await send(t, "office_pack_upload", [body])).toMatchObject({ error: code });
    }
    const missing = SOURCE(); missing.files.delete("rack.png");
    expect(await send(t, "office_pack_upload", [missing])).toMatchObject({ error: "skin_file_missing" });
    expect(skins.list().packs).toEqual([]);
  });

  it("office_pack_upload: a new pack is kept (in place for every viewer); a batch of several is one batch", async () => {
    const { t, skins, changed } = tools({ approval: "apply" });
    const r = await send(t, "office_pack_upload", [SOURCE(), SOURCE({ id: "other" })]);
    expect(r).toMatchObject({ applied: [{ id: "snug", replaced: null, previous_kept: false }, { id: "other", replaced: null }] });
    expect(skins.list().packs.map(p => p.id).sort()).toEqual(["other", "snug"]);
    expect(t.limiter.left("alpha").batches).toBe(OFFICE_PACK_TOOL_LIMITS.batchesPerHour - 1);
    expect(changed.at(-1)).toMatchObject({ skins: skins.rev(), changes: true });
    expect(await send(t, "office_pack_upload", [SOURCE(), SOURCE()])).toMatchObject({ error: "pack_invalid", message: expect.stringMatching(/twice/) });
  });
});

describe("the offices' layout overrides against the new pack", () => {
  it("overrideConflicts: each entry that does not fit, by office; dropConflicts drops exactly those", () => {
    const v2 = checkSkinPack(MANIFEST({ desks: 3, rack: false }));
    if (!v2.ok) throw new Error(v2.error);
    const c = overrideConflicts(OFFICES as never, v2.pack);
    expect(c.map(x => [x.office, x.entry])).toEqual([["ops", "seats.desks"], ["ops", "furniture.rack"], ["ops", "furnitureNight.rack"]]);
    expect(c[0]!.rule).toBe("seats.desks: 3 seats, as the pack has");
    const after = dropConflicts(OFFICES as never, c);
    expect(after[0]!.overrides).toEqual({ pack: "snug", seats: { lounge: [[770, 270]] }, furniture: { plant: [60, 60] }, door: [600, 710] });
    expect([after[1], after[2]]).toEqual([OFFICES[1], OFFICES[2]]);
  });

  it("an upload that would leave an office unsaveable is refused with the office named; drop_invalid_overrides clears just those", async () => {
    const { t, skins, offices } = tools({ approval: "apply" });
    expect(await send(t, "office_pack_upload", [SOURCE()])).toMatchObject({ applied: [{ id: "snug" }] });
    putOffices(offices);
    const v2 = SOURCE({ desks: 3, rack: false, seed: 9 });
    const refused = await send(t, "office_pack_upload", [v2]);
    expect(refused).toMatchObject({ error: "overrides_invalid", message: expect.stringMatching(/office "Ops" \(ops\): seats\.desks: 3 seats, as the pack has/),
      conflicts: [{ pack: "snug", office: "ops", entry: "seats.desks" }, { office: "ops", entry: "furniture.rack" }, { office: "ops", entry: "furnitureNight.rack" }] });
    expect(await send(t, "office_pack_check", [v2])).toMatchObject({ error: "overrides_invalid" });
    expect(skins.get("snug")!.manifest).toEqual(MANIFEST());                              // nothing changed
    expect(await send(t, "office_pack_check", [v2], { drop_invalid_overrides: true })).toMatchObject({ result: "PACK OK", packs: [{ drops: [{ entry: "seats.desks" }, { entry: "furniture.rack" }, { entry: "furnitureNight.rack" }] }] });
    const dropped = await send(t, "office_pack_upload", [v2], { drop_invalid_overrides: true });
    expect(dropped).toMatchObject({ applied: [{ id: "snug", dropped_overrides: [{ office: "ops", entry: "seats.desks" }, { entry: "furniture.rack" }, { entry: "furnitureNight.rack" }] }] });
    const now = offices.list().offices;
    expect(now.find(o => o.id === "ops")!.overrides).toEqual({ pack: "snug", seats: { lounge: [[770, 270]] }, furniture: { plant: [60, 60] }, door: [600, 710] });
    expect(now.find(o => o.id === "den")!.overrides).toEqual(DEN);
    // And the offices save again (PUT /ui/offices checks every office against the kept pack).
    expect(offices.replace(now, offices.rev())).toMatchObject({ ok: true });
  });

  // #2694 follow-up (Fable's P3 d): seat reservations (#2691, overrides.seatFor) are dropped one seat at a time — an
  // upload breaking one used to drop the office's whole layout.
  describe("seat reservations (seatFor)", () => {
    const RES = { pack: "snug", door: [600, 710], seats: { lounge: [[780, 280]] },
      seatFor: { desks: { 0: { for: ["alpha"], lend: false }, 1: { for: ["beta"], lend: true } }, lounge: { 0: { for: ["gamma"], lend: false } } } };
    /** v1 without its lounge (everyone's default the desks). */
    const NO_LOUNGE = () => { const m: any = MANIFEST(); delete m.areas.lounge; m.stateZones = { working: "desks", default: "desks" }; return { manifest: m, files: PICTURES(5) }; };
    const setUp = async (overrides: unknown) => {
      const x = tools({ approval: "apply" });
      expect(await send(x.t, "office_pack_upload", [SOURCE()])).toMatchObject({ applied: [{ id: "snug" }] });
      putOffices(x.offices, [{ id: "res", name: "Res", skin: "snug", members: [], overrides }] as never);
      return x;
    };
    const resOf = (offices: InstanceType<typeof OfficeStore>) => offices.list().offices.find(o => o.id === "res")!.overrides;

    it("a seat gone from an area: refused naming the office and that reservation; dropped, only it goes, and the offices save again", async () => {
      const { t, offices, skins, dir } = await setUp(RES);
      const v2 = SOURCE({ desks: 1, seed: 3 });
      const refused = await send(t, "office_pack_upload", [v2]) as any;
      expect(refused).toMatchObject({ error: "overrides_invalid", message: expect.stringMatching(/office "Res" \(res\): seatFor\.desks\.1: a seat the area has \(it has 1\)/) });
      expect(refused.conflicts.map((c: any) => c.entry)).toEqual(["seatFor.desks.1"]);
      expect(skins.get("snug")!.manifest).toEqual(MANIFEST());
      expect(await send(t, "office_pack_upload", [v2], { drop_invalid_overrides: true })).toMatchObject({ applied: [{ id: "snug", dropped_overrides: [{ office: "res", entry: "seatFor.desks.1" }] }] });
      const kept = { ...RES, seatFor: { desks: { 0: { for: ["alpha"], lend: false } }, lounge: { 0: { for: ["gamma"], lend: false } } } };
      expect(resOf(offices)).toEqual(kept);
      expect(offices.replace(offices.list().offices, offices.rev())).toMatchObject({ ok: true });       // PUT /ui/offices against the new pack
      expect(resOf(new OfficeStore(dir, id => skins.pack(id)))).toEqual(kept);                           // and so on disk (beside the offices)
    });

    it("an area gone: its seats and each of its reservations are named and dropped; the rest of the layout stays", async () => {
      const { t, offices } = await setUp(RES);
      const r = await send(t, "office_pack_check", [NO_LOUNGE()]) as any;
      expect(r.conflicts.map((c: any) => c.entry)).toEqual(["seats.lounge", "seatFor.lounge.0"]);
      expect(await send(t, "office_pack_upload", [NO_LOUNGE()], { drop_invalid_overrides: true })).toMatchObject({ applied: [{ dropped_overrides: [{ entry: "seats.lounge" }, { entry: "seatFor.lounge.0" }] }] });
      expect(resOf(offices)).toEqual({ pack: "snug", door: [600, 710], seatFor: { desks: RES.seatFor.desks } });
      expect(offices.replace(offices.list().offices, offices.rev())).toMatchObject({ ok: true });
    });

    it("an area's empty reservation map, its area gone, is one entry (Prism's #2693 P3 shape)", async () => {
      const { t, offices } = await setUp({ pack: "snug", door: [600, 710], seatFor: { lounge: {} } });
      const r = await send(t, "office_pack_check", [NO_LOUNGE()]) as any;
      expect(r.conflicts.map((c: any) => [c.entry, c.rule])).toEqual([["seatFor.lounge", "seatFor.lounge: an area the pack defines"]]);
      await send(t, "office_pack_upload", [NO_LOUNGE()], { drop_invalid_overrides: true });
      expect(resOf(offices)).toEqual({ pack: "snug", door: [600, 710] });
    });

    it("a pack that keeps every reserved seat is no conflict; a restore is checked the same way", async () => {
      const { t, offices } = await setUp(RES);
      expect(await send(t, "office_pack_check", [SOURCE({ desks: 2, seed: 4 })])).toMatchObject({ result: "PACK OK", packs: [{ id: "snug" }] });
      await send(t, "office_pack_upload", [NO_LOUNGE()], { drop_invalid_overrides: true });
      // Back to the version with the lounge: the reservations left fit it, so nothing else is dropped.
      expect(t.handle("alpha", "office_pack_restore", { id: "snug" })).toMatchObject({ applied: { restored: "snug" } });
      expect(resOf(offices)).toEqual({ pack: "snug", door: [600, 710], seatFor: { desks: RES.seatFor.desks } });
    });

    it("never the whole layout: a conflict no single entry explains is refused even with drop_invalid_overrides", () => {
      expect(() => dropConflicts(OFFICES as never, [{ office: "ops", name: "Ops", entry: "overrides", rule: "x" }])).toThrow(/undroppable/);
    });
  });
});

describe("the notice names what a change drops", () => {
  it("an admin approving from General sees each office and its entries; the applied notice too", async () => {
    const { t, offices, notices } = tools({ approval: "apply" });
    await send(t, "office_pack_upload", [SOURCE()]);
    putOffices(offices);
    t.setApproval("approve", "admin");
    const v2 = SOURCE({ desks: 3, rack: false, seed: 9 });
    const r = await send(t, "office_pack_upload", [v2], { drop_invalid_overrides: true }) as any;
    expect(r.pending.drops.map((d: any) => d.entry)).toEqual(["seats.desks", "furniture.rack", "furnitureNight.rack"]);
    expect(notices.at(-1)!.text).toContain("and dropping 3 layout override(s) that no longer fit — Ops: seats.desks, furniture.rack, furnitureNight.rack.");
    const yes = t.decide(r.pending.id, "approve", "admin");
    expect(yes).toMatchObject({ ok: true, text: expect.stringContaining("— Ops: seats.desks, furniture.rack, furnitureNight.rack") });
  });

  it("several offices, grouped; past the first six entries, the rest are counted", () => {
    const c = (office: string, name: string, entry: string) => ({ office, name, entry, rule: "x" });
    const many = [c("ops", "Ops", "seats.desks"), c("ops", "Ops", "furniture.a"), c("den", "Den", "seats.lounge"), c("ops", "Ops", "furniture.b"),
      c("den", "Den", "furniture.c"), c("lab", "Lab", "furnitureNight.d"), c("lab", "Lab", "furniture.e"), c("lab", "Lab", "furniture.f")];
    expect(dropsText(many)).toBe("and dropping 8 layout override(s) that no longer fit — Ops: seats.desks, furniture.a, furniture.b; Den: seats.lounge, furniture.c; Lab: furnitureNight.d …and 2 more");
    expect(dropsText(many.slice(0, 1))).toBe("and dropping 1 layout override(s) that no longer fit — Ops: seats.desks");
    const zh = readFileSync(join(process.cwd(), "src/locale.ts"), "utf8");
    expect(zh).toContain('"office_packs.drops": "並移除 {0} 項已不合用的版面調整——{1}"');
    expect(zh).toContain('"office_packs.drops_more": "…另有 {0} 項"');
  });
});

describe("replace: atomic, one previous version kept, restore", () => {
  it("a replace keeps the previous version (not counted as a pack); restore brings it back, and restoring again undoes that", async () => {
    const { t, skins, dir } = tools({ approval: "apply" });
    const first = await send(t, "office_pack_upload", [SOURCE()]) as any;
    const v1 = first.applied[0].version;
    const second = await send(t, "office_pack_upload", [SOURCE({ seed: 5 })]) as any;
    expect(second.applied[0]).toMatchObject({ replaced: v1, previous_kept: true });
    const v2 = second.applied[0].version;
    expect(existsSync(join(dir, "web-office-skins", "snug", PREVIOUS_FILE))).toBe(true);
    const listed = t.handle("alpha", "office_pack_list", {}) as any;
    expect(listed.packs).toEqual([expect.objectContaining({ id: "snug", version: v2, previous: expect.objectContaining({ version: v1 }), offices: [] })]);
    expect(skins.list().packs.length).toBe(1);
    expect(t.handle("alpha", "office_pack_restore", { id: "snug" })).toMatchObject({ applied: { restored: "snug", version: v1, replaced: v2 } });
    expect(skins.get("snug")!.sha).toBe(v1);
    // A cold read agrees, and every picture of the restored version is served.
    const cold = new OfficeSkinStore(dir);
    expect([cold.get("snug")!.sha, cold.records().previous.get("snug")!.sha]).toEqual([v1, v2]);
    for (const id of Object.values(cold.get("snug")!.files)) expect(cold.picture("snug", id)).not.toBeNull();
    expect(t.handle("alpha", "office_pack_restore", { id: "snug" })).toMatchObject({ applied: { restored: "snug", version: v2, replaced: v1 } });
    expect(t.handle("alpha", "office_pack_restore", { id: "nope" })).toMatchObject({ error: "skin_no_previous" });
  });

  it("a replace that fails mid-way leaves the old version in place — and the offices as they were", async () => {
    let fail = false;
    const { t, skins, offices, dir } = tools({ approval: "apply", hooks: { beforeSwap: () => { if (fail) throw new Error("disk full"); } } });
    const v1 = ((await send(t, "office_pack_upload", [SOURCE()])) as any).applied[0].version;
    putOffices(offices);
    const officesBefore = offices.list().offices;
    const prevBefore = existsSync(join(dir, "web-office-skins", "snug", PREVIOUS_FILE));
    fail = true;
    const r = await send(t, "office_pack_upload", [SOURCE({ desks: 3, rack: false, seed: 7 })], { drop_invalid_overrides: true });
    expect(r).toMatchObject({ error: "skin_write_failed", message: expect.stringMatching(/disk full; the version kept before stays/) });
    expect(skins.get("snug")!.sha).toBe(v1);
    expect(new OfficeSkinStore(dir).get("snug")!.sha).toBe(v1);                          // on disk too
    expect(existsSync(join(dir, "web-office-skins", "snug", PREVIOUS_FILE))).toBe(prevBefore);
    for (const id of Object.values(skins.get("snug")!.files)) expect(skins.picture("snug", id)).not.toBeNull();
    expect(offices.list().offices).toEqual(officesBefore);                               // the drop was put back
    fail = false;
    expect(await send(t, "office_pack_upload", [SOURCE({ seed: 7 })])).toMatchObject({ applied: [{ replaced: v1 }] });
  });

  it("delete: its previous version goes with it, unless keep_previous — then restore brings it back", async () => {
    const { t, skins } = tools({ approval: "apply" });
    await send(t, "office_pack_upload", [SOURCE()]);
    await send(t, "office_pack_upload", [SOURCE({ seed: 3 })]);
    expect(t.handle("alpha", "office_pack_delete", { id: "snug", keep_previous: true })).toMatchObject({ applied: { deleted: "snug", previous_kept: true } });
    expect(skins.list().packs).toEqual([]);
    expect((t.handle("alpha", "office_pack_list", {}) as any).deleted).toEqual([expect.objectContaining({ id: "snug" })]);
    expect(t.handle("alpha", "office_pack_restore", { id: "snug" })).toMatchObject({ applied: { restored: "snug", replaced: null } });
    expect(skins.list().packs.map(p => p.id)).toEqual(["snug"]);
    expect(t.handle("alpha", "office_pack_delete", { id: "snug" })).toMatchObject({ applied: { deleted: "snug", previous_kept: false } });
    expect([skins.list().packs, (t.handle("alpha", "office_pack_list", {}) as any).deleted]).toEqual([[], []]);
    expect(t.handle("alpha", "office_pack_delete", { id: "snug" })).toMatchObject({ error: "skin_unknown" });
  });

  // #2694 follow-up (Fable's P3 e): a pack deleted keeping its previous version is kept out of the pack's own directory,
  // so a host before #2692 (which sees the id free) can upload it again and nothing is left it can neither use nor delete.
  describe("a deleted pack's kept previous lives in .kept-<id>", () => {
    const skinsDir = (dir: string) => join(dir, "web-office-skins");
    const deletedKeeping = async () => {
      const x = tools({ approval: "apply" });
      await send(x.t, "office_pack_upload", [SOURCE()]);
      await send(x.t, "office_pack_upload", [SOURCE({ seed: 3 })]);
      const v1 = x.skins.records().previous.get("snug")!.sha;
      expect(x.t.handle("alpha", "office_pack_delete", { id: "snug", keep_previous: true })).toMatchObject({ applied: { previous_kept: true } });
      return { ...x, v1 };
    };
    const files = (dir: string) => readdirSync(dir).sort();

    it("the pack's directory is gone (the id free); its previous and that version's pictures only, in .kept-snug, read back after a restart", async () => {
      const { dir, skins, v1 } = await deletedKeeping();
      expect(existsSync(join(skinsDir(dir), "snug"))).toBe(false);
      const kept = join(skinsDir(dir), ".kept-snug");
      const v1Pictures = Object.values(skins.records().previous.get("snug")!.files).map(f => `${f.id}.png`);
      expect(files(kept)).toEqual([...new Set(v1Pictures)].concat(PREVIOUS_FILE).sort());
      const again = new OfficeSkinStore(dir);
      expect([again.list().packs, again.records().previous.get("snug")!.sha]).toEqual([[], v1]);
    });

    it("restore makes it the pack again (its own directory, no previous); an upload of the id brings the kept previous back with it", async () => {
      const a = await deletedKeeping();
      expect(a.t.handle("alpha", "office_pack_restore", { id: "snug" })).toMatchObject({ applied: { restored: "snug" } });
      expect([existsSync(join(skinsDir(a.dir), ".kept-snug")), files(join(skinsDir(a.dir), "snug")).includes(PREVIOUS_FILE), a.skins.get("snug")!.sha]).toEqual([false, false, a.v1]);
      expect(new OfficeSkinStore(a.dir).get("snug")!.sha).toBe(a.v1);
      const b = await deletedKeeping();
      expect(await send(b.t, "office_pack_upload", [SOURCE({ seed: 7 })])).toMatchObject({ applied: [{ id: "snug" }] });
      expect([existsSync(join(skinsDir(b.dir), ".kept-snug")), b.skins.records().previous.get("snug")!.sha]).toEqual([false, b.v1]);
      expect(new OfficeSkinStore(b.dir).records().previous.get("snug")!.sha).toBe(b.v1);
      expect(b.t.handle("alpha", "office_pack_restore", { id: "snug" })).toMatchObject({ applied: { restored: "snug" } });
    });

    it("deleting it again removes the kept previous", async () => {
      const { dir, t } = await deletedKeeping();
      expect(t.handle("alpha", "office_pack_delete", { id: "snug" })).toMatchObject({ applied: { previous_kept: false } });
      expect(files(skinsDir(dir)).filter(n => !n.startsWith(".agent-changes"))).toEqual([]);              // the change log stays
    });

    it("the layout #2692 first wrote (pack.prev.json alone in snug/) is moved out when read", async () => {
      const { dir } = await deletedKeeping();
      renameSync(join(skinsDir(dir), ".kept-snug"), join(skinsDir(dir), "snug"));
      const s = new OfficeSkinStore(dir);
      expect([s.list().packs, s.records().previous.has("snug")]).toEqual([[], true]);
      expect([existsSync(join(skinsDir(dir), "snug")), existsSync(join(skinsDir(dir), ".kept-snug", PREVIOUS_FILE))]).toEqual([false, true]);
    });

    it("a deleted version's pack.json a crash left in .kept-snug is cleared when read, so a later put-back crash cannot bring it back (#2696 review)", async () => {
      const { dir, skins } = await deletedKeeping();
      const v2 = skins.records().previous.get("snug")!;                                    // any record will do as the stale file
      writeFileSync(join(skinsDir(dir), ".kept-snug", "pack.json"), JSON.stringify({ ...v2, manifest: MANIFEST() }));
      const s = new OfficeSkinStore(dir);
      expect([s.list().packs, existsSync(join(skinsDir(dir), ".kept-snug", "pack.json")), s.records().previous.has("snug")]).toEqual([[], false, true]);
      // A put-back that crashed between its rename and the swap: snug/ holds only the previous, moved out again when read.
      renameSync(join(skinsDir(dir), ".kept-snug"), join(skinsDir(dir), "snug"));
      const after = new OfficeSkinStore(dir);
      expect([after.list().packs, after.records().previous.has("snug")]).toEqual([[], true]);
    });

    it("the id uploaded again where .kept-snug is not read (an older host): that pack is the one, the old previous goes", async () => {
      const { dir, v1 } = await deletedKeeping();
      // An older host's add(): the pack's own directory, its pictures and pack.json (it never looks at .kept-snug).
      const c = checkSkinUpload({ manifest: MANIFEST(), files: Object.fromEntries([...PICTURES(11)].map(([k, b]) => [k, b.toString("base64")])) }, "web", 5);
      if (!c.ok) throw new Error(c.error);
      mkdirSync(join(skinsDir(dir), "snug"));
      for (const [id, bytes] of c.pictures) writeFileSync(join(skinsDir(dir), "snug", `${id}.png`), bytes);
      writeFileSync(join(skinsDir(dir), "snug", "pack.json"), JSON.stringify(c.record));
      const s = new OfficeSkinStore(dir);
      expect([s.get("snug")!.sha, s.records().previous.has("snug"), existsSync(join(skinsDir(dir), ".kept-snug"))]).toEqual([c.record.sha, false, false]);
      expect(c.record.sha).not.toBe(v1);
    });
  });

  it("office_set_style points a stored office at a pack or a built-in style; its overrides must fit", async () => {
    const { t, offices } = tools({ approval: "apply" });
    await send(t, "office_pack_upload", [SOURCE()]);
    putOffices(offices);
    expect(t.handle("alpha", "office_set_style", { office: "lab", pack: "snug" })).toMatchObject({ applied: { office: "lab", style: "snug", was: "pixel" } });
    expect(t.handle("alpha", "office_set_style", { office: "ops", pack: "studio" })).toMatchObject({ applied: { style: "studio" } });
    expect(offices.list().offices.map(o => o.skin)).toEqual(["studio", "snug", "snug"]);
    expect(t.handle("alpha", "office_set_style", { office: "nope", pack: "snug" })).toMatchObject({ error: "office" });
    expect(t.handle("alpha", "office_set_style", { office: "lab", pack: "ghost" })).toMatchObject({ error: "style" });
  });
});

describe("approval: a change waits for an admin's yes", () => {
  it("the default holds the change as pending (nothing stored), told to the admins with it; approved, it is judged again and applied", async () => {
    const { t, skins, notices, settled } = tools();
    expect(t.approval()).toBe("approve");
    const r = await send(t, "office_pack_upload", [SOURCE()]) as any;
    expect(r).toMatchObject({ pending: { action: "upload", instance: "alpha", packs: [{ id: "snug", files: 4 }] }, message: expect.stringMatching(/waits for a fleet admin's yes/) });
    expect(skins.list().packs).toEqual([]);
    expect(notices).toEqual([{ text: expect.stringMatching(/^Office packs — alpha asks to upload snug “snug” \(4 files, 0\.0 MiB\)\.\nApprove or reject it here or on the Office page/), pending: expect.objectContaining({ id: r.pending.id }) }]);
    expect((t.handle("alpha", "office_pack_list", {}) as any).pending.map((v: any) => v.id)).toEqual([r.pending.id]);
    expect(t.changes().pending.map(v => v.id)).toEqual([r.pending.id]);
    const yes = t.decide(r.pending.id, "approve", "discord:42");
    expect(yes).toMatchObject({ ok: true, text: expect.stringMatching(/^Office packs — approved by discord:42 for alpha: uploaded snug/), applied: { applied: [{ id: "snug" }] } });
    expect(skins.list().packs.map(p => p.id)).toEqual(["snug"]);
    expect(settled).toEqual([[r.pending.id, yes.text]]);
    expect(t.decide(r.pending.id, "approve", "discord:42")).toMatchObject({ ok: false, status: 404 });
  });

  it("rejected: nothing changes; judged again on a yes: an office changed meanwhile refuses it; a fleet restart forgets it", async () => {
    const { t, skins, offices } = tools();
    expect(t.handle("alpha", "office_pack_delete", { id: "snug" })).toMatchObject({ error: "skin_unknown" });   // judged before it waits
    // Stored by an admin (apply), then a pending replace.
    t.setApproval("apply", "admin"); await send(t, "office_pack_upload", [SOURCE()]); t.setApproval("approve", "admin");
    const r = await send(t, "office_pack_upload", [SOURCE({ desks: 3, rack: false, seed: 4 })]) as any;
    expect(r.pending).toBeTruthy();
    expect(t.decide(r.pending.id, "reject", "admin")).toMatchObject({ ok: true, text: expect.stringMatching(/rejected by admin; nothing changed/) });
    const again = await send(t, "office_pack_upload", [SOURCE({ desks: 3, rack: false, seed: 4 })]) as any;
    putOffices(offices);                                                                  // meanwhile, offices with overrides on it
    expect(t.decide(again.pending.id, "approve", "admin")).toMatchObject({ ok: false, status: 409, error: "overrides_invalid", text: expect.stringMatching(/approved, but not applied/) });
    expect(skins.get("snug")!.manifest).toEqual(MANIFEST());
    const fresh = new OfficePackTools({ skins, offices, allowedAgents: () => [], notice: () => {}, settled: () => {}, changed: () => {} });
    expect(fresh.pendingViews()).toEqual([]);
  });

  it("pending changes expire after a day (their prompt says so); the admins' choice is kept beside the packs", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const { t, skins, offices, settled } = tools();
    const r = await send(t, "office_pack_upload", [SOURCE()]) as any;
    vi.setSystemTime(1_000_000 + OFFICE_PACK_TOOL_LIMITS.pendingMs + 1);
    expect(t.pendingViews()).toEqual([]);
    expect(settled).toEqual([[r.pending.id, expect.stringMatching(/not approved in time; nothing changed/)]]);
    expect(t.setApproval("apply", "admin")).toEqual({ ok: true, approval: "apply" });
    expect(t.setApproval("later", "admin")).toMatchObject({ ok: false });
    const again = new OfficePackTools({ skins, offices, allowedAgents: () => [], notice: () => {}, settled: () => {}, changed: () => {} });
    expect(again.approval()).toBe("apply");
  });
});

describe("the log and the notice", () => {
  it("every upload, replace, delete and restore: who, when, which pack, files, bytes, the manifest's and each picture's sha256", async () => {
    const { t, skins, dir, notices } = tools({ approval: "apply" });
    await send(t, "office_pack_upload", [SOURCE()]);
    await send(t, "office_pack_upload", [SOURCE({ seed: 2 })]);
    t.handle("alpha", "office_pack_restore", { id: "snug" });
    t.handle("alpha", "office_pack_delete", { id: "snug" });
    const lines = readFileSync(join(dir, "web-office-skins", ".agent-changes.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines.map(l => [l.by, l.action, l.pack])).toEqual([["admin", "approval", undefined], ["alpha", "upload", "snug"], ["alpha", "replace", "snug"], ["alpha", "restore", "snug"], ["alpha", "delete", "snug"]]);
    const up = lines[1]!;
    expect(up).toMatchObject({ files: 4, bytes: expect.any(Number), version: expect.stringMatching(/^[0-9a-f]{32}$/), manifest_sha256: sha256(JSON.stringify(MANIFEST())), previous_kept: false });
    expect(Date.parse(up.at)).toBeGreaterThan(0);
    // Each picture's sha256 is of the bytes kept (the same a restore brings back: the restore entry matches the upload's).
    const kept = checkSkinUpload({ manifest: MANIFEST(), files: Object.fromEntries([...PICTURES()].map(([k, v]) => [k, v.toString("base64")])) }, "x", 1);
    if (!kept.ok) throw new Error(kept.error);
    expect(up.pictures).toEqual(Object.fromEntries(Object.entries(kept.record.files).map(([src, f]) => [src, sha256(kept.pictures.get(f.id)!)])));
    expect([lines[3]!.version, lines[3]!.pictures, lines[3]!.manifest_sha256]).toEqual([up.version, up.pictures, up.manifest_sha256]);
    expect(lines[2]).toMatchObject({ replaced_version: up.version, previous_kept: true });
    expect(t.changes().log[0]).toMatchObject({ action: "delete" });
    expect(skins.list().packs).toEqual([]);
    // One short message each, to the admins — never a sign-in notice.
    expect(notices.map(n => n.text)).toEqual([
      expect.stringMatching(/^Office packs — alpha: uploaded snug “snug” \(4 files, 0\.0 MiB\)$/),
      expect.stringMatching(/^Office packs — alpha: uploaded snug .* replacing version [0-9a-f]{8} \(kept for a restore\)$/),
      expect.stringMatching(/^Office packs — alpha: restored snug to its previous version [0-9a-f]{8}$/),
      "Office packs — alpha: deleted snug (its previous version too)",
    ]);
    expect(notices.every(n => !n.text.includes("\n") && !("pending" in n))).toBe(true);
  });
});

describe("the rate limit: batches and bytes, not packs", () => {
  it("OfficePackBatchLimiter: at most N batches and B bytes an hour; when the next may go; larger than the hour never", () => {
    const clock = { t: 0 };
    const l = new OfficePackBatchLimiter(() => clock.t, { batchesPerHour: 2, bytesPerHour: 100 });
    expect(l.check("a", 60)).toEqual({ ok: true }); l.record("a", 60);
    expect(l.check("a", 60)).toMatchObject({ ok: false, retry_after_ms: 3_600_000 });   // bytes
    clock.t = 1_000; expect(l.check("a", 40)).toEqual({ ok: true }); l.record("a", 40);
    expect(l.check("a", 0)).toMatchObject({ ok: false, retry_after_ms: 3_599_000 });    // batches
    expect(l.check("b", 0)).toEqual({ ok: true });                                       // per agent
    expect(l.check("b", 101)).toMatchObject({ ok: false, retry_after_ms: null });
    clock.t = 3_600_001; expect(l.check("a", 60)).toEqual({ ok: true });
    expect(l.left("a")).toEqual({ batches: 1, bytes: 60 });
  });

  it("through the tools: a batch of several packs counts once; refusals and checks are not counted", async () => {
    const clock = { t: 0 };
    const { t } = tools({ approval: "apply", limiter: new OfficePackBatchLimiter(() => clock.t, { batchesPerHour: 2, bytesPerHour: 200 * 1024 * 1024 }) });
    expect(await send(t, "office_pack_upload", [SOURCE(), SOURCE({ id: "b" }), SOURCE({ id: "c" })])).toMatchObject({ applied: [{}, {}, {}] });
    await send(t, "office_pack_check", [SOURCE()]);
    expect(t.handle("alpha", "office_pack_restore", { id: "snug" })).toMatchObject({ error: "skin_no_previous" });
    expect(t.handle("alpha", "office_pack_delete", { id: "c" })).toMatchObject({ applied: { deleted: "c" } });
    expect(t.handle("alpha", "office_pack_delete", { id: "b" })).toMatchObject({ error: "rate_limited", retry_after_ms: 3_600_000, message: expect.stringMatching(/at most 2 batches/) });
    expect(t.handle("beta", "office_pack_delete", { id: "b" })).toMatchObject({ applied: { deleted: "b" } });
  });

  it("the stated defaults: 20 batches and 200 MiB an hour per agent", () => {
    expect([OFFICE_PACK_TOOL_LIMITS.batchesPerHour, OFFICE_PACK_TOOL_LIMITS.bytesPerHour]).toEqual([20, 200 * 1024 * 1024]);
  });
});

// ── The fleet: the IPC door, the Office page's routes, the notice's buttons ──

interface Res { status: number; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
async function fleet() {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const dir = scratch();
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  const told: string[] = [];
  vi.spyOn(fm, "notifyFleetError").mockImplementation((text: unknown) => { told.push(String(text)); return true; });
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp", office_pack_access: true }, beta: { working_directory: "/tmp" } }, defaults: {}, teams: {} };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" = "admin") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
    const cookie = `agend_session=${sessionId}`;
    return { read: { cookie }, write: { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } };
  };
  const stop = () => new Promise<void>(r => (fm.healthServer as Server).close(() => r()));
  return { fm, dir, port, session, stop, told };
}

describe("the fleet", () => {
  it("over IPC and the agent endpoint: the connection's instance, answered as a web theme tool; the switch names who may", async () => {
    const f = await fleet();
    try {
      const sent: Array<[string, unknown]> = [];
      vi.spyOn(f.fm, "emitSseEvent").mockImplementation((...a: unknown[]) => { sent.push([a[0] as string, a[1]]); });
      f.fm.officePackTools.setApproval("apply", "admin");
      const bytes = encodePackBatch([SOURCE()])!;
      const answer = await sendPackBatchInParts(bytes, {}, async args => f.fm.handleWebThemeHttp("alpha", "office_pack_upload", args));
      expect(answer).toMatchObject({ applied: [{ id: "snug" }] });
      expect(f.fm.officeSkins.list().packs.map((p: any) => p.id)).toEqual(["snug"]);
      expect(sent.map(s => s[0])).toEqual(expect.arrayContaining(["office_skins", "office_pack_changes"]));
      expect(f.told).toEqual([expect.stringMatching(/^Office packs — alpha: uploaded snug/)]);
      const ipcSend = vi.fn(() => true);
      f.fm.instanceIpcClients.set("alpha", { send: ipcSend });
      f.fm.dispatchTypedIpc("alpha", { type: "fleet_office_pack_list", fleetRequestId: "r1", payload: {}, meta: { instance_name: "beta" } });
      expect((ipcSend.mock.calls[0] as unknown as [Record<string, any>])[0]).toMatchObject({ type: "fleet_web_theme_response", fleetRequestId: "r1", result: { packs: [{ id: "snug" }], approval: "apply", left: { batches: 19 } } });
      f.fm.refuseTypedIpc("alpha", { type: "fleet_office_pack_upload", fleetRequestId: "r2" }, "nope");
      expect((ipcSend.mock.calls[1] as unknown as [Record<string, any>])[0]).toEqual({ type: "fleet_web_theme_response", fleetRequestId: "r2", error: "nope" });
      expect(f.fm.officePackTools.changes().agents).toEqual(["alpha"]);
    } finally { await f.stop(); }
  }, 30_000);

  it("the Office page: an admin session sees the agents, the approval mode and pending changes, and decides them; read, token and anonymous refused", async () => {
    const f = await fleet();
    try {
      vi.spyOn(f.fm, "emitSseEvent").mockImplementation(() => {});
      const r = await sendPackSources({ dir: "p" }, { workspace: (() => { const w = scratch(); mkdirSync(join(w, "p")); writeFileSync(join(w, "p", "manifest.json"), JSON.stringify(MANIFEST())); for (const [k, v] of PICTURES()) writeFileSync(join(w, "p", k), v); return w; })(), stateDir: scratch() },
        async args => f.fm.handleWebThemeHttp("alpha", "office_pack_upload", args) as Promise<Record<string, unknown>>) as any;
      expect(r.pending).toBeTruthy();                                                     // the default: needs a yes
      expect(f.told).toEqual([expect.stringMatching(/^Office packs — alpha asks to upload snug/)]);   // no General with buttons: the plain notice
      expect((await raw(f.port, "GET", "/ui/office-pack-changes")).status).toBe(401);
      expect((await raw(f.port, "GET", "/ui/office-pack-changes", f.session("read").read)).status).toBe(403);
      expect((await raw(f.port, "GET", "/ui/office-pack-changes", { "x-agend-token": f.fm.getDashboardAccess().token })).status).toBe(403);
      const admin = f.session("admin");
      const got = await raw(f.port, "GET", "/ui/office-pack-changes", admin.read);
      expect([got.status, JSON.parse(got.body)]).toEqual([200, { approval: "approve", agents: ["alpha"], pending: [expect.objectContaining({ id: r.pending.id, instance: "alpha" })], log: [expect.objectContaining({ outcome: "pending" })] }]);
      expect((await raw(f.port, "POST", `/ui/office-pack-changes/${r.pending.id}`, f.session("read").write, JSON.stringify({ decision: "approve" }))).status).toBe(403);
      expect(f.fm.officeSkins.list().packs).toEqual([]);
      const yes = await raw(f.port, "POST", `/ui/office-pack-changes/${r.pending.id}`, admin.write, JSON.stringify({ decision: "approve" }));
      expect([yes.status, JSON.parse(yes.body).text]).toEqual([200, expect.stringMatching(/approved by .* for alpha: uploaded snug/)]);
      expect(f.fm.officeSkins.list().packs.map((p: any) => p.id)).toEqual(["snug"]);
      const mode = await raw(f.port, "POST", "/ui/office-pack-changes", admin.write, JSON.stringify({ approval: "apply" }));
      expect([mode.status, JSON.parse(mode.body).approval]).toEqual([200, "apply"]);
      expect((await raw(f.port, "POST", "/ui/office-pack-changes", admin.write, JSON.stringify({ approval: "sometimes" }))).status).toBe(400);
      // Guests and the public link are unaffected: never theirs.
      expect([isPublicWebRoute("GET", "/ui/office-pack-changes"), isPublicWebRoute("POST", "/ui/office-pack-changes")]).toEqual([false, false]);
      expect(guestRouteDecision("GET", new URL("http://h/ui/office-pack-changes"), new Set(["alpha"]))).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
      expect(guestFrameData("office_pack_changes", {}, new Set(["alpha"]), { owner: { adapterId: "a", userId: "u" } } as never)).toBeUndefined();
    } finally { await f.stop(); }
  }, 30_000);

  it("from the notice: Approve on its buttons in General decides the pending change and retires the buttons with what happened", async () => {
    const f = await fleet();
    try {
      vi.spyOn(f.fm, "emitSseEvent").mockImplementation(() => {});
      const r = await send(f.fm.officePackTools, "office_pack_upload", [SOURCE()]) as any;
      const nonce = "a".repeat(32);
      f.fm.officePackPrompts.set(r.pending.id, nonce);
      const entry = { prefix: "office-pack:", messageId: "m1" };
      vi.spyOn(f.fm, "consumeNonceCallback").mockReturnValue({ entry, action: "approve" });
      const retire = vi.spyOn(f.fm, "retireNonceButtons").mockResolvedValue(undefined);
      expect(await f.fm.handleOfficePackCallback({ callbackData: `office-pack:${nonce}:approve`, userId: "42", messageId: "m1", chatId: "c" }, "main")).toBe(true);
      expect(f.fm.officeSkins.list().packs.map((p: any) => p.id)).toEqual(["snug"]);
      expect(retire).toHaveBeenCalledWith(entry, "m1", expect.stringMatching(/approved by fleet admin 42 for alpha/));
      expect(f.fm.officePackPrompts.size).toBe(0);
    } finally { await f.stop(); }
  }, 30_000);
});
