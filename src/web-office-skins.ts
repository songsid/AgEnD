/**
 * Fleet → Org chart → Office: skin packs an admin uploaded (#2513) — a manifest (format v1, src/ui/fleet-office-pack.js)
 * and its PNG pictures, kept on the host for every viewer, never changed once kept (an office moves things on one with
 * its own layout overrides, web-office-store.ts).
 *
 *   <dataDir>/web-office-skins/<pack-id>/pack.json      { version: 1, id, name, sha, bytes, uploaded_at, by, manifest,
 *                                                         files: { <src>: { id, bytes, width, height } } }   (0600)
 *   <dataDir>/web-office-skins/<pack-id>/<id>.png        each picture, metadata stripped; id = sha of the kept bytes
 *
 * Directories 0700, files 0600. An upload is written into a hidden directory first and renamed into place whole, so a
 * pack is there entirely or not at all; a delete renames it away before removing it. The manifest is checked by the
 * page's own module (checkSkinPack) — the page and the host agree on every rule — and then the pictures: each is a PNG
 * (its signature, IHDR first, walked to IEND), within the per-file and per-pack caps and the side and pixel caps; every
 * STRIP's picture is exactly frames·w × h; the background and the foreground are 16:9; every file the manifest names is sent and nothing
 * else. What is read back is checked again (a pack a tightened rule refuses is not offered; its files stay on disk).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { imageSize, sniffMedia, stripMetadata } from "./web-image-meta.js";
import { checkSkinPack, own, packImages, packStrips, type CheckedPack } from "./ui/fleet-office-pack.js";

const MiB = 1024 * 1024;
export const SKIN_LIMITS = {
  packs: 8, files: 64, fileBytes: 2 * MiB, packBytes: 6 * MiB, manifestBytes: 64 * 1024, side: 4096, pixels: 16 * MiB, name: 60, src: 200,
} as const;
/** The most an upload's body may be: every picture's base64 (4/3) plus the manifest and the envelope. */
export const SKIN_WIRE_BYTES = Math.ceil((SKIN_LIMITS.packBytes * 4) / 3) + SKIN_LIMITS.manifestBytes + 64 * 1024;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const FILE_ID = /^[0-9a-f]{32}$/;
/** A file name in a pack: segments of letters, digits, . _ -, never starting with a dot (no "..", no hidden file), .png. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface SkinFile { id: string; bytes: number; width: number; height: number }
export interface SkinRecord {
  version: 1; id: string; name: string; sha: string; bytes: number; uploaded_at: number; by: string;
  manifest: Record<string, unknown>; files: Record<string, SkinFile>;
}
export interface SkinSummary { id: string; name: string; sha: string; bytes: number; files: number; uploaded_at: number }
export type SkinRefusal = { ok: false; status: 400 | 404 | 409 | 413 | 503; error: string; detail?: string };
export type SkinChecked = { ok: true; record: SkinRecord; pack: CheckedPack; pictures: Map<string, Buffer> } | SkinRefusal;

const hash32 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex").slice(0, 32);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const refuse = (status: SkinRefusal["status"], error: string, detail?: string): SkinRefusal => ({ ok: false, status, error, ...(detail ? { detail } : {}) });

/** Whether `src` is a file name a pack may use (fleet-office-pack.js's rule, and no hidden or empty segment). */
export function skinFileNameOk(src: string): boolean {
  if (src.length > SKIN_LIMITS.src || CONTROL.test(src) || !/\.png$/i.test(src)) return false;
  const parts = src.split("/");
  return parts.length <= 4 && parts.every(p => SEGMENT.test(p) && p !== "." && p !== "..");
}

/**
 * One picture: a PNG, walked to its end, its metadata stripped, within the caps. { kept, width, height } or a refusal
 * naming the file.
 */
export function checkSkinPicture(name: string, bytes: Uint8Array): { ok: true; kept: Buffer; width: number; height: number } | SkinRefusal {
  if (bytes.length > SKIN_LIMITS.fileBytes) return refuse(413, "skin_file_too_large", `${name}: at most ${SKIN_LIMITS.fileBytes / MiB} MiB`);
  if (sniffMedia(bytes) !== "png") return refuse(400, "skin_not_png", `${name}: not a PNG (its signature)`);
  const size = imageSize(bytes, "png");
  if (!size || size.width < 1 || size.height < 1) return refuse(400, "skin_png_unreadable", `${name}: no IHDR`);
  if (size.width > SKIN_LIMITS.side || size.height > SKIN_LIMITS.side || size.width * size.height > SKIN_LIMITS.pixels) {
    return refuse(400, "skin_png_dimensions", `${name}: at most ${SKIN_LIMITS.side}×${SKIN_LIMITS.side} px`);
  }
  const kept = stripMetadata(bytes, "png");
  if (!kept) return refuse(400, "skin_png_unreadable", `${name}: its chunks do not run to IEND`);
  return { ok: true, kept: Buffer.from(kept), width: size.width, height: size.height };
}

