/** Public install ownership only. Never reads pairing secrets or treats disconnect as process exit. */
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFileSync } from "./atomic-write.js";
import { validateRuntimeServer } from "./runtime-client-store.js";
import { assertRuntimeInstallDirectory, observeRuntimeProcess, readRuntimeInstallFile, runtimeProcessMatches, type RuntimeInstallLock, type RuntimeProcessObservation, type RuntimeProcessProof } from "./runtime-update-lock.js";
import { readRuntimeInstallReceipt, registerRuntimeInstallOrigin } from "./runtime-update-install.js";
const DIRECTORY = ".agend-runtime-owners", UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface RuntimeInstallOwner { version: 1; id: string; installId: string; origin: string; parent: RuntimeProcessProof; child?: RuntimeProcessProof }
export class RuntimeInstallOwnerError extends Error { constructor(readonly reason: "unsafe" | "changed" | "shared" | "owned" | "unknown" | "unmanaged") { super(`Runtime installation ownership ${reason}`); } }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function processProof(value: unknown): RuntimeProcessProof {
  if (!object(value) || Object.keys(value).length !== 3 || Object.keys(value).some(key => !["pid", "birth", "boot"].includes(key))
    || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || typeof value.birth !== "string" || !/^\d{17,20}$/.test(value.birth)
    || typeof value.boot !== "string" || !/^[a-f0-9]{64}$/.test(value.boot)) throw new RuntimeInstallOwnerError("unsafe");
  return { pid: value.pid as number, birth: value.birth, boot: value.boot };
}
export function parseRuntimeInstallOwner(value: unknown): RuntimeInstallOwner {
  if (!object(value) || Object.keys(value).length !== (value.child === undefined ? 5 : 6) || Object.keys(value).some(key => !["version", "id", "installId", "origin", "parent", "child"].includes(key))
    || value.version !== 1 || typeof value.id !== "string" || !UUID.test(value.id) || typeof value.installId !== "string" || !UUID.test(value.installId)
    || typeof value.origin !== "string" || validateRuntimeServer(value.origin).origin !== value.origin) throw new RuntimeInstallOwnerError("unsafe");
  return { version: 1, id: value.id, installId: value.installId, origin: value.origin, parent: processProof(value.parent), ...(value.child === undefined ? {} : { child: processProof(value.child) }) };
}
function directory(root: string, create = false): string {
  assertRuntimeInstallDirectory(root); const path = join(root, DIRECTORY);
  if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  assertRuntimeInstallDirectory(path); return path;
}
function row(path: string, id: string) {
  if (!UUID.test(id)) throw new RuntimeInstallOwnerError("unsafe");
  assertRuntimeInstallDirectory(path);
  const file = readRuntimeInstallFile(join(path, `${id}.json`), 4096);
  if (!file) throw new RuntimeInstallOwnerError("changed");
  const owner = parseRuntimeInstallOwner(JSON.parse(file.text)); if (owner.id !== id) throw new RuntimeInstallOwnerError("unsafe");
  return { ...file, owner };
}
function unchanged(path: string, before: ReturnType<typeof row>): void {
  const next = row(path, before.owner.id);
  if (next.text !== before.text || next.stat.ino !== before.stat.ino || next.stat.dev !== before.stat.dev || next.stat.uid !== before.stat.uid) throw new RuntimeInstallOwnerError("changed");
}
function own(owner: RuntimeInstallOwner, lock: RuntimeInstallLock): void {
  lock.assert();
  if (lock.record.type !== "supervisor" || owner.parent.pid !== process.pid || runtimeProcessMatches(owner.parent, { state: "alive", proof: lock.record }) !== true) throw new RuntimeInstallOwnerError("changed");
}
/** Must commit BEFORE spawning; the child remains IPC-gated until its exact proof is committed below. */
export async function registerRuntimeInstallOwner(root: string, origin: string, lock: RuntimeInstallLock,
  observe: (pid: number) => Promise<RuntimeProcessObservation> = observeRuntimeProcess): Promise<RuntimeInstallOwner> {
  lock.assert();
  if (lock.record.type !== "supervisor" || lock.record.pid !== process.pid) throw new RuntimeInstallOwnerError("changed");
  const receipt = registerRuntimeInstallOrigin(root, origin, lock), path = directory(root, true);
  const current = () => {
    lock.assert();
    if (JSON.stringify(readRuntimeInstallReceipt(root)) !== JSON.stringify(receipt)) throw new RuntimeInstallOwnerError("changed");
  };
  const names = readdirSync(path);
  if (names.length > 64 || names.some(name => !UUID.test(name.slice(0, -5)) || !name.endsWith(".json"))) throw new RuntimeInstallOwnerError("unsafe");
  // Registration must remain available on shared roots too. Reap only positive process absence;
  // a dead parent does not vouch for its child, and unknown/live rows keep their slots.
  const observations = new Map<number, Promise<RuntimeProcessObservation>>();
  for (const name of names) {
    const before = row(path, name.slice(0, -5)); let retired = true;
    for (const proof of [before.owner.parent, ...before.owner.child ? [before.owner.child] : []]) {
      let observation = observations.get(proof.pid);
      if (!observation) { observation = observe(proof.pid); observations.set(proof.pid, observation); }
      if (runtimeProcessMatches(proof, await observation) !== false) { retired = false; break; }
    }
    if (retired) { current(); unchanged(path, before); unlinkSync(join(path, name)); }
  }
  current();
  if (readdirSync(path).length >= 64) throw new RuntimeInstallOwnerError("owned");
  const owner = parseRuntimeInstallOwner({ version: 1, id: randomUUID(), installId: receipt.id, origin,
    parent: { pid: lock.record.pid, birth: lock.record.birth, boot: lock.record.boot } });
  own(owner, lock);
  // A fresh unguessable row is created once; updates use compare-and-swap below.
  atomicWriteFileSync(join(path, `${owner.id}.json`), JSON.stringify(owner), { mode: 0o600, beforeRename: () => { own(owner, lock); current(); } });
  return owner;
}
export async function attachRuntimeInstallChild(root: string, expected: RuntimeInstallOwner, child: RuntimeProcessProof, lock: RuntimeInstallLock,
  observe: (pid: number) => Promise<RuntimeProcessObservation> = observeRuntimeProcess): Promise<RuntimeInstallOwner> {
  own(expected, lock); const path = directory(root), before = row(path, expected.id), proof = processProof(child);
  if (before.text !== JSON.stringify(expected)) throw new RuntimeInstallOwnerError("changed");
  if (expected.child) {
    const prior = runtimeProcessMatches(expected.child, await observe(expected.child.pid));
    if (prior !== false) throw new RuntimeInstallOwnerError(prior ? "owned" : "unknown");
  }
  if (runtimeProcessMatches(proof, await observe(proof.pid)) !== true) throw new RuntimeInstallOwnerError("unknown");
  const next = parseRuntimeInstallOwner({ ...expected, child: proof }); own(expected, lock); unchanged(path, before);
  atomicWriteFileSync(join(path, `${expected.id}.json`), JSON.stringify(next), { mode: 0o600, beforeRename: () => { own(expected, lock); unchanged(path, before); } });
  return next;
}
/** Other live supervisors (even for the same origin), retained children and unknown observations defer. */
export async function assertRuntimeInstallExclusive(root: string, expected: RuntimeInstallOwner, lock: RuntimeInstallLock,
  observe: (pid: number) => Promise<RuntimeProcessObservation> = observeRuntimeProcess): Promise<void> {
  own(expected, lock); const receipt = readRuntimeInstallReceipt(root);
  if (!receipt) throw new RuntimeInstallOwnerError("unmanaged");
  if (receipt.id !== expected.installId || receipt.shared || receipt.origins.length !== 1 || receipt.origins[0] !== expected.origin) throw new RuntimeInstallOwnerError("shared");
  const path = directory(root), self = row(path, expected.id);
  if (self.text !== JSON.stringify(expected)) throw new RuntimeInstallOwnerError("changed");
  const names = readdirSync(path); if (names.length > 64 || names.some(name => !UUID.test(name.slice(0, -5)) || !name.endsWith(".json"))) throw new RuntimeInstallOwnerError("unsafe");
  for (const name of names) {
    if (name === `${expected.id}.json`) continue;
    const before = row(path, name.slice(0, -5));
    if (before.owner.installId !== receipt.id || before.owner.origin !== expected.origin) throw new RuntimeInstallOwnerError("shared");
    for (const proof of [before.owner.parent, ...before.owner.child ? [before.owner.child] : []]) {
      const match = runtimeProcessMatches(proof, await observe(proof.pid));
      if (match !== false) throw new RuntimeInstallOwnerError(match ? "owned" : "unknown");
    }
    // Parent gone before a child proof was committed means the child never received its startup admission.
    // A registered child is retained until positively gone as well; a dead parent never vouches for it.
    own(expected, lock); unchanged(path, before); unlinkSync(join(path, name));
  }
  own(expected, lock); unchanged(path, self);
  const current = readRuntimeInstallReceipt(root);
  if (JSON.stringify(current) !== JSON.stringify(receipt)) throw new RuntimeInstallOwnerError("changed");
}
export async function releaseRuntimeInstallOwner(root: string, expected: RuntimeInstallOwner, lock: RuntimeInstallLock,
  observe: (pid: number) => Promise<RuntimeProcessObservation> = observeRuntimeProcess): Promise<void> {
  own(expected, lock); const path = directory(root), before = row(path, expected.id);
  if (before.text !== JSON.stringify(expected)) throw new RuntimeInstallOwnerError("changed");
  if (expected.child && runtimeProcessMatches(expected.child, await observe(expected.child.pid)) !== false) throw new RuntimeInstallOwnerError("owned");
  own(expected, lock); unchanged(path, before); unlinkSync(join(path, `${expected.id}.json`));
}

