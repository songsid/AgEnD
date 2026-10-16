/** #1629 CW1 library. Single fleet owner; stages are volatile, claims durable and scoped. */
import { randomBytes, createHash } from "node:crypto";
import { constants, openSync, fstatSync, readSync, closeSync, mkdirSync, mkdtempSync, writeFileSync, fsyncSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createHook } from "node:async_hooks";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.js";
import { checkEffectEntry, type CheckedWebEffect } from "./web-effect-bundle.js";
import { effectManifestJson } from "./web-effect-canonical.js";
import { parseWebEffectManifest, type WebEffectManifest } from "./web-effect.js";
export interface EffectPrincipal {
  kind: "agent" | "human";
  id: string;
}
export interface EffectReference {
  id: string;
  holder: string;
}
export interface EffectSummary {
  id: string;
  manifest: WebEffectManifest;
  bytes: number;
}
/** Caller-scoped controls; never includes another principal or any holder. */
export interface EffectManagementSummary extends EffectSummary {
  ownClaim: boolean;
  sharedByYou: boolean;
}
export type EffectFiles = ReadonlyMap<string, Uint8Array>;
type Failure = {
  ok: false;
  error: string;
};
type WriteReceipt = {
  ok: true;
  undo: () => boolean;
};
interface Claim {
  principal: EffectPrincipal;
  holders: string[];
  uploaded: number;
  shared: boolean;
}
interface RecordRow {
  sha256: string;
  bytes: number;
  manifest: WebEffectManifest;
  paths: string[];
  claims: Claim[];
}
interface Document {
  version: 1;
  rev: number;
  entries: Record<string, RecordRow>;
}
interface Snapshot {
  document: Document;
  fingerprint: string | null;
}
export interface EffectStageSummary extends EffectSummary {
  warnings: string[];
}
interface Stage {
  principal: EffectPrincipal;
  holder: string;
  expires: number;
  ids: string[];
  entries: CheckedWebEffect[];
  bytes: number;
}
const ID = /^[0-9a-f]{32}$/;
const MOD = /^mod:[0-9a-f]{32}$/;
const PATH = /^(?:effect\.json|worker\.js|poster\.png|cursor\.png|assets\/[a-z0-9][a-z0-9_-]{0,63}\.(?:png|jpe?g|webp|gif))$/;
const INDEX_LIMIT = 4 * 1024 * 1024;
const STAGE_TTL = 10 * 60 * 1000;
const STAGE_MEMORY = 64 * 1024 * 1024;
const QUOTA_BYTES = 8 * 1024 * 1024;
const principalSchema = z.strictObject({ kind: z.enum(["agent", "human"]), id: z.string().min(1).max(256) });
const claimSchema = z.strictObject({ principal: principalSchema, holders: z.array(z.string().refine(v => v === "upload" || MOD.test(v))).min(1).max(64), uploaded: z.number().finite().nonnegative(), shared: z.boolean() });
const rowSchema = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(1).max(1024 * 1024), manifest: z.unknown(), paths: z.array(z.string().regex(PATH)).min(2).max(20), claims: z.array(claimSchema).max(256) });
const documentSchema = z.strictObject({ version: z.literal(1), rev: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), entries: z.record(z.string().regex(ID), rowSchema) });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const key = (p: EffectPrincipal): string => JSON.stringify([p.kind, p.id]);
const digest = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
const empty = (): Document => ({ version: 1, rev: 0, entries: Object.create(null) });
const fail = (error: string): Failure => ({ ok: false, error });
class StoreError extends Error {
  constructor(readonly code: string) { super(code); }
}
/** Read a regular file through one fd with a physical cap, including growth after stat. */
function boundedRead(path: string, cap: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > cap)
      throw new StoreError("file_bound");
    const buffer = Buffer.alloc(info.size + 1);
    let n = 0;
    while (n < buffer.length) {
      const got = readSync(fd, buffer, n, buffer.length - n, null);
      if (!got)
        break;
      n += got;
    }
    if (n !== info.size || fstatSync(fd).size !== info.size)
      throw new StoreError("file_changed");
    return buffer.subarray(0, n);
  }
  finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  }
  catch { /* directory fsync is best effort, as in atomic-write.ts */ }
  finally {
    if (fd !== undefined)
      closeSync(fd);
  }
}
export class WebEffectLibrary {
  readonly path: string;
  private readonly blobs: string;
  private readonly stages = new Map<string, Stage>();
  private readonly providers = new Map<string, () => Iterable<EffectReference>>();
  private busy = false;
  private readingReferences = false;
  constructor(private readonly dataDir: string, private readonly options: {
    monotonic?: () => number;
    now?: () => number;
    beforeIndexRename?: () => void;
  } = {}) {
    this.path = join(dataDir, "web-effects.json");
    this.blobs = join(dataDir, "web-effects");
  }
  private clock(): number { const value = (this.options.monotonic ?? (() => performance.now()))(); if (!Number.isFinite(value))
    throw new StoreError("clock_unavailable"); return value; }
  private now(): number { const value = (this.options.now ?? Date.now)(); if (!Number.isFinite(value) || value < 0)
    throw new StoreError("clock_unavailable"); return value; }
  private load(): Snapshot {
    let bytes: Buffer;
    try {
      bytes = boundedRead(this.path, INDEX_LIMIT);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { document: empty(), fingerprint: null };
      throw new StoreError("library_unreadable");
    }
    try {
      const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!input || typeof input !== "object" || !Object.hasOwn(input, "entries"))
        throw new Error("invalid document");
      const rows = (input as {
        entries?: unknown;
      }).entries;
      if (!rows || typeof rows !== "object" || Array.isArray(rows) || Object.keys(rows).length > 1024)
        throw new Error("index bound");
      for (const value of Object.values(rows)) {
        if (!value || typeof value !== "object")
          throw new Error("invalid row");
        const row = value as {
          claims?: unknown;
          paths?: unknown;
        };
        if (!Array.isArray(row.claims) || row.claims.length > 256 || !Array.isArray(row.paths) || row.paths.length > 20)
          throw new Error("row bound");
      }
      const decoded = documentSchema.parse(input);
      if (Object.keys(decoded.entries).length > 1024)
        throw new Error("index bound");
      const entries: Record<string, RecordRow> = Object.create(null);
      for (const [id, row] of Object.entries(decoded.entries)) {
        const manifest = parseWebEffectManifest(row.manifest);
        if (!manifest.ok || !row.sha256.startsWith(id) || new Set(row.paths).size !== row.paths.length || !row.paths.includes("effect.json") || !row.paths.includes("worker.js"))
          throw new Error("invalid entry");
        const owners = new Set<string>();
        for (const claim of row.claims) {
          const owner = key(claim.principal);
          if (owners.has(owner) || new Set(claim.holders).size !== claim.holders.length || claim.shared && claim.principal.kind !== "human")
            throw new Error("invalid claim");
          owners.add(owner);
        }
        entries[id] = { ...row, manifest: manifest.manifest };
      }
      return { document: { ...decoded, entries }, fingerprint: digest(bytes) };
    }
    catch {
      throw new StoreError("library_unreadable");
    }
  }
  private save(before: Snapshot, document: Document, validate?: () => void): Snapshot {
    if (before.document.rev >= Number.MAX_SAFE_INTEGER - 1)
      throw new StoreError("revision_exhausted");
    document.rev = before.document.rev + 1;
    const text = JSON.stringify(document) + "\n";
    if (Buffer.byteLength(text) > INDEX_LIMIT || Object.keys(document.entries).length > 1024)
      throw new StoreError("library_full");
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.path, text, { mode: 0o600, beforeRename: () => {
        this.options.beforeIndexRename?.();
        if (this.load().fingerprint !== before.fingerprint)
          throw new StoreError("library_changed");
        validate?.();
      } });
    return { document, fingerprint: digest(text) };
  }
  private sweep(): void {
    const now = this.clock(), released: string[] = [];
    for (const [id, stage] of this.stages)
      if (now >= stage.expires) {
        this.stages.delete(id);
        released.push(...stage.ids);
      }
    if (released.length)
      this.collectLater(released);
  }
  private claim(row: RecordRow, principal: EffectPrincipal): Claim | undefined { return row.claims.find(c => key(c.principal) === key(principal)); }
  private visible(row: RecordRow, principal: EffectPrincipal): boolean { return !!this.claim(row, principal) || row.claims.some(c => c.principal.kind === "human" && c.shared); }
  private quota(document: Document, entries: CheckedWebEffect[], principal: EffectPrincipal): void {
    const own = new Map(Object.entries(document.entries).filter(([, r]) => this.claim(r, principal)).map(([id, r]) => [id, r.bytes]));
    for (const entry of entries)
      own.set(entry.id, entry.bytes);
    if (own.size > 10 || [...own.values()].reduce((a, b) => a + b, 0) > QUOTA_BYTES)
      throw new StoreError("effect_quota");
  }
  private summary(id: string, row: Pick<RecordRow, "manifest" | "bytes">): EffectSummary { return { id, manifest: clone(row.manifest), bytes: row.bytes }; }
  private error(error: unknown): Failure { return fail(error instanceof StoreError ? error.code : "library_write_failed"); }
  private transaction<T>(run: () => T): T | Failure {
    if (this.busy || this.readingReferences)
      return fail("library_busy");
    this.busy = true;
    try {
      return run();
    }
    catch (error) {
      return this.error(error);
    }
    finally {
      this.busy = false;
    }
  }
  /** Host-only provider; unreadable/invalid providers never authorize deletion or reference reads. */
  registerReferenceSource(name: string, source: () => Iterable<EffectReference>): () => void {
    if (!name || name.length > 64 || typeof source !== "function" || this.providers.size >= 64 || this.providers.has(name))
      throw new Error("Duplicate reference source");
    this.providers.set(name, source);
    return () => { if (this.providers.get(name) === source)
      this.providers.delete(name); };
  }
  private references(): EffectReference[] {
    if (this.readingReferences)
      throw new StoreError("references_unreadable");
    this.readingReferences = true;
    try {
      const sources = [...this.providers], refs: EffectReference[] = [];
      for (const [, source] of sources)
        for (const ref of source()) {
          if (refs.length >= 4096 || !ref || !ID.test(ref.id) || typeof ref.holder !== "string" || ref.holder.length < 1 || ref.holder.length > 256)
            throw new Error("invalid reference");
          refs.push({ id: ref.id, holder: ref.holder });
        }
      if (sources.length !== this.providers.size || sources.some(([name, fn]) => this.providers.get(name) !== fn))
        throw new Error("provider changed");
      return refs;
    }
    catch {
      throw new StoreError("references_unreadable");
    }
    finally {
      this.readingReferences = false;
    }
  }
  private referenceKey(ids: string[], refs: EffectReference[]): string {
    return JSON.stringify(refs.filter(r => ids.includes(r.id)).map(r => JSON.stringify([r.id, r.holder])).sort());
  }
  private guardReferences(ids: string[], refs: EffectReference[]): () => void {
    const expected = this.referenceKey(ids, refs);
    return () => { if (this.referenceKey(ids, this.references()) !== expected)
      throw new StoreError("references_changed"); };
  }
  private readRow(id: string, row: RecordRow): CheckedWebEffect {
    let size = 0;
    const files = new Map<string, Uint8Array>();
    for (const path of row.paths) {
      const bytes = boundedRead(join(this.blobs, id, path), 1024 * 1024 - size);
      size += bytes.length;
      files.set(path, bytes);
    }
    const checked = checkEffectEntry(files);
    if (!checked.ok || checked.id !== id || checked.sha256 !== row.sha256 || checked.bytes !== row.bytes || effectManifestJson(checked.manifest) !== effectManifestJson(row.manifest))
      throw new StoreError("blob_unreadable");
    return checked;
  }
  private writeBlob(entry: CheckedWebEffect, existing: RecordRow | undefined): void {
    if (existing) {
      if (existing.sha256 !== entry.sha256)
        throw new StoreError("hash_conflict");
      this.readRow(entry.id, existing);
      return;
    }
    mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    // A complete orphan may be reused only after this upload supplied and validated the same full content.
    try {
      this.readRow(entry.id, { ...entry, paths: [...entry.files.keys()], claims: [] });
      return;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new StoreError("blob_conflict");
    }
    const temp = mkdtempSync(join(this.blobs, ".stage-"));
    try {
      for (const [path, bytes] of entry.files) {
        if (path.startsWith("assets/"))
          mkdirSync(join(temp, "assets"), { recursive: true, mode: 0o700 });
        const fd = openSync(join(temp, path), "wx", 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        }
        finally {
          closeSync(fd);
        }
      }
      if ([...entry.files.keys()].some(path => path.startsWith("assets/")))
        syncDirectory(join(temp, "assets"));
      syncDirectory(temp);
      renameSync(temp, join(this.blobs, entry.id));
      syncDirectory(this.blobs);
    }
    finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  /** No writes. A restart loses the stage; callers must restage and review. */
  stage(input: EffectFiles | readonly EffectFiles[], principal: EffectPrincipal, options: {
    holder?: string;
  } = {}): {
    ok: true;
    stageId: string;
    ids: string[];
    entries: EffectStageSummary[];
  } | Failure {
    return this.transaction(() => {
      if (!principalSchema.safeParse(principal).success || options.holder !== undefined && !MOD.test(options.holder))
        return fail("invalid_principal");
      this.sweep();
      const inputs = input instanceof Map ? [input] : input;
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 10)
        return fail("invalid_entries");
      let raw = 0, members = 0;
      for (const files of inputs) {
        if (++members > 10)
          return fail("invalid_entries");
        if (!(files instanceof Map) || files.size > 20)
          return fail("invalid_entries");
        let parts = 0;
        for (const bytes of files.values()) {
          if (++parts > 20 || !(bytes instanceof Uint8Array))
            return fail("invalid_entries");
          raw += bytes.byteLength;
          if (raw > QUOTA_BYTES)
            return fail("stage_too_large");
        }
      }
      const unique = new Map<string, CheckedWebEffect>(), ids: string[] = [];
      for (const files of inputs) {
        const entry = checkEffectEntry(files);
        if (!entry.ok)
          return fail("invalid_entry");
        if (unique.has(entry.id) && unique.get(entry.id)!.sha256 !== entry.sha256)
          return fail("hash_conflict");
        unique.set(entry.id, entry);
        ids.push(entry.id);
      }
      const entries = [...unique.values()], bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
      this.quota(this.load().document, entries, principal);
      if (this.stages.size >= 64 || [...this.stages.values()].filter(s => key(s.principal) === key(principal)).length >= 4 || [...this.stages.values()].reduce((sum, s) => sum + s.bytes, bytes) > STAGE_MEMORY)
        return fail("stage_full");
      const stageId = randomBytes(16).toString("hex");
      this.stages.set(stageId, { principal: clone(principal), holder: options.holder ?? "upload", expires: this.clock() + STAGE_TTL, ids, entries, bytes });
      return { ok: true, stageId, ids: [...ids], entries: ids.map(id => ({ ...this.summary(id, unique.get(id)!), warnings: [...unique.get(id)!.warnings] })) };
    });
  }
  abort(stageId: string): void { const stage = this.stages.get(stageId); this.stages.delete(stageId); if (stage)
    this.collectLater(stage.ids); }
  private undo(before: Snapshot, after: Snapshot, ids: string[], refs: EffectReference[]): () => boolean {
    let active = true;
    // Expire BEFORE the next async callback, even one queued before this receipt existed.
    // A queued expiry alone is too late for prequeued microtasks. This temporary hook
    // disables itself at the first callback (or synchronous undo), with a cleanup microtask.
    const expire = () => { active = false; boundary.disable(); };
    const boundary = createHook({ before: expire });
    boundary.enable();
    queueMicrotask(expire);
    const relevant = (rows: EffectReference[]) => this.referenceKey(ids, rows);
    return () => {
      if (!active)
        return false;
      expire();
      const result = this.transaction(() => {
        const current = this.load();
        if (current.fingerprint !== after.fingerprint || relevant(this.references()) !== relevant(refs))
          return false;
        this.save(current, clone(before.document), this.guardReferences(ids, refs));
        this.collectLater(ids);
        return true;
      });
      return result === true;
    };
  }
  commit(stageId: string): (WriteReceipt & {
    ids: string[];
    created: string[];
  }) | Failure {
    return this.transaction(() => {
      this.sweep();
      const stage = this.stages.get(stageId);
      if (!stage)
        return fail("unknown_stage");
      const before = this.load(), refs = this.references(), document = clone(before.document), created: string[] = [];
      this.quota(document, stage.entries, stage.principal);
      for (const entry of stage.entries) {
        const old = Object.hasOwn(document.entries, entry.id) ? document.entries[entry.id] : undefined;
        this.writeBlob(entry, old);
        const row = old ?? { sha256: entry.sha256, bytes: entry.bytes, manifest: clone(entry.manifest), paths: [...entry.files.keys()], claims: [] };
        let claim = this.claim(row, stage.principal);
        if (!claim) {
          claim = { principal: clone(stage.principal), holders: [], uploaded: this.now(), shared: false };
          row.claims.push(claim);
          created.push(entry.id);
        }
        if (!claim.holders.includes(stage.holder))
          claim.holders.push(stage.holder);
        if (claim.holders.length > 64 || row.claims.length > 256)
          throw new StoreError("claim_limit");
        document.entries[entry.id] = row;
      }
      const after = this.save(before, document, this.guardReferences(stage.ids, refs));
      this.stages.delete(stageId);
      return { ok: true, ids: [...stage.ids], created, undo: this.undo(before, after, stage.ids, refs) };
    });
  }
  list(principal: EffectPrincipal): {
    ok: true;
    entries: EffectSummary[];
  } | Failure {
    try {
      if (!principalSchema.safeParse(principal).success)
        return fail("invalid_principal");
      return { ok: true, entries: Object.entries(this.load().document.entries).filter(([, r]) => this.visible(r, principal)).map(([id, r]) => this.summary(id, r)) };
    }
    catch (error) {
      return this.error(error);
    }
  }
  managementList(principal: EffectPrincipal): { ok: true; entries: EffectManagementSummary[] } | Failure {
    try {
      if (!principalSchema.safeParse(principal).success || principal.kind !== "human") return fail("invalid_principal");
      return { ok: true, entries: Object.entries(this.load().document.entries).filter(([, row]) => this.visible(row, principal)).map(([id, row]) => {
        const own = this.claim(row, principal);
        return { ...this.summary(id, row), ownClaim: !!own, sharedByYou: own?.shared === true };
      }) };
    } catch (error) { return this.error(error); }
  }
  read(id: string, principal: EffectPrincipal): {
    ok: true;
    entry: CheckedWebEffect;
  } | Failure {
    try {
      if (!ID.test(id) || !principalSchema.safeParse(principal).success)
        return fail("not_found");
      const rows = this.load().document.entries;
      const row = Object.hasOwn(rows, id) ? rows[id] : undefined;
      if (!row || !this.visible(row, principal))
        return fail("not_found");
      return { ok: true, entry: this.readRow(id, row) };
    }
    catch {
      return fail("not_found");
    }
  }
  /** Internal: caller first authorizes its own resource. Knowing an id/holder is never a route capability. */
  readReferenced(id: string, holder: string): {
    ok: true;
    entry: CheckedWebEffect;
  } | Failure {
    try {
      if (!ID.test(id) || !this.references().some(r => r.id === id && r.holder === holder))
        return fail("not_found");
      const rows = this.load().document.entries;
      if (!Object.hasOwn(rows, id))
        return fail("not_found");
      return { ok: true, entry: this.readRow(id, rows[id]) };
    }
    catch {
      return fail("not_found");
    }
  }
  setShared(id: string, principal: EffectPrincipal, shared: boolean): {
    ok: true;
  } | Failure {
    return this.transaction(() => {
      if (!ID.test(id) || !principalSchema.safeParse(principal).success || principal.kind !== "human" || typeof shared !== "boolean")
        return fail("not_found");
      const before = this.load(), document = clone(before.document), row = document.entries[id];
      const claim = row && this.claim(row, principal);
      if (!claim)
        return fail("not_found");
      claim.shared = shared;
      this.save(before, document);
      return { ok: true };
    });
  }
  /** Explicit normal delete removes this principal's whole unused claim, including orphan mod holders. */
  deleteClaim(id: string, principal: EffectPrincipal): {
    ok: true;
  } | Failure {
    return this.transaction(() => {
      this.sweep();
      if (!ID.test(id) || !principalSchema.safeParse(principal).success)
        return fail("not_found");
      const before = this.load(), document = clone(before.document), row = document.entries[id], claim = row && this.claim(row, principal);
      if (!claim)
        return fail("not_found");
      const refs = this.references();
      if (refs.some(r => r.id === id) || [...this.stages.values()].some(s => s.ids.includes(id)))
        return fail("effect_in_use");
      row.claims = row.claims.filter(c => c !== claim);
      this.save(before, document, this.guardReferences([id], refs));
      this.collectLater([id]);
      return { ok: true };
    });
  }
  /** Host-only mod uninstall. Never releases a direct upload or another holder/principal. */
  releaseHolder(holder: string, principal: EffectPrincipal): (WriteReceipt & {
    released: string[];
  }) | Failure {
    return this.transaction(() => {
      if (!MOD.test(holder) || !principalSchema.safeParse(principal).success)
        return fail("invalid_principal");
      const before = this.load(), refs = this.references(), document = clone(before.document), released: string[] = [];
      for (const [id, row] of Object.entries(document.entries)) {
        const claim = this.claim(row, principal);
        if (!claim?.holders.includes(holder))
          continue;
        claim.holders = claim.holders.filter(h => h !== holder);
        row.claims = row.claims.filter(c => c.holders.length > 0);
        released.push(id);
      }
      const after = this.save(before, document, this.guardReferences(released, refs));
      this.collectLater(released);
      return { ok: true, released, undo: this.undo(before, after, released, refs) };
    });
  }
  /** Host-only notification after a placement/reference is removed; never a caller capability. */
  collectUnreferenced(ids: readonly string[]): void {
    if (ids.length > 4096 || ids.some(id => !ID.test(id)))
      throw new Error("Invalid collection ids");
    this.collectLater([...new Set(ids)]);
  }
  private collectLater(ids: string[]): void {
    queueMicrotask(() => {
      this.transaction(() => {
        this.sweep();
        const before = this.load(), refs = this.references(), document = clone(before.document), gone: string[] = [];
        let changed = false;
        for (const id of new Set(ids)) {
          const row = document.entries[id];
          if (row?.claims.length || refs.some(r => r.id === id) || [...this.stages.values()].some(s => s.ids.includes(id)))
            continue;
          if (row) {
            delete document.entries[id];
            changed = true;
          }
          gone.push(id);
        }
        if (changed)
          this.save(before, document, this.guardReferences(gone, refs));
        for (const id of gone) {
          try {
            rmSync(join(this.blobs, id), { recursive: true, force: true });
          }
          catch { /* unreferenced debris has no authority */ }
        }
      });
    });
  }
}
/** r4-5 uses this structural interface; it need not depend on the concrete store in tests. */
export type EffectLibraryParticipant = Pick<WebEffectLibrary, "stage" | "commit" | "abort" | "read" | "readReferenced" | "releaseHolder" | "registerReferenceSource">;
