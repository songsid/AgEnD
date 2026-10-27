/**
 * #2695: Fable's three follow-ups on the Office pack tools (#2694 review).
 * (a) office_pack_check has its own hourly budget of batches and wire bytes, counted when a batch's first part arrives
 *     (refused before the rest of it is taken), apart from the changes' budget.
 * (b) A replace cut short by a crash (after the new pictures, before the swap) leaves pictures neither version names:
 *     the next read of the packs removes them — in a pack's directory and in a .kept-<id> one — and only where every
 *     record there was read back.
 * (c) An admin's yes covers the drops the notice showed: offices edited since, so that the change would drop other
 *     entries, refuse it with 409 (the agent resubmits).
 *
 * Isolation: temp directories; no child process.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const { OfficePackTools, OfficePackBatchLimiter, OFFICE_PACK_TOOL_LIMITS } = await import("../src/web-office-pack-tools.js");
const { encodePackBatch, sendPackBatchInParts, PACK_BATCH_WIRE_BYTES } = await import("../src/web-office-pack-read.js");
const { OfficeSkinStore, PREVIOUS_FILE } = await import("../src/web-office-skins.js");
const { OfficeStore } = await import("../src/web-office-store.js");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-pack-2695-")); dirs.push(d); return d; };

/** A tiny valid PNG of w×h; `seed` changes its bytes. */
function png(w: number, h: number, seed = 0): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h, seed);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const STRIP = (src: string) => ({ src, frames: 1, w: 16, h: 16, fps: 0, ax: 8, ay: 15 });
const MANIFEST = (o: { rack?: boolean } = {}) => ({
  format: 1, id: "snug", background: "bg.png",
  areas: { desks: { rect: [40, 120, 600, 400], seats: [[120, 220], [260, 220]] }, lounge: { rect: [700, 120, 500, 300], seats: [[760, 260]] } },
  stateZones: { working: "desks", default: "lounge" },
  furniture: [...(o.rack === false ? [] : [{ id: "rack", sprite: STRIP("rack.png"), x: 1020, y: 140, night: { sprite: STRIP("rack.png"), x: 300, y: 420 } }]), { id: "plant", sprite: STRIP("plant.png"), x: 50, y: 50 }],
  characters: { default: { idle: STRIP("idle.png") } },
});
const SOURCE = (o: { rack?: boolean; seed?: number } = {}) => {
  const seed = o.seed ?? 0;
  return { manifest: MANIFEST(o), files: new Map<string, Buffer>([["bg.png", png(32, 18, seed)], ["idle.png", png(16, 16, seed)], ["plant.png", png(16, 16, seed + 1)],
    ...(o.rack === false ? [] : [["rack.png", png(16, 16, seed + 2)] as [string, Buffer]])]) };
};
const OPS = { pack: "snug", seats: { desks: [[130, 230], [270, 230]] }, furniture: { rack: [1000, 150] }, furnitureNight: { rack: [310, 430] } };
const DEN = { pack: "snug", seats: { lounge: [[780, 280]] } };
const OFFICES = [{ id: "ops", name: "Ops", skin: "snug", members: [], overrides: OPS }, { id: "den", name: "Den", skin: "snug", members: [], overrides: DEN }];

function tools(o: { approval?: "apply" | "approve"; checkLimiter?: InstanceType<typeof OfficePackBatchLimiter>; hooks?: { beforeSwap?(id: string): void } } = {}) {
  const dir = scratch();
  const skins = new OfficeSkinStore(dir, () => 1_000, o.hooks);
  const offices = new OfficeStore(dir, id => skins.pack(id));
  const settled: Array<[string, string]> = [];
  const t = new OfficePackTools({ skins, offices, allowedAgents: () => ["alpha"], notice: () => {}, settled: (id, text) => settled.push([id, text]), changed: () => {} },
    o.checkLimiter ? { checkLimiter: o.checkLimiter } : {});
  if (o.approval) expect(t.setApproval(o.approval, "admin")).toMatchObject({ ok: true });
  return { dir, skins, offices, t, settled };
}
async function send(t: InstanceType<typeof OfficePackTools>, tool: "office_pack_check" | "office_pack_upload", packs: Array<{ manifest: unknown; files: Map<string, Buffer> }>, opts: Record<string, unknown> = {}) {
  const bytes = encodePackBatch(packs as never)!;
  const parts: number[] = [];
  const answer = await sendPackBatchInParts(bytes, opts, async args => { parts.push((args.part as { index: number }).index); return t.handle("alpha", tool, args) as Record<string, unknown>; });
  return Object.assign(answer, { parts, wire: bytes.length });
}
const skinsDir = (dir: string) => join(dir, "web-office-skins");
const pngs = (dir: string) => readdirSync(dir).filter(n => n.endsWith(".png")).sort();
const ORPHAN = `${"a".repeat(32)}.png`;

