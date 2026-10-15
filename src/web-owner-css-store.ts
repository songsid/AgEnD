/**
 * #1629 r4 §3: where each person's owner CSS lives. Per person (their web-prefs key, web-profile.ts webPersonKey), in
 * `<dataDir>/web-owner-css/<hash of the key>/`:
 *   <sha>.css        each kept version, as uploaded (served only after checkOwnerCss + serializeOwnerCss, every time)
 *   assets/<id>.<ext> the pictures and fonts its CSS names as url("asset:<id>") — metadata stripped, id = sha of the kept bytes
 *   index.json       { versions: [{ sha, at }] newest first, at most 5; assets: [{ id, kind, bytes }]; pending? }
 * Which version is in force is the person's `css.active` (web-prefs.ts), so every device of theirs follows.
 * Keep-or-revert: a saved version is in force on trial (`pending`) until the person keeps it. Unkept by its deadline,
 * it is reverted here, at the next read — a closed tab, or CSS that hid the question, reverts too.
 * Nothing here is reachable from an agent: no tool, CLI command or agent route names it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { MEDIA_EXT, MEDIA_MIME, type MediaKind, sniffMedia, stripMetadata } from "./web-image-meta.js";
import { checkOwnerCss, OWNER_CSS_ASSET_ID, ownerCssAssetRefs, serializeOwnerCss } from "./web-owner-css.js";

export const OWNER_CSS_VERSIONS = 5;
/** How long a saved version waits to be kept (the page asks for 15 s; the host allows a little more for the round trip). */
export const OWNER_CSS_KEEP_MS = 20_000;
export const OWNER_CSS_MAX_ASSETS = 16;
export const OWNER_CSS_MAX_ASSET_BYTES = 1024 * 1024;   // all of a person's assets together
const ASSET_KINDS: ReadonlySet<MediaKind> = new Set(["png", "webp", "jpeg", "gif", "woff2"]);
const SHA = /^[0-9a-f]{32}$/;

/**
 * The person's synced pointers (web-prefs internal keys): `css.active`, the version in force, and `css.trial`, the
 * version on trial (or none). One write moves both and bumps the person's revision, so every device of theirs asks
 * again — a save, a keep and a revert alike.
 */
export interface OwnerCssPointer {
  ownerCssActive(person: string): string | null;
  setOwnerCss(person: string, change: { active?: string | null; trial?: string | null }): { ok: true } | { ok: false; status: 400 | 503; error: string };
}
interface Pending { sha: string; previous: string | null; at: number; until: number }
interface Index { versions: Array<{ sha: string; at: number }>; assets: Array<{ id: string; kind: MediaKind; bytes: number }>; pending?: Pending }
export interface OwnerCssState {
  active: string | null;
  /** The active version is on trial: kept by this deadline (epoch ms), or reverted to `previous`. */
  pending: { sha: string; previous: string | null; until: number } | null;
  /** The active version's text as uploaded (for the editor). */
  text: string | null;
  versions: Array<{ sha: string; at: number; bytes: number }>;
  assets: Array<{ id: string; kind: MediaKind; bytes: number }>;
  limits: { maxBytes: number; maxAssets: number; maxAssetBytes: number; versions: number };
}
export type OwnerCssResult<T> = ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409 | 413 | 503; error: string; detail?: string };

const hash32 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 32);
/** Bytes to a file, whole or not at all (a temp file renamed over it), 0600. */
function writeBytesAtomic(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { writeFileSync(tmp, bytes, { mode: 0o600 }); renameSync(tmp, path); }
  catch (err) { try { unlinkSync(tmp); } catch { /* none */ } throw err; }
}

export class OwnerCssStore {
  constructor(private readonly dataDir: string, private readonly pointer: OwnerCssPointer, private readonly now: () => number = () => Date.now()) {}

