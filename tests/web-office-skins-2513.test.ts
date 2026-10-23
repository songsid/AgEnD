/**
 * #2513: the Office view's skin packs, kept on the host (src/web-office-skins.ts) — and an office's layout overrides on
 * one (src/web-office-store.ts).
 * - Upload: a manifest checked by the page's own module (checkSkinPack) and its PNGs — the signature, IHDR, walked to
 *   IEND; each STRIP frames·w × h; the background 16:9; every named file sent and nothing else; file names without
 *   traversal; per-file, per-pack and per-request caps; at most SKIN_LIMITS.packs; an id kept already is a 409.
 * - Storage: <AGEND_HOME>/web-office-skins/<id>/ (0700) with pack.json and the pictures by content id (0600), renamed
 *   into place whole; read back by a new store; a delete removes the directory.
 * - Routes: GET (list, manifest, picture) for a signed-in page and the public link's manifest; POST/DELETE from an
 *   admin session only — a read session 403, the CLI token 403, anonymous 401, the public link refused by its manifest
 *   and by the handler; pictures as image/png, nosniff, sandboxed, cached by their content id; announced on the stream.
 * - Overrides: PUT /ui/offices checks an office's overrides' shape, and for a pack the host keeps puts them on it.
 * - #2513 review: an inherited name ("constructor", "toString", "__proto__") is never a pack reference — in a manifest a
 *   refusal, in an office's overrides a 400 (never a 500); the reads a page makes on its own (the list, a manifest, its
 *   pictures) never slide an idle session, while uploads and deletes keep their session and CSRF checks.
 * - Format v1 additions: a strip's displayed size (dw/dh) and walkDown / walkUp / walkSide pass the host's checks.
 * - #2540: a `foreground` is one of the pack's PNG files and 16:9; furniture `depth: "y"` passes, other strings refused.
 * The fixture (tests/fixtures/office-skin-clinic) is a small pack whose pictures are drawn by a script (simple shapes, no outside art).
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`skins: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { OfficeSkinStore, SKIN_LIMITS, checkSkinUpload, skinFileNameOk } = await import("../src/web-office-skins.js");
const { OfficeStore, checkOffices } = await import("../src/web-office-store.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { isPassiveWebRead } = await import("../src/web-auth.js");
const { handleWebRequest } = await import("../src/web-api.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const b64 = (f: string) => readFileSync(join(FIXTURE, f)).toString("base64");
const UPLOAD = () => ({ manifest: MANIFEST(), files: { "office_bg.png": b64("office_bg.png"), "fox_idle.png": b64("fox_idle.png") } });

/** A tiny valid PNG of w×h (one IDAT; the bytes are never decoded by the host, only walked). */
function png(w: number, h: number, extra: Buffer[] = []): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-skins-")); dirs.push(d); return d; };

