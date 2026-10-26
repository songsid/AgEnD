/**
 * #2692: agents check, upload, replace, delete and restore the Office view's skin packs, and point a stored office at
 * one — office_pack_check, office_pack_upload, office_pack_delete, office_pack_restore, office_pack_list,
 * office_set_style. Packs are everyone's (every viewer of Fleet → Org chart → Office draws them), so:
 *
 * - The `office_packs` dashboard feature (dashboard-permissions.ts; `office_pack_access` in fleet.yaml) is off unless a
 *   person switches it on for the agent; the fleet's sinks refuse the tools before they reach here.
 * - The same checks as the web upload (POST /ui/office-skins): checkSkinUpload — the page's own checkSkinPack, every
 *   picture's PNG walk and sizes, the limits (SKIN_LIMITS). The pack arrives as bytes in parts (web-office-pack-read.ts:
 *   the agent's side reads its folder); the fleet never opens a path an agent names.
 * - The stored offices' layout overrides are checked against the new pack (overrideConflicts: checkLayoutOverrides'
 *   shape is the store's, applyOverrides puts each entry on the pack) for every office whose overrides were made on it —
 *   one that no longer fits would leave PUT /ui/offices refusing every save. Refused, naming each office and rule, unless
 *   `drop_invalid_overrides`, which drops exactly those entries (and the result names them).
 * - A replace is atomic (OfficeSkinStore.put): the new version is checked and written first, then swapped in at once; on
 *   any failure the old one stays, and an offices write made for it is put back. One previous version is kept per pack.
 * - Every change is logged (who, when, which pack, file count, bytes, the manifest's and each picture's sha256), in
 *   <dataDir>/web-office-skins/.agent-changes.log (JSON lines, the newest kept), and told to the fleet's admins in one
 *   short message (`notice`), never as a sign-in.
 * - Approval (the admins' choice for the fleet, on the Office page): "apply" — at once; "approve" (the default) — the
 *   change waits as a pending change (memory only: a fleet restart drops it) until an admin approves it on the page or
 *   from the notice's buttons in General; it is judged again then.
 * - A rate limit by batch and bytes (OfficePackBatchLimiter): 20 batches and 200 MiB an hour per agent; one call is one
 *   batch, however many packs it carries. Refusals are not counted; office_pack_check and office_pack_list are not.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { t } from "./locale.js";
import { applyOverrides, type CheckedPack, type LayoutOverrides } from "./ui/fleet-office-pack.js";
import { checkSkinUpload, SKIN_DISK_BYTES, SKIN_LIMITS, type OfficeSkinStore, type SkinChecked, type SkinRecord } from "./web-office-skins.js";
import type { Office, OfficeStore } from "./web-office-store.js";
import { PACK_BATCH_LIMITS, PACK_BATCH_WIRE_BYTES } from "./web-office-pack-read.js";
import { ASSET_PART_BYTES } from "./web-asset-parts.js";
import { OfficePackDeleteArgs, OfficePackListArgs, OfficePackRestoreArgs, OfficeSetStyleArgs, validateArgs } from "./outbound-schemas.js";

const MiB = 1024 * 1024, MINUTE_MS = 60_000, HOUR_MS = 60 * MINUTE_MS;
export const OFFICE_PACK_TOOL_LIMITS = {
  batchesPerHour: 20, bytesPerHour: 200 * MiB,
  /** Pending changes waiting for an admin's yes: at most 8 in the fleet, 200 MiB of pictures, each for 24 hours. */
  pending: 8, pendingBytes: 200 * MiB, pendingMs: 24 * HOUR_MS,
  /** The log keeps its newest entries: at most this many lines once it passes 512 KiB. */
  logLines: 500, logBytes: 512 * 1024,
} as const;
export const OFFICE_PACK_APPROVALS = ["apply", "approve"] as const;
export type OfficePackApproval = typeof OFFICE_PACK_APPROVALS[number];
/** Until an admin chooses: every change waits for a yes. */
export const OFFICE_PACK_APPROVAL_DEFAULT: OfficePackApproval = "approve";
/** The built-in styles an office may be drawn in besides a kept pack (fleet-office-skin.js BUILT_IN_SKINS). */
export const BUILT_IN_STYLES = ["pixel", "studio", "cozy"] as const;
export const OFFICE_PACK_TOOLS = ["office_pack_check", "office_pack_upload", "office_pack_delete", "office_pack_restore", "office_pack_list", "office_set_style"] as const;

export type OfficePackAnswer = Record<string, unknown>;
const refuse = (error: string, message: string, extra: Record<string, unknown> = {}): OfficePackAnswer => ({ error, message, ...extra });
/** A refusal carried through the steps that may also return something else. */
type Refused = { refused: OfficePackAnswer };
const no = (error: string, message: string, extra: Record<string, unknown> = {}): Refused => ({ refused: refuse(error, message, extra) });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
export const mib = (bytes: number) => `${(bytes / MiB).toFixed(bytes < 10 * MiB ? 1 : 0)} MiB`;

// ── Layout overrides against a pack ──

/**
 * One office's override entry that does not fit a pack: `entry` is what is dropped — "seats.desks", "furniture.rack",
 * "furnitureNight.rack", one seat's reservation "seatFor.desks.0" (#2691), or "seatFor.desks" for an area's empty
 * reservation map. "overrides" (UNDROPPABLE) when the layout fails as a whole but no single entry does: never dropped.
 */
export interface OverrideConflict { office: string; name: string; entry: string; rule: string }
/** A conflict no exact drop clears: the change is refused even with drop_invalid_overrides (never a whole layout lost). */
export const UNDROPPABLE = "overrides";
export const undroppable = (conflicts: readonly OverrideConflict[]) => conflicts.some(c => c.entry === UNDROPPABLE);

/**
 * Every entry of an office's overrides, each on its own (with `pack`): one per area's seats, item's place and item's
 * night place, one per seat's reservation (seatFor.<area>.<slot>; an area's empty map is one entry too), and any other
 * key whole (the door, the walkable graph). Every key there is, not a list of kinds: a key added later is checked too.
 */
