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
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { MEDIA_EXT, MEDIA_MIME, type MediaKind, sniffMedia, stripMetadata } from "./web-image-meta.js";
import { checkOwnerCss, OWNER_CSS_ASSET_ID, ownerCssAssetRefs, serializeOwnerCss } from "./web-owner-css.js";

export const OWNER_CSS_VERSIONS = 5;
/** How long a saved version waits to be kept (the page asks for 15 s; the host allows a little more for the round trip). */
export const OWNER_CSS_KEEP_MS = 20_000;
/**
 * #2198: a version an agent saved (General, set_web_settings) waits this long for a person's page to show it. The keep
 * window above is a dead-man switch for CSS that hides its own Keep button: it starts when a page shows the trial, not
 * when the agent saves it — an agent's save reaches the person only when they open the dashboard, and their "keep it"
 * comes back through a chat round trip (~40 s). Never shown by then, it goes back without having been on any screen.
 */
export const OWNER_CSS_AGENT_WAIT_MS = 10 * 60_000;
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
  /** Optional for legacy pointer providers: no proof means unknown, never off. */
  ownerCssSelection?(person: string): { known: true; active: string | null } | { known: false };
  /** r4-5: the trial pointer, read for a transaction's snapshot. */
  ownerCssTrial?(person: string): string | null;
  setOwnerCss(person: string, change: { active?: string | null; trial?: string | null }): { ok: true } | { ok: false; status: 400 | 503; error: string };
}
/**
 * One trial: `id` is random per save, so the same text saved twice is two trials — a keep or revert names its trial,
 * never content (#1883 r2). `css.trial` holds the id, so a new trial always moves the person's revision.
 */
interface Pending { id: string; sha: string; previous: string | null; at: number; until: number; by?: "agent"; shown?: true }
/**
 * #2198: how the last trial ended — kept, reverted by someone (Revert), or expired (its window ran out). An agent's keep
 * may put back the one that just expired (as `use` of it), never one a person or agent reverted on purpose.
 */