describe("checkSkinUpload: the manifest by the page's rules, then the pictures", () => {
  const refused = (body: unknown) => { const r = checkSkinUpload(body, "me", 1); return r.ok ? null : [r.status, r.error, r.detail ?? ""]; };
  it("the clinic sample pack passes: its files by content id, sizes recorded, metadata stripped", () => {
    const r = checkSkinUpload(UPLOAD(), "me", 7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.record.id, r.record.name, r.record.by, r.record.uploaded_at]).toEqual(["clinic-sample", "clinic-sample", "me", 7]);
    expect(r.record.files["office_bg.png"]).toMatchObject({ width: 640, height: 360 });
    expect(r.record.files["fox_idle.png"]).toMatchObject({ width: 128, height: 48 });
    expect(Object.values(r.record.files).every(f => /^[0-9a-f]{32}$/.test(f.id))).toBe(true);
    expect(r.pictures.size).toBe(2);
    expect(r.record.manifest).not.toHaveProperty("byInstance");                          // the fixture names no instance
    expect(checkSkinUpload({ ...UPLOAD(), name: "  Clinic  " }, "me", 1)).toMatchObject({ ok: true, record: { name: "Clinic" } });
  });
  it.each([
    ["not an object", [], "skin_invalid"],
    ["an unknown key", { ...UPLOAD(), extra: 1 }, "skin_invalid"],
    ["a manifest the page refuses", { ...UPLOAD(), manifest: { ...MANIFEST(), format: 2 } }, "skin_manifest_invalid", "format: 1"],
    ["a built-in id", { ...UPLOAD(), manifest: { ...MANIFEST(), id: "studio" } }, "skin_manifest_invalid", "id: a built-in skin's id"],
    ["a file the manifest does not name", { ...UPLOAD(), files: { ...UPLOAD().files, "extra.png": png(2, 2).toString("base64") } }, "skin_file_unused", "extra.png"],
    ["a named file missing", { ...UPLOAD(), files: { "office_bg.png": b64("office_bg.png") } }, "skin_file_missing", "fox_idle.png"],
    ["not base64", { ...UPLOAD(), files: { ...UPLOAD().files, "office_bg.png": "!!!!" } }, "skin_invalid", "files.office_bg.png"],
    ["a long name", { ...UPLOAD(), name: "x".repeat(61) }, "skin_invalid", "name"],
  ])("refuses %s", (_what, body, error, detail = "") => {
    const r = refused(body);
    expect(r?.[1]).toBe(error);
    expect(String(r?.[2])).toContain(detail);
  });
  it("review: an inherited name is never a reference — the otherwise normal clinic upload with stateZones naming \"constructor\" is refused; the declared area (control) passes", () => {
    expect(checkSkinUpload(UPLOAD(), "me", 1).ok).toBe(true);
    const nap = UPLOAD(); nap.manifest.stateZones.default = "nap";
    expect(checkSkinUpload(nap, "me", 1).ok).toBe(true);
    for (const bad of ["constructor", "toString", "__proto__"]) {
      const u = UPLOAD(); u.manifest.stateZones.default = bad;
      expect(refused(u), bad).toEqual([400, "skin_manifest_invalid", "stateZones.default: an area the pack defines"]);
      const by = UPLOAD(); by.manifest.byInstance = { atlas: bad };
      expect(refused(by), bad).toEqual([400, "skin_manifest_invalid", "byInstance.atlas: a character set the pack defines"]);
    }
  });
  it("format v1 additions: a strip's displayed size (dw/dh) and walkDown / walkUp / walkSide pass; the picture is still frames·w × h; a size out of range is refused", () => {
    const u: any = UPLOAD();
    u.manifest.characters.default = { ...u.manifest.characters.default,
      walkDown: { src: "fox_walk.png", frames: 2, w: 32, h: 48, ax: 16, ay: 44, dw: 48 }, walkUp: { src: "fox_walk.png", frames: 2, w: 32, h: 48 },
      walkSide: { src: "fox_walk.png", frames: 2, w: 32, h: 48, dw: 48, dh: 72 } };
    u.files["fox_walk.png"] = png(64, 48).toString("base64");
    const r = checkSkinUpload(u, "me", 1);
    expect(r.ok).toBe(true);
    if (r.ok) { const d = r.pack.characters.default!; expect([d.walkDown!.dw, d.walkDown!.dh, d.walkUp!.dw, d.walkUp!.dh, d.walkSide!.dh]).toEqual([48, 72, 64, 96, 72]); }
    u.files["fox_walk.png"] = png(48, 72).toString("base64");                                // the displayed size is not the picture's
    expect(refused(u)?.[1]).toBe("skin_strip_dimensions");
    u.files["fox_walk.png"] = png(64, 48).toString("base64");
    u.manifest.characters.default.walkSide.dw = 2000;
    expect(refused(u)).toEqual([400, "skin_manifest_invalid", "characters.default.walkSide.dw: a number from 1 to 1280"]);
  });
  it("#2540: a pack's `matte` (the colour around the scene) passes as #rrggbb and is kept as uploaded; anything else is refused by the page's rule", () => {
    const u: any = UPLOAD(); u.manifest.matte = "#1B1D24";
    const r = checkSkinUpload(u, "me", 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.pack.matte, r.record.manifest.matte]).toEqual(["#1b1d24", "#1B1D24"]);
    for (const bad of ["#fff", "red", "#1b1d24ff", 12, "", "#12345g"]) {
      const b: any = UPLOAD(); b.manifest.matte = bad;
      expect(refused(b), String(bad)).toEqual([400, "skin_manifest_invalid", "matte: a colour as #rrggbb"]);
    }
  });
  it("#2540: a `foreground` is one of the pack's files, a PNG, 16:9 — sent, checked and kept; missing, not a PNG or not 16:9 is refused", () => {
    const u: any = UPLOAD(); u.manifest.foreground = "front.png"; u.files["front.png"] = png(640, 360).toString("base64");
    const r = checkSkinUpload(u, "me", 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.pack.foreground, r.record.files["front.png"]?.width, r.record.files["front.png"]?.height]).toEqual(["front.png", 640, 360]);
    const missing: any = UPLOAD(); missing.manifest.foreground = "front.png";
    expect(refused(missing)).toEqual([400, "skin_file_missing", "front.png: named by the manifest, not sent"]);
    u.files["front.png"] = png(640, 400).toString("base64");
    expect(refused(u)).toEqual([400, "skin_foreground_aspect", "foreground: front.png is 640×400 px; it must be 16:9"]);
    u.files["front.png"] = Buffer.from("GIF89a......").toString("base64");
    expect(refused(u)).toEqual([400, "skin_not_png", "front.png: not a PNG (its signature)"]);
    const jpg: any = UPLOAD(); jpg.manifest.foreground = "front.jpg"; jpg.files["front.jpg"] = png(640, 360).toString("base64");
    expect(refused(jpg)?.[1]).toBe("skin_file_name");
    const desks: any = UPLOAD(); delete desks.manifest.stateZones; desks.manifest.foreground = "front.png"; desks.files["front.png"] = png(640, 360).toString("base64");
    expect(refused(desks)).toEqual([400, "skin_manifest_invalid", "foreground: only with stateZones"]);
  });
  it("#2540: furniture `depth: \"y\"` passes the host's check; any other string is refused", () => {
    const u: any = UPLOAD();
    u.manifest.furniture = [{ id: "pillar", sprite: { src: "fox_idle.png", frames: 4, w: 32, h: 48 }, x: 300, y: 300, depth: "y" }];
    const r = checkSkinUpload(u, "me", 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pack.furniture[0]!.depth).toBe("y");
    for (const bad of ["Y", "x", "", "1000"]) {
      u.manifest.furniture[0].depth = bad;
      expect(refused(u), bad).toEqual([400, "skin_manifest_invalid", 'furniture[0].depth: a whole number from -10000 to 10000, or "y"']);
    }
  });
  it("a picture that is not a PNG (a JPEG, a GIF, text named .png) or one cut short is refused, naming the file", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
    for (const bad of [jpeg, Buffer.from("GIF89a......"), Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")]) {
      expect(refused({ ...UPLOAD(), files: { ...UPLOAD().files, "fox_idle.png": bad.toString("base64") } })).toEqual([400, "skin_not_png", "fox_idle.png: not a PNG (its signature)"]);
    }
    const cut = png(128, 48).subarray(0, 60);
    expect(refused({ ...UPLOAD(), files: { ...UPLOAD().files, "fox_idle.png": cut.toString("base64") } })?.slice(0, 2)).toEqual([400, "skin_png_unreadable"]);
    const huge = png(1, 1); huge.writeUInt32BE(5000, 16);                                   // IHDR says 5000 px wide
    expect(refused({ ...UPLOAD(), files: { ...UPLOAD().files, "fox_idle.png": huge.toString("base64") } })?.slice(0, 2)).toEqual([400, "skin_png_dimensions"]);
  });
  it("a STRIP's picture must be exactly frames·w × h; the background 16:9", () => {
    const wrong = png(120, 48);                                                             // 4 frames of 32 need 128
    expect(refused({ ...UPLOAD(), files: { ...UPLOAD().files, "fox_idle.png": wrong.toString("base64") } }))
      .toEqual([400, "skin_strip_dimensions", "characters.default.idle: fox_idle.png is 120×48 px; its strip needs 128×48 (frames·w × h)"]);
    expect(refused({ ...UPLOAD(), files: { ...UPLOAD().files, "fox_idle.png": png(128, 40).toString("base64") } })?.[1]).toBe("skin_strip_dimensions");
    expect(refused({ ...UPLOAD(), files: { ...UPLOAD().files, "office_bg.png": png(640, 400).toString("base64") } }))
      .toEqual([400, "skin_background_aspect", "background: office_bg.png is 640×400 px; it must be 16:9"]);
    expect(checkSkinUpload({ ...UPLOAD(), files: { ...UPLOAD().files, "office_bg.png": png(1280, 720).toString("base64") } }, "me", 1).ok).toBe(true);
  });
  it("file names: no traversal, no hidden or empty part, .png only — in the manifest or among the files", () => {
    for (const bad of ["../x.png", "a/../x.png", "/x.png", ".x.png", "a//x.png", "a/./x.png", "x.PNG.svg", "x.gif", "a\\x.png", "a/b/c/d/e.png"]) expect(skinFileNameOk(bad), bad).toBe(false);
    for (const good of ["x.png", "sprites/idle_2.png", "A-b.c.PNG"]) expect(skinFileNameOk(good), good).toBe(true);
    const m = MANIFEST();
    m.characters.default.idle.src = "./fox_idle.png";                                    // the page's rule allows "./"; the host's does not
    expect(refused({ manifest: m, files: { "office_bg.png": b64("office_bg.png"), "./fox_idle.png": b64("fox_idle.png") } })?.[1]).toBe("skin_file_name");
    expect(refused({ ...UPLOAD(), files: { ...UPLOAD().files, "../../etc/passwd.png": b64("fox_idle.png") } })?.[1]).toBe("skin_file_name");
  });
  it("sizes: a picture over the per-file cap and a pack over its total are 413; so is a manifest over its cap", () => {
    const big = Buffer.concat([png(2, 2).subarray(0, 33), Buffer.alloc(SKIN_LIMITS.fileBytes)]);
    expect(refused({ ...UPLOAD(), files: { ...UPLOAD().files, "fox_idle.png": big.toString("base64") } })?.slice(0, 2)).toEqual([413, "skin_file_too_large"]);
    const m = MANIFEST(), files: Record<string, string> = { "office_bg.png": b64("office_bg.png"), "fox_idle.png": b64("fox_idle.png") };
    // Four furniture strips of just under 2 MiB each (padded with a private chunk): each passes alone, not all together.
    m.furniture = [0, 1, 2, 3].map(i => ({ id: `f${i}`, sprite: { src: `f${i}.png`, frames: 1, w: 1, h: 1 }, x: 10, y: 10 }));
    const pad = (i: number) => { const p = png(1, 1); const len = Buffer.alloc(4); const body = Buffer.alloc(SKIN_LIMITS.fileBytes - p.length - 100, i);
      len.writeUInt32BE(body.length); const chunk = Buffer.concat([len, Buffer.from("prIv"), body, Buffer.alloc(4)]);
      return Buffer.concat([p.subarray(0, 33), chunk, p.subarray(33)]); };
    for (const i of [0, 1, 2, 3]) files[`f${i}.png`] = pad(i).toString("base64");
    expect(refused({ manifest: m, files })?.slice(0, 2)).toEqual([413, "skin_too_large"]);
    const fat = { ...MANIFEST(), bubbles: { en: Object.fromEntries(["working", "idle", "paused", "needs", "stuck", "crashed", "stopped", "missing"].map(s => [s, Array(12).fill("x".repeat(40))])) } };
    expect(checkSkinUpload({ manifest: fat, files: UPLOAD().files }, "me", 1).ok).toBe(true);                // well under 64 KiB
    expect(refused({ manifest: { ...MANIFEST(), pad: "x".repeat(SKIN_LIMITS.manifestBytes) }, files: UPLOAD().files })?.slice(0, 2)).toEqual([413, "skin_manifest_too_large"]);
  });
});

