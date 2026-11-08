/**
 * M-2682: the one writer for a sealed Hub setting changed after initialization (agreed with Cairn, cid-m2687-settings-commit).
 *
 * The hub.* block is sealed: the initialization manifest signs its normalized digest (init/plan-digest.ts) with the Hub's
 * issuer key, and every mount re-checks the pair (mount.ts). A setting written to fleet.yaml alone makes the Hub hold, so a
 * change goes through here: the new block and a new manifest, signed by the same issuer key, committed as one unit.
 *
 * - An operation names exactly what it changes; there is no generic reseal. Today: `rename` (set or clear hub.name; a cleared
 *   name is the key absent — never "" or blanks). Each operation's authority is its caller's: the Hub administrator for
 *   rename (settings-api.ts). The issuer key, hubId, origins, certificates, directory and data are never touched.
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
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";
import { hubPlanDigest } from "./init/plan-digest.js";
import { sealHubInitialization, verifyHubInitialization } from "./initialization.js";
import { ensurePrivateDirectory, privatePath } from "./private-files.js";
import { personKeyString } from "./identity.js";
import type { PersonKey } from "./types.js";

export const SETTINGS_JOURNAL = "hub/settings-journal.json";
export const SETTINGS_STAGED = "hub/settings-staged";
export const SETTINGS_RECEIPTS = "hub/settings-receipts";
const MANIFEST = "hub/init-manifest.json";
/** The same rule as the initializer's Hub name: 1–64 characters, no control characters, no blanks around it. */
export const HUB_NAME_RULE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const PREPARED_MS = 5 * 60_000;
const MAX_PREPARED = 32;

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
  step?(name: "staged" | "committed" | "manifest" | "config" | "done"): void;
}

interface Prepared { op: HubSettingsOp; person: string; sessionId: string; oldDigest: string; newDigest: string; manifestSha: string; expiresAt: number }
interface Journal {
  v: 1; id: string; op: "rename"; phase: "prepared" | "committed" | "done";
  old: { digest: string; manifestSha: string }; new: { digest: string; manifestSha: string; name: string | null };
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
}

export function createHubSettingsWriter(deps: HubSettingsWriterDeps): HubSettingsWriter {
  const now = deps.now ?? Date.now;
  const prepared = new Map<string, Prepared>();
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
    try { verifyHubInitialization({ home: deps.home, hubId: hub.hubId, memberOrigin: hub.memberOrigin, planDigest: digest }); }
    catch { throw new HubSettingsError("unavailable", "the Hub's sealed settings do not verify"); }
    return { hub, digest, manifest, manifestSha: sha(manifest) };
  };
  const readJournal = (): Journal | null => {
    if (!existsSync(file(SETTINGS_JOURNAL))) return null;
    const j = JSON.parse(readFileSync(privatePath(deps.home, SETTINGS_JOURNAL), "utf8")) as Journal;
    if (j?.v !== 1 || j.op !== "rename" || !["prepared", "committed", "done"].includes(j.phase) || typeof j.id !== "string" || !/^[0-9a-f-]{36}$/.test(j.id)) {
      throw new HubSettingsError("recovery", "the settings journal is unreadable");
    }
    return j;
  };
  const writeJournal = (j: Journal) => writePrivate("hub", SETTINGS_JOURNAL, `${JSON.stringify(j, null, 2)}\n`);
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

  const pending = () => existsSync(file(SETTINGS_JOURNAL));
  return {
    pending,

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