function entriesOf(ov: LayoutOverrides): Array<{ entry: string; only: LayoutOverrides }> {
  const out: Array<{ entry: string; only: LayoutOverrides }> = [], pack = ov.pack;
  const one = (entry: string, rest: Record<string, unknown>) => out.push({ entry, only: { pack, ...rest } as LayoutOverrides });
  for (const [kind, v] of Object.entries(ov as unknown as Record<string, unknown>)) {
    if (kind === "pack") continue;
    if (kind === "seatFor" && isObj(v)) {
      for (const [area, slots] of Object.entries(v)) {
        const keys = isObj(slots) ? Object.keys(slots) : [];
        if (!keys.length) one(`seatFor.${area}`, { seatFor: { [area]: slots } });
        for (const slot of keys) one(`seatFor.${area}.${slot}`, { seatFor: { [area]: { [slot]: (slots as Record<string, unknown>)[slot] } } });
      }
    } else if (isObj(v)) for (const key of Object.keys(v)) one(`${kind}.${key}`, { [kind]: { [key]: v[key] } });
    else one(kind, { [kind]: v });
  }
  return out;
}
/** `ov` with `entry` (an entriesOf one) taken out; empty maps go with it. */
function without(ov: Record<string, any>, entry: string): void {
  const [kind, key, slot] = entry.split(".") as [string, string | undefined, string | undefined];
  if (key === undefined) { delete ov[kind]; return; }
  if (!isObj(ov[kind])) return;
  if (slot !== undefined) {
    if (isObj(ov[kind][key])) { delete ov[kind][key][slot]; if (!Object.keys(ov[kind][key]).length) delete ov[kind][key]; }
  } else delete ov[kind][key];
  if (!Object.keys(ov[kind]).length) delete ov[kind];
}

/**
 * Each stored office whose overrides were made on `pack` (overrides.pack: the ones PUT /ui/offices checks against it),
 * put on it whole (applyOverrides, as that save does — every entry, the reservations too), and where that fails entry
 * by entry: what does not fit. When the entries found are dropped the rest must fit whole; if not (a rule between
 * entries), the office's conflict is UNDROPPABLE instead, and the change is refused.
 */
export function overrideConflicts(offices: readonly Office[], pack: CheckedPack): OverrideConflict[] {
  const out: OverrideConflict[] = [];
  for (const o of offices) {
    const ov = o.overrides;
    if (!ov || ov.pack !== pack.id) continue;
    const whole = applyOverrides(pack, ov);
    if (whole.ok) continue;
    const mine: OverrideConflict[] = [];
    for (const { entry, only } of entriesOf(ov)) {
      const r = applyOverrides(pack, only);
      if (!r.ok) mine.push({ office: o.id, name: o.name, entry, rule: r.error.replace(/^overrides\./, "") });
    }
    const left = JSON.parse(JSON.stringify(ov)) as Record<string, any>;
    for (const c of mine) without(left, c.entry);
    out.push(...(mine.length && applyOverrides(pack, left as LayoutOverrides).ok ? mine
      : [{ office: o.id, name: o.name, entry: UNDROPPABLE, rule: whole.error.replace(/^overrides\./, "") }]));
  }
  return out;
}
/** The offices with exactly those entries dropped (an office left with nothing but `pack` loses its overrides). An UNDROPPABLE conflict is never passed here. */
export function dropConflicts(offices: readonly Office[], conflicts: readonly OverrideConflict[]): Office[] {
  if (undroppable(conflicts)) throw new Error("dropConflicts: an undroppable conflict");
  return offices.map(o => {
    const mine = conflicts.filter(c => c.office === o.id);
    if (!mine.length || !o.overrides) return o;
    const { overrides: _gone, ...bare } = o;
    const ov = JSON.parse(JSON.stringify(o.overrides)) as Record<string, any>;
    for (const c of mine) without(ov, c.entry);
    return Object.keys(ov).some(k => k !== "pack") ? { ...o, overrides: ov as LayoutOverrides } : bare;
  });
}
/** How many dropped entries a notice names; the rest are counted. */
export const DROPS_SHOWN = 6;
/**
 * What a change drops, for its notice (an admin approving from General sees it): the count, then each office with its
 * entries — "Ops: seats.desks, furniture.rack; Den: …" — the first DROPS_SHOWN entries, "…and N more" after them.
 */
export function dropsText(conflicts: readonly OverrideConflict[]): string {
  const shown = conflicts.slice(0, DROPS_SHOWN), byOffice = new Map<string, { name: string; entries: string[] }>();
  for (const c of shown) {
    const g = byOffice.get(c.office) ?? { name: c.name || c.office, entries: [] };
    if (!g.entries.includes(c.entry)) g.entries.push(c.entry);
    byOffice.set(c.office, g);
  }
  const listed = [...byOffice.values()].map(g => `${g.name}: ${g.entries.join(", ")}`).join("; ");
  const more = conflicts.length > DROPS_SHOWN ? ` ${t("office_packs.drops_more", conflicts.length - DROPS_SHOWN)}` : "";
  return t("office_packs.drops", conflicts.length, listed + more);
}
const DROP_HINT = "Fix the pack, or send drop_invalid_overrides: true to drop exactly those entries.";
const UNDROPPABLE_HINT = "Those entries cannot be dropped one by one (the layout fails as a whole), so drop_invalid_overrides does not apply: fix the pack, or the office's layout on the Office page.";
const conflictText = (c: readonly OverrideConflict[]) => c.map(x => `office "${x.name}" (${x.office}): ${x.rule}`).join("; ");

// ── The rate limit: batches and bytes ──