describe("the skin store: web-office-skins/", () => {
  it("round trip: 0700/0600, pictures by content id, renamed into place; a new store reads it back; delete removes it", () => {
    const dir = scratch(), s = new OfficeSkinStore(dir, () => 5);
    expect(s.list()).toMatchObject({ packs: [], readable: true });
    const r = s.add(UPLOAD(), "person");
    expect(r).toMatchObject({ ok: true, pack: { id: "clinic-sample", files: 2, uploaded_at: 5 } });
    const at = join(dir, "web-office-skins", "clinic-sample");
    expect(statSync(at).mode & 0o777).toBe(0o700);
    expect(statSync(join(at, "pack.json")).mode & 0o777).toBe(0o600);
    const files = readdirSync(at).sort();
    expect(files.filter(f => f.endsWith(".png")).every(f => /^[0-9a-f]{32}\.png$/.test(f) && (statSync(join(at, f)).mode & 0o777) === 0o600)).toBe(true);
    expect(readdirSync(join(dir, "web-office-skins")).filter(f => f.startsWith("."))).toEqual([]);   // no upload left half-way
    const again = new OfficeSkinStore(dir);
    expect(again.list().packs.map(p => p.id)).toEqual(["clinic-sample"]);
    expect(again.rev()).toBe(s.rev());
    const got = again.get("clinic-sample")!;
    expect(got.manifest.id).toBe("clinic-sample");
    expect(again.picture("clinic-sample", got.files["office_bg.png"]!)?.subarray(1, 4).toString()).toBe("PNG");
    expect(again.picture("clinic-sample", "0".repeat(32))).toBeNull();
    expect(again.picture("clinic-sample", "../pack")).toBeNull();
    expect(again.pack("clinic-sample")?.areas.desks?.seats).toHaveLength(4);
    expect(s.add(UPLOAD(), "person")).toMatchObject({ ok: false, status: 409, error: "skin_exists" });        // immutable: delete first
    expect(s.add({ ...UPLOAD(), manifest: { ...MANIFEST(), id: "CLINIC-sample" } }, "p")).toMatchObject({ ok: false, status: 409, error: "skin_exists" });
    const before = s.rev();
    expect(s.remove("clinic-sample")).toMatchObject({ ok: true });
    expect([existsSync(at), s.list().packs, s.rev() === before]).toEqual([false, [], false]);
    expect(s.remove("clinic-sample")).toMatchObject({ ok: false, status: 404 });
  });
  it("at most SKIN_LIMITS.packs; a pack that no longer checks is not offered", () => {
    const dir = scratch(), s = new OfficeSkinStore(dir);
    for (let i = 0; i < SKIN_LIMITS.packs; i++) expect(s.add({ ...UPLOAD(), manifest: { ...MANIFEST(), id: `p${i}` } }, "me").ok).toBe(true);
    expect(s.add({ ...UPLOAD(), manifest: { ...MANIFEST(), id: "one-more" } }, "me")).toMatchObject({ ok: false, status: 409, error: "skins_quota" });
    const pj = join(dir, "web-office-skins", "p0", "pack.json"), rec = JSON.parse(readFileSync(pj, "utf8"));
    rec.manifest.format = 9;
    writeFileSync(pj, JSON.stringify(rec));
    expect(new OfficeSkinStore(dir).list().packs.map(p => p.id)).not.toContain("p0");
  });
});