/** Read-only recovery evidence. Possessing a row never grants process or update authority. */
export function readRuntimeInstallOwner(root: string, id: string): RuntimeInstallOwner {
  return row(directory(root), id).owner;
}
function receiptCurrent(root: string, expected: RuntimeInstallOwner): () => void {
  const receipt = readRuntimeInstallReceipt(root);
  if (!receipt || receipt.id !== expected.installId || !receipt.origins.includes(expected.origin)) throw new RuntimeInstallOwnerError("changed");
  return () => { if (JSON.stringify(readRuntimeInstallReceipt(root)) !== JSON.stringify(receipt)) throw new RuntimeInstallOwnerError("changed"); };
}
/** An already registered child may adopt its own row only after positive parent absence.
 * Used by the temporary handoff helper and by a task-capable candidate whose helper died;
 * IPC loss and an unknown observation are never proof of parent exit. */
export async function adoptRuntimeInstallOwner(root: string, expected: RuntimeInstallOwner, lock: RuntimeInstallLock,
  observe: (pid: number) => Promise<RuntimeProcessObservation> = observeRuntimeProcess): Promise<RuntimeInstallOwner> {
  lock.assert(); const candidate = expected.child;
  if (!candidate || lock.record.type !== "supervisor" || candidate.pid !== process.pid
    || runtimeProcessMatches(candidate, { state: "alive", proof: lock.record }) !== true) throw new RuntimeInstallOwnerError("changed");
  const current = receiptCurrent(root, expected), path = directory(root), before = row(path, expected.id);
  if (before.text !== JSON.stringify(expected)) throw new RuntimeInstallOwnerError("changed");
  const parent = runtimeProcessMatches(expected.parent, await observe(expected.parent.pid));
  if (parent !== false) throw new RuntimeInstallOwnerError(parent ? "owned" : "unknown");
  if (runtimeProcessMatches(candidate, await observe(candidate.pid)) !== true) throw new RuntimeInstallOwnerError("unknown");
  const next = parseRuntimeInstallOwner({ version: 1, id: expected.id, installId: expected.installId, origin: expected.origin, parent: candidate });
  const assert = () => { own(next, lock); current(); unchanged(path, before); };
  assert(); atomicWriteFileSync(join(path, `${expected.id}.json`), JSON.stringify(next), { mode: 0o600, beforeRename: assert });
  return next;
}
/** After positive activation, the helper transfers ownership to the exact registered live child.
 * The child independently verifies the resulting row before starting its next update loop. */
export async function transferRuntimeInstallOwner(root: string, expected: RuntimeInstallOwner, lock: RuntimeInstallLock,
  observe: (pid: number) => Promise<RuntimeProcessObservation> = observeRuntimeProcess): Promise<RuntimeInstallOwner> {
  own(expected, lock); if (!expected.child) throw new RuntimeInstallOwnerError("changed");
  const current = receiptCurrent(root, expected), path = directory(root), before = row(path, expected.id);
  if (before.text !== JSON.stringify(expected)) throw new RuntimeInstallOwnerError("changed");
  if (runtimeProcessMatches(expected.child, await observe(expected.child.pid)) !== true) throw new RuntimeInstallOwnerError("unknown");
  const next = parseRuntimeInstallOwner({ version: 1, id: expected.id, installId: expected.installId, origin: expected.origin, parent: expected.child });
  const assert = () => { own(expected, lock); current(); unchanged(path, before); };
  assert(); atomicWriteFileSync(join(path, `${expected.id}.json`), JSON.stringify(next), { mode: 0o600, beforeRename: assert });
  return next;
}