/** The sizes the checked manifest asks of its pictures: each STRIP exactly frames·w × h; the background and foreground 16:9. */
function sizesAgree(pack: CheckedPack, sizes: Map<string, { width: number; height: number }>): SkinRefusal | null {
  for (const { at, strip } of packStrips(pack)) {
    const s = sizes.get(strip.src);
    if (s && (s.width !== strip.frames * strip.w || s.height !== strip.h)) {
      return refuse(400, "skin_strip_dimensions", `${at}: ${strip.src} is ${s.width}×${s.height} px; its strip needs ${strip.frames * strip.w}×${strip.h} (frames·w × h)`);
    }
  }
  const bg = pack.background ? sizes.get(pack.background) : undefined;
  if (bg && bg.width * 9 !== bg.height * 16) return refuse(400, "skin_background_aspect", `background: ${pack.background} is ${bg.width}×${bg.height} px; it must be 16:9`);
  const fg = pack.foreground ? sizes.get(pack.foreground) : undefined;
  if (fg && fg.width * 9 !== fg.height * 16) return refuse(400, "skin_foreground_aspect", `foreground: ${pack.foreground} is ${fg.width}×${fg.height} px; it must be 16:9`);
  return null;
}

/**
 * An upload, as the page sends it: { manifest, files: { <src>: <base64> }, name? }. Every rule, or a refusal naming
 * where it broke. Pure (no I/O); `by` and `now` are kept in the record.
 */
export function checkSkinUpload(body: unknown, by: string, now: number): SkinChecked {
  if (!isObj(body)) return refuse(400, "skin_invalid", "an object: { manifest, files, name? }");
  const extra = Object.keys(body).find(k => !["manifest", "files", "name"].includes(k));
  if (extra !== undefined) return refuse(400, "skin_invalid", `unknown key "${extra}"`);
  const manifestText = JSON.stringify(body.manifest ?? null);
  if (Buffer.byteLength(manifestText) > SKIN_LIMITS.manifestBytes) return refuse(413, "skin_manifest_too_large", `at most ${SKIN_LIMITS.manifestBytes / 1024} KiB`);
  const checked = checkSkinPack(body.manifest);
  if (!checked.ok) return refuse(400, "skin_manifest_invalid", checked.error);
  const pack = checked.pack;
  let name = pack.id;
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > SKIN_LIMITS.name || CONTROL.test(body.name)) return refuse(400, "skin_invalid", `name: 1–${SKIN_LIMITS.name} characters`);
    name = body.name.trim();
  }
  const named = packImages(pack);
  for (const src of named) if (!skinFileNameOk(src)) return refuse(400, "skin_file_name", `${src}: letters, digits, . _ - and /, no hidden or empty part, ending .png`);
  if (!isObj(body.files)) return refuse(400, "skin_invalid", "files: { <file name>: <base64> }");
  const sent = Object.keys(body.files);
  if (sent.length > SKIN_LIMITS.files) return refuse(400, "skin_too_many_files", `at most ${SKIN_LIMITS.files}`);
  for (const src of sent) {
    if (!skinFileNameOk(src)) return refuse(400, "skin_file_name", `${src}: letters, digits, . _ - and /, no hidden or empty part, ending .png`);
    if (!named.includes(src)) return refuse(400, "skin_file_unused", `${src}: the manifest does not name it`);
  }
  for (const src of named) if (!sent.includes(src)) return refuse(400, "skin_file_missing", `${src}: named by the manifest, not sent`);
  const files: Record<string, SkinFile> = {}, pictures = new Map<string, Buffer>(), sizes = new Map<string, { width: number; height: number }>();
  let total = 0;
  for (const src of named) {
    const b64 = own(body.files, src);
    if (typeof b64 !== "string" || b64.length % 4 !== 0 || !B64.test(b64)) return refuse(400, "skin_invalid", `files.${src}: base64`);
    if (b64.length > Math.ceil((SKIN_LIMITS.fileBytes * 4) / 3) + 4) return refuse(413, "skin_file_too_large", `${src}: at most ${SKIN_LIMITS.fileBytes / MiB} MiB`);
    const pic = checkSkinPicture(src, Buffer.from(b64, "base64"));
    if (!pic.ok) return pic;
    total += pic.kept.length;
    if (total > SKIN_LIMITS.packBytes) return refuse(413, "skin_too_large", `at most ${SKIN_LIMITS.packBytes / MiB} MiB in all`);
    const id = hash32(pic.kept);
    files[src] = { id, bytes: pic.kept.length, width: pic.width, height: pic.height };
    pictures.set(id, pic.kept);
    sizes.set(src, { width: pic.width, height: pic.height });
  }
  const bad = sizesAgree(pack, sizes);
  if (bad) return bad;
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const sha = hash32(JSON.stringify({ manifest, files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, f.id])) }));
  return { ok: true, record: { version: 1, id: pack.id, name, sha, bytes: total, uploaded_at: now, by, manifest, files }, pack, pictures };
}