interface Res { status: number; body: Buffer; headers: Record<string, string | string[] | undefined> }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
const parse = (r: Res) => JSON.parse(r.body.toString("utf8"));
async function fleet() {
  const dir = scratch();
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" = "admin") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
    const cookie = `agend_session=${sessionId}`;
    return { id: sessionId, read: { cookie }, write: { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } };
  };
  const stop = () => new Promise<void>(r => (fm.healthServer as Server).close(() => r()));
  return { fm, dir, port, origin, session, stop };
}

describe("the routes", () => {
  it("POST /ui/office-skins: an admin session only — read 403, CLI token 403, anonymous 401; checked; announced; listed", async () => {
    const f = await fleet();
    try {
      const sent: Array<[string, unknown]> = [];
      vi.spyOn(f.fm, "emitSseEvent").mockImplementation((...a: unknown[]) => { sent.push([a[0] as string, a[1]]); });
      const post = (headers: Record<string, string>, body: unknown) => raw(f.port, "POST", "/ui/office-skins", headers, JSON.stringify(body));
      expect((await post({ origin: f.origin, "content-type": "application/json" }, UPLOAD())).status).toBe(401);
      const read = await post(f.session("read").write, UPLOAD());
      expect([read.status, parse(read).error]).toEqual([403, "skins_need_an_admin_session"]);
      const token = await post({ "x-agend-token": f.fm.getDashboardAccess().token, "content-type": "application/json" }, UPLOAD());
      expect([token.status, parse(token).error]).toEqual([403, "skins_need_an_admin_session"]);
      expect(f.fm.officeSkins.list().packs).toEqual([]);
      const admin = f.session("admin").write;
      const bad = await post(admin, { ...UPLOAD(), files: { ...UPLOAD().files, "fox_idle.png": png(64, 48).toString("base64") } });
      expect([bad.status, parse(bad).error]).toEqual([400, "skin_strip_dimensions"]);
      expect(sent).toEqual([]);
      const ok = await post(admin, UPLOAD());
      expect([ok.status, parse(ok).pack.id]).toEqual([200, "clinic-sample"]);
      expect(sent).toEqual([["office_skins", { rev: parse(ok).rev }]]);
      expect(existsSync(join(f.dir, "web-office-skins", "clinic-sample", "pack.json"))).toBe(true);
      const list = await raw(f.port, "GET", "/ui/office-skins", f.session("read").read);
      expect([list.status, parse(list).packs.map((p: any) => p.id), list.headers["cache-control"]]).toEqual([200, ["clinic-sample"], "private, no-store"]);
      expect((await raw(f.port, "GET", "/ui/office-skins")).status).toBe(401);
      expect([isPassiveWebRead("GET", "/ui/office-skins"), isPassiveWebRead("POST", "/ui/office-skins")]).toEqual([true, false]);
      // DELETE: the same guard.
      expect((await raw(f.port, "DELETE", "/ui/office-skins/clinic-sample", f.session("read").write)).status).toBe(403);
      expect((await raw(f.port, "DELETE", "/ui/office-skins/clinic-sample", { "x-agend-token": f.fm.getDashboardAccess().token })).status).toBe(403);
      const del = await raw(f.port, "DELETE", "/ui/office-skins/clinic-sample", admin);
      expect([del.status, sent.length, f.fm.officeSkins.list().packs]).toEqual([200, 2, []]);
      expect((await raw(f.port, "DELETE", "/ui/office-skins/clinic-sample", admin)).status).toBe(404);
    } finally { await f.stop(); }
  }, 30_000);
  it("a request body over the wire cap is refused (413 or the connection dropped) before anything is kept", async () => {
    const f = await fleet();
    try {
      const { SKIN_WIRE_BYTES } = await import("../src/web-office-skins.js");
      // The reader stops at the cap and drops the connection (as every bounded body does): the client may see the 413 or
      // a closed socket, never a kept pack.
      const r = await raw(f.port, "POST", "/ui/office-skins", f.session("admin").write, JSON.stringify({ manifest: MANIFEST(), files: { x: "A".repeat(SKIN_WIRE_BYTES) } })).catch(() => null);
      if (r) expect([r.status, parse(r).error]).toEqual([413, "skin_too_large"]);
      expect([f.fm.officeSkins.list().packs, existsSync(join(f.dir, "web-office-skins"))]).toEqual([[], false]);
    } finally { await f.stop(); }
  }, 30_000);
  it("serving: the manifest (cached by its sha) and the pictures (image/png, nosniff, sandboxed, immutable by content id) to a signed-in page only", async () => {
    const f = await fleet();
    try {
      f.fm.officeSkins.add(UPLOAD(), "me");
      const reader = f.session("read").read;
      const man = await raw(f.port, "GET", "/ui/office-skins/clinic-sample", reader);
      const body = parse(man);
      expect([man.status, body.manifest.id, man.headers["cache-control"], man.headers["x-content-type-options"]]).toEqual([200, "clinic-sample", "private, no-store", "nosniff"]);
      expect((await raw(f.port, "GET", `/ui/office-skins/clinic-sample?v=${body.sha}`, reader)).headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      const id = body.files["office_bg.png"];
      const pic = await raw(f.port, "GET", `/ui/office-skins/clinic-sample/img/${id}.png`, reader);
      expect([pic.status, pic.headers["content-type"], pic.headers["x-content-type-options"], pic.headers["cache-control"], pic.headers["content-security-policy"]])
        .toEqual([200, "image/png", "nosniff", "private, max-age=31536000, immutable", "default-src 'none'; sandbox"]);
      expect(pic.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      expect((await raw(f.port, "GET", `/ui/office-skins/clinic-sample/img/${id}.png`)).status).toBe(401);
      expect((await raw(f.port, "GET", `/ui/office-skins/clinic-sample/img/${"0".repeat(32)}.png`, reader)).status).toBe(404);
      expect((await raw(f.port, "GET", "/ui/office-skins/clinic-sample/img/..%2Fpack.json", reader)).status).toBe(404);
      expect((await raw(f.port, "GET", "/ui/office-skins/nope", reader)).status).toBe(404);
    } finally { await f.stop(); }
  }, 30_000);
  it("the public link: the reads on its manifest, upload and delete absent — and refused by the handler on its own", async () => {
    const id = "a".repeat(32);
    expect([isPublicWebRoute("GET", "/ui/office-skins"), isPublicWebRoute("GET", "/ui/office-skins/clinic-sample"), isPublicWebRoute("GET", `/ui/office-skins/clinic-sample/img/${id}.png`)]).toEqual([true, true, true]);
    expect([isPublicWebRoute("POST", "/ui/office-skins"), isPublicWebRoute("DELETE", "/ui/office-skins/clinic-sample"), isPublicWebRoute("GET", "/ui/office-skins/a/b")]).toEqual([false, false, false]);
    const f = await fleet();
    try {
      f.fm.officeSkins.add(UPLOAD(), "me");
      const { sessionId } = f.fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "t", tokenEpoch: tokenEpoch(f.fm.webToken) });
      for (const [method, path] of [["POST", "/ui/office-skins"], ["DELETE", "/ui/office-skins/clinic-sample"]] as const) {
        const answer = await new Promise<{ status: number; body: string }>(resolve => {
          let code = 0;
          const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { code = c; res.headersSent = true; return res; }, end(b: string) { resolve({ status: code, body: String(b) }); } };
          const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "x.trycloudflare.com", cookie: `__Host-agend_session=${sessionId}`, origin: "https://x.trycloudflare.com", "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" }, destroy() {}, resume() {} });
          bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
          expect(handleWebRequest(req as never, res, new URL(`https://x.trycloudflare.com${path}`), f.fm)).toBe(true);
        });
        expect([answer.status, JSON.parse(answer.body).error], `${method} ${path}`).toEqual([403, "skins_not_over_public_link"]);
      }
      expect(f.fm.officeSkins.list().packs).toHaveLength(1);
    } finally { await f.stop(); }
  }, 30_000);
  it("review: the reads a page makes on its own — the list, a manifest, its pictures — never slide an idle session; a person's read does; deletes still need CSRF", async () => {
    const id = "a".repeat(32);
    expect(["/ui/office-skins", "/ui/office-skins/clinic-sample", `/ui/office-skins/clinic-sample/img/${id}.png`].map(p => isPassiveWebRead("GET", p))).toEqual([true, true, true]);
    expect([isPassiveWebRead("POST", "/ui/office-skins"), isPassiveWebRead("DELETE", "/ui/office-skins/clinic-sample"), isPassiveWebRead("HEAD", "/ui/office-skins"),
      isPassiveWebRead("GET", "/ui/office-skins/a/b"), isPassiveWebRead("GET", "/ui/office-skins/clinic-sample/img/x.png"), isPassiveWebRead("GET", "/ui/office-skinsx")]).toEqual([false, false, false, false, false, false]);
    const f = await fleet();
    try {
      f.fm.officeSkins.add(UPLOAD(), "me");
      let clock = Date.now();
      f.fm.webSessions.now = () => clock;
      const { sessionId, record } = f.fm.webSessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(f.fm.webToken) });
      const cookie = { cookie: `agend_session=${sessionId}` };
      const before = [record.lastSeen, record.idleExpiry];
      clock += 60_000;
      const man = await raw(f.port, "GET", "/ui/office-skins/clinic-sample", cookie);
      expect(man.status).toBe(200);
      const { sha, files } = parse(man);
      for (const path of ["/ui/office-skins", `/ui/office-skins/clinic-sample?v=${sha}`, `/ui/office-skins/clinic-sample/img/${files["fox_idle.png"]}.png`, `/ui/office-skins/clinic-sample/img/${files["office_bg.png"]}.png`]) {
        expect((await raw(f.port, "GET", path, cookie)).status, path).toBe(200);
      }
      expect([record.lastSeen, record.idleExpiry]).toEqual(before);                         // another person's upload refreshed nothing
      expect((await raw(f.port, "GET", "/ui/org", cookie)).status).toBe(200);              // control: the person's own read slides it
      expect(record.lastSeen).toBe(clock);
      const noCsrf = await raw(f.port, "DELETE", "/ui/office-skins/clinic-sample", { ...cookie, origin: f.origin });
      expect(noCsrf.status).toBe(403);
      expect(f.fm.officeSkins.list().packs).toHaveLength(1);
      const del = await raw(f.port, "DELETE", "/ui/office-skins/clinic-sample", { ...cookie, origin: f.origin, "x-agend-csrf": csrfTokenFor(sessionId) });
      expect([del.status, f.fm.officeSkins.list().packs]).toEqual([200, []]);
    } finally { await f.stop(); }
  }, 30_000);
  it("a guest never reads the packs: no guest route, and the stream drops `office_skins` for a guest", async () => {
    const { guestRouteDecision, guestFrameData } = await import("../src/web-guest-access.js");
    for (const path of ["/ui/office-skins", "/ui/office-skins/clinic-sample"]) for (const method of ["GET", "POST", "DELETE"]) {
      expect(guestRouteDecision(method, new URL(`http://h${path}`), new Set(["alpha"])), `${method} ${path}`).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
    }
    expect(guestFrameData("office_skins", { rev: "x" }, new Set(["alpha"]), { owner: { adapterId: "a", userId: "u" } } as never)).toBeUndefined();
  });
});