/** How much one agent may change: batches and bytes an hour (accepted calls only; a monotonic clock; memory only). */
export class OfficePackBatchLimiter {
  private readonly batches = new Map<string, Array<{ t: number; bytes: number }>>();
  constructor(private readonly now: () => number = () => performance.now(),
    private readonly limits: { batchesPerHour: number; bytesPerHour: number } = OFFICE_PACK_TOOL_LIMITS) {}
  private recent(instance: string, now: number) {
    const kept = (this.batches.get(instance) ?? []).filter(b => now - b.t < HOUR_MS);
    if (kept.length) this.batches.set(instance, kept); else this.batches.delete(instance);
    return kept;
  }
  /** Whether a batch of `bytes` may go now; else the ms until it may (never: larger than the hour's budget). */
  check(instance: string, bytes: number): { ok: true } | { ok: false; retry_after_ms: number | null; why: string } {
    const now = this.now(), kept = this.recent(instance, now);
    if (bytes > this.limits.bytesPerHour) return { ok: false, retry_after_ms: null, why: `larger than the hour's budget of ${mib(this.limits.bytesPerHour)}` };
    let wait = 0;
    if (kept.length >= this.limits.batchesPerHour) wait = HOUR_MS - (now - kept[kept.length - this.limits.batchesPerHour]!.t);
    let used = kept.reduce((n, b) => n + b.bytes, 0);
    for (const b of kept) {
      if (used + bytes <= this.limits.bytesPerHour) break;
      used -= b.bytes;
      wait = Math.max(wait, HOUR_MS - (now - b.t));
    }
    return wait > 0 ? { ok: false, retry_after_ms: Math.ceil(wait), why: `at most ${this.limits.batchesPerHour} batches and ${mib(this.limits.bytesPerHour)} an hour` } : { ok: true };
  }
  record(instance: string, bytes: number): void { const now = this.now(); this.batches.set(instance, [...this.recent(instance, now), { t: now, bytes }]); }
  /** What is left of the hour's budget. */
  left(instance: string): { batches: number; bytes: number } {
    const kept = this.recent(instance, this.now());
    return { batches: Math.max(0, this.limits.batchesPerHour - kept.length), bytes: Math.max(0, this.limits.bytesPerHour - kept.reduce((n, b) => n + b.bytes, 0)) };
  }
  forget(instance: string): void { this.batches.delete(instance); }
}

// ── The parts a batch arrives in ──

interface Incoming { id: string; count: number; next: number; bytes: number; sha256: string; chunks: Buffer[]; received: number; last: number; options: Record<string, unknown> }
const PART_IDLE_MS = 60_000;
/**
 * The receiving side of web-office-pack-read.ts's parts: one unfinished batch per instance and tool, dropped after a
 * minute without a part; at most 8 at once and twice a batch's wire size in memory. The caller is the connection's
 * instance, never a field of a part; no path is ever accepted.
 */
export class OfficePackUploads {
  private readonly pending = new Map<string, Incoming>();
  constructor(private readonly clock: () => number = () => performance.now()) {}
  forget(instance: string): void { for (const k of [...this.pending.keys()]) if (k.startsWith(`${instance}\u0000`)) this.pending.delete(k); }
  accept(instance: string, tool: string, args: Record<string, unknown>): { done: false; answer: OfficePackAnswer } | { done: true; doc: unknown; options: Record<string, unknown> } {
    const key = `${instance}\u0000${tool}`, now = this.clock();
    const fail = (message: string): { done: false; answer: OfficePackAnswer } => { this.pending.delete(key); return { done: false, answer: refuse("pack_part", message) }; };
    for (const [k, p] of this.pending) if (now - p.last >= PART_IDLE_MS) this.pending.delete(k);
    if (!isObj(args)) return fail("expected a part of a pack batch");
    if (Object.hasOwn(args, "dir") || Object.hasOwn(args, "files") || Object.hasOwn(args, "manifest") || Object.hasOwn(args, "packs")) {
      return fail("the fleet takes a pack as parts of bytes, never a path or a manifest: send it through your tool (the agent's side reads the folder)");
    }
    const extra = Object.keys(args).find(k => !["data_b64", "part", "drop_invalid_overrides"].includes(k));
    if (extra !== undefined) return fail(`unknown key "${extra}"`);
    const p = args.part;
    if (typeof args.data_b64 !== "string" || args.data_b64.length > Math.ceil(ASSET_PART_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data_b64) || !isObj(p)) return fail("a part: { data_b64, part }");
    const keys = Object.keys(p).sort().join(",");
    if (keys !== "bytes,count,index,sha256" && keys !== "bytes,count,index,sha256,upload") return fail("part: { index, count, bytes, sha256, upload? }");
    const { index, count, bytes } = p as Record<string, number>;
    if (![index, count, bytes].every(Number.isSafeInteger) || typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) return fail("part: numbers and a sha256");
    if (bytes < 1 || bytes > PACK_BATCH_WIRE_BYTES || count !== Math.ceil(bytes / ASSET_PART_BYTES) || index < 0 || index >= count) return fail(`part: at most ${mib(PACK_BATCH_WIRE_BYTES)} in all, in parts of ${ASSET_PART_BYTES} bytes`);
    const chunk = Buffer.from(args.data_b64, "base64");
    if (chunk.toString("base64") !== args.data_b64 || chunk.length !== (index < count - 1 ? ASSET_PART_BYTES : bytes - index * ASSET_PART_BYTES)) return fail("part: its bytes");
    if (index === 0) {
      if (p.upload !== undefined) return fail("part 0 starts a batch");
      if (args.drop_invalid_overrides !== undefined && typeof args.drop_invalid_overrides !== "boolean") return fail("drop_invalid_overrides: true or false");
      if (!this.pending.has(key) && this.pending.size >= 8) return fail("too many batches arriving at once: try again shortly");
      this.pending.set(key, { id: randomBytes(16).toString("hex"), count, next: 0, bytes, sha256: p.sha256 as string, chunks: [], received: 0, last: now,
        options: args.drop_invalid_overrides === undefined ? {} : { drop_invalid_overrides: args.drop_invalid_overrides } });
    } else if (args.drop_invalid_overrides !== undefined) return fail("options go on part 0");
    const up = this.pending.get(key);
    if (!up || (index !== 0 && p.upload !== up.id) || index !== up.next || bytes !== up.bytes || count !== up.count || p.sha256 !== up.sha256) return fail("part: not the next part of this batch");
    if ([...this.pending.values()].reduce((n, x) => n + x.received, chunk.length) > 2 * PACK_BATCH_WIRE_BYTES) return fail("too much arriving at once: try again shortly");
    up.chunks.push(chunk); up.received += chunk.length; up.next++; up.last = now;
    if (up.next < up.count) return { done: false, answer: { upload: up.id, received: up.received } };
    this.pending.delete(key);
    const all = Buffer.concat(up.chunks);
    if (all.length !== up.bytes || sha256(all) !== up.sha256) return { done: false, answer: refuse("pack_part", "the batch's sha256 does not match") };
    try { return { done: true, doc: JSON.parse(all.toString("utf8")), options: up.options }; }
    catch { return { done: false, answer: refuse("pack_part", "the batch is not JSON") }; }
  }
}

