/** Explicit option-A reconciliation. Native V2 files are read/copied, never moved, rewritten or deleted. */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";
import { kiroCanonicalDirectory, kiroCarryCandidate, kiroOwnedConversation, kiroEngineFloor, isConsistentKiroIdentityRecord } from "./kiro-identity.js";
import type { KiroClassicArchiveInput } from "./kiro-classic-archive.js";

export interface KiroReconcileInput extends KiroClassicArchiveInput { archiveId: string; model: string }
export interface KiroReconcilePlan { digest: string; rollbackReceipt?: string }
type Fingerprint = { hash: string; size: number; dev: number; ino: number; mtime: number; ctime: number };
type File = { bytes: Buffer; fingerprint: Fingerprint };
type Manifest = { version: 1; input: KiroReconcileInput; actor: string; classicHash: string;
  files: Record<string, Fingerprint | null>; identityBefore: string; classicClaimBefore: string; keepClaimBefore: string; archiveClaimBefore: string | null };
type Journal = { receipt: string; phase: "prepared" | "selected" | "rollback_pending" | "rolled_back" };
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const receiptPattern = /^[a-f0-9]{64}$/;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function syncDir(path: string): void { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function privateDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.mode & 0o077 || process.getuid && s.uid !== process.getuid()) throw new Error("Reconciliation directory is not private and owned");
  syncDir(path); syncDir(dirname(path));
}
function checkPrivateDir(path: string): void {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.mode & 0o077 || process.getuid && s.uid !== process.getuid()) throw new Error("Reconciliation directory is not private and owned");
}
function read(path: string, limit: number, privateFile = false): File {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > limit || process.getuid && s.uid !== process.getuid() || privateFile && s.mode & 0o077) throw new Error("Reconciliation file is unsafe or oversized");
    const bytes = Buffer.alloc(s.size); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new Error("Reconciliation file was truncated"); offset += n; }
    const after = fstatSync(fd), atPath = lstatSync(path);
    if (bytes.length !== s.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs
      || atPath.dev !== s.dev || atPath.ino !== s.ino) throw new Error("Reconciliation file changed while reading");
    return { bytes, fingerprint: { hash: hash(bytes), size: s.size, dev: s.dev, ino: s.ino, mtime: s.mtimeMs, ctime: s.ctimeMs } };
  } finally { closeSync(fd); }
}
function optional(path: string, limit: number, privateFile = false): File | null {
  try { return read(path, limit, privateFile); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
function atomic(path: string, text: string): void {
  atomicWriteFileSync(path, text, { mode: 0o600 }); syncDir(dirname(path));
}
function writeNew(path: string, bytes: Buffer): void {
  if (!existsSync(path)) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    syncDir(dirname(path));
  }
  if (!read(path, bytes.length, true).bytes.equals(bytes)) throw new Error("Reconciliation archive read-back failed");
  // A prior attempt may have left a visible file after fsync failed. Retry must
  // establish durability too, before publishing any authority to re-pin.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(path));
}
function scope(input: KiroReconcileInput): void {
  if (!idPattern.test(input.sessionId) || !idPattern.test(input.archiveId) || input.sessionId === input.archiveId
    || !/^[^\r\n\0]{1,512}$/.test(input.instance) || !input.model) throw new Error("Invalid explicit reconciliation selection");
}
function paths(input: KiroReconcileInput) {
  const ownerHash = hash(input.instance).slice(0, 32), root = join(input.agendHome, "kiro-reconciliations", ownerHash);
  return { root, active: join(root, "active.json"), identity: join(input.agendHome, "kiro-identity", "instances", ownerHash + ".json"),
    classicClaim: join(input.agendHome, "kiro-identity", "claims", "v1", input.sessionId),
    keepClaim: join(input.agendHome, "kiro-identity", "claims", "v2", input.sessionId),
    archiveClaim: join(input.agendHome, "kiro-identity", "claims", "v2", input.archiveId) };
}
function fileNames(input: KiroReconcileInput): string[] { return [input.sessionId, input.archiveId].flatMap(id => [id + ".json", id + ".jsonl", id + ".history"]); }
function limit(name: string): number { return name.endsWith(".jsonl") ? 64 * 1024 * 1024 : name.endsWith(".json") ? 8 * 1024 * 1024 : 16 * 1024 * 1024; }
function files(input: KiroReconcileInput): Record<string, File | null> {
  return Object.fromEntries(fileNames(input).map(name => [name, name.endsWith(".history")
    ? optional(join(input.sessionsDir, name), limit(name)) : read(join(input.sessionsDir, name), limit(name))]));
}
function state(input: KiroReconcileInput) {
  const p = paths(input);
  return { identity: read(p.identity, 1024 * 1024).bytes.toString("utf8"),
    classicClaim: read(p.classicClaim, 1024).bytes.toString("utf8"),
    keepClaim: read(p.keepClaim, 1024).bytes.toString("utf8"), archiveClaim: optional(p.archiveClaim, 1024)?.bytes.toString("utf8") ?? null };
}
function peerProof(input: KiroReconcileInput): void {
  const dir = dirname(paths(input).identity), names = readdirSync(dir);
  if (names.length > 4096) throw new Error("Too many Kiro identities to prove ownership");
  for (const name of names) {
    if (!name.endsWith(".json") || name === hash(input.instance).slice(0, 32) + ".json") continue;
    const other = JSON.parse(read(join(dir, name), 1024 * 1024).bytes.toString("utf8"));
    if (name.endsWith(".adopting.json")) {
      if (!other || typeof other !== "object" || Array.isArray(other)) throw new Error("Alternative adoption ownership is not exclusive");
      for (const [key, id] of Object.entries(other)) {
        const tuple = JSON.parse(key);
        if (!Array.isArray(tuple) || tuple.length !== 3 || !["v1", "v2", "v3"].includes(tuple[0]) || typeof tuple[1] !== "string"
          || tuple[2] !== null && typeof tuple[2] !== "string" || typeof id !== "string" || !idPattern.test(id) || id === input.archiveId) throw new Error("Alternative adoption ownership is not exclusive");
      }
    } else {
      if (other.version !== 2 || typeof other.instance !== "string" || !other.keys || Object.entries(other.keys).some(([k, r]) => !isConsistentKiroIdentityRecord(k, r))
        || Object.values(other.keys).some((r: any) => r.engine === "v2" && (r.id === input.archiveId
        || r.id === null && kiroCanonicalDirectory(r.workingDirectory) === kiroCanonicalDirectory(input.workingDirectory)))) throw new Error("Alternative session may belong to another instance");
    }
  }
}
/** Planning is read-only; only hashes/metadata leave the worker. */
export function inspectKiroReconciliation(input: KiroReconcileInput, classicHash: string): KiroReconcilePlan {
  scope(input);
  if (kiroEngineFloor(input.agendHome, input.instance) !== "v2") throw new Error("Only the original V2 carry can be reconciled");
  const candidate = kiroCarryCandidate(input);
  if (!candidate?.repair || candidate.id !== input.sessionId) throw new Error("Reconciliation requires the original abandoned carry");
  const snapshots = files(input), keep = JSON.parse(snapshots[input.sessionId + ".json"]!.bytes.toString("utf8")), other = JSON.parse(snapshots[input.archiveId + ".json"]!.bytes.toString("utf8"));
  for (const [id, meta] of [[input.sessionId, keep], [input.archiveId, other]] as const) {
    if (meta.session_id !== id || meta.session_state?.version !== "v1" || meta.session_state?.rts_model_state?.conversation_id !== id
      || typeof meta.cwd !== "string" || kiroCanonicalDirectory(meta.cwd) !== kiroCanonicalDirectory(input.workingDirectory)
      || !Number.isFinite(Date.parse(meta.created_at))) throw new Error("Reconciliation session/cwd is not proven");
  }
  if (Date.parse(other.created_at) <= Date.parse(keep.created_at) || !snapshots[input.archiveId + ".jsonl"]!.bytes.length) throw new Error("The named alternative is not newer work");
  const before = state(input);
  if (before.classicClaim !== input.instance + "\n" || before.keepClaim !== input.instance + "\nabandoned\n"
    || before.archiveClaim !== null && before.archiveClaim !== input.instance + "\n") throw new Error("Reconciliation claims are not exclusively owned");
  peerProof(input);
  const digest = hash(JSON.stringify({ input, classicHash, before, active: optional(paths(input).active, 4096, true)?.fingerprint ?? null,
    files: Object.fromEntries(Object.entries(snapshots).map(([n, f]) => [n, f?.fingerprint ?? null])) }));
  return { digest };
}
function manifestAt(input: KiroReconcileInput, receipt: string): { manifest: Manifest; root: string } {
  scope(input);
  if (!receiptPattern.test(receipt)) throw new Error("Invalid reconciliation receipt");
  const root = join(paths(input).root, receipt);
  for (const dir of [join(input.agendHome, "kiro-reconciliations"), paths(input).root, root]) checkPrivateDir(dir);
  const manifest = JSON.parse(read(join(root, "manifest.json"), 2 * 1024 * 1024, true).bytes.toString("utf8")) as Manifest;
  if (hash(JSON.stringify(manifest)) !== receipt || manifest.version !== 1 || !equal(manifest.input, input)
    || !equal(Object.keys(manifest.files).sort(), fileNames(input).sort())) throw new Error("Reconciliation receipt scope/checksum differs");
  for (const [name, f] of Object.entries(manifest.files)) if (f) {
    const copy = read(join(root, name), limit(name), true);
    if (copy.fingerprint.hash !== f.hash || copy.fingerprint.size !== f.size) throw new Error("Reconciliation archive checksum differs");
  }
  return { manifest, root };
}
function journal(input: KiroReconcileInput): Journal | null {
  const file = optional(paths(input).active, 4096, true);
  if (!file) return null;
  const value = JSON.parse(file.bytes.toString("utf8")) as Journal;
  if (!receiptPattern.test(value.receipt) || !["prepared", "selected", "rollback_pending", "rolled_back"].includes(value.phase)) throw new Error("Reconciliation journal is invalid");
  return value;
}
function setPhase(input: KiroReconcileInput, receipt: string, phase: Journal["phase"]): void { atomic(paths(input).active, JSON.stringify({ receipt, phase }) + "\n"); }
export function preserveKiroReconciliation(input: KiroReconcileInput, plan: KiroReconcilePlan, classicHash: string, actor: string): string {
  if (inspectKiroReconciliation(input, classicHash).digest !== plan.digest || !actor || actor.length > 512) throw new Error("Reconciliation confirmation is stale");
  const snapshots = files(input), before = state(input);
  const manifest: Manifest = { version: 1, input, actor, classicHash, files: Object.fromEntries(Object.entries(snapshots).map(([n, f]) => [n, f?.fingerprint ?? null])),
    identityBefore: before.identity, classicClaimBefore: before.classicClaim, keepClaimBefore: before.keepClaim, archiveClaimBefore: before.archiveClaim };
  const receipt = hash(JSON.stringify(manifest)), base = join(input.agendHome, "kiro-reconciliations");
  privateDir(base); privateDir(paths(input).root); const root = join(paths(input).root, receipt); privateDir(root);
  for (const [name, f] of Object.entries(snapshots)) if (f) writeNew(join(root, name), f.bytes);
  writeNew(join(root, "manifest.json"), Buffer.from(JSON.stringify(manifest)));
  manifestAt(input, receipt);
  if (inspectKiroReconciliation(input, classicHash).digest !== plan.digest) throw new Error("Reconciliation sources changed while preserving");
  setPhase(input, receipt, "prepared"); return receipt;
}
/** An active/rolled-back intent is never interpreted as permission for a fresh conversation. */
export function assertKiroReconciliationLaunch(input: KiroClassicArchiveInput): { input: KiroReconcileInput; classicHash: string } | null {
  const j = journal({ ...input, archiveId: "unused", model: "unused" }); if (!j) return null;
  if (j.phase === "rollback_pending" || j.phase === "rolled_back") throw new Error("Kiro reconciliation was rolled back; explicit confirmation is required before starting");
  if (!receiptPattern.test(j.receipt)) throw new Error("Invalid reconciliation receipt");
  const path = join(paths({ ...input, archiveId: "unused", model: "unused" }).root, j.receipt, "manifest.json");
  const m = JSON.parse(read(path, 2 * 1024 * 1024, true).bytes.toString("utf8")) as Manifest;
  if (!archivedKiroAlternative({ ...input, sessionId: m.input.sessionId }, m.input.archiveId)) throw new Error("Reconciliation selection is not proven");
  if (j.phase === "prepared") inspectKiroReconciliationRollback(m.input, j.receipt);
  return j.phase === "prepared" ? { input: m.input, classicHash: m.classicHash } : null;
}
export function archivedKiroAlternative(input: KiroClassicArchiveInput, alternative: string): (() => boolean) | null {
  const j = journal({ ...input, archiveId: alternative, model: "unused" }); if (!j) return null;
  if (j.phase !== "prepared" && j.phase !== "selected") return null;
  // The receipt supplies the model; every storage/root/selection field still has to match this launch.
  if (!receiptPattern.test(j.receipt)) throw new Error("Invalid reconciliation receipt");
  const path = join(paths({ ...input, archiveId: alternative, model: "unused" }).root, j.receipt, "manifest.json");
  const m = JSON.parse(read(path, 2 * 1024 * 1024, true).bytes.toString("utf8")) as Manifest;
  if (m.input.archiveId !== alternative) return null;
  const scoped = { ...input, archiveId: alternative, model: m.input.model };
  const { manifest } = manifestAt(scoped, j.receipt);
  peerProof(scoped);
  const claim = state(scoped).archiveClaim;
  if (claim !== manifest.archiveClaimBefore && claim !== input.instance + "\nabandoned\n") throw new Error("Archived alternative ownership changed");
  const unchanged = () => {
    const now = files(scoped);
    const names = j.phase === "prepared" ? fileNames(scoped) : [alternative + ".json", alternative + ".jsonl", alternative + ".history"];
    return names.every(name => equal(now[name]?.fingerprint ?? null, manifest.files[name]));
  };
  if (!unchanged()) throw new Error("Archived alternative changed; reconciliation held");
  return unchanged;
}
export function completeKiroSelection(input: KiroReconcileInput, receipt: string): void {
  manifestAt(input, receipt); const p = paths(input), current = state(input), value = JSON.parse(current.identity), key = JSON.stringify(["v2", kiroCanonicalDirectory(input.workingDirectory), input.credentialProfile]);
  if (kiroOwnedConversation({ ...input, engine: "v2" }) !== input.sessionId || current.keepClaim !== input.instance + "\n") throw new Error("Original selection is no longer owned");
  if (current.archiveClaim !== null && current.archiveClaim !== input.instance + "\n" && current.archiveClaim !== input.instance + "\nabandoned\n") throw new Error("Archived alternative acquired another owner");
  value.keys[key].abandoned = [...new Set([...value.keys[key].abandoned, input.archiveId])];
  if (current.archiveClaim === null) {
    const fd = openSync(p.archiveClaim, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, input.instance + "\nabandoned\n"); fsyncSync(fd); } finally { closeSync(fd); }
    syncDir(dirname(p.archiveClaim));
  } else atomic(p.archiveClaim, input.instance + "\nabandoned\n");
  atomic(p.identity, JSON.stringify(value) + "\n"); setPhase(input, receipt, "selected");
}
/** Finish a confirmed intent after a worker/process interruption, before publishing a resumed CLI. */
export function finishKiroReconciliationLaunch(input: KiroClassicArchiveInput): void {
  const j = journal({ ...input, archiveId: "unused", model: "unused" });
  if (j?.phase !== "prepared") return;
  const path = join(paths({ ...input, archiveId: "unused", model: "unused" }).root, j.receipt, "manifest.json");
  const m = JSON.parse(read(path, 2 * 1024 * 1024, true).bytes.toString("utf8")) as Manifest;
  const scoped = { ...input, archiveId: m.input.archiveId, model: m.input.model };
  manifestAt(scoped, j.receipt); completeKiroSelection(scoped, j.receipt);
}
export function inspectKiroReconciliationRollback(input: KiroReconcileInput, receipt: string): KiroReconcilePlan {
  const { manifest } = manifestAt(input, receipt), j = journal(input);
  if (j?.receipt !== receipt || j.phase === "rolled_back") throw new Error("Receipt is not the active reconciliation");
  const current = state(input), before = JSON.parse(manifest.identityBefore), now = JSON.parse(current.identity);
  const key = JSON.stringify(["v2", kiroCanonicalDirectory(input.workingDirectory), input.credentialProfile]);
  const old = before.keys[key], live = now.keys[key];
  const selected = { ...old, id: input.sessionId, abandoned: old.abandoned.filter((id: string) => id !== input.sessionId), agentConfirmed: live?.agentConfirmed };
  const retired = { ...selected, abandoned: [...new Set([...selected.abandoned, input.archiveId])] };
  if (!live || typeof live.agentConfirmed !== "boolean" || ![old, selected, retired].some(expected => equal(live, expected))) throw new Error("A newer selection supersedes rollback");
  delete before.keys[key]; delete now.keys[key];
  if (!equal(before, now) || current.classicClaim !== manifest.classicClaimBefore || ![manifest.keepClaimBefore, input.instance + "\n"].includes(current.keepClaim)
    || ![manifest.archiveClaimBefore, input.instance + "\nabandoned\n"].includes(current.archiveClaim)) throw new Error("Identity or claims changed; rollback refused");
  return { digest: hash(JSON.stringify({ receipt, current, phase: j.phase })), rollbackReceipt: receipt };
}
export function rollbackKiroSelection(input: KiroReconcileInput, plan: KiroReconcilePlan): string {
  const receipt = plan.rollbackReceipt!;
  if (inspectKiroReconciliationRollback(input, receipt).digest !== plan.digest) throw new Error("Rollback confirmation is stale");
  const { manifest } = manifestAt(input, receipt), p = paths(input);
  setPhase(input, receipt, "rollback_pending");
  atomic(p.keepClaim, manifest.keepClaimBefore);
  if (manifest.archiveClaimBefore === null) { if (existsSync(p.archiveClaim)) unlinkSync(p.archiveClaim); syncDir(dirname(p.archiveClaim)); }
  else atomic(p.archiveClaim, manifest.archiveClaimBefore);
  atomic(p.identity, manifest.identityBefore); setPhase(input, receipt, "rolled_back"); return receipt;
}
export function beginKiroReconciliationRollback(input: KiroReconcileInput, plan: KiroReconcilePlan): { plan: KiroReconcilePlan; classicHash: string } {
  const receipt = plan.rollbackReceipt!;
  if (inspectKiroReconciliationRollback(input, receipt).digest !== plan.digest) throw new Error("Rollback confirmation is stale");
  const { manifest } = manifestAt(input, receipt);
  setPhase(input, receipt, "rollback_pending");
  return { plan: inspectKiroReconciliationRollback(input, receipt), classicHash: manifest.classicHash };
}
