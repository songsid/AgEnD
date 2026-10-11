/**
 * #1630: images the web app shows that come from a chat platform — a bot's own avatar, a Discord server's custom
 * emoji — fetched on the host with the token the adapter already holds, kept on disk, and served same-origin (the page
 * never loads cdn.discordapp.com or a Telegram file URL, and CSP img-src stays 'self').
 *
 * - On disk under `<AGEND_HOME>/cache/<kind>/`, one file per key, named by a hash of the key (a key never becomes a
 *   path), written to a temp file and renamed.
 * - Refreshed at most once a day: the file's age is wall-clock (mtime — it must survive a restart). A stale file is
 *   still served while the refresh runs in the background.
 * - A failed fetch keeps the file it had; the key is then not retried for an hour. A fetch that says there is no image
 *   (a bot with no avatar) removes the file, and is not asked again for a day. Those two waits are in-memory durations:
 *   monotonic clock.
 * - Never more than one fetch per key at a time. Nothing here blocks a caller: `peek` starts a refresh and returns
 *   what is on disk now; only `get` (a first request for an emoji nobody has fetched yet) waits for one.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { StickerPreview } from "./channel/types.js";

export const WEB_IMAGE_MAX_AGE_MS = 24 * 60 * 60_000;
export const WEB_IMAGE_RETRY_MS = 60 * 60_000;
/** Files not refreshed for this long (an emoji no longer used, a removed connection) are deleted on the next write. */
export const WEB_IMAGE_PRUNE_MS = 30 * WEB_IMAGE_MAX_AGE_MS;
export const WEB_IMAGE_MAX_BYTES = 256 * 1024;

const MIME: Readonly<Record<StickerPreview["ext"], string>> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const EXTS = Object.keys(MIME) as StickerPreview["ext"][];

/** The picture type of an uploaded file by its extension (View's profile avatars), or null for anything else. */
export function imageMimeForFile(name: string): string | null {
  const ext = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext === "jpeg" ? MIME.jpg : ext && Object.hasOwn(MIME, ext) ? MIME[ext as StickerPreview["ext"]] : null;
}

export interface CachedImage { readonly bytes: Buffer; readonly mime: string; readonly version: string }
/** What a fetch found: the picture, or null when there is none (the bot has no avatar). Throws when it failed. */
export type ImageLoader = () => Promise<StickerPreview | null>;

export class WebImageCache {
  private readonly inflight = new Map<string, Promise<void>>();
  /** key → when it may be asked again (monotonic ms), after a failure or a "none". */
  private readonly quietUntil = new Map<string, number>();

  constructor(private readonly opts: {
    dir: string;
    now?: () => number;            // wall clock, compared with file mtimes
    mono?: () => number;           // monotonic, for the in-memory waits
    maxAgeMs?: number;
    retryMs?: number;
    onError?: (key: string, err: unknown) => void;
  }) {}

  private get now(): number { return (this.opts.now ?? Date.now)(); }
  private get mono(): number { return (this.opts.mono ?? (() => performance.now()))(); }
  private base(key: string): string { return createHash("sha256").update(key).digest("hex").slice(0, 32); }

  private find(key: string): { path: string; ext: StickerPreview["ext"]; mtimeMs: number } | null {
    const base = this.base(key);
    for (const ext of EXTS) {
      const path = join(this.opts.dir, `${base}.${ext}`);
      try { if (existsSync(path)) return { path, ext, mtimeMs: statSync(path).mtimeMs }; } catch { /* raced with a refresh */ }
    }
    return null;
  }
  private stale(mtimeMs: number): boolean { return this.now - mtimeMs >= (this.opts.maxAgeMs ?? WEB_IMAGE_MAX_AGE_MS); }

  /** What is on disk now (fresh or stale), as a version for the page's URL; a stale or missing one is refreshed in the background. */
  peek(key: string, loader: ImageLoader): { version: string } | null {
    const found = this.find(key);
    if (!found || this.stale(found.mtimeMs)) void this.refresh(key, loader);
    return found ? { version: Math.floor(found.mtimeMs).toString(36) } : null;
  }

  /** The bytes on disk, or null. Never fetches. */
  read(key: string): CachedImage | null {
    const found = this.find(key);
    if (!found) return null;
    try { return { bytes: readFileSync(found.path), mime: MIME[found.ext], version: Math.floor(found.mtimeMs).toString(36) }; }
    catch { return null; }
  }

  /** The bytes, fetching first when nothing is on disk yet (a stale file is served and refreshed behind). */
  async get(key: string, loader: ImageLoader): Promise<CachedImage | null> {
    const found = this.find(key);
    if (!found) await this.refresh(key, loader);
    else if (this.stale(found.mtimeMs)) void this.refresh(key, loader);
    return this.read(key);
  }

  /** One fetch per key at a time; none while the key is quiet (after a failure or a "none"). Never throws. */
  refresh(key: string, loader: ImageLoader): Promise<void> {
    const running = this.inflight.get(key);
    if (running) return running;
    const quiet = this.quietUntil.get(key);
    if (quiet !== undefined && this.mono < quiet) return Promise.resolve();
    // Started on a later tick, after it is registered: a loader that throws at once must still release the key.
    const run = Promise.resolve().then(async () => {
      try {
        const got = await loader();
        if (!got) { this.remove(key); this.quietUntil.set(key, this.mono + (this.opts.maxAgeMs ?? WEB_IMAGE_MAX_AGE_MS)); return; }
        if (!MIME[got.ext] || got.bytes.length === 0 || got.bytes.length > WEB_IMAGE_MAX_BYTES) throw new Error("not a usable image");
        this.write(key, got);
        this.quietUntil.delete(key);
      } catch (err) {
        this.quietUntil.set(key, this.mono + (this.opts.retryMs ?? WEB_IMAGE_RETRY_MS));
        this.opts.onError?.(key, err);
      } finally {
        if (this.inflight.get(key) === run) this.inflight.delete(key);
      }
    });
    this.inflight.set(key, run);
    return run;
  }

  private write(key: string, image: StickerPreview): void {
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const base = this.base(key), path = join(this.opts.dir, `${base}.${image.ext}`);
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, image.bytes, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* never created */ }
      throw err;
    }
    for (const ext of EXTS) if (ext !== image.ext) { try { unlinkSync(join(this.opts.dir, `${base}.${ext}`)); } catch { /* none */ } }
    this.prune();
  }
  private remove(key: string): void {
    const base = this.base(key);
    for (const ext of EXTS) { try { unlinkSync(join(this.opts.dir, `${base}.${ext}`)); } catch { /* none */ } }
  }
  private prune(): void {
    let names: string[];
    try { names = readdirSync(this.opts.dir); } catch { return; }
    for (const name of names) {
      const path = join(this.opts.dir, name);
      try { if (this.now - statSync(path).mtimeMs > WEB_IMAGE_PRUNE_MS) unlinkSync(path); } catch { /* raced */ }
    }
  }
}