// ── The tools ──

type Checked = Extract<SkinChecked, { ok: true }>;
/** A pending change's view (no picture bytes): the page, the notice and office_pack_list show it. */
export interface PackChangeView {
  id: string; instance: string; at: number; expires_at: number;
  action: "upload" | "delete" | "restore" | "style";
  packs: Array<{ id: string; name: string; files?: number; bytes?: number; replaces?: string | null }>;
  office?: string; style?: string; keep_previous?: boolean; drop_invalid_overrides?: boolean; drops?: OverrideConflict[];
}
interface PendingChange { view: PackChangeView; spec: ChangeSpec; bytes: number }
export interface PackLogEntry {
  at: string; by: string; action: string; pack?: string; name?: string; version?: string; files?: number; bytes?: number;
  manifest_sha256?: string; pictures?: Record<string, string>; previous_kept?: boolean; replaced_version?: string | null;
  office?: string; style?: string; dropped_overrides?: OverrideConflict[]; change?: string; approved_by?: string; approval?: string; outcome?: string;
}
export interface OfficePackToolsDeps {
  skins: OfficeSkinStore;
  offices: OfficeStore;
  /** The agents whose `office_packs` feature is on (the Office page shows them). */
  allowedAgents(): string[];
  /** Tell the fleet's admins (General): one short message; with `pending`, the change waits for their yes (buttons). */
  notice(text: string, pending?: PackChangeView): void;
  /** A pending change was decided or expired (its notice's buttons are retired with `text`). */
  settled(id: string, text: string): void;
  /** What changed, for every page: the packs' rev, the offices' rev, the agent changes (pending, approval, log). */
  changed(what: { skins?: string; offices?: number; changes?: boolean }): void;
  logger?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

export class OfficePackTools {
  readonly limiter: OfficePackBatchLimiter;
  readonly uploads: OfficePackUploads;
  private readonly pending = new Map<string, PendingChange>();
  private readonly now: () => number;
  private approvalCache: OfficePackApproval | null = null;
  constructor(private readonly deps: OfficePackToolsDeps, opts: { limiter?: OfficePackBatchLimiter; uploads?: OfficePackUploads; now?: () => number } = {}) {
    this.limiter = opts.limiter ?? new OfficePackBatchLimiter();
    this.uploads = opts.uploads ?? new OfficePackUploads();
    this.now = opts.now ?? (() => Date.now());
  }
  private get settingsPath() { return join(this.deps.skins.dir, ".agent-changes.json"); }
  private get logPath() { return join(this.deps.skins.dir, ".agent-changes.log"); }

  /** The admins' choice: "apply" (at once) or "approve" (a pending change until an admin's yes). Kept beside the packs. */
  approval(): OfficePackApproval {
    if (this.approvalCache) return this.approvalCache;
    let mode: OfficePackApproval = OFFICE_PACK_APPROVAL_DEFAULT;
    try { const d = JSON.parse(readFileSync(this.settingsPath, "utf8")); if ((OFFICE_PACK_APPROVALS as readonly string[]).includes(d?.approval)) mode = d.approval; } catch { /* the default */ }
    return (this.approvalCache = mode);
  }
  setApproval(mode: unknown, by: string): { ok: true; approval: OfficePackApproval } | { ok: false; error: string } {
    if (!(OFFICE_PACK_APPROVALS as readonly unknown[]).includes(mode)) return { ok: false, error: `approval: ${OFFICE_PACK_APPROVALS.join(" or ")}` };
    try {
      mkdirSync(this.deps.skins.dir, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(this.settingsPath, JSON.stringify({ version: 1, approval: mode }) + "\n", { mode: 0o600 });
    } catch (err) { return { ok: false, error: `not saved: ${(err as Error).message}` }; }
    this.approvalCache = mode as OfficePackApproval;
    this.log({ by, action: "approval", approval: mode as string });
    this.deps.changed({ changes: true });
    return { ok: true, approval: mode as OfficePackApproval };
  }

  /** Append one entry to the log (and the fleet log); the newest are kept once it grows past its cap. */
  private log(entry: Omit<PackLogEntry, "at">): PackLogEntry {
    const full: PackLogEntry = { at: new Date(this.now()).toISOString(), ...entry };
    try {
      mkdirSync(this.deps.skins.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.logPath, JSON.stringify(full) + "\n", { mode: 0o600 });
      if (statSync(this.logPath).size > OFFICE_PACK_TOOL_LIMITS.logBytes) {
        const lines = readFileSync(this.logPath, "utf8").split("\n").filter(Boolean).slice(-Math.floor(OFFICE_PACK_TOOL_LIMITS.logLines / 2));
        atomicWriteFileSync(this.logPath, lines.join("\n") + "\n", { mode: 0o600 });
      }
    } catch (err) { this.deps.logger?.warn({ err: (err as Error).message }, "Office pack log could not be written"); }
    this.deps.logger?.info({ ...full, pictures: undefined }, "Office pack change");
    return full;
  }
  /** The newest log entries first. */
  logEntries(limit = 20): PackLogEntry[] {
    try {
      return readFileSync(this.logPath, "utf8").split("\n").filter(Boolean).slice(-limit).reverse()
        .map(l => { try { return JSON.parse(l) as PackLogEntry; } catch { return null; } }).filter((e): e is PackLogEntry => !!e);
    } catch { return []; }
  }

  /** A version's digests: the manifest's sha256 and each picture's (its kept bytes), from the upload or from disk. */
  private digest(r: SkinRecord, pictures?: Map<string, Buffer>): { manifest_sha256: string; pictures: Record<string, string> } {
    const out: Record<string, string> = {};
    for (const [src, f] of Object.entries(r.files)) {
      let bytes = pictures?.get(f.id);
      if (!bytes) { try { bytes = readFileSync(join(this.deps.skins.dir, r.id, `${f.id}.png`)); } catch { /* gone */ } }
      out[src] = bytes ? sha256(bytes) : "";
    }
    return { manifest_sha256: sha256(JSON.stringify(r.manifest)), pictures: out };
  }
  private recordOf(id: string): SkinRecord | undefined { return this.deps.skins.records().packs.find(r => r.id === id); }

  private sweep(): void {
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (p.view.expires_at > now) continue;
      this.pending.delete(id);
      this.log({ by: p.view.instance, action: p.view.action, change: id, outcome: "expired", pack: p.view.packs[0]?.id });
      try { this.deps.settled(id, t("office_packs.expired", summaryOf(p.view))); } catch { /* the buttons expire themselves */ }
      this.deps.changed({ changes: true });
    }
  }
  /** The pending changes (all, or one agent's). */
  pendingViews(instance?: string): PackChangeView[] {
    this.sweep();
    return [...this.pending.values()].map(p => p.view).filter(v => !instance || v.instance === instance).map(v => JSON.parse(JSON.stringify(v)));
  }
  /** GET /ui/office-pack-changes: what the Office page shows an admin. */
  changes(): { approval: OfficePackApproval; agents: string[]; pending: PackChangeView[]; log: PackLogEntry[] } {
    return { approval: this.approval(), agents: [...this.deps.allowedAgents()].sort(), pending: this.pendingViews(), log: this.logEntries() };
  }