describe("an office's layout overrides", () => {
  const OV = { pack: "clinic-sample", seats: { desks: [[220, 250], [430, 240], [208, 360], [428, 360]] }, door: [600, 700],
    waypoints: [{ id: "a", x: 10, y: 10 }, { id: "b", x: 20, y: 20 }], edges: [["a", "b"]] };
  const office = (overrides: unknown) => [{ id: "clinic", name: "Clinic", skin: "clinic-sample", members: [], overrides }];
  it("their shape is checked on every write (ranges as the pack's: 1280×720), with where it broke", () => {
    expect(checkOffices(office(OV))).toMatchObject({ ok: true, offices: [{ overrides: OV }] });
    const where = (ov: unknown) => { const r = checkOffices(office(ov)); return r.ok ? null : r.detail; };
    expect(where({ ...OV, door: [1281, 0] })).toBe("offices[0].overrides.door[0]: a number from 0 to 1280");
    expect(where({ ...OV, seats: { desks: [[0, 721]] } })).toBe("offices[0].overrides.seats.desks[0][1]: a number from 0 to 720");
    expect(where({ ...OV, colour: 1 })).toBe('offices[0].overrides: unknown key "colour"');
    expect(where({ ...OV, edges: [["a", "zz"]] })).toBe("offices[0].overrides.edges[0]: two different waypoint ids");
    expect(where({ ...OV, edges: [["a", "b"], ["b", "a"]] })).toBe("offices[0].overrides.edges[1]: joined twice");
    expect(where({ pack: "clinic-sample", edges: [] })).toBe("offices[0].overrides.edges: only with waypoints");
    expect(where({ pack: "../x" })).toBe("offices[0].overrides.pack: 1–40 letters, digits, _ or -");
    expect(where("x")).toBe("offices[0].overrides: an object");
  });
  it("on a pack the host keeps they must fit it: a seat inside its area, the pack's seat count, its furniture", async () => {
    const dir = scratch(), skins = new OfficeSkinStore(dir);
    skins.add(UPLOAD(), "me");
    const s = new OfficeStore(dir, id => skins.pack(id));
    expect(s.replace(office(OV), 0)).toMatchObject({ ok: true, rev: 1 });
    expect(s.replace(office({ ...OV, seats: { desks: [[10, 10], [430, 240], [208, 360], [428, 360]] } }), 1))
      .toMatchObject({ ok: false, status: 400, detail: "offices[0].overrides.seats.desks[0]: outside its area's rect" });
    expect(s.replace(office({ ...OV, seats: { desks: [[220, 250]] } }), 1)).toMatchObject({ ok: false, detail: "offices[0].overrides.seats.desks: 4 seats, as the pack has" });
    expect(s.replace(office({ ...OV, seats: { kitchen: [[220, 250]] } }), 1)).toMatchObject({ ok: false, detail: "offices[0].overrides.seats.kitchen: an area the pack defines" });
    expect(s.replace(office({ ...OV, furniture: { sofa: [1, 1] } }), 1)).toMatchObject({ ok: false, detail: "offices[0].overrides.furniture.sofa: an item the pack has" });
    // Made on another pack (or a built-in style): only the shape is the host's to check.
    expect(s.replace([{ ...office(OV)[0], overrides: { ...OV, pack: "studio", seats: { anywhere: [[1, 1]] } } }], 1)).toMatchObject({ ok: true });
  });
  it("review: overrides naming an inherited area or item are a refusal (400), never a 500 — in the store and over PUT; a declared area (control) is kept", async () => {
    const dir = scratch(), skins = new OfficeSkinStore(dir);
    skins.add(UPLOAD(), "me");
    const s = new OfficeStore(dir, id => skins.pack(id));
    for (const bad of ["constructor", "toString", "__proto__"]) {
      const seats = JSON.parse(`{"pack":"clinic-sample","seats":{${JSON.stringify(bad)}:[[0,0]]}}`);
      expect(s.replace(office(seats), 0), bad).toMatchObject({ ok: false, status: 400, detail: `offices[0].overrides.seats.${bad}: an area's name` });
      const furniture = JSON.parse(`{"pack":"clinic-sample","furniture":{${JSON.stringify(bad)}:[1,1]}}`);
      expect(s.replace(office(furniture), 0), bad).toMatchObject({ ok: false, status: 400, detail: `offices[0].overrides.furniture.${bad}: an item's id` });
    }
    expect(s.replace(office({ pack: "clinic-sample", seats: { nap: [[936, 572], [1018, 572], [1100, 600]] } }), 0)).toMatchObject({ ok: true, rev: 1 });
    const f = await fleet();
    try {
      f.fm.officeSkins.add(UPLOAD(), "me");
      const admin = f.session("admin").write;
      for (const bad of ["constructor", "__proto__"]) {
        const body = `{"rev":0,"offices":[{"id":"clinic","name":"Clinic","skin":"clinic-sample","members":[],"overrides":{"pack":"clinic-sample","seats":{${JSON.stringify(bad)}:[[0,0]]}}}]}`;
        const r = await raw(f.port, "PUT", "/ui/offices", admin, body);
        expect([r.status, parse(r).detail], bad).toEqual([400, `offices[0].overrides.seats.${bad}: an area's name`]);
      }
      const ok = await raw(f.port, "PUT", "/ui/offices", admin, JSON.stringify({ rev: 0, offices: office(OV) }));
      expect(ok.status).toBe(200);
    } finally { await f.stop(); }
  }, 30_000);
  it("PUT /ui/offices refuses overrides that do not fit an uploaded pack, and keeps ones that do", async () => {
    const f = await fleet();
    try {
      f.fm.officeSkins.add(UPLOAD(), "me");
      const admin = f.session("admin").write;
      const put = (offices: unknown, rev: number) => raw(f.port, "PUT", "/ui/offices", admin, JSON.stringify({ offices, rev }));
      const bad = await put(office({ ...OV, seats: { lounge: [[0, 0], [0, 0], [0, 0], [0, 0]] } }), 0);
      expect([bad.status, parse(bad).detail]).toEqual([400, "offices[0].overrides.seats.lounge[0]: outside its area's rect"]);
      const ok = await put(office(OV), 0);
      expect([ok.status, parse(ok).offices[0].overrides]).toEqual([200, OV]);
    } finally { await f.stop(); }
  }, 30_000);
});