/** A record read back: the same rules as an upload's (the pictures' sizes as recorded), or null. */
function recordOk(raw: unknown, dirName: string): { record: SkinRecord; pack: CheckedPack } | null {
  if (!isObj(raw) || raw.version !== 1 || raw.id !== dirName || typeof raw.sha !== "string" || !FILE_ID.test(raw.sha)) return null;
  const checked = checkSkinPack(raw.manifest);
  if (!checked.ok || checked.pack.id !== dirName || !isObj(raw.files)) return null;
  const files = raw.files as Record<string, SkinFile>, sizes = new Map<string, { width: number; height: number }>();
  const named = packImages(checked.pack);
  if (Object.keys(files).length !== named.length) return null;
  for (const src of named) {
    const f = own<SkinFile>(files, src);
    if (!skinFileNameOk(src) || !isObj(f) || !FILE_ID.test(String(f.id)) || !Number.isSafeInteger(f.bytes) || !Number.isSafeInteger(f.width) || !Number.isSafeInteger(f.height)) return null;
    sizes.set(src, { width: f.width, height: f.height });
  }
  if (sizesAgree(checked.pack, sizes)) return null;
  const name = typeof raw.name === "string" && raw.name.trim() && raw.name.length <= SKIN_LIMITS.name ? raw.name : dirName;
  return { record: { version: 1, id: dirName, name, sha: raw.sha, bytes: Number(raw.bytes) || 0, uploaded_at: Number(raw.uploaded_at) || 0,
    by: typeof raw.by === "string" ? raw.by : "", manifest: raw.manifest as Record<string, unknown>, files }, pack: checked.pack };
}

type State = { packs: Map<string, { record: SkinRecord; pack: CheckedPack }> } | "unreadable";

export class OfficeSkinStore {
  private state: State | null = null;
  readonly dir: string;
  constructor(dataDir: string, private readonly now: () => number = () => Date.now()) { this.dir = join(dataDir, "web-office-skins"); }

  private load(): State {
    if (this.state) return this.state;
    let names: string[];
    try { names = readdirSync(this.dir); }
    catch (err) { return (this.state = (err as NodeJS.ErrnoException).code === "ENOENT" ? { packs: new Map() } : "unreadable"); }
    const packs = new Map<string, { record: SkinRecord; pack: CheckedPack }>();
    for (const n of names.sort()) {
      // An upload or a delete a restart cut short: never offered, removed.
      if (/^\.(?:up|rm)-[0-9a-f]{16}$/.test(n)) { try { rmSync(join(this.dir, n), { recursive: true, force: true }); } catch { /* next time */ } continue; }
      if (!ID.test(n) || packs.size >= SKIN_LIMITS.packs) continue;
      try {
        const ok = recordOk(JSON.parse(readFileSync(join(this.dir, n, "pack.json"), "utf8")), n);
        if (ok) packs.set(n, ok);
      } catch { /* not a pack */ }
    }
    return (this.state = { packs });
  }

