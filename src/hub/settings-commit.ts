/**
 * M-2682: the one writer for a sealed Hub setting changed after initialization (agreed with Cairn, cid-m2687-settings-commit).
 *
 * The hub.* block is sealed: the initialization manifest signs its normalized digest (init/plan-digest.ts) with the Hub's
 * issuer key, and every mount re-checks the pair (mount.ts). A setting written to fleet.yaml alone makes the Hub hold, so a
 * change goes through here: the new block and a new manifest, signed by the same issuer key, committed as one unit.
 *
 * - An operation names exactly what it changes; there is no generic reseal. `rename` sets/clears hub.name (absent, not blank).
 *   The internal, opt-in directory-v2 participant below changes only directory settings and the opaque bind file. Its route
 *   proof, production composition and UI are not exposed yet. Neither op changes issuer keys, hubId, origins or certificates.
 * - `prepare` validates and returns a redacted summary and an opaque reference, bound to the session and person that asked,
 *   to the exact old image (the sealed digest and the manifest bytes) and to a short expiry. Nothing is written.
 * - `commit` runs with no await from its first check to publication (the fleet's config save is synchronous too), so no other
 *   save, reload or Hub apply can see half of it inside this process. Across a crash, a journal carries it:
 *     prepared  — the staged manifest and receipt are written and fsynced; nothing in force has changed.
 *     committed — the commit point: the old image was re-read and matched, the session and person were re-checked.
 *     (install the manifest, then save hub.* through the fleet's own writer; then the pair is verified)
 *     done      — the receipt is kept; the staged files and the journal are removed.
 *   `recover()` (before any Hub apply): prepared → drop the staged files, the old pair is untouched; committed → finish each
 *   file that is still old, keep each that is new, and refuse — overwriting nothing — any file that is neither.
 * - Provenance: the v1 manifest's schema is unchanged. A versioned receipt (hub/settings-receipts/<id>.json) records the
 *   operation, who, the request and both digests; the manifest's confirmationId is the receipt's hash, so the issuer
 *   signature binds it. It never stands for the host owner's initialization confirmation.
 * - Directory-v2 preserves rename v1. Its ONLY decision is settings-directory-decision.ts's root SQL COMMIT (including
 *   floor/version, binding, sessions, audit and complete security notices). Its file phase is recovery progress only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";
import { hubPlanDigest } from "./init/plan-digest.js";
import { sealHubInitialization, verifyHubInitialization } from "./initialization.js";
import { ensurePrivateDirectory, privatePath, readPrivateFile } from "./private-files.js";
import { personKeyString } from "./identity.js";
import type { PersonKey } from "./types.js";
import { BIND_PASSWORD_REF, BIND_SECRET_REL } from "./init/layout.js";
import { resolveDirectoryConfig, type HubDirectoryConfig } from "./directory/config.js";
import { canonicalArguments } from "./identity.js";
import { scalarString } from "./validation.js";
import type { HubDirectorySessionRotation } from "./session-directory-transition.js";
import type { HubDirectoryDecisionRequest, HubDirectorySettingsDecision, HubDirectorySettingsImage, HubDirectorySettingsOperation } from "./settings-directory-decision.js";
import { parseHubDirectoryDecisionMetadata } from "./settings-directory-decision.js";

export const SETTINGS_JOURNAL = "hub/settings-journal.json";
export const SETTINGS_STAGED = "hub/settings-staged";
export const SETTINGS_RECEIPTS = "hub/settings-receipts";
const MANIFEST = "hub/init-manifest.json";
/** The same rule as the initializer's Hub name: 1–64 characters, no control characters, no blanks around it. */
export const HUB_NAME_RULE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const PREPARED_MS = 5 * 60_000;
const MAX_PREPARED = 32;
const currentProof = (check: () => boolean): boolean => {
  const result: unknown = check();
  if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
    try { (result as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refuse either way */ }
    return false;
  }
  return result === true;
};

export type HubSettingsOp = { kind: "rename"; name: string | null };
/** Who asks, as the caller's fresh authority check returned it. */
export interface HubSettingsActor { person: PersonKey; sessionId: string; requestId: string }
export type HubSettingsSummary = { field: "name"; from: string | null; to: string | null };
export type HubSettingsRefusal = "invalid" | "unchanged" | "unavailable" | "stale" | "expired" | "denied" | "busy";
export class HubSettingsError extends Error {
  constructor(readonly code: HubSettingsRefusal | "recovery", detail?: string) { super(detail ?? code); this.name = "HubSettingsError"; }
}

