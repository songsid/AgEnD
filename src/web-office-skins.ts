/**
 * Fleet → Org chart → Office: skin packs an admin uploaded (#2513) — a manifest (format v1, src/ui/fleet-office-pack.js)
 * and its PNG pictures, kept on the host for every viewer, never changed once kept (an office moves things on one with
 * its own layout overrides, web-office-store.ts).
 *
 *   <dataDir>/web-office-skins/<pack-id>/pack.json      { version: 1, id, name, sha, bytes, uploaded_at, by, manifest,
 *                                                         files: { <src>: { id, bytes, width, height } } }   (0600)
 *   <dataDir>/web-office-skins/<pack-id>/<id>.png        each picture, metadata stripped; id = sha of the kept bytes
 *
 *   <dataDir>/web-office-skins/<pack-id>/pack.prev.json the version it replaced (#2692: one, for a restore), its pictures
 *                                                      beside the current ones'
 *   <dataDir>/web-office-skins/.kept-<pack-id>/         a pack deleted keeping its previous version: pack.prev.json and its
 *                                                      pictures, out of the pack's own directory (#2694 follow-up) — a
 *                                                      host before #2692 skips the name (never an id) and never removes it,
 *                                                      so there the id is free to upload again and nothing is left stuck
 *
 * Directories 0700, files 0600. An upload is written into a hidden directory first and renamed into place whole, so a
 * pack is there entirely or not at all; a delete renames it away before removing it. A replace (#2692) writes the new
 * pictures beside the old and swaps pack.json in one rename (put). The manifest is checked by the
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
/** #2632: 160 files and 20 MiB a pack (was 64, 6 MiB) — room for a whole fleet's character sets. */
export const SKIN_LIMITS = {
  packs: 16, files: 160, fileBytes: 2 * MiB, packBytes: 20 * MiB, manifestBytes: 64 * 1024, side: 4096, pixels: 16 * MiB, name: 60, src: 200,
} as const;
/** The most an upload's body may be: every picture's base64 (4/3) plus the manifest and the envelope. */
export const SKIN_WIRE_BYTES = Math.ceil((SKIN_LIMITS.packBytes * 4) / 3) + SKIN_LIMITS.manifestBytes + 64 * 1024;
/**
 * #2692: what the packs may take on disk in all — every pack's pictures and its one kept previous version's (a picture
 * both share counted once): room for 16 full packs and a full previous version of each. Previous versions do not count
 * towards SKIN_LIMITS.packs.
 */
export const SKIN_DISK_BYTES = 2 * SKIN_LIMITS.packs * SKIN_LIMITS.packBytes;
/** #2692: a pack's previous version, beside its pack.json (a host before #2692 reads neither the file nor a directory without pack.json). */
export const PREVIOUS_FILE = "pack.prev.json";
/** A deleted pack's kept previous version: its own directory, never the pack's (a host before #2692 would find the id taken, yet no pack to delete). */
export const keptDir = (id: string) => `.kept-${id}`;
const KEPT = /^\.kept-([A-Za-z0-9_-]{1,40})$/;

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
  const checked = checkSkinPack(raw.manifest, { kept: true });
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

type Kept = { record: SkinRecord; pack: CheckedPack; text: string };
/**
 * `previous` (#2692): each pack's one kept previous version — also a deleted pack's, when it was deleted keeping it;
 * `away`: the ids whose previous is such a deleted pack's, kept in keptDir(id).
 */
type State = { packs: Map<string, Kept>; previous: Map<string, Kept>; away: Set<string> } | "unreadable";
const summaryOf = (r: SkinRecord): SkinSummary => ({ id: r.id, name: r.name, sha: r.sha, bytes: r.bytes, files: Object.keys(r.files).length, uploaded_at: r.uploaded_at });
/** The pictures a record keeps, by their file id (one id may serve several names). */
const pictureIds = (r: SkinRecord | undefined): Set<string> => new Set(r ? Object.values(r.files).map(f => f.id) : []);
/** The bytes a pack's directory holds: its pictures, each once, the current and the previous version's together. */
const dirBytes = (...records: Array<SkinRecord | undefined>): number => {
  const seen = new Map<string, number>();
  for (const r of records) if (r) for (const f of Object.values(r.files)) seen.set(f.id, f.bytes);
  return [...seen.values()].reduce((a, b) => a + b, 0);
};
/** A test's place to fail a write between its steps (#2692: a replace that fails mid-way leaves the old version). */
export interface SkinStoreHooks { beforeSwap?(id: string): void }