  /** The tool call, from the instance its connection (or agent token) belongs to. */
  handle(instance: string, tool: string, args: Record<string, unknown>): OfficePackAnswer {
    switch (tool) {
      case "office_pack_list": {
        const v = validateArgs(OfficePackListArgs, args ?? {}, tool);
        return v.ok ? this.list(instance) : refuse("invalid", v.error);
      }
      case "office_pack_check": case "office_pack_upload": {
        const got = this.uploads.accept(instance, tool, args ?? {});
        if (!got.done) return got.answer;
        const drop = got.options.drop_invalid_overrides === true;
        const items = this.decode(got.doc, instance);
        if (!Array.isArray(items)) return items.refused;
        return tool === "office_pack_check" ? this.check(items, drop) : this.submit(instance, { action: "upload", items, drop });
      }
      case "office_pack_delete": {
        const v = validateArgs(OfficePackDeleteArgs, args ?? {}, tool);
        return v.ok ? this.submit(instance, { action: "delete", id: v.data.id, keepPrevious: v.data.keep_previous === true }) : refuse("invalid", v.error);
      }
      case "office_pack_restore": {
        const v = validateArgs(OfficePackRestoreArgs, args ?? {}, tool);
        return v.ok ? this.submit(instance, { action: "restore", id: v.data.id, drop: v.data.drop_invalid_overrides === true }) : refuse("invalid", v.error);
      }
      case "office_set_style": {
        const v = validateArgs(OfficeSetStyleArgs, args ?? {}, tool);
        return v.ok ? this.submit(instance, { action: "style", office: v.data.office, style: v.data.pack }) : refuse("invalid", v.error);
      }
      default: return refuse("unknown_tool", `${tool} is not an Office pack tool`);
    }
  }

  private list(instance: string): OfficePackAnswer {
    const rec = this.deps.skins.records(), offices = this.deps.offices.list().offices;
    const brief = (r: SkinRecord) => ({ version: r.sha, files: Object.keys(r.files).length, bytes: r.bytes, uploaded_at: r.uploaded_at, by: r.by });
    const current = new Set(rec.packs.map(r => r.id));
    return {
      readable: rec.readable,
      packs: rec.packs.map(r => ({ id: r.id, name: r.name, ...brief(r), previous: rec.previous.has(r.id) ? brief(rec.previous.get(r.id)!) : null,
        offices: offices.filter(o => o.skin === r.id).map(o => o.id) })),
      deleted: [...rec.previous].filter(([id]) => !current.has(id)).map(([id, r]) => ({ id, name: r.name, previous: brief(r) })),
      offices: offices.map(o => ({ id: o.id, name: o.name, style: o.skin, ...(o.overrides ? { overrides_on: o.overrides.pack } : {}) })),
      built_in_styles: [...BUILT_IN_STYLES],
      approval: this.approval(),
      pending: this.pendingViews(instance),
      limits: { packs: SKIN_LIMITS.packs, files: SKIN_LIMITS.files, pack_bytes: SKIN_LIMITS.packBytes, file_bytes: SKIN_LIMITS.fileBytes, disk_bytes: SKIN_DISK_BYTES,
        batch_packs: PACK_BATCH_LIMITS.packs, batch_bytes: PACK_BATCH_LIMITS.bytes, batches_per_hour: OFFICE_PACK_TOOL_LIMITS.batchesPerHour, bytes_per_hour: OFFICE_PACK_TOOL_LIMITS.bytesPerHour },
      disk_bytes: rec.diskBytes,
      left: this.limiter.left(instance),
    };
  }

  /** The batch document, each pack checked as the web upload checks it. */
  private decode(doc: unknown, instance: string): Checked[] | Refused {
    if (!isObj(doc) || !Array.isArray(doc.packs) || !doc.packs.length || Object.keys(doc).some(k => k !== "packs")) return no("pack_invalid", "a batch: { packs: [...] }");
    if (doc.packs.length > PACK_BATCH_LIMITS.packs) return no("pack_invalid", `at most ${PACK_BATCH_LIMITS.packs} packs in one batch`);
    const items: Checked[] = [], ids = new Set<string>();
    for (const [i, body] of doc.packs.entries()) {
      const c = checkSkinUpload(body, `agent:${instance}`, this.now());
      const at = doc.packs.length > 1 ? `packs[${i}]` : "the pack";
      if (!c.ok) return no(c.error, `${at}: ${c.detail ?? c.error}`, { pack: i });
      if (ids.has(c.record.id.toLowerCase())) return no("pack_invalid", `${at}: "${c.record.id}" is in the batch twice`, { pack: i });
      ids.add(c.record.id.toLowerCase());
      items.push(c);
    }
    const total = items.reduce((n, c) => n + c.record.bytes, 0);
    if (total > PACK_BATCH_LIMITS.bytes) return no("pack_invalid", `at most ${mib(PACK_BATCH_LIMITS.bytes)} of pictures in one batch`);
    return items;
  }

