/**
 * #2308: the person's own app icon. One square PNG (the admin's page crops and draws whatever they chose into one) is
 * checked and decoded here (web-png.ts), and made into the sizes a browser and a home screen ask for: the touch icon
 * (180, on white — iOS shows transparency as black), the favicon (an ICO of 32 and 48) and the manifest's 192 and 512.
 *
 * Under the state dir: `web-app-icon/<version>/…`, the version being the source's sha256 (16 hex), and
 * `web-app-icon/current.json` naming the version in force — written last, atomically, so a reader sees the old set or
 * the new one, never half of one. Older version folders are removed once the pointer has moved.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodeIco, encodePng, flatten, isPng, PngError, resize } from "./web-png.js";

/** What an upload may weigh (the route stops reading past it). */
export const APP_ICON_MAX_BYTES = 5 * 1024 * 1024;
/** The source's side: at least the manifest's largest icon, at most what decodes in a few MB of memory. */
export const APP_ICON_MIN_SIDE = 512;
export const APP_ICON_MAX_SIDE = 2048;

/** The files made from the source, by the name each is served as. */
export const APP_ICON_FILES = ["apple-touch-icon.png", "favicon.ico", "icon-192.png", "icon-512.png"] as const;
export type AppIconFile = (typeof APP_ICON_FILES)[number];

export interface AppIconState {
  version: string;
  updatedAt: string;
  by: string;
}

export type AppIconResult = { ok: true; state: AppIconState } | { ok: false; status: 400 | 413 | 415 | 500; error: string; detail?: string };

function writeBytesAtomic(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { writeFileSync(tmp, bytes, { mode: 0o600 }); renameSync(tmp, path); }
  catch (err) { try { unlinkSync(tmp); } catch { /* none */ } throw err; }
}

/** The sizes made from one decoded source. */
export function appIconSet(bytes: Uint8Array): Record<AppIconFile, Buffer> {
  const src = decodePng(bytes, { maxSide: APP_ICON_MAX_SIDE });
  if (src.width !== src.height) throw new PngError(`not square (${src.width}×${src.height})`);
  if (src.width < APP_ICON_MIN_SIDE) throw new PngError(`smaller than ${APP_ICON_MIN_SIDE}×${APP_ICON_MIN_SIDE}`);
  const at = (n: number) => resize(src, n, n);
  return {
    "apple-touch-icon.png": encodePng(flatten(at(180), [255, 255, 255])),
    "favicon.ico": encodeIco([{ size: 32, png: encodePng(at(32)) }, { size: 48, png: encodePng(at(48)) }]),
    "icon-192.png": encodePng(at(192)),
    "icon-512.png": encodePng(at(512)),
  };
}

export class AppIconStore {
  private cached: { mtimeMs: number; state: AppIconState | null } | null = null;

  constructor(private readonly dataDir: string, private readonly now: () => Date = () => new Date()) {}

  private get root(): string { return join(this.dataDir, "web-app-icon"); }
  private get pointer(): string { return join(this.root, "current.json"); }

  /** The custom icon in force, or null for the bundled one. Read again only when the pointer file changed. */
  current(): AppIconState | null {
    let mtimeMs: number;
    try { mtimeMs = statSync(this.pointer).mtimeMs; } catch { this.cached = { mtimeMs: -1, state: null }; return null; }
    if (this.cached && this.cached.mtimeMs === mtimeMs) return this.cached.state;
    let state: AppIconState | null = null;
    try {
      const v = JSON.parse(readFileSync(this.pointer, "utf8")) as Partial<AppIconState>;
      if (typeof v.version === "string" && /^[0-9a-f]{16}$/.test(v.version) && typeof v.updatedAt === "string" && typeof v.by === "string") {
        state = { version: v.version, updatedAt: v.updatedAt, by: v.by };
      }
    } catch { /* unreadable: the bundled icon */ }
    this.cached = { mtimeMs, state };
    return state;
  }

  /** A made file of the icon in force (or of `version`), or null. */
  file(name: AppIconFile, version?: string): Buffer | null {
    const v = version ?? this.current()?.version;
    if (!v || !/^[0-9a-f]{16}$/.test(v)) return null;
    try { return readFileSync(join(this.root, v, name)); } catch { return null; }
  }

  /** Check, decode and make the sizes; then switch to them. Nothing on disk changes unless every step succeeded. */
  set(bytes: Uint8Array, by: string): AppIconResult {
    if (bytes.length > APP_ICON_MAX_BYTES) return { ok: false, status: 413, error: "app_icon_too_large", detail: "at most 5 MiB" };
    if (!isPng(bytes)) return { ok: false, status: 415, error: "app_icon_not_png", detail: "a PNG image (the page converts JPG and WebP)" };
    let made: Record<AppIconFile, Buffer>;
    try { made = appIconSet(bytes); } catch (err) {
      if (err instanceof PngError) return { ok: false, status: 400, error: "app_icon_unreadable", detail: err.message };
      return { ok: false, status: 400, error: "app_icon_unreadable", detail: "the image could not be read" };
    }
    const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const state: AppIconState = { version, updatedAt: this.now().toISOString(), by };
    try {
      const dir = join(this.root, version);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeBytesAtomic(join(dir, "source.png"), bytes);
      for (const name of APP_ICON_FILES) writeBytesAtomic(join(dir, name), made[name]);
      writeBytesAtomic(this.pointer, Buffer.from(JSON.stringify(state)));
    } catch {
      return { ok: false, status: 500, error: "app_icon_not_saved" };
    }
    this.cached = null;
    this.prune(version);
    return { ok: true, state };
  }

  /** Back to the bundled icon. */
  reset(): void {
    try { unlinkSync(this.pointer); } catch { /* none */ }
    this.cached = null;
    this.prune(null);
  }

  /** Remove every version folder but `keep`. */
  private prune(keep: string | null): void {
    let names: string[];
    try { names = readdirSync(this.root); } catch { return; }
    for (const n of names) if (/^[0-9a-f]{16}$/.test(n) && n !== keep) { try { rmSync(join(this.root, n), { recursive: true, force: true }); } catch { /* next time */ } }
  }
}
