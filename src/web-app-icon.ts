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
import { Worker } from "node:worker_threads";
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

export type AppIconResult = { ok: true; state: AppIconState } | { ok: false; status: 400 | 409 | 413 | 415 | 500 | 503; error: string; detail?: string };
/** A source checked and made into its files (prepare), not yet in force (commit). */
export interface AppIconPrepared { version: string; source: Uint8Array; files: Record<AppIconFile, Buffer>; epoch: number }
export type AppIconPrepareResult = { ok: true; prepared: AppIconPrepared } | Extract<AppIconResult, { ok: false }>;

/** The conversion's bounds off the event loop: its time, and its worker's heap. */
export const APP_ICON_CONVERT_MS = 30_000;
const CONVERT_HEAP_MB = 256;

/** Make the files from a source somewhere: a worker thread in the fleet (the default), in-process where a test says so. */
export type AppIconConvert = (bytes: Uint8Array) => Promise<{ ok: true; files: Record<AppIconFile, Buffer> } | { ok: false; detail: string }>;

/** What the conversion needs of a worker thread (a test gives one that ends when it says). */
export interface IconWorker {
  on(event: "message" | "error" | "exit", listener: (...args: any[]) => void): unknown;
  terminate(): Promise<number>;
}
/** The fleet's worker: its own heap; TypeScript sources through tsx, the built .js otherwise. */
export function spawnIconWorker(source: ArrayBuffer): IconWorker {
  return import.meta.url.endsWith(".ts")
    ? new Worker(`const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
      { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: CONVERT_HEAP_MB }, workerData: { entry: new URL("./web-app-icon-worker.ts", import.meta.url).href, source } })
    : new Worker(new URL("./web-app-icon-worker.js", import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: CONVERT_HEAP_MB }, workerData: { source }, transferList: [source] });
}

/**
 * The conversion in a one-off worker thread: its own heap, a deadline (terminated past it), never the fleet's loop.
 * It settles only once the worker has exited (#2319 review): a timed-out or finished conversion whose thread is still
 * winding down keeps its claim, so the store never runs two threads at once.
 */
export function convertWithWorker(spawn: (source: ArrayBuffer) => IconWorker = spawnIconWorker, deadlineMs = APP_ICON_CONVERT_MS): AppIconConvert {
  return (bytes) => new Promise((resolve) => {
    const worker = spawn(new Uint8Array(bytes).buffer);
    let result: Awaited<ReturnType<AppIconConvert>> | null = null;
    let exited = false;
    const settle = () => { if (result && exited) resolve(result); };
    const finish = (r: Awaited<ReturnType<AppIconConvert>>) => {
      if (result) return;
      result = r;
      clearTimeout(timer);
      if (!exited) void worker.terminate().catch(() => { /* its exit still settles */ });
      settle();
    };
    const timer = setTimeout(() => finish({ ok: false, detail: "it took too long to read" }), deadlineMs);
    worker.on("message", (m: { ok: boolean; files?: Record<AppIconFile, Uint8Array>; detail?: string }) => {
      if (!m || !m.ok || !m.files) { finish({ ok: false, detail: (m && m.detail) || "the image could not be read" }); return; }
      const files = {} as Record<AppIconFile, Buffer>;
      for (const name of APP_ICON_FILES) {
        const f = m.files[name];
        if (!f) { finish({ ok: false, detail: "the image could not be read" }); return; }
        files[name] = Buffer.from(f.buffer, f.byteOffset, f.byteLength);
      }
      finish({ ok: true, files });
    });
    worker.on("error", () => finish({ ok: false, detail: "the image could not be read" }));
    worker.on("exit", () => { exited = true; finish({ ok: false, detail: "the image could not be read" }); settle(); });
  });
}
export const convertInWorker: AppIconConvert = convertWithWorker();

/** The conversion on this thread (tests, tools): the same code, without the worker. */
export const convertInProcess: AppIconConvert = async (bytes) => {
  try { return { ok: true, files: appIconSet(bytes) }; } catch (err) {
    return { ok: false, detail: err instanceof PngError ? err.message : "the image could not be read" };
  }
};

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

  /** One conversion at a time: a second upload meanwhile is told to wait (409). */
  private converting = false;
  private closed = false;
  /** Moved by every reset: an icon prepared before it is no longer the person's latest wish, and is not used. */
  private epoch = 0;

  constructor(private readonly dataDir: string, private readonly now: () => Date = () => new Date(), private readonly convert: AppIconConvert = convertInWorker) {}

  /** The fleet is stopping: nothing more is converted or switched to. */
  close(): void { this.closed = true; }
  get isClosed(): boolean { return this.closed; }

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

  /**
   * Check a source (its size and magic here; decoding and the sizes in the conversion, off the event loop) and make its
   * files. Nothing on disk changes: commit() switches to them, after its caller checked again who asks.
   */
  async prepare(bytes: Uint8Array): Promise<AppIconPrepareResult> {
    if (this.closed) return { ok: false, status: 503, error: "app_icon_unavailable" };
    if (bytes.length > APP_ICON_MAX_BYTES) return { ok: false, status: 413, error: "app_icon_too_large", detail: "at most 5 MiB" };
    if (!isPng(bytes)) return { ok: false, status: 415, error: "app_icon_not_png", detail: "a PNG image (the page converts JPG and WebP)" };
    if (this.converting) return { ok: false, status: 409, error: "app_icon_busy", detail: "another icon is being made" };
    this.converting = true;
    const epoch = this.epoch;
    try {
      const made = await this.convert(bytes);
      if (!made.ok) return { ok: false, status: 400, error: "app_icon_unreadable", detail: made.detail };
      return { ok: true, prepared: { version: createHash("sha256").update(bytes).digest("hex").slice(0, 16), source: bytes, files: made.files, epoch } };
    } finally {
      this.converting = false;
    }
  }

  /** Switch to a prepared icon: its files under its version, then the pointer (last, atomically), then old versions go. */
  commit(prepared: AppIconPrepared, by: string): AppIconResult {
    if (this.closed) return { ok: false, status: 503, error: "app_icon_unavailable" };
    // #2319 review: restored to the default while this one was being made — the later wish wins.
    if (prepared.epoch !== this.epoch) return { ok: false, status: 409, error: "app_icon_superseded", detail: "the icon was reset meanwhile" };
    const { version } = prepared;
    const state: AppIconState = { version, updatedAt: this.now().toISOString(), by };
    try {
      const dir = join(this.root, version);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeBytesAtomic(join(dir, "source.png"), prepared.source);
      for (const name of APP_ICON_FILES) writeBytesAtomic(join(dir, name), prepared.files[name]);
      writeBytesAtomic(this.pointer, Buffer.from(JSON.stringify(state)));
    } catch {
      return { ok: false, status: 500, error: "app_icon_not_saved" };
    }
    this.cached = null;
    this.prune(version);
    return { ok: true, state };
  }

  /** prepare() then commit(), for a caller with nothing to check in between. */
  async set(bytes: Uint8Array, by: string): Promise<AppIconResult> {
    const p = await this.prepare(bytes);
    return p.ok ? this.commit(p.prepared, by) : p;
  }

  /**
   * Back to the bundled icon: the pointer removed (none there is already the default), then the files. A pointer that
   * cannot be removed is a failure — nothing is pruned, so the icon in force keeps its files (#2308 review).
   */
  reset(): { ok: true } | { ok: false; status: 500; error: string; detail?: string } {
    this.epoch++;
    try { unlinkSync(this.pointer); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, status: 500, error: "app_icon_not_reset", detail: (err as NodeJS.ErrnoException).code ?? "error" };
    }
    this.cached = null;
    this.prune(null);
    return { ok: true };
  }

  /** Remove every version folder but `keep`. */
  private prune(keep: string | null): void {
    let names: string[];
    try { names = readdirSync(this.root); } catch { return; }
    for (const n of names) if (/^[0-9a-f]{16}$/.test(n) && n !== keep) { try { rmSync(join(this.root, n), { recursive: true, force: true }); } catch { /* next time */ } }
  }
}