  /** Whether the checked packs may go in now: the pack count, the disk budget, the offices' overrides. */
  private fit(items: readonly Checked[], drop: boolean): { ok: true; packs: Array<{ c: Checked; conflicts: OverrideConflict[]; replaces: SkinRecord | undefined }> } | { ok: false; answer: OfficePackAnswer } {
    const rec = this.deps.skins.records();
    if (!rec.readable) return { ok: false, answer: refuse("skins_unreadable", "The fleet's packs cannot be read now.") };
    const current = new Map(rec.packs.map(r => [r.id, r]));
    const added = items.filter(c => !current.has(c.record.id)).length;
    if (current.size + added > SKIN_LIMITS.packs) return { ok: false, answer: refuse("skins_quota", `at most ${SKIN_LIMITS.packs} packs: the fleet keeps ${current.size}, this adds ${added}. Delete one first.`) };
    const offices = this.deps.offices.list().offices;
    const packs = items.map(c => ({ c, conflicts: overrideConflicts(offices, c.pack), replaces: current.get(c.record.id) }));
    const bad = packs.filter(p => p.conflicts.length);
    if (bad.length && (!drop || bad.some(p => undroppable(p.conflicts)))) {
      const conflicts = bad.flatMap(p => p.conflicts.map(x => ({ pack: p.c.record.id, ...x })));
      return { ok: false, answer: refuse("overrides_invalid", `A stored office's layout overrides would no longer fit — ${bad.map(p => `${p.c.record.id}: ${conflictText(p.conflicts)}`).join(" | ")}. ${undroppable(conflicts) ? UNDROPPABLE_HINT : DROP_HINT}`, { conflicts }) };
    }
    return { ok: true, packs };
  }

  private check(items: Checked[], drop: boolean): OfficePackAnswer {
    const f = this.fit(items, drop);
    if (!f.ok) return f.answer;
    return { result: "PACK OK", packs: f.packs.map(({ c, conflicts, replaces }) => ({
      id: c.record.id, name: c.record.name, files: Object.keys(c.record.files).length, bytes: c.record.bytes, version: c.record.sha,
      replaces: replaces ? replaces.sha : null, unchanged: replaces?.sha === c.record.sha,
      offices: this.deps.offices.list().offices.filter(o => o.skin === c.record.id).map(o => o.id),
      ...(conflicts.length ? { drops: conflicts } : {}) })) };
  }

  /** A change from an agent: judged, counted, then applied at once or held for an admin's yes. */
  private submit(instance: string, change: ChangeSpec): OfficePackAnswer {
    this.sweep();
    const judged = this.judge(change);
    if ("refused" in judged) return judged.refused;
    const bytes = change.action === "upload" ? change.items.reduce((n, c) => n + c.record.bytes, 0) : 0;
    const allowed = this.limiter.check(instance, bytes);
    if (!allowed.ok) return refuse("rate_limited", `Too many pack changes (${allowed.why})${allowed.retry_after_ms === null ? "." : `; try again in ${Math.ceil(allowed.retry_after_ms / 1000)} s.`}`, { retry_after_ms: allowed.retry_after_ms, left: this.limiter.left(instance) });
    if (this.approval() === "approve") {
      if (this.pending.size >= OFFICE_PACK_TOOL_LIMITS.pending) return refuse("pending_full", `${OFFICE_PACK_TOOL_LIMITS.pending} changes already wait for an admin's yes: try again once they are decided.`);
      if ([...this.pending.values()].reduce((n, p) => n + p.bytes, bytes) > OFFICE_PACK_TOOL_LIMITS.pendingBytes) return refuse("pending_full", `${mib(OFFICE_PACK_TOOL_LIMITS.pendingBytes)} of packs already wait for an admin's yes.`);
      const at = this.now(), id = randomBytes(16).toString("hex");
      const view: PackChangeView = { id, instance, at, expires_at: at + OFFICE_PACK_TOOL_LIMITS.pendingMs, action: change.action, packs: judged.packs,
        ...(change.action === "style" ? { office: change.office, style: change.style } : {}),
        ...(change.action === "delete" ? { keep_previous: change.keepPrevious } : {}),
        ...((change.action === "upload" || change.action === "restore") && change.drop ? { drop_invalid_overrides: true } : {}),
        ...(judged.drops.length ? { drops: judged.drops } : {}) };
      this.pending.set(id, { view, spec: change, bytes });
      this.limiter.record(instance, bytes);
      this.log({ by: instance, action: change.action, change: id, outcome: "pending", ...this.logFields(change, judged.packs) });
      this.deps.notice(t("office_packs.pending", instance, summaryOf(view), Math.round(OFFICE_PACK_TOOL_LIMITS.pendingMs / HOUR_MS)), view);
      this.deps.changed({ changes: true });
      return { pending: JSON.parse(JSON.stringify(view)), message: "This change waits for a fleet admin's yes (on the Office page, or from the notice in General); it is judged again then. office_pack_list shows it while it waits." };
    }
    const r = this.apply(instance, change, null, null);
    if ("refused" in r) {
      // A batch that stopped part-way: the packs before the failure are in (each atomically) — counted and told.
      const done = Array.isArray(r.refused.applied) ? (r.refused.applied as Array<{ id: string }>) : [];
      if (done.length) {
        this.limiter.record(instance, bytes);
        this.deps.notice(t("office_packs.applied", instance, `${t("office_packs.uploaded", done.map(a => a.id).join(", "))} — ${String(r.refused.message ?? r.refused.error)}`));
      }
      return r.refused;
    }
    this.limiter.record(instance, bytes);
    this.deps.notice(t("office_packs.applied", instance, r.summary));
    return r.answer;
  }
  private logFields(change: ChangeSpec, packs: PackChangeView["packs"]): Partial<PackLogEntry> {
    return { pack: packs.map(p => p.id).join(",") || undefined, ...(change.action === "style" ? { office: change.office, style: change.style } : {}) };
  }