  readable(): boolean { return this.load() !== "unreadable"; }
  /** A rev that moves with any change (the packs' ids and shas), the same after a restart. */
  rev(): string { const s = this.load(); return s === "unreadable" ? "" : hash32([...s.packs.values()].map(p => `${p.record.id}:${p.record.sha}`).join("\n")).slice(0, 12); }
  /** GET /ui/office-skins: what every viewer's style picker lists. */
  list(): { rev: string; packs: SkinSummary[]; readable: boolean; limits: typeof SKIN_LIMITS } {
    const s = this.load();
    const packs = s === "unreadable" ? [] : [...s.packs.values()].map(({ record: r }) => ({ id: r.id, name: r.name, sha: r.sha, bytes: r.bytes, files: Object.keys(r.files).length, uploaded_at: r.uploaded_at }));
    return { rev: this.rev(), packs, readable: s !== "unreadable", limits: SKIN_LIMITS };
  }
  /** GET /ui/office-skins/<id>: the manifest as uploaded and each file's picture id; null when there is no such pack. */
  get(id: string): { id: string; name: string; sha: string; manifest: Record<string, unknown>; files: Record<string, string> } | null {
    const s = this.load();
    const p = s === "unreadable" ? undefined : s.packs.get(id);
    if (!p) return null;
    const r = p.record;
    return { id: r.id, name: r.name, sha: r.sha, manifest: JSON.parse(JSON.stringify(r.manifest)), files: Object.fromEntries(Object.entries(r.files).map(([k, f]) => [k, f.id])) };
  }
  /** The checked pack (an office's overrides are checked against it), or null. */
  pack(id: string): CheckedPack | null { const s = this.load(); return s === "unreadable" ? null : s.packs.get(id)?.pack ?? null; }
  /** One picture of a pack, by its id (the sha of its bytes); null when the pack does not have it. */
  picture(id: string, file: string): Buffer | null {
    const s = this.load();
    const p = s === "unreadable" ? undefined : s.packs.get(id);
    if (!p || !FILE_ID.test(file) || !Object.values(p.record.files).some(f => f.id === file)) return null;
    try { return readFileSync(join(this.dir, id, `${file}.png`)); } catch { return null; }
  }

  /** Keep an upload (POST /ui/office-skins). A pack is immutable: its id taken is a 409 (delete it first). */
  add(body: unknown, by: string): { ok: true; rev: string; pack: SkinSummary } | SkinRefusal {
    const s = this.load();
    if (s === "unreadable") return refuse(503, "skins_unreadable");
    const checked = checkSkinUpload(body, by, this.now());
    if (!checked.ok) return checked;
    const r = checked.record;
    // Case-insensitively too: on a case-insensitive disk "Cozy" and "cozy" are one directory.
    if ([...s.packs.keys()].some(k => k.toLowerCase() === r.id.toLowerCase()) || existsSync(join(this.dir, r.id))) return refuse(409, "skin_exists", `"${r.id}" is kept already: delete it first`);
    if (s.packs.size >= SKIN_LIMITS.packs) return refuse(409, "skins_quota", `at most ${SKIN_LIMITS.packs} packs`);
    const tmp = join(this.dir, `.up-${randomBytes(8).toString("hex")}`);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      mkdirSync(tmp, { mode: 0o700 });
      for (const [id, bytes] of checked.pictures) writeFileSync(join(tmp, `${id}.png`), bytes, { mode: 0o600, flag: "wx" });
      atomicWriteFileSync(join(tmp, "pack.json"), JSON.stringify(r, null, 1) + "\n", { mode: 0o600 });
      renameSync(tmp, join(this.dir, r.id));
    } catch (err) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      return refuse(503, "skin_write_failed", (err as Error).message);
    }
    s.packs.set(r.id, { record: r, pack: checked.pack });
    return { ok: true, rev: this.rev(), pack: { id: r.id, name: r.name, sha: r.sha, bytes: r.bytes, files: Object.keys(r.files).length, uploaded_at: r.uploaded_at } };
  }

  /** Remove a pack (DELETE /ui/office-skins/<id>). Offices naming it are drawn in a built-in style until it is back. */
  remove(id: string): { ok: true; rev: string } | SkinRefusal {
    const s = this.load();
    if (s === "unreadable") return refuse(503, "skins_unreadable");
    if (!ID.test(id) || !s.packs.has(id)) return refuse(404, "skin_unknown");
    const gone = join(this.dir, `.rm-${randomBytes(8).toString("hex")}`);
    try { renameSync(join(this.dir, id), gone); } catch (err) { return refuse(503, "skin_write_failed", (err as Error).message); }
    s.packs.delete(id);
    try { rmSync(gone, { recursive: true, force: true }); } catch { /* removed on the next load */ }
    return { ok: true, rev: this.rev() };
  }
}