describe("(a) office_pack_check has its own budget", () => {
  it("the stated defaults: 60 batches and 1 GiB of wire bytes an hour, room for several of the largest batch", () => {
    expect([OFFICE_PACK_TOOL_LIMITS.checkBatchesPerHour, OFFICE_PACK_TOOL_LIMITS.checkBytesPerHour]).toEqual([60, 1024 * 1024 * 1024]);
    expect(OFFICE_PACK_TOOL_LIMITS.checkBytesPerHour).toBeGreaterThan(4 * PACK_BATCH_WIRE_BYTES);
  });

  it("each check counts its wire bytes, a refused one too; past the budget the first part is refused, nothing more taken", async () => {
    const clock = { t: 0 };
    const { t } = tools({ checkLimiter: new OfficePackBatchLimiter(() => clock.t, { batchesPerHour: 2, bytesPerHour: 1024 * 1024 * 1024 }) });
    const ok = await send(t, "office_pack_check", [SOURCE()]);
    expect(ok).toMatchObject({ result: "PACK OK" });
    const bad = await send(t, "office_pack_check", [{ manifest: { format: 1 }, files: new Map() }]);
    expect(bad.error).toBeTypeOf("string");
    expect(t.checkLimiter.left("alpha")).toEqual({ batches: 0, bytes: 1024 * 1024 * 1024 - ok.wire - bad.wire });
    const over = await send(t, "office_pack_check", [SOURCE()]);
    expect(over).toMatchObject({ error: "rate_limited", retry_after_ms: 3_600_000, message: expect.stringMatching(/Too many pack checks \(at most 2 batches/) });
    expect(over.parts).toEqual([0]);
    expect((t.handle("alpha", "office_pack_list", {}) as any).check_left).toEqual({ batches: 0, bytes: 1024 * 1024 * 1024 - ok.wire - bad.wire });
    clock.t = 3_600_000;
    expect(await send(t, "office_pack_check", [SOURCE()])).toMatchObject({ result: "PACK OK" });
  });

  it("by bytes too, per agent; uploads never draw on it, nor checks on theirs", async () => {
    const one = encodePackBatch([SOURCE()] as never)!.length;
    const { t } = tools({ approval: "apply", checkLimiter: new OfficePackBatchLimiter(() => 0, { batchesPerHour: 60, bytesPerHour: one + 10 }) });
    expect(await send(t, "office_pack_check", [SOURCE()])).toMatchObject({ result: "PACK OK" });
    expect(await send(t, "office_pack_check", [SOURCE()])).toMatchObject({ error: "rate_limited", message: expect.stringMatching(/MiB an hour/) });
    expect(await t.handle("beta", "office_pack_list", {})).toMatchObject({ check_left: { batches: 60, bytes: one + 10 } });
    const left = t.limiter.left("alpha");
    expect(await send(t, "office_pack_upload", [SOURCE()])).toMatchObject({ applied: [{ id: "snug" }] });
    expect(t.checkLimiter.left("alpha")).toEqual({ batches: 59, bytes: 10 });
    expect(t.limiter.left("alpha").batches).toBe(left.batches - 1);
  });

  it("a check larger than the hour's budget is refused for good (retry_after_ms null)", async () => {
    const { t } = tools({ checkLimiter: new OfficePackBatchLimiter(() => 0, { batchesPerHour: 60, bytesPerHour: 100 }) });
    expect(await send(t, "office_pack_check", [SOURCE()])).toMatchObject({ error: "rate_limited", retry_after_ms: null });
  });
});

describe("(b) pictures a crashed replace left are removed when the packs are read", () => {
  /** The skins directory as a crash at the swap of a replace leaves it: new pictures and pack.prev.json written, pack.json not. */
  async function crashedReplace() {
    const crash = scratch();
    const x = tools({ approval: "apply", hooks: { beforeSwap: () => cpSync(skinsDir(x.dir), skinsDir(crash), { recursive: true }) } });
    expect(await send(x.t, "office_pack_upload", [SOURCE()])).toMatchObject({ applied: [{}] });
    rmSync(skinsDir(crash), { recursive: true, force: true });
    const v1 = x.skins.records();
    expect(await send(x.t, "office_pack_upload", [SOURCE({ seed: 9 })])).toMatchObject({ applied: [{ replaced: v1.packs[0]!.sha }] });
    return { crash, v1 };
  }

  it("the crash image: the old version is the pack, the new version's pictures are gone, the disk count is the old one", async () => {
    const { crash, v1 } = await crashedReplace();
    const named = [...new Set(Object.values(v1.packs[0]!.files).map(f => `${f.id}.png`))].sort();
    expect(pngs(join(skinsDir(crash), "snug")).length).toBeGreaterThan(named.length);       // the new version's, orphaned
    const back = new OfficeSkinStore(crash);
    expect(back.get("snug")!.sha).toBe(v1.packs[0]!.sha);
    expect(pngs(join(skinsDir(crash), "snug"))).toEqual(named);
    expect(back.records().diskBytes).toBe(v1.diskBytes);
    for (const id of Object.values(back.get("snug")!.files)) expect(back.picture("snug", id)).not.toBeNull();
  });

  it("a pack with a previous version keeps both versions' pictures; only unnamed ones go", async () => {
    const { t, skins, dir } = tools({ approval: "apply" });
    await send(t, "office_pack_upload", [SOURCE()]);
    await send(t, "office_pack_upload", [SOURCE({ seed: 5 })]);
    const home = join(skinsDir(dir), "snug"), before = pngs(home);
    writeFileSync(join(home, ORPHAN), png(16, 16, 77));
    writeFileSync(join(home, "notes.txt"), "not a picture");
    const back = new OfficeSkinStore(dir);
    expect(back.records().previous.get("snug")!.sha).toBe(skins.records().previous.get("snug")!.sha);
    expect(pngs(home)).toEqual(before);
    expect(existsSync(join(home, "notes.txt"))).toBe(true);
  });

  it("in a .kept-<id> directory too", async () => {
    const { t, dir } = tools({ approval: "apply" });
    await send(t, "office_pack_upload", [SOURCE()]);
    await send(t, "office_pack_upload", [SOURCE({ seed: 5 })]);
    expect(t.handle("alpha", "office_pack_delete", { id: "snug", keep_previous: true })).toMatchObject({ applied: { previous_kept: true } });
    const kept = join(skinsDir(dir), ".kept-snug"), before = pngs(kept);
    writeFileSync(join(kept, ORPHAN), png(16, 16, 77));
    expect(new OfficeSkinStore(dir).records().previous.has("snug")).toBe(true);
    expect(pngs(kept)).toEqual(before);
  });

  it("never where a record was not read back: an unreadable pack.json or pack.prev.json keeps every file", async () => {
    for (const broken of ["pack.json", PREVIOUS_FILE]) {
      const { t, dir } = tools({ approval: "apply" });
      await send(t, "office_pack_upload", [SOURCE()]);
      await send(t, "office_pack_upload", [SOURCE({ seed: 5 })]);
      const home = join(skinsDir(dir), "snug");
      writeFileSync(join(home, ORPHAN), png(16, 16, 77));
      writeFileSync(join(home, broken), "{ not json");
      const before = pngs(home);
      new OfficeSkinStore(dir).records();
      expect(pngs(home), broken).toEqual(before);
    }
  });
});

describe("(c) a yes covers the drops the admin was shown", () => {
  async function pendingDrop() {
    const x = tools({ approval: "apply" });
    await send(x.t, "office_pack_upload", [SOURCE()]);
    expect(x.offices.replace(OFFICES as never, x.offices.rev(), { packOf: id => x.skins.pack(id) })).toMatchObject({ ok: true });
    x.t.setApproval("approve", "admin");
    const r = await send(x.t, "office_pack_upload", [SOURCE({ rack: false, seed: 6 })], { drop_invalid_overrides: true }) as any;
    expect(r.pending.drops.map((d: any) => `${d.office}:${d.entry}`)).toEqual(["ops:furniture.rack", "ops:furnitureNight.rack"]);
    return { ...x, id: r.pending.id as string, v1: x.skins.get("snug")!.sha };
  }
  const editDen = (x: Awaited<ReturnType<typeof pendingDrop>>, overrides: unknown) => {
    const list = x.offices.list().offices.map(o => (o.id === "den" ? { ...o, overrides } : o));
    expect(x.offices.replace(list as never, x.offices.rev(), { packOf: id => x.skins.pack(id) })).toMatchObject({ ok: true });
  };

  it("unchanged offices: approved, exactly the shown entries go", async () => {
    const x = await pendingDrop();
    expect(x.t.decide(x.id, "approve", "admin")).toMatchObject({ ok: true, applied: { applied: [{ dropped_overrides: [{ entry: "furniture.rack" }, { entry: "furnitureNight.rack" }] }] } });
    expect(x.offices.list().offices.find(o => o.id === "ops")!.overrides).toEqual({ pack: "snug", seats: OPS.seats });
  });

  it("another office edited since with an entry the new pack does not fit: 409, nothing applied, the offices as they are", async () => {
    const x = await pendingDrop();
    editDen(x, { ...DEN, furniture: { rack: [990, 160] } });
    const officesBefore = x.offices.list().offices;
    const no = x.t.decide(x.id, "approve", "admin");
    expect(no).toMatchObject({ ok: false, status: 409, error: "offices_changed", text: expect.stringMatching(/approved, but not applied.*it would now drop Ops: furniture\.rack, Ops: furnitureNight\.rack, Den: furniture\.rack.*resubmit/s) });
    expect(x.settled).toEqual([[x.id, no.text]]);
    expect([x.skins.get("snug")!.sha, x.offices.list().offices]).toEqual([x.v1, officesBefore]);
    expect(x.t.decide(x.id, "approve", "admin")).toMatchObject({ ok: false, status: 404 });
  });

  it("the same office, as many drops, another entry than shown: 409", async () => {
    const x = tools({ approval: "apply" });
    await send(x.t, "office_pack_upload", [SOURCE()]);
    const ops = { id: "ops", name: "Ops", skin: "snug", members: [], overrides: { pack: "snug", furniture: { rack: [1000, 150] } } };
    expect(x.offices.replace([ops] as never, x.offices.rev(), { packOf: id => x.skins.pack(id) })).toMatchObject({ ok: true });
    x.t.setApproval("approve", "admin");
    const r = await send(x.t, "office_pack_upload", [SOURCE({ rack: false, seed: 6 })], { drop_invalid_overrides: true }) as any;
    expect(r.pending.drops.map((d: any) => `${d.office}:${d.entry}`)).toEqual(["ops:furniture.rack"]);
    const more = { ...ops, overrides: { pack: "snug", furnitureNight: { rack: [310, 430] } } };
    expect(x.offices.replace([more] as never, x.offices.rev(), { packOf: id => x.skins.pack(id) })).toMatchObject({ ok: true });
    expect(x.t.decide(r.pending.id, "approve", "admin")).toMatchObject({ ok: false, status: 409, error: "offices_changed", text: expect.stringMatching(/Ops: furnitureNight\.rack/) });
    expect(x.offices.list().offices[0]!.overrides).toEqual(more.overrides);
  });

  it("fewer drops than shown (an office fixed meanwhile) is a different change too: 409", async () => {
    const x = await pendingDrop();
    const list = x.offices.list().offices.map(o => (o.id === "ops" ? { ...o, overrides: { pack: "snug", seats: OPS.seats } } : o));
    expect(x.offices.replace(list as never, x.offices.rev(), { packOf: id => x.skins.pack(id) })).toMatchObject({ ok: true });
    expect(x.t.decide(x.id, "approve", "admin")).toMatchObject({ ok: false, status: 409, error: "offices_changed", text: expect.stringMatching(/it would now drop nothing/) });
    expect(x.skins.get("snug")!.sha).toBe(x.v1);
  });

  it("a restore held for a yes is held to its shown drops the same way", async () => {
    const x = tools({ approval: "apply" });
    await send(x.t, "office_pack_upload", [SOURCE({ rack: false })]);
    await send(x.t, "office_pack_upload", [SOURCE({ seed: 6 })]);                                // the rack-less version is the previous
    expect(x.offices.replace(OFFICES as never, x.offices.rev(), { packOf: id => x.skins.pack(id) })).toMatchObject({ ok: true });
    x.t.setApproval("approve", "admin");
    const r = x.t.handle("alpha", "office_pack_restore", { id: "snug", drop_invalid_overrides: true }) as any;
    expect(r.pending.drops.map((d: any) => d.office)).toEqual(["ops", "ops"]);
    const list = x.offices.list().offices.map(o => (o.id === "den" ? { ...o, overrides: { ...DEN, furniture: { rack: [990, 160] } } } : o));
    expect(x.offices.replace(list as never, x.offices.rev(), { packOf: id => x.skins.pack(id) })).toMatchObject({ ok: true });
    const current = x.skins.get("snug")!.sha;
    expect(x.t.decide(r.pending.id, "approve", "admin")).toMatchObject({ ok: false, status: 409, error: "offices_changed" });
    expect(x.skins.get("snug")!.sha).toBe(current);
  });
});