  /** What a change would do, or why it cannot: the packs it names (for the view), the override entries it drops. */
  private judge(change: ChangeSpec): { packs: PackChangeView["packs"]; drops: OverrideConflict[] } | Refused {
    const rec = this.deps.skins.records();
    if (!rec.readable) return no("skins_unreadable", "The fleet's packs cannot be read now.");
    const current = new Map(rec.packs.map(r => [r.id, r]));
    switch (change.action) {
      case "upload": {
        const f = this.fit(change.items, change.drop);
        if (!f.ok) return { refused: f.answer };
        return { packs: f.packs.map(({ c, replaces }) => ({ id: c.record.id, name: c.record.name, files: Object.keys(c.record.files).length, bytes: c.record.bytes, replaces: replaces?.sha ?? null })),
          drops: f.packs.flatMap(p => p.conflicts) };
      }
      case "delete": {
        const r = current.get(change.id), prev = rec.previous.get(change.id);
        if (!r && !prev) return no("skin_unknown", `The fleet keeps no pack "${change.id}" (office_pack_list lists them).`);
        if (!r && change.keepPrevious) return no("skin_unknown", `"${change.id}" is deleted already; its previous version is kept.`);
        return { packs: [{ id: change.id, name: (r ?? prev)!.name, files: Object.keys((r ?? prev)!.files).length, bytes: (r ?? prev)!.bytes }], drops: [] };
      }
      case "restore": {
        const prev = rec.previous.get(change.id), pack = this.deps.skins.previousPack(change.id);
        if (!prev || !pack) return no("skin_no_previous", `"${change.id}" has no previous version kept.`);
        if (!current.has(change.id) && current.size >= SKIN_LIMITS.packs) return no("skins_quota", `at most ${SKIN_LIMITS.packs} packs`);
        const conflicts = overrideConflicts(this.deps.offices.list().offices, pack);
        if (conflicts.length && (!change.drop || undroppable(conflicts))) return no("overrides_invalid", `A stored office's layout overrides would no longer fit the restored version — ${conflictText(conflicts)}. ${undroppable(conflicts) ? UNDROPPABLE_HINT : "Send drop_invalid_overrides: true to drop exactly those entries."}`, { conflicts });
        return { packs: [{ id: change.id, name: prev.name, files: Object.keys(prev.files).length, bytes: prev.bytes, replaces: current.get(change.id)?.sha ?? null }], drops: conflicts };
      }
      case "style": {
        const offices = this.deps.offices.list();
        const o = offices.offices.find(x => x.id === change.office);
        if (!offices.readable) return no("offices_unreadable", "The stored offices cannot be read now.");
        if (!o) return no("office", `There is no stored office "${change.office}". Stored: ${offices.offices.map(x => x.id).join(", ") || "none"}.`);
        const r = current.get(change.style);
        if (!r && !(BUILT_IN_STYLES as readonly string[]).includes(change.style)) return no("style", `"${change.style}" is neither a pack the fleet keeps nor a built-in style (${BUILT_IN_STYLES.join(", ")}).`);
        const pack = r ? this.deps.skins.pack(change.style) : null;
        const conflicts = pack ? overrideConflicts([o], pack) : [];
        if (conflicts.length) return no("overrides_invalid", `Its layout overrides do not fit "${change.style}" — ${conflictText(conflicts)}.`, { conflicts });
        return { packs: r ? [{ id: r.id, name: r.name }] : [{ id: change.style, name: change.style }], drops: [] };
      }
    }
  }

  /** Make the change (judged again first). Its answer for the agent, and a one-line summary for the notice. */
  private apply(instance: string, change: ChangeSpec, approvedBy: string | null, changeId: string | null): { answer: OfficePackAnswer; summary: string } | Refused {
    const judged = this.judge(change);
    if ("refused" in judged) return judged;
    const extra = { ...(approvedBy ? { approved_by: approvedBy } : {}), ...(changeId ? { change: changeId } : {}) };
    switch (change.action) {
      case "upload": {
        const applied: Array<Record<string, unknown>> = [];
        let skinsRev: string | undefined, officesRev: number | undefined;
        const done = (failure?: OfficePackAnswer): Refused | undefined => {
          if (skinsRev !== undefined || officesRev !== undefined) this.deps.changed({ ...(skinsRev !== undefined ? { skins: skinsRev } : {}), ...(officesRev !== undefined ? { offices: officesRev } : {}), changes: true });
          return failure ? { refused: failure } : undefined;
        };
        for (const c of change.items) {
          const before = this.deps.offices.list();
          const conflicts = overrideConflicts(before.offices, c.pack);
          if (conflicts.length && (!change.drop || undroppable(conflicts))) return done(refuse("overrides_invalid", `${c.record.id}: ${conflictText(conflicts)}`, { conflicts, applied }))!;
          let wrote: number | null = null;
          if (conflicts.length) {
            const w = this.deps.offices.replace(dropConflicts(before.offices, conflicts), before.rev, { packOf: id => (id === c.pack.id ? c.pack : this.deps.skins.pack(id)) });
            if (!w.ok) return done(refuse(w.error, `${c.record.id}: the offices could not be updated (${w.detail ?? w.error}); nothing of it was stored`, { applied }))!;
            wrote = w.rev;
          }
          const replaced = this.recordOf(c.record.id);
          const put = this.deps.skins.put(c, { replace: true });
          if (!put.ok) {
            // The pack stays as it was: so do the offices.
            if (wrote !== null) { const back = this.deps.offices.replace(before.offices, wrote, { packOf: () => null }); if (back.ok) officesRev = back.rev; }
            return done(refuse(put.error, `${c.record.id}: ${put.detail ?? put.error}; the version kept before stays`, { applied, failed: c.record.id }))!;
          }
          if (wrote !== null) officesRev = wrote;
          skinsRev = put.rev;
          const entry = this.log({ by: instance, action: replaced ? "replace" : "upload", pack: c.record.id, name: c.record.name, version: c.record.sha,
            files: Object.keys(c.record.files).length, bytes: c.record.bytes, ...this.digest(c.record, c.pictures), previous_kept: !!replaced,
            replaced_version: replaced?.sha ?? null, ...(conflicts.length ? { dropped_overrides: conflicts } : {}), ...extra });
          applied.push({ id: c.record.id, name: c.record.name, version: c.record.sha, files: entry.files, bytes: c.record.bytes, replaced: replaced?.sha ?? null,
            previous_kept: !!replaced, ...(conflicts.length ? { dropped_overrides: conflicts } : {}), manifest_sha256: entry.manifest_sha256 });
        }
        done();
        return { answer: { applied }, summary: t("office_packs.uploaded", applied.map(a => t("office_packs.upload_item", String(a.id), String(a.name), Number(Object.keys(change.items.find(c => c.record.id === a.id)!.record.files).length), mib(Number(a.bytes)))
          + (a.replaced ? ` ${t("office_packs.replaces", String(a.replaced).slice(0, 8))}` : "")
          + (Array.isArray(a.dropped_overrides) ? ` ${dropsText(a.dropped_overrides as OverrideConflict[])}` : "")).join("; ")) };
      }
      case "delete": {
        const r = this.recordOf(change.id) ?? this.deps.skins.records().previous.get(change.id)!;
        const digest = this.digest(r);
        const using = this.deps.offices.list().offices.filter(o => o.skin === change.id).map(o => o.id);
        const gone = this.deps.skins.remove(change.id, { keepPrevious: change.keepPrevious });
        if (!gone.ok) return no(gone.error, gone.detail ?? gone.error);
        this.log({ by: instance, action: "delete", pack: change.id, name: r.name, version: r.sha, files: Object.keys(r.files).length, bytes: r.bytes, ...digest, previous_kept: gone.previous_kept, ...extra });
        this.deps.changed({ skins: gone.rev, changes: true });
        return { answer: { applied: { deleted: change.id, version: r.sha, previous_kept: gone.previous_kept, offices_now_built_in: using } },
          summary: t(gone.previous_kept ? "office_packs.deleted_keep" : "office_packs.deleted", change.id) };
      }
      case "restore": {
        let wrote: number | null = null;
        const before = this.deps.offices.list();
        const pack = this.deps.skins.previousPack(change.id)!;
        if (judged.drops.length) {
          const w = this.deps.offices.replace(dropConflicts(before.offices, judged.drops), before.rev, { packOf: id => (id === pack.id ? pack : this.deps.skins.pack(id)) });
          if (!w.ok) return no(w.error, `the offices could not be updated (${w.detail ?? w.error}); nothing was restored`);
          wrote = w.rev;
        }
        const r = this.deps.skins.restore(change.id);
        if (!r.ok) {
          if (wrote !== null) { const back = this.deps.offices.replace(before.offices, wrote, { packOf: () => null }); if (back.ok) this.deps.changed({ offices: back.rev }); }
          return no(r.error, `${r.detail ?? r.error}; the version kept before stays`);
        }
        const now = this.recordOf(change.id)!;
        this.log({ by: instance, action: "restore", pack: change.id, name: now.name, version: now.sha, files: Object.keys(now.files).length, bytes: now.bytes, ...this.digest(now),
          replaced_version: r.replaced?.sha ?? null, previous_kept: !!r.replaced, ...(judged.drops.length ? { dropped_overrides: judged.drops } : {}), ...extra });
        this.deps.changed({ skins: r.rev, ...(wrote !== null ? { offices: wrote } : {}), changes: true });
        return { answer: { applied: { restored: change.id, version: now.sha, replaced: r.replaced?.sha ?? null, ...(judged.drops.length ? { dropped_overrides: judged.drops } : {}) } },
          summary: t("office_packs.restore", change.id, now.sha.slice(0, 8)) + (judged.drops.length ? ` ${dropsText(judged.drops)}` : "") };
      }
      case "style": {
        const list = this.deps.offices.list();
        const next = list.offices.map(o => (o.id === change.office ? { ...o, skin: change.style } : o));
        const w = this.deps.offices.replace(next, list.rev);
        if (!w.ok) return no(w.error, w.detail ?? w.error);
        const was = list.offices.find(o => o.id === change.office)!.skin;
        this.log({ by: instance, action: "style", office: change.office, style: change.style, pack: change.style, ...extra });
        this.deps.changed({ offices: w.rev, changes: true });
        return { answer: { applied: { office: change.office, style: change.style, was } }, summary: t("office_packs.styled", change.office, change.style) };
      }
    }
  }