interface LastTrial { id: string; sha: string; at: number; how: "keep" | "revert" | "expire"; shown: boolean }
interface Index { versions: Array<{ sha: string; at: number }>; assets: Array<{ id: string; kind: MediaKind; bytes: number }>; pending?: Pending; last?: LastTrial }
export interface OwnerCssState {
  /** B2 admission evidence; nullable active alone cannot distinguish missing from unreadable. */
  effectState: "off" | "on" | "unknown";
  active: string | null;
  /**
   * The active version is on trial (`id`): kept within `remaining_ms` — the host's own clock, so a device's clock never
   * stretches or shortens it — or reverted to `previous`.
   */
  pending: { id: string; sha: string; previous: string | null; remaining_ms: number; waiting?: true } | null;
  /** The active version's text as uploaded (for the editor). */
  text: string | null;
  versions: Array<{ sha: string; at: number; bytes: number }>;
  assets: Array<{ id: string; kind: MediaKind; bytes: number }>;
  limits: { maxBytes: number; maxAssets: number; maxAssetBytes: number; versions: number };
}
/** r4-5: a person's owner-CSS state as a mod import found it (opaque to callers). */
export interface OwnerCssSnapshot { index: Index; active: string | null; trial: string | null; texts: Map<string, string> }
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
  private readIndex(person: string, evidence?: { known: boolean }): Index {
    if (evidence) evidence.known = false;
    try {
      const raw = JSON.parse(readFileSync(join(this.dir(person), "index.json"), "utf8")) as Partial<Index>;
      const versions = Array.isArray(raw.versions) ? raw.versions.filter(v => v && SHA.test(String(v.sha)) && Number.isFinite(v.at)) : [];
      const assets = Array.isArray(raw.assets) ? raw.assets.filter(a => a && SHA.test(String(a.id)) && ASSET_KINDS.has(a.kind) && Number.isSafeInteger(a.bytes)) : [];
      const p = raw.pending;
      const pending = p && SHA.test(String(p.id)) && SHA.test(String(p.sha)) && (p.previous === null || SHA.test(String(p.previous))) && Number.isFinite(p.at) && Number.isFinite(p.until)
        ? { id: p.id, sha: p.sha, previous: p.previous, at: p.at, until: p.until, ...(p.by === "agent" ? { by: "agent" as const } : {}), ...(p.shown === true ? { shown: true as const } : {}) } : undefined;
      const l = raw.last;
      const last = l && SHA.test(String(l.id)) && SHA.test(String(l.sha)) && Number.isFinite(l.at) && (l.how === "keep" || l.how === "revert" || l.how === "expire") ? { id: l.id, sha: l.sha, at: l.at, how: l.how, shown: l.shown === true } : undefined;
      if (evidence) evidence.known = Array.isArray(raw.versions) && Array.isArray(raw.assets)
        && versions.length === raw.versions.length && versions.every(v => typeof v.sha === "string")
        && assets.length === raw.assets.length && assets.every(a => typeof a.id === "string" && a.bytes >= 0)
        && (raw.pending === undefined || !!pending && typeof pending.id === "string" && typeof pending.sha === "string"
          && (pending.previous === null || typeof pending.previous === "string"));
      return { versions, assets, ...(pending ? { pending } : {}), ...(last ? { last } : {}) };
    } catch (err) { if (evidence) evidence.known = (err as NodeJS.ErrnoException)?.code === "ENOENT"; return { versions: [], assets: [] }; }
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
    this.endTrial(person, index, "expire");
  }
  /**
   * End the trial in `index`: "keep" leaves its version in force; "revert" puts back the one before it (if that one is
   * still kept, else none). Either way `css.trial` is cleared in the same write, so every device hears of it.
   */
  private endTrial(person: string, index: Index, how: "keep" | "revert" | "expire"): boolean {
    const p = index.pending;
    if (!p) return false;
    const change: { active?: string | null; trial: null } = { trial: null };
    if (how !== "keep" && this.pointer.ownerCssActive(person) === p.sha) {
      change.active = p.previous && index.versions.some(v => v.sha === p.previous) ? p.previous : null;
    }
    if (!this.pointer.setOwnerCss(person, change).ok) return false;    // the pointer cannot be written: try at the next read
    const { pending: _done, ...rest } = index;
    void _done;
    // Shown: a person's own trial always was (their page saved it); an agent's once a page said so.
    this.writeIndex(person, { ...rest, last: { id: p.id, sha: p.sha, at: this.now(), how, shown: p.by !== "agent" || p.shown === true } });
    return true;
  }

  /**
   * r4-5: everything a mod import may change for this person, to put back exactly if the import fails later: the index
   * (versions, assets, a trial), both pointers, and the text of every kept version (a save may drop the oldest's file).
   */
  snapshot(person: string): OwnerCssSnapshot {
    const index = this.readIndex(person);
    const texts = new Map<string, string>();
    for (const v of index.versions) { const t = this.readText(person, v.sha); if (t !== null) texts.set(v.sha, t); }
    return { index: JSON.parse(JSON.stringify(index)) as Index, active: this.pointer.ownerCssActive(person), trial: this.pointer.ownerCssTrial?.(person) ?? null, texts };
  }
  /** Put a snapshot back: texts, index, pointers; versions and assets added since are removed. */
  restoreSnapshot(person: string, snap: OwnerCssSnapshot): OwnerCssResult<Record<never, never>> {
    const now = this.readIndex(person);
    try {
      for (const [sha, text] of snap.texts) if (this.readText(person, sha) !== text) { mkdirSync(this.dir(person), { recursive: true, mode: 0o700 }); atomicWriteFileSync(join(this.dir(person), `${sha}.css`), text, { mode: 0o600 }); }
      this.writeIndex(person, snap.index);
    } catch (err) { return { ok: false, status: 503, error: "owner_css_restore_failed", detail: (err as Error).message }; }
    const set = this.pointer.setOwnerCss(person, { active: snap.active, trial: snap.trial });
    if (!set.ok) return set;
    for (const v of now.versions) if (!snap.texts.has(v.sha)) { try { unlinkSync(join(this.dir(person), `${v.sha}.css`)); } catch { /* none */ } }
    const kept = new Set(snap.index.assets.map(a => a.id));
    for (const a of now.assets) if (!kept.has(a.id)) { try { unlinkSync(join(this.dir(person), "assets", `${a.id}.${MEDIA_EXT[a.kind]}`)); } catch { /* none */ } }
    return { ok: true };
  }

  /** The version in force (a kept one), or null — what the page links at load. */
  active(person: string): string | null {
    this.settle(person);
    const active = this.pointer.ownerCssActive(person);
    return active && this.readIndex(person).versions.some(v => v.sha === active) ? active : null;
  }

  /** Positive CSS evidence for the page; no identity fallback or change to legacy CSS save/serve behavior. */
  effectState(person: string): "off" | "on" | "unknown" {
    try {
      this.settle(person);
      const selection = this.pointer.ownerCssSelection?.(person);
      if (!selection?.known) return "unknown";
      const evidence = { known: false }, index = this.readIndex(person, evidence);
      if (!evidence.known) return "unknown";
      if (selection.active === null) return "off";
      return index.versions.some(v => v.sha === selection.active) && this.served(person, selection.active) !== null ? "on" : "unknown";
    } catch { return "unknown"; }
  }

  state(person: string): OwnerCssState {
    this.settle(person);
    const index = this.readIndex(person);
    const active = this.pointer.ownerCssActive(person);
    const kept = active && index.versions.some(v => v.sha === active) ? active : null;
    const p = index.pending, waiting = !!p && p.by === "agent" && !p.shown;
    return {
      effectState: this.effectState(person),
      active: kept,
      // #2198: an agent's trial no page has shown yet waits (`waiting`): the page that shows it says so (shown()).
      pending: p && p.sha === kept
        ? { id: p.id, sha: p.sha, previous: p.previous, remaining_ms: Math.max(0, Math.min(waiting ? OWNER_CSS_AGENT_WAIT_MS : OWNER_CSS_KEEP_MS, p.until - this.now())), ...(waiting ? { waiting: true as const } : {}) }
        : null,
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
  save(person: string, text: unknown, opts: { by?: "agent" } = {}): OwnerCssResult<{ sha: string; previous: string | null; trial: string }> {
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
    const trial = randomBytes(16).toString("hex");
    // #2198: an agent's save waits for a page to show it (OWNER_CSS_AGENT_WAIT_MS); a person's, on their page, is shown.
    const pending: Pending = opts.by === "agent" ? { id: trial, sha, previous, at, until: at + OWNER_CSS_AGENT_WAIT_MS, by: "agent" } : { id: trial, sha, previous, at, until: at + OWNER_CSS_KEEP_MS };
    this.writeIndex(person, { ...index, versions: keepList, pending });
    const set = this.pointer.setOwnerCss(person, { active: sha, trial });
    if (!set.ok) return set;
    for (const v of dropped) { try { unlinkSync(join(this.dir(person), `${v.sha}.css`)); } catch { /* already gone */ } }
    return { ok: true, sha, previous, trial };
  }

  /** The trial `id` names, while it still is the one on trial and in force; else null. */
  private trialOf(person: string, id: unknown): Index | null {
    if (typeof id !== "string" || !SHA.test(id)) return null;
    this.settle(person);
    const index = this.readIndex(person);
    return index.pending && index.pending.id === id && this.pointer.ownerCssActive(person) === index.pending.sha ? index : null;
  }

  /**
   * #2198: a page is showing this trial (its stylesheet loaded on screen). An agent's waiting trial starts its keep window
   * now — the dead-man switch, from when a person can see it. Already shown, or a person's own trial: as it is.
   */
  shown(person: string, trial: unknown): OwnerCssResult<{ remaining_ms: number; started: boolean }> {
    if (typeof trial !== "string" || !SHA.test(trial)) return { ok: false, status: 400, error: "trial" };
    const index = this.trialOf(person, trial);
    if (!index) return { ok: false, status: 409, error: "not_on_trial" };
    const p = index.pending!;
    if (p.by !== "agent" || p.shown) return { ok: true, remaining_ms: Math.max(0, Math.min(OWNER_CSS_KEEP_MS, p.until - this.now())), started: false };
    const now = this.now();
    this.writeIndex(person, { ...index, pending: { ...p, shown: true, until: now + OWNER_CSS_KEEP_MS } });
    return { ok: true, remaining_ms: OWNER_CSS_KEEP_MS, started: true };
  }

  /**
   * #2198: an agent's "keep" (the person said so in chat). The trial still on: kept. The one that just went back by
   * itself — the most recent trial, expired within OWNER_CSS_AGENT_WAIT_MS, its version still saved — is put back in
   * force, as `use` of it — if a page had shown it. One reverted on purpose (Revert), one no screen ever showed, or
   * anything else: not_on_trial (an earlier version is `use`).
   */
  keepForAgent(person: string): OwnerCssResult<{ active: string; restored: boolean }> {
    this.settle(person);
    const index = this.readIndex(person);
    if (index.pending) {
      const kept = this.keep(person, index.pending.id);
      return kept.ok ? { ok: true, active: kept.active, restored: false } : kept;
    }
    const last = index.last, now = this.now();
    // Never shown (it expired waiting): nobody saw it — it is not put in force without its keep window.
    if (last && last.how === "expire" && last.shown && now >= last.at && now - last.at <= OWNER_CSS_AGENT_WAIT_MS && index.versions.some(v => v.sha === last.sha)) {
      const r = this.restore(person, last.sha);
      if (!r.ok) return r;
      this.writeIndex(person, { ...this.readIndex(person), last: { ...last, how: "keep" } });
      return { ok: true, active: last.sha, restored: true };
    }
    return { ok: false, status: 409, error: "not_on_trial" };
  }

  /** Keep this trial (the person answered "Keep"). Too late, or another trial (even of the same text): 409. */
  keep(person: string, trial: unknown): OwnerCssResult<{ active: string }> {
    if (typeof trial !== "string" || !SHA.test(trial)) return { ok: false, status: 400, error: "trial" };
    const index = this.trialOf(person, trial);
    if (!index) return { ok: false, status: 409, error: "not_on_trial" };
    if (!this.endTrial(person, index, "keep")) return { ok: false, status: 503, error: "prefs_unwritable" };
    return { ok: true, active: index.pending!.sha };
  }

  /**
   * Revert exactly this trial — the page's Revert, or its timer. Only while it still is the trial: one kept, reverted
   * or replaced meanwhile (a new trial of the same text included), on any device, is left alone (409).
   */
  revertTrial(person: string, trial: unknown): OwnerCssResult<{ active: string | null }> {
    if (typeof trial !== "string" || !SHA.test(trial)) return { ok: false, status: 400, error: "trial" };
    const index = this.trialOf(person, trial);
    if (!index) return { ok: false, status: 409, error: "not_on_trial" };
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
