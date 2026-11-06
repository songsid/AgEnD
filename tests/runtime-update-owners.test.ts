/** Private public-metadata rows and inert exact process observations; no native process queries. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireRuntimeInstallLock, type RuntimeProcessObservation, type RuntimeProcessProof } from "../src/runtime-update-lock.js";
import { RUNTIME_INSTALL_RECEIPT, readRuntimeInstallReceipt } from "../src/runtime-update-install.js";
import { assertRuntimeInstallExclusive, attachRuntimeInstallChild, parseRuntimeInstallOwner, registerRuntimeInstallOwner, releaseRuntimeInstallOwner, type RuntimeInstallOwner } from "../src/runtime-update-owners.js";
const roots: string[] = [], origin = "https://paired.example.test", parent = { pid: process.pid, birth: "638980000000000000", boot: "a".repeat(64) }, child = { ...parent, pid: 123457 };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-install-owners-")); roots.push(root);
  writeFileSync(join(root, RUNTIME_INSTALL_RECEIPT), JSON.stringify({ version: 1, id: randomUUID(), createdAt: 1, revision: 1, origins: [origin], shared: false }), { mode: 0o600 });
  const lock = await acquireRuntimeInstallLock(root, { ownProof: parent }), owner = registerRuntimeInstallOwner(root, origin, lock);
  return { root, lock, owner, directory: join(root, ".agend-runtime-owners") };
}
const alive = (proof: RuntimeProcessProof): RuntimeProcessObservation => ({ state: "alive", proof });
const gone = async (): Promise<RuntimeProcessObservation> => ({ state: "gone" });
function other(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<RuntimeInstallOwner> = {}) {
  const row = { ...f.owner, id: randomUUID(), parent: { ...parent, pid: 123456 }, ...overrides };
  writeFileSync(join(f.directory, `${row.id}.json`), JSON.stringify(row), { mode: 0o600 }); return row;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("commits only public parent identity before child startup and requires its exact live proof", async () => {
  const f = await fixture();
  try {
    expect(f.owner).toEqual({ version: 1, id: expect.any(String), installId: readRuntimeInstallReceipt(f.root)!.id, origin, parent });
    await assertRuntimeInstallExclusive(f.root, f.owner, f.lock, gone);
    await expect(attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => ({ state: "unknown" }))).rejects.toThrow(/unknown/);
    expect(JSON.parse(readFileSync(join(f.directory, `${f.owner.id}.json`), "utf8"))).toEqual(f.owner);
    const running = await attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => alive(child));
    expect(running.child).toEqual(child);
    await expect(releaseRuntimeInstallOwner(f.root, running, f.lock, async () => alive(child))).rejects.toThrow(/owned/);
    await releaseRuntimeInstallOwner(f.root, running, f.lock, gone); expect(readdirSync(f.directory)).toEqual([]);
  } finally { f.lock.release(); }
});
it("a second origin permanently disables exclusivity even after its owner exits", async () => {
  const f = await fixture();
  try {
    const second = registerRuntimeInstallOwner(f.root, "https://other.example.test", f.lock);
    await releaseRuntimeInstallOwner(f.root, second, f.lock, gone);
    expect(readRuntimeInstallReceipt(f.root)?.shared).toBe(true);
    await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, gone)).rejects.toThrow(/shared/);
  } finally { f.lock.release(); }
});
it("even same-origin live or unknown owners defer without removing their reservation", async () => {
  for (const observation of ["alive", "unknown"] as const) {
    const f = await fixture(), prior = other(f);
    try {
      await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, async () => observation === "alive" ? alive(prior.parent) : { state: "unknown" })).rejects.toThrow(observation === "alive" ? /owned/ : /unknown/);
      expect(existsSync(join(f.directory, `${prior.id}.json`))).toBe(true);
    } finally { f.lock.release(); }
  }
});
it("a dead supervisor never vouches for a live or unknown retained child", async () => {
  for (const observation of ["alive", "unknown"] as const) {
    const f = await fixture(), prior = other(f, { child });
    try {
      await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, async pid => pid === prior.parent.pid ? { state: "gone" } : observation === "alive" ? alive(child) : { state: "unknown" })).rejects.toThrow(observation === "alive" ? /owned/ : /unknown/);
      expect(existsSync(join(f.directory, `${prior.id}.json`))).toBe(true);
    } finally { f.lock.release(); }
  }
});
it("prunes only positively gone or reused parent and child identities", async () => {
  const f = await fixture(), prior = other(f, { child });
  try {
    await assertRuntimeInstallExclusive(f.root, f.owner, f.lock, async pid => alive({ ...prior.parent, pid, birth: "638990000000000000" }));
    expect(existsSync(join(f.directory, `${prior.id}.json`))).toBe(false); expect(existsSync(join(f.directory, `${f.owner.id}.json`))).toBe(true);
  } finally { f.lock.release(); }
});
it("does not delete a replaced owner after a process query awaits", async () => {
  const f = await fixture(), prior = other(f); let release!: (value: RuntimeProcessObservation) => void;
  try {
    const checking = assertRuntimeInstallExclusive(f.root, f.owner, f.lock, () => new Promise(done => { release = done; }));
    const refused = expect(checking).rejects.toThrow(/changed/), replacement = { ...prior, child };
    writeFileSync(join(f.directory, `${prior.id}.json`), JSON.stringify(replacement)); release({ state: "gone" }); await refused;
    expect(JSON.parse(readFileSync(join(f.directory, `${prior.id}.json`), "utf8"))).toEqual(replacement);
  } finally { f.lock.release(); }
});
it("replaces its own child only after positive old-child absence and new-child identity", async () => {
  const f = await fixture();
  try {
    const first = await attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => alive(child)), next = { ...child, pid: 123458 };
    await expect(attachRuntimeInstallChild(f.root, first, next, f.lock, async pid => alive(pid === child.pid ? child : next))).rejects.toThrow(/owned/);
    const second = await attachRuntimeInstallChild(f.root, first, next, f.lock, async pid => pid === child.pid ? { state: "gone" } : alive(next));
    expect(second.child).toEqual(next); await assertRuntimeInstallExclusive(f.root, second, f.lock, gone);
  } finally { f.lock.release(); }
});
it("a replaced self row and unknown directory entries never become exclusivity", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.directory, "unknown"), "retain"); await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, gone)).rejects.toThrow(/unsafe/);
    rmSync(join(f.directory, "unknown")); const replacement = { ...f.owner, child }; writeFileSync(join(f.directory, `${f.owner.id}.json`), JSON.stringify(replacement));
    await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, gone)).rejects.toThrow(/changed/);
    await expect(releaseRuntimeInstallOwner(f.root, f.owner, f.lock, gone)).rejects.toThrow(/changed/);
    expect(JSON.parse(readFileSync(join(f.directory, `${f.owner.id}.json`), "utf8"))).toEqual(replacement);
  } finally { f.lock.release(); }
});
it("strictly rejects command/path/credential fields and malformed process identities", async () => {
  const f = await fixture();
  try {
    for (const bad of [{ ...f.owner, credential: "anything" }, { ...f.owner, child: { ...child, command: "anything" } }, { ...f.owner, parent: { ...parent, birth: "unknown" } }, { ...f.owner, origin: "https://paired.example.test/" }]) expect(() => parseRuntimeInstallOwner(bad)).toThrow();
  } finally { f.lock.release(); }
});