export interface HubSettingsWriterDeps {
  /** The AgEnD home holding hub/ (the Hub's keys and manifest). */
  home: string;
  /** The hub.* block in force (the fleet's raw configuration), read fresh on every call. */
  readHub(): unknown;
  /** Writes hub.* changes through the fleet's own configuration writer, synchronously; throws when it refuses. */
  saveHub(patches: Array<{ path: string[]; value?: unknown; remove?: true }>): void;
  now?(): number;
  /** Tests only: called after each journal step, to stop there as a crash would. */
  step?(name: "staged" | "committed" | "manifest" | "config" | "done" | "directory-decision" | "directory-secret"): void;
  /** Directory-v2 only: the existing Hub DB/floor/audit decision. Absent keeps every directory method unexposed. */
  directoryDecision?: () => HubDirectorySettingsDecision | null;
}

interface Prepared { op: HubSettingsOp; person: string; sessionId: string; oldDigest: string; newDigest: string; manifestSha: string; expiresAt: number }
interface Journal {
  v: 1; id: string; op: "rename"; phase: "prepared" | "committed" | "done";
  old: { digest: string; manifestSha: string }; new: { digest: string; manifestSha: string; name: string | null };
}
interface DirectoryJournal { v: 2; id: string; op: "directory"; phase: "prepared" | "installing" | "done" }
export interface HubDirectorySettingsCandidate {
  directory: HubDirectoryConfig;
  /** Omitted retains the old secret ONLY for the same URL, trust and bind identity. Never returned. */
  bindPassword?: string;
  changes: HubDirectoryDecisionRequest["changes"];
  recipients: HubDirectoryDecisionRequest["recipients"];
}
type DirectoryActor = HubDirectoryDecisionRequest["actor"];
interface PreparedDirectory {
  actor: DirectoryActor; expected: HubDirectoryDecisionRequest["expected"]; before: HubDirectorySettingsImage;
  next: Record<string, unknown>; secret: string; generation: string;
  changes: HubDirectoryDecisionRequest["changes"]; recipients: HubDirectoryDecisionRequest["recipients"];
  createdAt: number; expiresAt: number;
  recoveryDeadline?: number;
}
export interface HubDirectorySettingsWriter {
  /** Internal only: caller proves old-directory recent auth/D3, same immutable candidate admin, GUIDs and trust consent. */
  prepare(candidate: HubDirectorySettingsCandidate, actor: DirectoryActor, current: () => boolean): { ref: string; expiresAt: number };
  commit(ref: string, actor: DirectoryActor, current: () => boolean, rotation?: HubDirectorySessionRotation, recoveryDeadline?: number): { receiptId: string; directoryEpoch: number };
  /** Only the exact prior-content intent preauthorized by the original operation; never an old session/role.
   * An optional orchestration deadline is checked by the writer's final clock, not just before an await. */
  compensate(originalId: string, currentIntent: (original: HubDirectorySettingsOperation) => boolean, expiresAt?: number): { receiptId: string; directoryEpoch: number };
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * A name as an administrator sent it: `null` clears it (the key absent); a string is trimmed and must then pass the
 * initializer's rule. A blank string is refused, not taken as a clear: clearing is its own explicit choice.
 */
export function hubNameInput(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new HubSettingsError("invalid", "name");
  const name = raw.trim();
  if (!HUB_NAME_RULE.test(name)) throw new HubSettingsError("invalid", "name");
  return name;
}
/** The name in force: a present name is a string; absent is null (the plain brand). */
export const currentHubName = (hub: unknown): string | null => (typeof obj(hub).name === "string" && obj(hub).name ? (obj(hub).name as string) : null);

export interface HubSettingsWriter {
  prepare(op: HubSettingsOp, actor: HubSettingsActor): { ref: string; summary: HubSettingsSummary; expiresAt: number };
  commit(ref: string, actor: HubSettingsActor, current: () => boolean): { receiptId: string; summary: HubSettingsSummary };
  /** Before any Hub apply: finishes or rolls back an interrupted commit. Throws `recovery` when a file is neither. */
  recover(): void;
  /** A journal is present: an interrupted commit waits for recover(). */
  pending(): boolean;
  /** Read/validate the existing journal without exposing its private material. */
  pendingDirectory(): boolean;
  directory?: HubDirectorySettingsWriter;
}

/** Internal material projection shared by the writer and its mount barrier; not a browser DTO or an authority proof. */
export function hubDirectorySettingsImage(hub: unknown, manifest: string, secret: string): HubDirectorySettingsImage {
  return { configDigest: hubPlanDigest(hub), configSha: sha(canonical(hub)), directorySha: sha(canonical(obj(hub).directory)),
    manifestSha: sha(manifest), bindSecretSha: sha(secret) };
}

/** Fixed private files only. Callers still verify the seal and the authoritative SQL head before admission. */
export function readHubDirectorySettingsImage(home: string, hub: unknown): HubDirectorySettingsImage {
  if (obj(obj(hub).directory).bindPasswordRef !== BIND_PASSWORD_REF) throw new HubSettingsError("unavailable");
  return hubDirectorySettingsImage(hub, readPrivateFile(home, MANIFEST, 64 * 1024, { preserveBom: true }),
    readPrivateFile(home, BIND_SECRET_REL, 4096, { preserveBom: true }));
}

export function createHubSettingsWriter(deps: HubSettingsWriterDeps): HubSettingsWriter {
  const now = deps.now ?? Date.now;
  const prepared = new Map<string, Prepared>();
  const preparedDirectory = new Map<string, PreparedDirectory>();
  const step = (name: Parameters<NonNullable<HubSettingsWriterDeps["step"]>>[0]) => deps.step?.(name);
  const file = (suffix: string) => join(deps.home, suffix);
  const writePrivate = (dir: string, suffix: string, content: string) => {
    ensurePrivateDirectory(deps.home, dir);
    atomicWriteFileSync(file(suffix), content, { mode: 0o600 });
    privatePath(deps.home, suffix);   // refuses a file that is not private, the owner's, a plain file
  };
  const readManifest = (): string => readFileSync(privatePath(deps.home, MANIFEST), "utf8");
  /** The pair in force verifies against its own digest; returns the image a change is bound to. */
  const image = () => {
    const hub = obj(deps.readHub());
    if (hub.enabled !== true || typeof hub.hubId !== "string" || typeof hub.memberOrigin !== "string") throw new HubSettingsError("unavailable");
    const digest = hubPlanDigest(hub), manifest = readManifest();
    let confirmationId: string;
    try { ({ confirmationId } = verifyHubInitialization({ home: deps.home, hubId: hub.hubId, memberOrigin: hub.memberOrigin, planDigest: digest })); }
    catch { throw new HubSettingsError("unavailable", "the Hub's sealed settings do not verify"); }
    return { hub, digest, manifest, manifestSha: sha(manifest), confirmationId };
  };
  const readJournal = (): Journal | DirectoryJournal | null => {
    if (!existsSync(file(SETTINGS_JOURNAL))) return null;
    const j = JSON.parse(readFileSync(privatePath(deps.home, SETTINGS_JOURNAL), "utf8")) as Journal | DirectoryJournal;
    if (j?.v === 2 && j.op === "directory" && ["prepared", "installing", "done"].includes(j.phase)
      && typeof j.id === "string" && /^[0-9a-f-]{36}$/.test(j.id) && Object.keys(j).sort().join() === "id,op,phase,v") return j;
    if (j?.v !== 1 || j.op !== "rename" || !["prepared", "committed", "done"].includes(j.phase) || typeof j.id !== "string" || !/^[0-9a-f-]{36}$/.test(j.id)) {
      throw new HubSettingsError("recovery", "the settings journal is unreadable");
    }
    return j;
  };
  const writeJournal = (j: Journal | DirectoryJournal) => writePrivate("hub", SETTINGS_JOURNAL, `${JSON.stringify(j, null, 2)}\n`);
  const staged = (id: string, kind: "manifest" | "receipt") => `${SETTINGS_STAGED}/${id}.${kind}.json`;
  const finish = (j: Journal) => {
    // The receipt is kept with the others; then nothing of this commit is left to recover.
    const receipt = readFileSync(privatePath(deps.home, staged(j.id, "receipt")), "utf8");
    writePrivate(SETTINGS_RECEIPTS, `${SETTINGS_RECEIPTS}/${j.id}.json`, receipt);
    writeJournal({ ...j, phase: "done" }); step("done");
    cleanup(j.id);
  };
  const cleanup = (id: string) => {
    for (const kind of ["manifest", "receipt"] as const) rmSync(file(staged(id, kind)), { force: true });
    rmSync(file(SETTINGS_JOURNAL), { force: true });
  };
  const namePatch = (name: string | null) => [name === null ? { path: ["hub", "name"], remove: true as const } : { path: ["hub", "name"], value: name }];

  // Directory-v2 is an operation of THIS writer. The optional SQL participant decides; these routines alone install files.
  const decision = () => {
    const d = deps.directoryDecision?.();
    if (!d) throw new HubSettingsError("unavailable");
    if (d.hubId !== obj(deps.readHub()).hubId) throw new HubSettingsError("unavailable", "the directory decision belongs to another Hub");
    return d;
  };
  const flushDirectory = (dir: string) => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
  const writeDirectoryPrivate = (dir: string, suffix: string, content: string) => {
    writePrivate(dir, suffix, content);
    // Unlike the shared atomic helper's best-effort directory flush, staging must report durability failure.
    flushDirectory(dirname(file(suffix))); flushDirectory(file("hub")); flushDirectory(deps.home);
  };
  const writeDirectoryJournal = (j: DirectoryJournal) => writeDirectoryPrivate("hub", SETTINGS_JOURNAL, `${JSON.stringify(j, null, 2)}\n`);
  const directoryFile = (id: string, role: string) => `${SETTINGS_STAGED}/${id}.directory-${role}`;
  const readDirectoryFile = (id: string, role: string, limit = 1024 * 1024) => readPrivateFile(deps.home, directoryFile(id, role), limit, { preserveBom: true });
  const readSecret = () => readPrivateFile(deps.home, BIND_SECRET_REL, 4096, { preserveBom: true });
  const directoryImage = (hub: unknown = deps.readHub(), manifest = readManifest(), secret = readSecret()): HubDirectorySettingsImage =>
    hubDirectorySettingsImage(hub, manifest, secret);
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  const removeDirectoryPreparation = (id: string) => {
    for (const role of ["old-hub", "new-hub", "old-secret", "new-secret", "old-manifest", "new-manifest", "receipt"]) rmSync(file(directoryFile(id, role)), { force: true });
    rmSync(file(SETTINGS_JOURNAL), { force: true });
  };
  const finishDirectory = (j: DirectoryJournal): { receiptId: string; directoryEpoch: number } | null => {
    const d = decision(), op = d.lookup(j.id); // an unreadable/advanced floor throws; it NEVER means "no decision"
    if (!op) { removeDirectoryPreparation(j.id); return null; }
    const assertHead = () => { if (d.inspect().operationId !== op.id) throw new HubSettingsError("recovery", "a newer settings operation is in force"); };
    assertHead();
    const oldHub = JSON.parse(readDirectoryFile(j.id, "old-hub")), nextHub = JSON.parse(readDirectoryFile(j.id, "new-hub"));
    const oldSecret = readDirectoryFile(j.id, "old-secret", 4096), nextSecret = readDirectoryFile(j.id, "new-secret", 4096);
    const oldManifest = readDirectoryFile(j.id, "old-manifest"), nextManifest = readDirectoryFile(j.id, "new-manifest"), receipt = readDirectoryFile(j.id, "receipt");
    if (!same(directoryImage(oldHub, oldManifest, oldSecret), op.before) || !same(directoryImage(nextHub, nextManifest, nextSecret), op.after)
      || sha(receipt) !== op.receiptSha || !same({ ...oldHub, directory: undefined }, { ...nextHub, directory: undefined })) throw new HubSettingsError("recovery", "the staged directory image changed");
    const current = directoryImage();
    // Judge ALL files before the first write. Mixed old/new is resumable; any third image is not ours to overwrite.
    if (Object.keys(current).some(k => current[k as keyof typeof current] !== op.before[k as keyof typeof current]
      && current[k as keyof typeof current] !== op.after[k as keyof typeof current])) throw new HubSettingsError("recovery", "directory settings changed outside this operation");
    writeDirectoryJournal({ ...j, phase: "installing" });
    assertHead();
    if (current.bindSecretSha !== op.after.bindSecretSha) writeDirectoryPrivate("hub/secrets", BIND_SECRET_REL, nextSecret);
    step("directory-secret");
    assertHead();
    if (current.manifestSha !== op.after.manifestSha) writeDirectoryPrivate("hub", MANIFEST, nextManifest);
    step("manifest");
    assertHead();
    if (current.configSha !== op.after.configSha) {
      deps.saveHub([{ path: ["hub", "directory"], value: nextHub.directory }]); flushDirectory(deps.home);
    }
    step("config");
    assertHead();
    if (!same(directoryImage(), op.after)) throw new HubSettingsError("recovery", "the installed directory image differs from the decision");
    image(); // same issuer/identity, actual installed seal; no browser authority is published here
    writeDirectoryPrivate(SETTINGS_RECEIPTS, `${SETTINGS_RECEIPTS}/${j.id}.json`, receipt);
    writeDirectoryJournal({ ...j, phase: "done" }); step("done");
    rmSync(file(SETTINGS_JOURNAL), { force: true });
    // Keep the exact private preimages for the original operation's bounded forward compensation, never an old DB.
    return { receiptId: op.id, directoryEpoch: op.directoryEpoch };
  };
  const installDirectory = (p: PreparedDirectory, current: () => boolean, original?: HubDirectorySettingsOperation, rotation?: HubDirectorySessionRotation) => {
    const checkTime = () => {
      const t = now();
      if (!Number.isSafeInteger(t) || t < p.createdAt || t >= p.expiresAt) throw new HubSettingsError("denied");
      return t;
    };
    const check = () => {
      checkTime();
      if (!currentProof(current)) throw new HubSettingsError("denied");
      image();
      if (!same(directoryImage(), p.before)) throw new HubSettingsError("stale");
    };
    if (pending()) throw new HubSettingsError("busy");
    check(); image();
    const id = randomUUID(), at = now(), oldHub = structuredClone(obj(deps.readHub())), oldSecret = readSecret(), oldManifest = readManifest();
    const nextDigest = hubPlanDigest(p.next);
    const receipt = { v: 2, kind: "agend-hub-settings-receipt", id, op: original ? "directory-compensation" : "directory", compensates: original?.id ?? null,
      actor: p.actor, at, oldDigest: p.before.configDigest, newDigest: nextDigest, expected: p.expected,
      ...(p.recoveryDeadline === undefined ? {} : { recovery: { v: 1 as const, expiresAt: p.recoveryDeadline } }) };
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`, committedAt = new Date(at).toISOString(), confirmationId = sha(canonical(receipt)).slice(0, 32);
    const signature = sealHubInitialization({ home: deps.home, planDigest: nextDigest, confirmationId, committedAt });
    const manifest = `${JSON.stringify({ v: 1, hubId: oldHub.hubId, planDigest: nextDigest, committedAt, confirmationId, signature }, null, 2)}\n`;
    const after = directoryImage(p.next, manifest, p.secret);
    for (const [role, text] of Object.entries({ "old-hub": JSON.stringify(oldHub), "new-hub": JSON.stringify(p.next), "old-secret": oldSecret,
      "new-secret": p.secret, "old-manifest": oldManifest, "new-manifest": manifest, receipt: receiptText })) writeDirectoryPrivate(SETTINGS_STAGED, directoryFile(id, role), text);
    const journal: DirectoryJournal = { v: 2, id, op: "directory", phase: "prepared" };
    writeDirectoryJournal(journal); step("staged");
    const request: HubDirectoryDecisionRequest = { id, expected: p.expected, before: p.before, after, generation: p.generation,
      receiptSha: sha(receiptText), actor: p.actor, at, changes: p.changes, recipients: p.recipients,
      ...(p.recoveryDeadline === undefined ? {} : { recovery: { v: 1 as const, expiresAt: p.recoveryDeadline } }) };
    const decisionCheck = () => {
      check();
      if (!same(directoryImage(JSON.parse(readDirectoryFile(id, "old-hub")), readDirectoryFile(id, "old-manifest"), readDirectoryFile(id, "old-secret", 4096)), p.before)
        || !same(directoryImage(JSON.parse(readDirectoryFile(id, "new-hub")), readDirectoryFile(id, "new-manifest"), readDirectoryFile(id, "new-secret", 4096)), after)
        || sha(readDirectoryFile(id, "receipt")) !== request.receiptSha) throw new HubSettingsError("stale");
      // Proof and material checks may cross either bound; fence the callback-free SQL transition with a fresh sample.
      return checkTime(); // the session participant shares this FINAL writer-owned sample
    };
    try {
      if (original) decision().compensate(original.id, request, decisionCheck); else decision().decide(request, decisionCheck, rotation);
    } catch (error) {
      try { if (!decision().lookup(id)) removeDirectoryPreparation(id); } catch { /* uncertainty keeps the index and private material */ }
      throw error;
    }
    step("directory-decision");
    return finishDirectory(journal)!;
  };
  const directoryWriter: HubDirectorySettingsWriter = {
    prepare(candidate, actor, current) {
      const metadata = parseHubDirectoryDecisionMetadata({ actor, changes: candidate.changes, recipients: candidate.recipients });
      const cfg = structuredClone(candidate.directory), nextDirectory = resolveDirectoryConfig(cfg), old = image(), oldCfg = obj(old.hub.directory);
      const oldSecret = readSecret(), before = directoryImage(old.hub, old.manifest, oldSecret);
      if (metadata.actor.kind === "hub-administrator" && !same(metadata.actor.person, old.hub.administrator)) throw new HubSettingsError("denied");
      if (oldCfg.bindPasswordRef !== BIND_PASSWORD_REF || cfg.bindPasswordRef !== undefined && cfg.bindPasswordRef !== BIND_PASSWORD_REF
        || nextDirectory.realm !== oldCfg.realm || nextDirectory.profile !== oldCfg.profile) throw new HubSettingsError("invalid");
      const next = { ...old.hub, directory: { ...cfg, bindPasswordRef: BIND_PASSWORD_REF } };
      if (Buffer.byteLength(canonical(next)) > 1024 * 1024) throw new HubSettingsError("invalid");
      let secret = candidate.bindPassword;
      if (secret === undefined) {
        if (cfg.url !== oldCfg.url || cfg.caPem !== oldCfg.caPem || cfg.bindDn !== oldCfg.bindDn) throw new HubSettingsError("invalid");
        secret = oldSecret;
      }
      if (typeof secret !== "string" || !secret || Buffer.byteLength(secret) > 4096 || !scalarString(secret)) throw new HubSettingsError("invalid");
      if (!currentProof(current)) throw new HubSettingsError("denied");
      if (!same(directoryImage(), before)) throw new HubSettingsError("stale");
      const d = decision(), expected = d.inspect();
      if (same(next, old.hub) && sha(secret) === before.bindSecretSha) throw new HubSettingsError("unchanged");
      const generation = sha(canonicalArguments({ v: 1, realm: nextDirectory.realm, url: nextDirectory.url, profile: nextDirectory.profile,
        baseDn: nextDirectory.baseDn, bindDn: nextDirectory.bindDn, loginAttribute: nextDirectory.loginAttribute,
        userFilter: nextDirectory.userFilter, caSha256: nextDirectory.caPem === undefined ? null : sha(nextDirectory.caPem) }));
      const t = now();
      for (const [key, value] of preparedDirectory) if (value.expiresAt <= t) preparedDirectory.delete(key);
      if (preparedDirectory.size >= MAX_PREPARED) throw new HubSettingsError("busy");
      const ref = randomBytes(24).toString("base64url"), expiresAt = t + PREPARED_MS;
      preparedDirectory.set(ref, { ...metadata, before, expected, next: structuredClone(next), secret, generation, createdAt: t, expiresAt });
      return { ref, expiresAt };
    },
    commit(ref, actor, current, rotation, recoveryDeadline) {
      const p = preparedDirectory.get(ref); preparedDirectory.delete(ref);
      if (!p) throw new HubSettingsError("expired");
      const fresh = parseHubDirectoryDecisionMetadata({ actor, changes: p.changes, recipients: p.recipients });
      if (!same({ ...p.actor, requestId: undefined }, { ...fresh.actor, requestId: undefined })) throw new HubSettingsError("denied");
      if (recoveryDeadline !== undefined && (!Number.isSafeInteger(recoveryDeadline) || recoveryDeadline <= p.createdAt)) throw new HubSettingsError("invalid");
      const expiresAt = recoveryDeadline === undefined ? p.expiresAt : Math.min(p.expiresAt, recoveryDeadline);
      return installDirectory({ ...p, actor: fresh.actor, expiresAt, ...(recoveryDeadline === undefined ? {} : { recoveryDeadline: expiresAt }) }, current, undefined, rotation);
    },
    compensate(originalId, currentIntent, expiresAt) {
      const d = decision(), original = d.operation(originalId);
      if (original.recovery) {
        const receiptText = readDirectoryFile(original.id, "receipt"), receipt = JSON.parse(receiptText);
        if (sha(receiptText) !== original.receiptSha || !same(receipt.recovery, original.recovery)) throw new HubSettingsError("recovery");
        // SQL and a staged receipt can agree with each other without agreeing with the issuer's signed receipt binding.
        if (receipt.id !== original.id || image().confirmationId !== sha(canonical(receipt)).slice(0, 32)) throw new HubSettingsError("recovery");
        const intent = d.mountRecovery();
        if (intent?.operation.id !== original.id || intent.state !== "pending") throw new HubSettingsError("stale");
        expiresAt = Math.min(expiresAt ?? Infinity, original.recovery.expiresAt);
      }
      if (d.inspect().operationId !== original.id || original.kind !== "directory" || !currentProof(() => currentIntent(structuredClone(original)))) throw new HubSettingsError("denied");
      if (!same(directoryImage(), original.after)) throw new HubSettingsError("stale");
      const next = JSON.parse(readDirectoryFile(original.id, "old-hub")), secret = readDirectoryFile(original.id, "old-secret", 4096);
      // This is the preauthorized old CONTENT, not a DB/floor/session restore. The SQL participant retains newer security.
      if (sha(canonical(next)) !== original.before.configSha || hubPlanDigest(next) !== original.before.configDigest || sha(secret) !== original.before.bindSecretSha) throw new HubSettingsError("recovery");
      const t = now();
      if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= t)) throw new HubSettingsError("expired");
      return installDirectory({ actor: original.actor, expected: d.inspect(), before: directoryImage(), next, secret,
        generation: original.previousGeneration, changes: original.changes, recipients: original.recipients, createdAt: t, expiresAt: Math.min(t + PREPARED_MS, expiresAt ?? Infinity) },
      () => currentIntent(structuredClone(original)), original);
    },
  };

  const pending = () => existsSync(file(SETTINGS_JOURNAL));
  return {
    pending,
    pendingDirectory: () => readJournal()?.v === 2,
    ...(deps.directoryDecision ? { directory: directoryWriter } : {}),

    prepare(op, actor) {
      if (op.kind !== "rename") throw new HubSettingsError("invalid");
      const name = hubNameInput(op.name);
      const old = image();
      const from = currentHubName(old.hub);
      if (from === name) throw new HubSettingsError("unchanged");
      const next: Record<string, unknown> = { ...old.hub };
      if (name === null) delete next.name; else next.name = name;
      const t = now();
      for (const [k, p] of prepared) if (p.expiresAt <= t) prepared.delete(k);
      if (prepared.size >= MAX_PREPARED) prepared.delete(prepared.keys().next().value!);
      const ref = randomBytes(24).toString("base64url"), expiresAt = t + PREPARED_MS;
      prepared.set(ref, { op: { kind: "rename", name }, person: personKeyString(actor.person), sessionId: actor.sessionId,
        oldDigest: old.digest, newDigest: hubPlanDigest(next), manifestSha: old.manifestSha, expiresAt });
      return { ref, summary: { field: "name", from, to: name }, expiresAt };
    },

    commit(ref, actor, current) {
      // From here to publication there is no await: nothing else in this process runs in between.
      const p = typeof ref === "string" ? prepared.get(ref) : undefined;
      if (!p) throw new HubSettingsError("expired");
      prepared.delete(ref);   // one use
      if (p.expiresAt <= now()) throw new HubSettingsError("expired");
      if (p.person !== personKeyString(actor.person) || p.sessionId !== actor.sessionId || !current()) throw new HubSettingsError("denied");
      if (pending()) throw new HubSettingsError("busy");
      const old = image();
      if (old.digest !== p.oldDigest || old.manifestSha !== p.manifestSha) throw new HubSettingsError("stale");
      const name = p.op.name, from = currentHubName(old.hub);
      const next: Record<string, unknown> = { ...old.hub };
      if (name === null) delete next.name; else next.name = name;
      if (hubPlanDigest(next) !== p.newDigest) throw new HubSettingsError("stale");

      const id = randomUUID(), at = new Date(now()).toISOString();
      const receipt = { v: 1, kind: "agend-hub-settings-receipt", id, op: "rename", actor: { kind: "hub-administrator", person: personKeyString(actor.person) },
        requestId: actor.requestId, hubId: old.hub.hubId, oldDigest: old.digest, newDigest: p.newDigest, at };
      const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
      // The issuer signature binds the receipt: confirmationId is its hash (32 hex, as the v1 schema requires).
      const confirmationId = sha(canonical(receipt)).slice(0, 32);
      const signature = sealHubInitialization({ home: deps.home, planDigest: p.newDigest, confirmationId, committedAt: at });
      const manifestText = `${JSON.stringify({ v: 1, hubId: old.hub.hubId, planDigest: p.newDigest, committedAt: at, confirmationId, signature }, null, 2)}\n`;
      writePrivate(SETTINGS_STAGED, staged(id, "receipt"), receiptText);
      writePrivate(SETTINGS_STAGED, staged(id, "manifest"), manifestText);
      const journal: Journal = { v: 1, id, op: "rename", phase: "prepared", old: { digest: old.digest, manifestSha: old.manifestSha },
        new: { digest: p.newDigest, manifestSha: sha(manifestText), name } };
      writeJournal(journal); step("staged");

      // The commit point: the image is still the one prepared, and the person and session still hold.
      // Any refusal here (the pair changed, stopped verifying, or the session ended) cancels: the staged files go, nothing in
      // force was touched, and no journal is left to make the next commit wait.
      let again: ReturnType<typeof image> | null = null;
      try { again = image(); } catch { /* the pair no longer verifies: as stale */ }
      if (!again || again.digest !== p.oldDigest || again.manifestSha !== p.manifestSha || !current()) { cleanup(id); throw new HubSettingsError("stale"); }
      writeJournal({ ...journal, phase: "committed" }); step("committed");

      // Past the commit point a failure leaves the journal committed: the next Hub apply calls recover() first, which
      // finishes the change (or refuses, overwriting nothing). Until then the running Hub keeps its mounted settings.
      writePrivate("hub", MANIFEST, manifestText); step("manifest");
      deps.saveHub(namePatch(name)); step("config");
      // What was saved must be exactly what was sealed, and the pair must verify; anything else past the commit point is a
      // recovery (the journal stays committed; recover() then finishes it or refuses, overwriting nothing).
      if (hubPlanDigest(obj(deps.readHub())) !== p.newDigest) throw new HubSettingsError("recovery", "the saved settings differ from the sealed ones");
      try { image(); } catch { throw new HubSettingsError("recovery", "the new pair does not verify"); }
      finish({ ...journal, phase: "committed" });
      return { receiptId: id, summary: { field: "name", from, to: name } };
    },

    recover() {
      const j = readJournal();
      if (!j) return;
      if (j.v === 2) { finishDirectory(j); return; }
      if (j.phase === "prepared") { cleanup(j.id); return; }   // nothing in force changed
      if (j.phase === "done") { cleanup(j.id); return; }
      // committed: finish each file that is still old, keep each that is new; anything else is not ours to overwrite.
      // Both files are judged before either is written, so a refusal leaves both exactly as they were.
      const manifestSha = sha(readManifest());
      const stagedManifest = readFileSync(privatePath(deps.home, staged(j.id, "manifest")), "utf8");
      if (sha(stagedManifest) !== j.new.manifestSha) throw new HubSettingsError("recovery", "the staged manifest changed");
      if (manifestSha !== j.new.manifestSha && manifestSha !== j.old.manifestSha) throw new HubSettingsError("recovery", "the manifest changed outside this commit");
      const digest = hubPlanDigest(obj(deps.readHub()));
      if (digest !== j.new.digest && digest !== j.old.digest) throw new HubSettingsError("recovery", "hub.* changed outside this commit");
      if (manifestSha !== j.new.manifestSha) writePrivate("hub", MANIFEST, stagedManifest);
      step("manifest");
      if (digest !== j.new.digest) {
        deps.saveHub(namePatch(j.new.name));
        if (hubPlanDigest(obj(deps.readHub())) !== j.new.digest) throw new HubSettingsError("recovery", "the saved settings differ from the sealed ones");
      }
      step("config");
      finish(j);
    },
  };
}