export class OfficeSkinStore {
  private state: State | null = null;
  readonly dir: string;
  constructor(dataDir: string, private readonly now: () => number = () => Date.now(), private readonly hooks: SkinStoreHooks = {}) { this.dir = join(dataDir, "web-office-skins"); }

  private load(): State {
    if (this.state) return this.state;
    let names: string[];
    try { names = readdirSync(this.dir); }
    catch (err) { return (this.state = (err as NodeJS.ErrnoException).code === "ENOENT" ? { packs: new Map(), previous: new Map(), away: new Set() } : "unreadable"); }
    const packs = new Map<string, Kept>(), previous = new Map<string, Kept>(), away = new Set<string>(), kept: string[] = [], stray: string[] = [];
    const read = (dir: string, file: string, id = dir): Kept | null => {
      try {
        const text = readFileSync(join(this.dir, dir, file), "utf8");
        const ok = recordOk(JSON.parse(text), id);
        return ok ? { ...ok, text } : null;
      } catch { return null; }
    };
    for (const n of names.sort()) {
      // An upload or a delete a restart cut short: never offered, removed.
      if (/^\.(?:up|rm)-[0-9a-f]{16}$/.test(n)) { try { rmSync(join(this.dir, n), { recursive: true, force: true }); } catch { /* next time */ } continue; }
      const k = KEPT.exec(n);
      if (k) { kept.push(k[1]!); continue; }
      if (!ID.test(n)) continue;
      const prev = read(n, PREVIOUS_FILE);
      // A deleted pack's previous left in the pack's own directory (as #2692 first kept it): moved out below.
      if (prev && !existsSync(join(this.dir, n, "pack.json"))) { stray.push(n); continue; }
      if (prev) previous.set(n, prev);
      if (packs.size >= SKIN_LIMITS.packs) continue;
      const ok = read(n, "pack.json");
      if (ok) packs.set(n, ok);
    }
    for (const n of stray) {
      if (kept.includes(n)) continue;
      try { renameSync(join(this.dir, n), join(this.dir, keptDir(n))); kept.push(n); } catch { /* left as it is: not offered */ }
    }
    for (const id of kept) {
      // The id uploaded again meanwhile (a host before #2692 sees it free): that pack is the one; the old previous goes.
      if (packs.has(id) || existsSync(join(this.dir, id))) { if (packs.has(id)) try { rmSync(join(this.dir, keptDir(id)), { recursive: true, force: true }); } catch { /* next time */ } continue; }
      // A pack.json there is a deleted version's that a crash left (remove's, or restore's before its rename): never
      // read, and gone before anything renames the directory back as the pack's (#2696 review).
      try { rmSync(join(this.dir, keptDir(id), "pack.json"), { force: true }); } catch { /* next time; put() removes it too */ }
      const prev = read(keptDir(id), PREVIOUS_FILE, id);
      if (prev) { previous.set(id, prev); away.add(id); }
    }
    return (this.state = { packs, previous, away });
  }