  private dir(person: string): string { return join(this.dataDir, "web-owner-css", hash32(`person\0${person}`)); }
  private readIndex(person: string): Index {
    try {
      const raw = JSON.parse(readFileSync(join(this.dir(person), "index.json"), "utf8")) as Partial<Index>;
      const versions = Array.isArray(raw.versions) ? raw.versions.filter(v => v && SHA.test(String(v.sha)) && Number.isFinite(v.at)) : [];
      const assets = Array.isArray(raw.assets) ? raw.assets.filter(a => a && SHA.test(String(a.id)) && ASSET_KINDS.has(a.kind) && Number.isSafeInteger(a.bytes)) : [];
      const p = raw.pending;
      const pending = p && SHA.test(String(p.sha)) && (p.previous === null || SHA.test(String(p.previous))) && Number.isFinite(p.at) && Number.isFinite(p.until) ? p : undefined;
      return { versions, assets, ...(pending ? { pending } : {}) };
    } catch { return { versions: [], assets: [] }; }
  }
  private writeIndex(person: string, index: Index): void {
    mkdirSync(this.dir(person), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(this.dir(person), "index.json"), JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
  }
  private readText(person: string, sha: string): string | null {
    if (!SHA.test(sha)) return null;
    try { return readFileSync(join(this.dir(person), `${sha}.css`), "utf8"); } catch { return null; }
  }
  private assetIds(index: Index): Set<string> { return new Set(index.assets.map(a => a.id)); }

  /**
   * A trial nobody kept by its deadline is reverted now: the version before it is put back. A clock that went back
   * past the save counts as expired too (the deadline cannot be trusted).
   */
  private settle(person: string): void {
    const index = this.readIndex(person);
    const p = index.pending;
    if (!p) return;
    const now = this.now();
    if (now <= p.until && now >= p.at) return;
    this.endTrial(person, index, "revert");
  }
  /**
   * End the trial in `index`: "keep" leaves its version in force; "revert" puts back the one before it (if that one is
   * still kept, else none). Either way `css.trial` is cleared in the same write, so every device hears of it.
   */
  private endTrial(person: string, index: Index, how: "keep" | "revert"): boolean {
    const p = index.pending;
    if (!p) return false;
    const change: { active?: string | null; trial: null } = { trial: null };
    if (how === "revert" && this.pointer.ownerCssActive(person) === p.sha) {
      change.active = p.previous && index.versions.some(v => v.sha === p.previous) ? p.previous : null;
    }
    if (!this.pointer.setOwnerCss(person, change).ok) return false;    // the pointer cannot be written: try at the next read
    const { pending: _done, ...rest } = index;
    void _done;
    this.writeIndex(person, rest);
    return true;
  }

  /** The version in force (a kept one), or null — what the page links at load. */
  active(person: string): string | null {
    this.settle(person);
    const active = this.pointer.ownerCssActive(person);
    return active && this.readIndex(person).versions.some(v => v.sha === active) ? active : null;
  }

  state(person: string): OwnerCssState {
    this.settle(person);
    const index = this.readIndex(person);
    const active = this.pointer.ownerCssActive(person);
    const kept = active && index.versions.some(v => v.sha === active) ? active : null;
    return {
      active: kept,
      pending: index.pending && index.pending.sha === kept ? { sha: index.pending.sha, previous: index.pending.previous, until: index.pending.until } : null,
      text: kept ? this.readText(person, kept) : null,
      versions: index.versions.map(v => ({ ...v, bytes: Buffer.byteLength(this.readText(person, v.sha) ?? "", "utf8") })),
      assets: index.assets,
      limits: { maxBytes: 64 * 1024, maxAssets: OWNER_CSS_MAX_ASSETS, maxAssetBytes: OWNER_CSS_MAX_ASSET_BYTES, versions: OWNER_CSS_VERSIONS },
    };
  }

  /**
   * Check, store and select a new version — on trial until kept (keep()). `previous`: the version in force before,
   * which an unkept trial goes back to.
   */
  save(person: string, text: unknown): OwnerCssResult<{ sha: string; previous: string | null }> {
    if (typeof text !== "string") return { ok: false, status: 400, error: "css: text" };
    const index = this.readIndex(person);
    const checked = checkOwnerCss(text, this.assetIds(index));
    if (!checked.ok) return { ok: false, status: checked.error.problem === "too_large" ? 413 : 400, error: checked.error.problem, ...(checked.error.detail ? { detail: checked.error.detail } : {}) };
    try { serializeOwnerCss(checked.tokens); } catch { return { ok: false, status: 400, error: "unserialisable" }; }
    const sha = hash32(text);
    const before = this.state(person);
    // A trial on top of a trial goes back to what was in force before the first: never to an unkept version.
    const previous = before.pending ? (this.readIndex(person).pending?.previous ?? null) : before.active;
    mkdirSync(this.dir(person), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(this.dir(person), `${sha}.css`), text, { mode: 0o600 });
    const versions = [{ sha, at: this.now() }, ...index.versions.filter(v => v.sha !== sha)];
    // The version a trial would go back to is never dropped, even past five.
    const keepList = versions.slice(0, OWNER_CSS_VERSIONS);
    if (previous && !keepList.some(v => v.sha === previous)) { const p = versions.find(v => v.sha === previous); if (p) keepList.push(p); }
    const dropped = versions.filter(v => !keepList.includes(v));
    const at = this.now();
    this.writeIndex(person, { ...index, versions: keepList, pending: { sha, previous, at, until: at + OWNER_CSS_KEEP_MS } });
    const set = this.pointer.setOwnerCss(person, { active: sha, trial: sha });
    if (!set.ok) return set;
    for (const v of dropped) { try { unlinkSync(join(this.dir(person), `${v.sha}.css`)); } catch { /* already gone */ } }
    return { ok: true, sha, previous };
  }

  /** Keep the version on trial (the person answered "Keep"). Too late, or another version: 409. */
  keep(person: string, sha: unknown): OwnerCssResult<{ active: string }> {
    if (typeof sha !== "string" || !SHA.test(sha)) return { ok: false, status: 400, error: "sha" };
    this.settle(person);
    const index = this.readIndex(person);
    if (!index.pending || index.pending.sha !== sha || this.pointer.ownerCssActive(person) !== sha) return { ok: false, status: 409, error: "not_on_trial" };
    if (!this.endTrial(person, index, "keep")) return { ok: false, status: 503, error: "prefs_unwritable" };
    return { ok: true, active: sha };
  }

  /**
   * Revert exactly this trial — the page's Revert, or its timer. Only while `sha` is still the version on trial: a trial
   * kept (or reverted, or replaced) meanwhile, on any device, is left alone (409). Never a history restore.
   */
  revertTrial(person: string, sha: unknown): OwnerCssResult<{ active: string | null }> {
    if (typeof sha !== "string" || !SHA.test(sha)) return { ok: false, status: 400, error: "sha" };
    this.settle(person);
    const index = this.readIndex(person);
    if (!index.pending || index.pending.sha !== sha || this.pointer.ownerCssActive(person) !== sha) return { ok: false, status: 409, error: "not_on_trial" };
    if (!this.endTrial(person, index, "revert")) return { ok: false, status: 503, error: "prefs_unwritable" };
    return { ok: true, active: this.pointer.ownerCssActive(person) };
  }

  /** Put a kept version back in force, or (null) none: their screens go stock. Ends any trial. */
  restore(person: string, sha: unknown): OwnerCssResult<{ active: string | null }> {
    if (sha !== null && (typeof sha !== "string" || !SHA.test(sha))) return { ok: false, status: 400, error: "sha" };
    const index = this.readIndex(person);
    if (sha !== null && !index.versions.some(v => v.sha === sha)) return { ok: false, status: 404, error: "no_such_version" };
    const set = this.pointer.setOwnerCss(person, { active: sha, trial: null });
    if (!set.ok) return set;
    if (index.pending) { const { pending: _done, ...rest } = index; void _done; this.writeIndex(person, rest); }
    return { ok: true, active: sha };
  }

  /** A picture or font for this person's CSS: png, webp, jpeg, gif or woff2; metadata stripped; ≤ 16 files, ≤ 1 MiB together. */
  addAsset(person: string, bytes: Uint8Array): OwnerCssResult<{ id: string; kind: MediaKind; bytes: number }> {
    const kind = sniffMedia(bytes);
    if (!kind || !ASSET_KINDS.has(kind)) return { ok: false, status: 400, error: "asset_type", detail: "png, webp, jpeg, gif or woff2" };
    const kept = stripMetadata(bytes, kind);
    if (!kept) return { ok: false, status: 400, error: "asset_unreadable" };
    const id = hash32(kept);
    const index = this.readIndex(person);
    const existing = index.assets.find(a => a.id === id);
    if (existing) return { ok: true, ...existing };
    if (index.assets.length >= OWNER_CSS_MAX_ASSETS) return { ok: false, status: 409, error: "asset_quota", detail: `at most ${OWNER_CSS_MAX_ASSETS} files` };
    if (index.assets.reduce((n, a) => n + a.bytes, 0) + kept.length > OWNER_CSS_MAX_ASSET_BYTES) return { ok: false, status: 413, error: "asset_quota", detail: "at most 1 MiB together" };
    mkdirSync(join(this.dir(person), "assets"), { recursive: true, mode: 0o700 });
    writeBytesAtomic(join(this.dir(person), "assets", `${id}.${MEDIA_EXT[kind]}`), kept);
    const entry = { id, kind, bytes: kept.length };
    this.writeIndex(person, { ...index, assets: [...index.assets, entry] });
    return { ok: true, ...entry };
  }

  /** Remove an asset no kept version names (a kept version must always restore whole). */
  removeAsset(person: string, id: string): OwnerCssResult<{ removed: string }> {
    const index = this.readIndex(person);
    const entry = index.assets.find(a => a.id === id);
    if (!entry) return { ok: false, status: 404, error: "no_such_asset" };
    // What a kept version names, read from its decoded tokens: url("\\61sset:<id>") names the asset as well.
    const names = (text: string | null) => {
      if (text === null) return false;
      const checked = checkOwnerCss(text, this.assetIds(index));
      return checked.ok && ownerCssAssetRefs(checked.tokens).has(id);
    };
    if (index.versions.some(v => names(this.readText(person, v.sha)))) return { ok: false, status: 409, error: "asset_in_use" };
    try { unlinkSync(join(this.dir(person), "assets", `${id}.${MEDIA_EXT[entry.kind]}`)); } catch { /* already gone */ }
    this.writeIndex(person, { ...index, assets: index.assets.filter(a => a.id !== id) });
    return { ok: true, removed: id };
  }

  /** The text to serve for one of this person's kept versions: checked again and re-serialised. null: none, or it fails. */
  served(person: string, sha: string): string | null {
    const index = this.readIndex(person);
    if (!index.versions.some(v => v.sha === sha)) return null;
    const text = this.readText(person, sha);
    if (text === null) return null;
    const checked = checkOwnerCss(text, this.assetIds(index));
    if (!checked.ok) return null;
    try { return serializeOwnerCss(checked.tokens); } catch { return null; }
  }

  asset(person: string, id: string): { bytes: Buffer; mime: string } | null {
    if (!OWNER_CSS_ASSET_ID.test(id)) return null;
    const entry = this.readIndex(person).assets.find(a => a.id === id);
    if (!entry) return null;
    try { return { bytes: readFileSync(join(this.dir(person), "assets", `${id}.${MEDIA_EXT[entry.kind]}`)), mime: MEDIA_MIME[entry.kind] }; } catch { return null; }
  }
}