  /**
   * An admin's yes or no on a pending change (the Office page, or the notice's buttons). A yes judges it again and
   * applies it; what happened is the answer (and the notice's new text).
   */
  decide(id: string, decision: "approve" | "reject", by: string): { ok: true; text: string; applied?: OfficePackAnswer } | { ok: false; status: 404 | 409; error: string; text: string } {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return { ok: false, status: 404, error: "change_unknown", text: t("office_packs.gone") };
    this.pending.delete(id);
    const spec = p.spec;
    const summary = summaryOf(p.view);
    if (decision === "reject") {
      this.log({ by: p.view.instance, action: p.view.action, change: id, outcome: "rejected", approved_by: by, pack: p.view.packs.map(x => x.id).join(",") });
      const text = t("office_packs.rejected", by, p.view.instance, summary);
      this.deps.settled(id, text);
      this.deps.changed({ changes: true });
      return { ok: true, text };
    }
    const r = this.apply(p.view.instance, spec, by, id);
    if ("refused" in r) {
      const why = String(r.refused.message ?? r.refused.error);
      this.log({ by: p.view.instance, action: p.view.action, change: id, outcome: `failed: ${why}`, approved_by: by, pack: p.view.packs.map(x => x.id).join(",") });
      const text = t("office_packs.failed", p.view.instance, summary, why);
      this.deps.settled(id, text);
      this.deps.changed({ changes: true });
      return { ok: false, status: 409, error: String(r.refused.error), text };
    }
    const text = t("office_packs.approved", by, p.view.instance, r.summary);
    this.deps.settled(id, text);
    return { ok: true, text, applied: r.answer };
  }

  forget(instance: string): void { this.limiter.forget(instance); this.uploads.forget(instance); }
}

type ChangeSpec =
  | { action: "upload"; items: Checked[]; drop: boolean }
  | { action: "delete"; id: string; keepPrevious: boolean }
  | { action: "restore"; id: string; drop: boolean }
  | { action: "style"; office: string; style: string };

/** One line for a notice: what a pending change would do. */
export function summaryOf(v: PackChangeView): string {
  const ids = v.packs.map(p => p.id).join(", ");
  switch (v.action) {
    case "upload": return t("office_packs.upload", v.packs.map(p => t("office_packs.upload_item", p.id, p.name, p.files ?? 0, mib(p.bytes ?? 0)) + (p.replaces ? ` ${t("office_packs.replaces", p.replaces.slice(0, 8))}` : "")).join("; ")
      + (v.drops?.length ? ` ${dropsText(v.drops)}` : ""));
    case "delete": return t(v.keep_previous ? "office_packs.delete_keep" : "office_packs.delete", ids);
    case "restore": return t("office_packs.restore_pending", ids) + (v.drops?.length ? ` ${dropsText(v.drops)}` : "");
    case "style": return t("office_packs.style", v.office ?? "", v.style ?? "");
  }
}