  readable(): boolean { return this.load() !== "unreadable"; }
  /** A rev that moves with any change (the packs' ids and shas), the same after a restart. */
  rev(): string { const s = this.load(); return s === "unreadable" ? "" : hash32([...s.packs.values()].map(p => `${p.record.id}:${p.record.sha}`).join("\n")).slice(0, 12); }
  /** GET /ui/office-skins: what every viewer's style picker lists. */
  list(): { rev: string; packs: SkinSummary[]; readable: boolean; limits: typeof SKIN_LIMITS } {
    const s = this.load();
    const packs = s === "unreadable" ? [] : [...s.packs.values()].map(({ record: r }) => summaryOf(r));
    return { rev: this.rev(), packs, readable: s !== "unreadable", limits: SKIN_LIMITS };
  }
  /** #2692: each kept pack's record and its previous version's (also a deleted pack's kept previous), for the tools. */
  records(): { packs: SkinRecord[]; previous: Map<string, SkinRecord>; readable: boolean; diskBytes: number } {
    const s = this.load();
    if (s === "unreadable") return { packs: [], previous: new Map(), readable: false, diskBytes: 0 };
    const ids = new Set([...s.packs.keys(), ...s.previous.keys()]);
    return { packs: [...s.packs.values()].map(p => p.record), previous: new Map([...s.previous].map(([k, v]) => [k, v.record])), readable: true,
      diskBytes: [...ids].reduce((n, id) => n + dirBytes(s.packs.get(id)?.record, s.previous.get(id)?.record), 0) };
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
  /** #2692: a pack's kept previous version, checked, or null. */
  previousPack(id: string): CheckedPack | null { const s = this.load(); return s === "unreadable" ? null : s.previous.get(id)?.pack ?? null; }
  /** One picture of a pack, by its id (the sha of its bytes); null when the pack does not have it. */
  picture(id: string, file: string): Buffer | null {
    const s = this.load();
    const p = s === "unreadable" ? undefined : s.packs.get(id);
    if (!p || !FILE_ID.test(file) || !Object.values(p.record.files).some(f => f.id === file)) return null;
    try { return readFileSync(join(this.dir, id, `${file}.png`)); } catch { return null; }
  }

  /** Keep an upload (POST /ui/office-skins). A pack the fleet keeps is never replaced here: its id taken is a 409 (delete it first). */
  add(body: unknown, by: string): { ok: true; rev: string; pack: SkinSummary } | SkinRefusal {
    if (this.load() === "unreadable") return refuse(503, "skins_unreadable");
    const checked = checkSkinUpload(body, by, this.now());
    if (!checked.ok) return checked;
    const r = this.put(checked, { replace: false });
    return r.ok ? { ok: true, rev: r.rev, pack: r.pack } : r;
  }

  /**
   * Keep a checked upload (#2692: office_pack_upload). `replace`: an id the fleet keeps is replaced in place, its version
   * now kept as the previous one (the one before that is dropped); else that is a 409, as the web upload's. The new
   * pictures go into the pack's directory beside the old (each named by the sha of its bytes), the version being
   * replaced is written as pack.prev.json, and then pack.json is renamed over in one step — the swap. Until it, the old
   * version is what every reader gets; when anything fails before it, the old one stays and pack.prev.json is put back.
   * A new pack is written into a hidden directory and renamed into place whole, as before.
   */
  put(checked: Extract<SkinChecked, { ok: true }>, opts: { replace: boolean }): { ok: true; rev: string; pack: SkinSummary; replaced: SkinSummary | null } | SkinRefusal {
    const s = this.load();
    if (s === "unreadable") return refuse(503, "skins_unreadable");
    const r = checked.record, current = s.packs.get(r.id), previous = s.previous.get(r.id);
    // Case-insensitively too: on a case-insensitive disk "Cozy" and "cozy" are one directory.
    const clash = [...s.packs.keys(), ...s.previous.keys()].find(k => k.toLowerCase() === r.id.toLowerCase() && k !== r.id);
    if (clash) return refuse(409, "skin_exists", `"${clash}" is kept already (ids differ only in case)`);
    if (current && !opts.replace) return refuse(409, "skin_exists", `"${r.id}" is kept already: delete it first`);
    if (!current && s.packs.size >= SKIN_LIMITS.packs) return refuse(409, "skins_quota", `at most ${SKIN_LIMITS.packs} packs`);
    const text = JSON.stringify(r, null, 1) + "\n";
    const disk = this.records().diskBytes - dirBytes(current?.record, previous?.record) + dirBytes(r, current?.record ?? previous?.record);
    if (disk > SKIN_DISK_BYTES) return refuse(409, "skins_disk_budget", `at most ${SKIN_DISK_BYTES / MiB} MiB on disk, previous versions included: delete a pack (its previous version goes with it)`);
    const home = join(this.dir, r.id);
    if (!current && !previous) {
      if (existsSync(home)) return refuse(409, "skin_exists", `"${r.id}" is kept already: delete it first`);
      const tmp = join(this.dir, `.up-${randomBytes(8).toString("hex")}`);
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        mkdirSync(tmp, { mode: 0o700 });
        for (const [id, bytes] of checked.pictures) writeFileSync(join(tmp, `${id}.png`), bytes, { mode: 0o600, flag: "wx" });
        atomicWriteFileSync(join(tmp, "pack.json"), text, { mode: 0o600 });
        this.hooks.beforeSwap?.(r.id);
        renameSync(tmp, home);
      } catch (err) {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
        return refuse(503, "skin_write_failed", (err as Error).message);
      }
      s.packs.set(r.id, { record: r, pack: checked.pack, text });
      return { ok: true, rev: this.rev(), pack: summaryOf(r), replaced: null };
    }
    // In place: a kept pack replaced, or a deleted one whose previous version was kept (that previous stays: its
    // directory comes back as the pack's first).
    const keep = current ?? previous!, written: string[] = [], back = !current && s.away.has(r.id);
    if (back) {
      if (existsSync(home)) return refuse(409, "skin_exists", `"${r.id}" is kept already: delete it first`);
      try { rmSync(join(this.dir, keptDir(r.id), "pack.json"), { force: true }); renameSync(join(this.dir, keptDir(r.id)), home); }
      catch (err) { return refuse(503, "skin_write_failed", (err as Error).message); }
      s.away.delete(r.id);
    }
    try {
      for (const [id, bytes] of checked.pictures) {
        const at = join(home, `${id}.png`);
        if (existsSync(at)) continue;                                                 // the same bytes (named by their sha)
        writeFileSync(at, bytes, { mode: 0o600, flag: "wx" });
        written.push(at);
      }
      if (current) atomicWriteFileSync(join(home, PREVIOUS_FILE), current.text, { mode: 0o600 });
      this.hooks.beforeSwap?.(r.id);
      atomicWriteFileSync(join(home, "pack.json"), text, { mode: 0o600 });                // the swap
    } catch (err) {
      try { if (current) { if (previous) atomicWriteFileSync(join(home, PREVIOUS_FILE), previous.text, { mode: 0o600 }); else rmSync(join(home, PREVIOUS_FILE), { force: true }); } } catch { /* read back as it is */ }
      for (const at of written) { try { rmSync(at, { force: true }); } catch { /* removed with the pack */ } }
      if (back) { try { renameSync(home, join(this.dir, keptDir(r.id))); s.away.add(r.id); } catch { /* moved out on the next load */ } }
      return refuse(503, "skin_write_failed", (err as Error).message);
    }
    s.packs.set(r.id, { record: r, pack: checked.pack, text });
    if (current) s.previous.set(r.id, current);
    this.sweep(home, r, current ? current.record : keep.record);
    return { ok: true, rev: this.rev(), pack: summaryOf(r), replaced: current ? summaryOf(current.record) : null };
  }

  /** Remove the pictures of a pack's directory (`dir`) that neither its current nor its previous version names. */
  private sweep(dir: string, ...keep: Array<SkinRecord | undefined>): void {
    const ids = new Set(keep.flatMap(r => [...pictureIds(r)]));
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) if (/^[0-9a-f]{32}\.png$/.test(n) && !ids.has(n.slice(0, 32))) { try { rmSync(join(dir, n), { force: true }); } catch { /* next time */ } }
  }

  /**
   * #2692: bring back a pack's previous version. The version it replaces becomes the previous one (a restore is undone
   * the same way); a deleted pack whose previous was kept comes back with none. pack.json is renamed over in one step.
   */
  restore(id: string): { ok: true; rev: string; pack: SkinSummary; replaced: SkinSummary | null } | SkinRefusal {
    const s = this.load();
    if (s === "unreadable") return refuse(503, "skins_unreadable");
    const previous = ID.test(id) ? s.previous.get(id) : undefined, current = s.packs.get(id);
    if (!previous) return refuse(404, "skin_no_previous", `"${id}" has no previous version kept`);
    if (!current && s.packs.size >= SKIN_LIMITS.packs) return refuse(409, "skins_quota", `at most ${SKIN_LIMITS.packs} packs`);
    const home = join(this.dir, id);
    if (!current && s.away.has(id)) {
      // A deleted pack's kept previous: its pack.json written in its own directory, which then becomes the pack's in one rename.
      const away = join(this.dir, keptDir(id));
      if (existsSync(home)) return refuse(409, "skin_exists", `"${id}" is kept already: delete it first`);
      try {
        this.hooks.beforeSwap?.(id);
        atomicWriteFileSync(join(away, "pack.json"), previous.text, { mode: 0o600 });
        renameSync(away, home);                                                             // the swap
      } catch (err) {
        try { rmSync(join(away, "pack.json"), { force: true }); } catch { /* not read in a kept directory */ }
        return refuse(503, "skin_write_failed", (err as Error).message);
      }
      s.away.delete(id);
    } else {
      try {
        this.hooks.beforeSwap?.(id);
        atomicWriteFileSync(join(home, "pack.json"), previous.text, { mode: 0o600 });       // the swap
      } catch (err) { return refuse(503, "skin_write_failed", (err as Error).message); }
    }
    try { if (current) atomicWriteFileSync(join(home, PREVIOUS_FILE), current.text, { mode: 0o600 }); else rmSync(join(home, PREVIOUS_FILE), { force: true }); }
    catch { /* the previous file still names the restored version: restoring again changes nothing */ }
    s.packs.set(id, previous);
    if (current) s.previous.set(id, current); else s.previous.delete(id);
    return { ok: true, rev: this.rev(), pack: summaryOf(previous.record), replaced: current ? summaryOf(current.record) : null };
  }

  /**
   * Remove a pack (DELETE /ui/office-skins/<id>). Offices naming it are drawn in a built-in style until it is back. Its
   * previous version goes with it — unless `keepPrevious` (#2692), which removes only the current one, so a restore can
   * bring the previous back: the pack's directory is renamed to keptDir(id) at once (gone for every reader, an older
   * host's too, the id free there), then its pack.json and the current version's own pictures are removed. A deleted
   * pack's kept previous is removed by deleting it again.
   */
  remove(id: string, opts: { keepPrevious?: boolean } = {}): { ok: true; rev: string; removed: SkinSummary | null; previous_kept: boolean } | SkinRefusal {
    const s = this.load();
    if (s === "unreadable") return refuse(503, "skins_unreadable");
    const current = ID.test(id) ? s.packs.get(id) : undefined, previous = ID.test(id) ? s.previous.get(id) : undefined;
    if (!current && !previous) return refuse(404, "skin_unknown");
    if (opts.keepPrevious && previous && current) {
      const away = join(this.dir, keptDir(id));
      try { rmSync(away, { recursive: true, force: true }); renameSync(join(this.dir, id), away); } catch (err) { return refuse(503, "skin_write_failed", (err as Error).message); }
      try { rmSync(join(away, "pack.json"), { force: true }); } catch { /* never read in a kept directory */ }
      s.packs.delete(id); s.away.add(id);
      this.sweep(away, previous.record);
      return { ok: true, rev: this.rev(), removed: summaryOf(current.record), previous_kept: true };
    }
    if (opts.keepPrevious && !current) return refuse(404, "skin_unknown", `"${id}" is deleted already; its previous version is kept`);
    const gone = join(this.dir, `.rm-${randomBytes(8).toString("hex")}`);
    try { renameSync(join(this.dir, current ? id : keptDir(id)), gone); } catch (err) { return refuse(503, "skin_write_failed", (err as Error).message); }
    s.packs.delete(id); s.previous.delete(id); s.away.delete(id);
    try { rmSync(gone, { recursive: true, force: true }); } catch { /* removed on the next load */ }
    return { ok: true, rev: this.rev(), removed: current ? summaryOf(current.record) : null, previous_kept: false };
  }
}
